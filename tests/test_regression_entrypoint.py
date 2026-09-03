import sys

from scripts import run_regression


def test_regression_runs_renderers_as_modules(monkeypatch):
    calls = []
    monkeypatch.setattr(sys, "argv", ["run_regression"])
    monkeypatch.setattr(
        run_regression.subprocess,
        "call",
        lambda command, **kwargs: calls.append((command, kwargs)) or 0,
    )
    assert run_regression.main() == 0
    assert calls[1][0] == [sys.executable, "-m", "tools.canvas_render.smoke_test"]
    assert calls[2][0] == [
        sys.executable, "-m", "tools.canvas_render.capture_fixture", "--all"
    ]
    assert all(call[1]["cwd"] == run_regression.Path(__file__).resolve().parents[1]
               for call in calls)
