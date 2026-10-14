"""Suite-wide guard: no test may reach the user's real data dir (N1).

`config` puts every data path under ``~/.kokoro_reader`` unless KOKORO_DATA_DIR is set, so
a bare `pytest` writes there whenever a test, or a thread that outlives one, is not
redirected. Every path is moved to a session tmp dir before the first test. Tests that
monkeypatch a path themselves still win, and their undo lands back here. The guard is never
undone: a straggler thread writing during interpreter exit must still miss the real dir.
"""

from __future__ import annotations

import pytest

from kokoro_reader import config

DATA_PATHS = ("DATA_DIR", "DOCS_DIR", "CACHE_DIR", "AUDIO_CACHE_DIR", "LLM_CACHE_DIR")


@pytest.fixture(autouse=True, scope="session")
def _scratch_data_dir(tmp_path_factory: pytest.TempPathFactory) -> None:
    scratch = tmp_path_factory.mktemp("kokoro_data")
    real = config.DATA_DIR
    for name in DATA_PATHS:
        setattr(config, name, scratch / getattr(config, name).relative_to(real))
