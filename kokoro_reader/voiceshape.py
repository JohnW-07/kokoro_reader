"""V1 (docs/18): Kokoro's native voice knobs, applied to the F0 (pitch) curve the model predicts.

kokoro_mlx's ``forward`` asks ``predictor.F0Ntrain`` for a per-frame F0 in Hz and renders
from it. Rescaling that curve moves the voice's pitch without resampling, so the length and
the timbre stay put; stretching it about its voiced mean widens or flattens the intonation.
Measured on af_aoede (docs/18): pitch 0.85/1.15 -> rendered median 0.857x/1.148x, length
unchanged; expressiveness 0.5/1.5 -> rendered F0 IQR 0.53x/1.43x, median unchanged.

The shape travels by a thread-local, set around ``generate`` with ``using``; the model's
own lock serialises ``forward``, so the predictor reads the shape of the thread rendering.

V2: Siri has no F0 to hook, so ``shape_audio`` applies the same curve edit to its rendered
waveform with Praat's PSOLA (parselmouth). Measured on Nora, 6 s, 48 kHz: pitch 0.85/1.15 ->
median 0.854x/1.153x; expressiveness 0.5/1.5 -> F0 IQR 0.50x/1.42x; length unchanged; ~23 ms.
"""

from __future__ import annotations

import threading
from contextlib import contextmanager
from dataclasses import dataclass
from functools import wraps
from typing import Any, Iterator

import numpy as np

PITCH_MIN, PITCH_MAX = 0.85, 1.15                     # the measured range
EXPRESSIVENESS_MIN, EXPRESSIVENESS_MAX = 0.5, 1.5
VOICED_HZ = 50.0                                      # predicted F0 below this is unvoiced
PSOLA_STEP_S = 0.01                                   # Praat's pitch analysis, for shape_audio
PSOLA_FLOOR_HZ, PSOLA_CEILING_HZ = 75.0, 600.0        # Praat's speech defaults
_SHAPING_MARK = "_kokoro_reader_shapes_f0"

_current = threading.local()


def _clamp(value: float, low: float, high: float) -> float:
    return min(high, max(low, float(value)))


@dataclass(frozen=True)
class VoiceShape:
    pitch: float = 1.0
    expressiveness: float = 1.0

    @classmethod
    def clamped(cls, pitch: float = 1.0, expressiveness: float = 1.0) -> VoiceShape:
        return cls(
            _clamp(pitch, PITCH_MIN, PITCH_MAX),
            _clamp(expressiveness, EXPRESSIVENESS_MIN, EXPRESSIVENESS_MAX),
        )

    @property
    def is_neutral(self) -> bool:
        return self == NEUTRAL

    def key(self) -> str:
        """Cache-key suffix; empty when neutral so audio cached before V1 stays a hit."""
        return "" if self.is_neutral else f"|p{self.pitch:.2f}|e{self.expressiveness:.2f}"


NEUTRAL = VoiceShape()


def shape_f0(f0: Any, shape: VoiceShape) -> Any:
    """Stretch voiced frames about their mean by ``expressiveness``, then scale by ``pitch``."""
    if shape.is_neutral:
        return f0
    import mlx.core as mx  # imported lazily: heavy, MLX-only (as kokoro_mlx in tts_engine)

    voiced = f0 > VOICED_HZ
    mean = mx.sum(mx.where(voiced, f0, 0)) / mx.maximum(mx.sum(voiced), 1)
    stretched = mx.maximum(mean + (f0 - mean) * shape.expressiveness, 0)
    return mx.where(voiced, stretched * shape.pitch, f0)


def shape_audio(audio: np.ndarray, rate: int, shape: VoiceShape) -> np.ndarray:
    """``shape_f0`` for a rendered waveform: edit Praat's pitch tier, resynthesise by PSOLA.

    Neutral, or audio with no voiced frames, is returned as the same array.
    """
    if shape.is_neutral:
        return audio
    import parselmouth  # imported lazily: only Siri renders need it
    from parselmouth.praat import call

    sound = parselmouth.Sound(np.asarray(audio, dtype=np.float64), sampling_frequency=rate)
    manipulation = call(sound, "To Manipulation", PSOLA_STEP_S, PSOLA_FLOOR_HZ, PSOLA_CEILING_HZ)
    tier = call(manipulation, "Extract pitch tier")
    if call(tier, "Get number of points") == 0:
        return audio
    mean = call(tier, "Get mean (points)", 0, 0)
    call(tier, "Formula", f"max(0, {mean} + (self - {mean}) * {shape.expressiveness}) * {shape.pitch}")
    call([tier, manipulation], "Replace pitch tier")
    shaped = call(manipulation, "Get resynthesis (overlap-add)").values[0]
    return shaped[: len(audio)].astype(np.float32)


def current() -> VoiceShape:
    """The shape this thread renders with (set by ``using``)."""
    return getattr(_current, "shape", NEUTRAL)


@contextmanager
def using(shape: VoiceShape) -> Iterator[None]:
    """Render with ``shape`` on this thread only."""
    previous = current()
    _current.shape = shape
    try:
        yield
    finally:
        _current.shape = previous


def install(model: Any) -> Any:
    """Have ``model``'s predictor shape its F0 by the thread's shape. Idempotent; a model
    without kokoro_mlx's internals (the Siri host) is returned untouched."""
    predictor = getattr(getattr(model, "_model", None), "predictor", None)
    predict = getattr(predictor, "F0Ntrain", None)
    if predict is None or getattr(predict, _SHAPING_MARK, False):
        return model

    @wraps(predict)
    def shaped(*args: Any, **kwargs: Any) -> Any:
        f0, noise = predict(*args, **kwargs)
        return shape_f0(f0, current()), noise

    setattr(shaped, _SHAPING_MARK, True)
    predictor.F0Ntrain = shaped
    return model
