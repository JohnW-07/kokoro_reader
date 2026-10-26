"""V1 (docs/18): Kokoro's native voice knobs, applied to the F0 (pitch) curve the model predicts.

kokoro_mlx's ``forward`` asks ``predictor.F0Ntrain`` for a per-frame F0 in Hz and renders
from it. Rescaling that curve moves the voice's pitch without resampling, so the length and
the timbre stay put; stretching it about its voiced mean widens or flattens the intonation.
Measured on af_aoede (docs/18): pitch 0.85/1.15 -> rendered median 0.857x/1.148x, length
unchanged; expressiveness 0.5/1.5 -> rendered F0 IQR 0.53x/1.43x, median unchanged.

The shape travels by a thread-local, set around ``generate`` with ``using``; the model's
own lock serialises ``forward``, so the predictor reads the shape of the thread rendering.
"""

from __future__ import annotations

import threading
from contextlib import contextmanager
from dataclasses import dataclass
from functools import wraps
from typing import Any, Iterator

PITCH_MIN, PITCH_MAX = 0.85, 1.15                     # the measured range
EXPRESSIVENESS_MIN, EXPRESSIVENESS_MAX = 0.5, 1.5
VOICED_HZ = 50.0                                      # predicted F0 below this is unvoiced
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


@contextmanager
def using(shape: VoiceShape) -> Iterator[None]:
    """Render with ``shape`` on this thread only."""
    previous = getattr(_current, "shape", NEUTRAL)
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
        return shape_f0(f0, getattr(_current, "shape", NEUTRAL)), noise

    setattr(shaped, _SHAPING_MARK, True)
    predictor.F0Ntrain = shaped
    return model
