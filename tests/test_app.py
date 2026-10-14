"""Desktop shell contract: settings survive a restart and the window never runs stale JS."""

from __future__ import annotations

from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

import app


def test_static_files_are_served_no_store():
    client = TestClient(app.app)
    for path in ("/static/js/state.js", "/static/css/app.css", "/"):
        response = client.get(path)
        assert response.status_code == 200, path
        assert response.headers["cache-control"] == "no-store", path


def test_window_starts_with_persistent_storage(monkeypatch):
    calls = {}
    monkeypatch.setattr(app.config, "ensure_dirs", lambda: None)
    monkeypatch.setattr(app.threading, "Thread", lambda **_: SimpleNamespace(start=lambda: None))
    monkeypatch.setattr(app.webview, "create_window", lambda **_: None)
    monkeypatch.setattr(app.webview, "start", lambda *a, **kw: calls.update(args=a, kwargs=kw))

    app.main()

    # private_mode=True (pywebview's default) wipes localStorage at launch, losing voice, speed and subs.
    assert calls["kwargs"].get("private_mode") is False


def test_window_fits_half_of_a_laptop_screen(monkeypatch):
    windows = []
    monkeypatch.setattr(app.config, "ensure_dirs", lambda: None)
    monkeypatch.setattr(app.threading, "Thread", lambda **_: SimpleNamespace(start=lambda: None))
    monkeypatch.setattr(app.webview, "create_window", lambda **kw: windows.append(kw))
    monkeypatch.setattr(app.webview, "start", lambda *a, **kw: None)

    app.main()

    # Snapping to half of a 1512 pt MacBook screen leaves 756 pt; the window must be allowed that narrow.
    assert windows[0]["min_size"] == (app.MIN_WINDOW_WIDTH, app.MIN_WINDOW_HEIGHT)
    assert app.MIN_WINDOW_WIDTH <= 1512 // 2


def _fake_dialog(monkeypatch, result):
    """Stand in for the native Save dialog; records what it was asked to suggest."""
    asked = {}

    def dialog(dialog_type, save_filename=""):
        asked.update(dialog_type=dialog_type, save_filename=save_filename)
        return result

    monkeypatch.setattr(app.webview, "windows", [SimpleNamespace(create_file_dialog=dialog)])
    return asked


def test_save_export_returns_none_when_the_dialog_is_cancelled(monkeypatch):
    asked = _fake_dialog(monkeypatch, None)

    assert app.PyWebViewApi().save_export("paper.pdf.md", "# notes") is None
    assert asked["save_filename"] == "paper.pdf.md"


@pytest.mark.parametrize("shape", [str, lambda p: (p,)], ids=["macos-str", "tuple"])
def test_save_export_writes_utf8_to_the_chosen_path(monkeypatch, tmp_path, shape):
    target = tmp_path / "chosen name.md"
    _fake_dialog(monkeypatch, shape(str(target)))

    saved = app.PyWebViewApi().save_export("paper.pdf.md", "# Notes — café ✓")

    assert saved == "chosen name.md"
    assert target.read_text(encoding="utf-8") == "# Notes — café ✓"


def test_save_export_reports_a_failed_write(monkeypatch, tmp_path):
    _fake_dialog(monkeypatch, str(tmp_path / "missing-dir" / "notes.json"))

    with pytest.raises(OSError, match="Could not save notes.json"):
        app.PyWebViewApi().save_export("paper.pdf.json", "[]")


@pytest.mark.parametrize("name", ["../evil.md", "/tmp/x.md", "notes.txt", "notes", ".md", 7])
def test_save_export_rejects_bad_names_before_opening_a_dialog(monkeypatch, name):
    asked = _fake_dialog(monkeypatch, "/should/not/be/used.md")

    with pytest.raises(ValueError):
        app.PyWebViewApi().save_export(name, "text")
    assert asked == {}
