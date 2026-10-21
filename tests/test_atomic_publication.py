from __future__ import annotations

import json

import pytest

from Json_2_Canvas import publication


def windows_lock():
    error = PermissionError("File temporarily locked")
    error.winerror = 32
    return error


def test_atomic_write_retries_windows_lock_without_removing_previous_file(monkeypatch, tmp_path):
    path = tmp_path / "board.canvas"
    path.write_text("previous board", encoding="utf-8")
    replace = publication.os.replace
    attempts = []
    sleeps = []

    def briefly_locked(source, target):
        attempts.append(source)
        assert path.read_text(encoding="utf-8") == "previous board"
        if len(attempts) < 3:
            raise windows_lock()
        replace(source, target)

    monkeypatch.setattr(publication.os, "replace", briefly_locked)
    monkeypatch.setattr(publication.time, "sleep", sleeps.append)
    publication.write_json_atomic(path, {"nodes": [], "edges": []})
    assert json.loads(path.read_text(encoding="utf-8")) == {"nodes": [], "edges": []}
    assert sleeps == [0.05, 0.1]
    assert not list(tmp_path.glob("*.tmp"))


def test_persistent_lock_preserves_previous_file_and_cleans_temporary(monkeypatch, tmp_path):
    path = tmp_path / "board.canvas"
    path.write_text("previous board", encoding="utf-8")
    attempts = []

    def always_locked(*args):
        attempts.append(args)
        raise windows_lock()

    monkeypatch.setattr(publication.os, "replace", always_locked)
    monkeypatch.setattr(publication.time, "sleep", lambda _delay: None)
    with pytest.raises(PermissionError):
        publication.write_json_atomic(path, {"nodes": [], "edges": []})
    assert len(attempts) == 6
    assert path.read_text(encoding="utf-8") == "previous board"
    assert not list(tmp_path.glob("*.tmp"))


def test_regular_permission_failure_is_not_retried(monkeypatch, tmp_path):
    def forbidden(*_args):
        raise PermissionError("Not authorized")

    monkeypatch.setattr(publication.os, "replace", forbidden)
    monkeypatch.setattr(publication.time, "sleep", lambda _delay: pytest.fail("Must not retry a non-Windows permission error"))
    with pytest.raises(PermissionError, match="Not authorized"):
        publication.write_json_atomic(tmp_path / "board.canvas", {})
