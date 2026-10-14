"""Resolve a HuggingFace model id to its cached snapshot, so a warm launch is offline.

Both ``kokoro_mlx`` and ``mlx_lm`` call ``snapshot_download`` online for any id that
is not a local directory, which pings the Hub on every launch even when the weights
are already cached. Handing them the cached directory instead skips that request.
"""

from __future__ import annotations

from pathlib import Path


def cached_path_or_id(model_id: str) -> str:
    """The local snapshot dir if cached, else ``model_id`` for the caller to download."""
    if Path(model_id).expanduser().is_dir():
        return model_id
    from huggingface_hub import snapshot_download  # imported lazily: keeps imports cheap
    from huggingface_hub.errors import LocalEntryNotFoundError

    try:
        return snapshot_download(model_id, local_files_only=True)
    except LocalEntryNotFoundError:
        return model_id
