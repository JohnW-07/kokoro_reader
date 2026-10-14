"""R6: the Kokoro weights load from the project's own copy when it is there and complete."""

from __future__ import annotations

from pathlib import Path

import pytest

from kokoro_reader import config
from tests.test_tts_engine import PaddedModel, cache_dir  # noqa: F401 - cache_dir is a fixture

ENV_KEY = "KOKORO_TTS_MODEL"
TEXT = "One short sentence."
VOICE = "af_aoede"


def _complete_copy(root: Path) -> Path:
    model = root / "Kokoro-82M-bf16"
    for name in config.LOCAL_TTS_MODEL_FILES:
        (model / name).parent.mkdir(parents=True, exist_ok=True)
        (model / name).write_bytes(b"x")
    return model


def test_a_complete_local_copy_is_the_default(tmp_path):
    model = _complete_copy(tmp_path)
    assert config.resolve_tts_model({}, model) == str(model)


def test_no_local_copy_falls_back_to_the_hub_id(tmp_path):
    assert config.resolve_tts_model({}, tmp_path / "missing") == config.TTS_MODEL_ID


@pytest.mark.parametrize("name", config.LOCAL_TTS_MODEL_FILES)
def test_a_copy_missing_any_needed_file_falls_back(tmp_path, name):
    model = _complete_copy(tmp_path)
    (model / name).unlink()
    assert config.resolve_tts_model({}, model) == config.TTS_MODEL_ID


def test_an_empty_weights_file_counts_as_incomplete(tmp_path):
    model = _complete_copy(tmp_path)
    (model / "kokoro-v1_0.safetensors").write_bytes(b"")
    assert config.resolve_tts_model({}, model) == config.TTS_MODEL_ID


def test_the_env_override_wins_over_a_complete_copy(tmp_path):
    model = _complete_copy(tmp_path)
    assert config.resolve_tts_model({ENV_KEY: "some/model"}, model) == "some/model"


def test_an_empty_env_override_is_ignored(tmp_path):
    model = _complete_copy(tmp_path)
    assert config.resolve_tts_model({ENV_KEY: ""}, model) == str(model)


def test_the_needed_files_are_what_kokoro_mlx_reads_plus_the_default_voice():
    assert set(config.LOCAL_TTS_MODEL_FILES) == {
        "config.json", "kokoro-v1_0.safetensors", f"voices/{config.DEFAULT_VOICE}.safetensors",
    }


def test_the_local_copy_is_found_from_the_project_root_not_the_cwd():
    root = Path(config.__file__).resolve().parent.parent
    assert config.LOCAL_TTS_MODEL_DIR == root / "weights" / "kokoro" / "Kokoro-82M-bf16"
    assert config.LOCAL_TTS_MODEL_DIR.is_absolute()


# The audio cache key names the model, so loading the same weights from the project copy
# must keep the Hub id's key: otherwise every clip cached before R6 is thrown away.
def test_the_local_copy_keeps_the_hub_ids_cache_identity():
    assert config.tts_cache_id(str(config.LOCAL_TTS_MODEL_DIR)) == config.TTS_MODEL_ID


@pytest.mark.parametrize("model", [config.TTS_MODEL_ID, "/elsewhere/Kokoro-82M-bf16", "apple-siri"])
def test_any_other_model_is_its_own_cache_identity(model):
    assert config.tts_cache_id(model) == model


@pytest.fixture
def cached_by_hub_id(cache_dir: Path) -> None:
    """A clip cached before R6, by an engine that loaded the Hub id."""
    from kokoro_reader.tts_engine import TTSEngine
    TTSEngine(model_id=config.TTS_MODEL_ID, loader=lambda _m: PaddedModel()).synthesize(TEXT, voice=VOICE)


def _no_model(_model_id: str) -> None:
    raise AssertionError("must be served from the cache")


def test_the_local_copy_serves_clips_cached_under_the_hub_id(cached_by_hub_id):
    from kokoro_reader.tts_engine import TTSEngine
    local = TTSEngine(model_id=str(config.LOCAL_TTS_MODEL_DIR), loader=_no_model)
    assert local.model_id == str(config.LOCAL_TTS_MODEL_DIR)
    assert local.synthesize(TEXT, voice=VOICE)


def test_the_route_probe_counts_those_clips_as_hits(cached_by_hub_id):
    from kokoro_reader.routes import tts as tts_routes
    from kokoro_reader.tts_engine import TTSEngine
    local = TTSEngine(model_id=str(config.LOCAL_TTS_MODEL_DIR), loader=_no_model)
    assert tts_routes._is_cached(local, TEXT, VOICE, 1.0)
