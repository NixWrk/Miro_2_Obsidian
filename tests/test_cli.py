"""Agent-facing CLI: exit codes, --json shapes, credential handling, legacy compatibility."""

from __future__ import annotations

import json
import sys
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from miro2obsidian import app_setup, browser_setup, cli, import_service, miro_auth
from miro2obsidian.agent_guide import AGENT_GUIDE
from miro2obsidian.application import PipelineResult
from miro2obsidian.credential_store import CredentialStoreUnavailable
from miro2obsidian.import_service import ImportOptions, ImportResult
from scripts import miro_pipeline

SECRET = "client-secret-VALUE-123"
CLIENT_ID = "client-id-VALUE-456"
TOKEN = "tok-SECRET-0123456789"
BOARD = "uXjVJSz4qHA="


def run(capsys, *argv: str) -> tuple[int, str, str]:
    code = cli.main(list(argv))
    captured = capsys.readouterr()
    return code, captured.out, captured.err


def run_json(capsys, *argv: str) -> tuple[int, dict]:
    code, out, _ = run(capsys, *argv, "--json")
    return code, json.loads(out)


def json_lines(out: str) -> list[dict]:
    return [json.loads(line) for line in out.splitlines() if line.strip()]


@pytest.fixture(autouse=True)
def isolated(monkeypatch, tmp_path):
    """No real Miro, vault, credential store or browser is ever touched."""
    for name in ("MIRO_ACCESS_TOKEN", "MIRO_CLIENT_ID", "MIRO_CLIENT_SECRET"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("MIRO2OBSIDIAN_CAPTURE_DIR", str(tmp_path / "caps"))
    monkeypatch.setattr(import_service, "get_boards", MagicMock(side_effect=AssertionError("network")))
    monkeypatch.setattr(import_service, "fetch_board_name", lambda *a, **k: None)
    monkeypatch.setattr("webbrowser.open", MagicMock(return_value=True))
    monkeypatch.setattr(sys.stdin, "isatty", lambda: False, raising=False)


@pytest.fixture
def vault(tmp_path) -> Path:
    path = tmp_path / "vault"
    (path / ".obsidian").mkdir(parents=True)
    return path


# ---------------------------------------------------------------------------
# dispatch, help, usage
# ---------------------------------------------------------------------------


def test_subcommand_list() -> None:
    assert set(cli.SUBCOMMANDS) == {"doctor", "setup", "auth", "boards", "capture", "import", "agent-guide"}


def test_pipeline_main_dispatches_subcommands(monkeypatch) -> None:
    called = MagicMock(return_value=3)
    monkeypatch.setattr(cli, "main", called)
    for name in cli.SUBCOMMANDS:
        monkeypatch.setattr(sys, "argv", ["miro2obsidian", name, "--json"])
        assert miro_pipeline.main() == 3
        called.assert_called_with([name, "--json"])


def test_existing_serve_subcommands_still_route_to_their_servers(monkeypatch) -> None:
    monkeypatch.setattr(cli, "main", MagicMock(side_effect=AssertionError("must not dispatch")))
    with patch("miro2obsidian.websdk_server.main", return_value=11) as websdk:
        monkeypatch.setattr(sys, "argv", ["miro2obsidian", "websdk-serve", "--port", "8766"])
        assert miro_pipeline.main() == 11
        websdk.assert_called_once_with(["--port", "8766"])
    with patch("miro2obsidian.browser_setup.main", return_value=12) as setup:
        monkeypatch.setattr(sys, "argv", ["miro2obsidian", "setup-serve", "--port", "8767"])
        assert miro_pipeline.main() == 12
        setup.assert_called_once_with(["--port", "8767"])


def test_legacy_flag_invocation_is_unchanged(monkeypatch, tmp_path) -> None:
    source_json = tmp_path / "board.json"
    expected = PipelineResult(
        source_json=source_json,
        canvas_path=tmp_path / "board.canvas",
        item_count=2,
        asset_stats={},
        scale=1.0,
        scale_context={},
        messages=["done"],
        completeness={"complete": True},
    )
    monkeypatch.setattr(cli, "main", MagicMock(side_effect=AssertionError("must not dispatch")))
    argv = [
        "miro2obsidian", "--existing-json", "--source-json", str(source_json),
        "--target-dir", str(tmp_path / "out"), "--vault-root", str(tmp_path), "--scale", "1",
    ]
    monkeypatch.setattr(sys, "argv", argv)
    with (
        patch("scripts.miro_pipeline.resolve_attachment_dir", return_value=None),
        patch("miro2obsidian.application.run_existing_json_pipeline", return_value=expected) as existing,
    ):
        assert miro_pipeline.main() == 0
    existing.assert_called_once()
    assert existing.call_args.kwargs["source_json"] == source_json


def test_legacy_help_mentions_the_subcommands(monkeypatch, capsys) -> None:
    monkeypatch.setattr(sys, "argv", ["miro2obsidian", "--help"])
    with pytest.raises(SystemExit) as exit_info:
        miro_pipeline.main()
    assert exit_info.value.code == 0
    text = capsys.readouterr().out
    for name in (*cli.SUBCOMMANDS, "websdk-serve", "setup-serve"):
        assert name in text
    assert "--existing-json" in text  # the legacy flags are still documented


def test_usage_errors_exit_1_not_2(capsys) -> None:
    for argv in (
        ["import"],  # --vault missing
        ["import", "--vault", "x", "--bogus"],
        ["auth"],
        ["setup", "nope"],
        ["capture"],
    ):
        code, out, err = run(capsys, *argv)
        assert code == 1, argv
        assert "error" in err


def test_no_arguments_is_a_usage_error(capsys) -> None:
    assert run(capsys)[0] == 1


# ---------------------------------------------------------------------------
# agent-guide, setup
# ---------------------------------------------------------------------------


def test_agent_guide_prints_the_procedure(capsys) -> None:
    code, out, _ = run(capsys, "agent-guide")
    assert code == 0 and out == AGENT_GUIDE
    for needle in (
        "miro2obsidian doctor",
        "setup guide",
        "auth login --form",
        "miro2obsidian boards",
        "miro2obsidian import",
        "--json",
        "needs_user",
        "next_step",
        "degraded",
        "NEVER ask for",
    ):
        assert needle in out
    assert len(AGENT_GUIDE.splitlines()) < 120
    code, data = run_json(capsys, "agent-guide")
    assert code == 0 and data == {"guide": AGENT_GUIDE}


def test_agent_guide_tells_every_documented_reason(capsys) -> None:
    for reason in ("not_connected", "app_setup_required", "websdk_capture_timeout", "file_locked", "board_ambiguous"):
        assert reason in AGENT_GUIDE


def test_agent_guide_is_importable_package_code() -> None:
    # A module constant ships in the wheel and in frozen builds without data files.
    assert cli.AGENT_GUIDE is AGENT_GUIDE


def test_setup_guide_json_and_text(capsys) -> None:
    code, data = run_json(capsys, "setup", "guide")
    assert code == 0
    assert [s["id"] for s in data["steps"]] == [s["id"] for s in app_setup.setup_steps()]
    code, out, _ = run(capsys, "setup", "guide")
    assert code == 0
    assert "http://localhost:8766/index.html" in out and "auth login --form" in out
    assert "may differ" in out


def test_setup_manifest_prints_yaml(capsys) -> None:
    code, out, _ = run(capsys, "setup", "manifest")
    assert code == 0 and out == app_setup.app_manifest_yaml()
    code, data = run_json(capsys, "setup", "manifest")
    assert data == {"manifest": app_setup.app_manifest_yaml()}
    code, _, err = run(capsys, "setup", "manifest", "--sdk-port", "0")
    assert code == 1 and "sdk_port" in err


def test_setup_open_opens_the_developer_hub(monkeypatch, capsys) -> None:
    opened = MagicMock(return_value=True)
    monkeypatch.setattr("webbrowser.open", opened)
    code, data = run_json(capsys, "setup", "open")
    assert code == 0 and data == {"opened": True, "url": app_setup.DEVELOPER_HUB_URL}
    opened.assert_called_once_with(app_setup.DEVELOPER_HUB_URL)
    opened.return_value = False
    code, out, _ = run(capsys, "setup", "open")
    assert code == 0 and app_setup.DEVELOPER_HUB_URL in out


# ---------------------------------------------------------------------------
# doctor
# ---------------------------------------------------------------------------


def test_doctor_exit_codes_and_shapes(monkeypatch, capsys, vault) -> None:
    ready = {
        "version": "1", "python": {"version": "3.13"}, "connection": {"connected": True, "message": "ok"},
        "websdk_app": {"present": True}, "ports": {}, "vault": {"checked": False},
        "next_steps": ["Ready."], "ready": True,
    }
    seen = {}

    def fake_doctor(vault_root=None, *, verify_online=False):
        seen.update(vault=vault_root, verify=verify_online)
        return ready

    monkeypatch.setattr(import_service, "doctor", fake_doctor)
    code, data = run_json(capsys, "doctor", "--vault", str(vault), "--verify")
    assert code == 0 and data == ready
    assert seen == {"vault": vault, "verify": True}
    code, out, _ = run(capsys, "doctor")
    assert code == 0 and "Next steps" in out and "Ready." in out
    monkeypatch.setattr(import_service, "doctor", lambda *a, **k: {**ready, "ready": False})
    assert run(capsys, "doctor")[0] == 3


def test_doctor_real_report_through_the_cli(capsys, vault, monkeypatch) -> None:
    monkeypatch.setattr(
        miro_auth, "connection_status", lambda **kw: miro_auth.ConnectionStatus(connected=False, message="not connected")
    )
    monkeypatch.setattr(import_service, "_probe_port", lambda port: {"port": port, "state": "free"})
    code, data = run_json(capsys, "doctor", "--vault", str(vault))
    assert code == 3 and data["ready"] is False
    assert any("auth login --form" in s for s in data["next_steps"])


# ---------------------------------------------------------------------------
# auth
# ---------------------------------------------------------------------------


def _connected(**kw) -> miro_auth.ConnectionStatus:
    return miro_auth.ConnectionStatus(connected=True, source="vault-v2", team_name="Product", message="Miro is connected to team Product.", **kw)


def test_auth_status_exit_codes(monkeypatch, capsys) -> None:
    status = MagicMock(return_value=_connected())
    monkeypatch.setattr(miro_auth, "connection_status", status)
    code, data = run_json(capsys, "auth", "status", "--verify")
    status.assert_called_once_with(verify_online=True)
    assert code == 0 and data["connected"] is True and data["team_name"] == "Product"
    assert "token" not in json.dumps(data).lower().replace("expires", "")

    monkeypatch.setattr(
        miro_auth, "connection_status",
        lambda **kw: miro_auth.ConnectionStatus(connected=False, message="Miro is not connected."),
    )
    code, data = run_json(capsys, "auth", "status")
    assert code == 3 and data["connected"] is False and "auth login --form" in data["next_step"]
    code, out, _ = run(capsys, "auth", "status")
    assert code == 3 and "Next:" in out


def test_auth_login_reads_credentials_from_the_environment(monkeypatch, capsys) -> None:
    monkeypatch.setenv("MIRO_CLIENT_ID", CLIENT_ID)
    monkeypatch.setenv("MIRO_CLIENT_SECRET", SECRET)
    connect = MagicMock(return_value=_connected())
    monkeypatch.setattr(miro_auth, "connect_with_credentials", connect)
    code, out, err = run(capsys, "auth", "login", "--json", "--timeout", "30")
    assert code == 0
    connect.assert_called_once()
    assert connect.call_args.args == (CLIENT_ID, SECRET)
    assert connect.call_args.kwargs["open_browser"] is True and connect.call_args.kwargs["timeout_seconds"] == 30
    for text in (out, err):
        assert SECRET not in text and CLIENT_ID not in text
    last = json_lines(out)[-1]
    assert last["event"] == "connected" and last["connected"] is True


def test_auth_login_no_browser_prints_the_authorize_url(monkeypatch, capsys) -> None:
    monkeypatch.setenv("MIRO_CLIENT_ID", CLIENT_ID)
    monkeypatch.setenv("MIRO_CLIENT_SECRET", SECRET)
    url = "https://miro.com/oauth/authorize?response_type=code&client_id=abc&state=s"

    def fake_connect(client_id, client_secret, *, open_browser, on_authorize_url, **kw):
        assert open_browser is False
        on_authorize_url(url)
        return _connected()

    monkeypatch.setattr(miro_auth, "connect_with_credentials", fake_connect)
    code, out, _ = run(capsys, "auth", "login", "--no-browser")
    assert code == 0 and url in out
    code, out, _ = run(capsys, "auth", "login", "--no-browser", "--json")
    events = json_lines(out)
    assert events[0] == {"event": "authorize_url", "url": url}
    assert events[-1]["event"] == "connected"


@pytest.mark.parametrize(
    "extra",
    [["--client-secret", SECRET], ["--client-id", CLIENT_ID], ["--secret", SECRET], ["--token", TOKEN], [f"--client-secret={SECRET}"]],
)
def test_auth_login_never_accepts_secrets_as_arguments(monkeypatch, capsys, extra) -> None:
    connect = MagicMock()
    monkeypatch.setattr(miro_auth, "connect_with_credentials", connect)
    code, out, err = run(capsys, "auth", "login", *extra)
    assert code == 1
    connect.assert_not_called()
    assert "unrecognized arguments" in err


def test_auth_login_without_credentials_needs_the_user(monkeypatch, capsys) -> None:
    connect = MagicMock()
    monkeypatch.setattr(miro_auth, "connect_with_credentials", connect)
    code, data = run_json(capsys, "auth", "login")
    assert code == 3
    connect.assert_not_called()
    assert (data["status"], data["reason"]) == ("needs_user", "not_connected")
    assert "--form" in data["next_step"] and "Never pass them as arguments" in data["next_step"]


def test_auth_login_prompts_on_a_terminal_without_echoing_the_secret(monkeypatch, capsys) -> None:
    monkeypatch.setattr(sys.stdin, "isatty", lambda: True, raising=False)
    monkeypatch.setattr("builtins.input", lambda prompt="": CLIENT_ID)
    getpass = MagicMock(return_value=SECRET)
    monkeypatch.setattr(cli.getpass, "getpass", getpass)
    connect = MagicMock(return_value=_connected())
    monkeypatch.setattr(miro_auth, "connect_with_credentials", connect)
    code, out, _ = run(capsys, "auth", "login")
    assert code == 0
    assert connect.call_args.args == (CLIENT_ID, SECRET)
    getpass.assert_called_once()
    assert SECRET not in out


def test_auth_login_form_uses_the_loopback_form(monkeypatch, capsys) -> None:
    monkeypatch.setenv("MIRO_CLIENT_ID", CLIENT_ID)
    monkeypatch.setenv("MIRO_CLIENT_SECRET", SECRET)
    connect = MagicMock()
    monkeypatch.setattr(miro_auth, "connect_with_credentials", connect)
    form = MagicMock(side_effect=lambda **kw: (kw["report"]("http://127.0.0.1:50001/"), browser_setup.SetupState(status="complete"))[1])
    monkeypatch.setattr(browser_setup, "run_form", form)
    monkeypatch.setattr(miro_auth, "connection_status", lambda **kw: _connected())
    code, out, _ = run(capsys, "auth", "login", "--form", "--json")
    assert code == 0
    connect.assert_not_called()  # the form, not the environment, supplies credentials
    assert form.call_args.kwargs["open_browser"] is True
    events = json_lines(out)
    assert events[0] == {"event": "form_url", "url": "http://127.0.0.1:50001/"}
    assert events[-1]["event"] == "connected"
    assert SECRET not in out


def test_auth_login_form_failure_and_timeout(monkeypatch, capsys) -> None:
    monkeypatch.setattr(browser_setup, "run_form", lambda **kw: browser_setup.SetupState(status="failed", error="OAuthTokenExchangeError"))
    code, data = run_json(capsys, "auth", "login", "--form")
    assert code == 1 and data["status"] == "failed" and "OAuthTokenExchangeError" in data["message"]
    monkeypatch.setattr(browser_setup, "run_form", lambda **kw: browser_setup.SetupState(status="authorizing"))
    code, data = run_json(capsys, "auth", "login", "--form", "--timeout", "5")
    assert code == 3 and data["status"] == "needs_user"
    assert "--form" in data["next_step"]


def test_auth_login_failures_never_echo_credentials(monkeypatch, capsys) -> None:
    monkeypatch.setenv("MIRO_CLIENT_ID", CLIENT_ID)
    monkeypatch.setenv("MIRO_CLIENT_SECRET", SECRET)
    monkeypatch.setattr(
        miro_auth, "connect_with_credentials", MagicMock(side_effect=RuntimeError(f"bad {CLIENT_ID} {SECRET}"))
    )
    code, out, err = run(capsys, "auth", "login", "--json")
    assert code == 1
    assert SECRET not in out + err and CLIENT_ID not in out + err
    assert json.loads(out)["status"] == "failed"


def test_auth_login_other_outcomes(monkeypatch, capsys) -> None:
    monkeypatch.setenv("MIRO_CLIENT_ID", CLIENT_ID)
    monkeypatch.setenv("MIRO_CLIENT_SECRET", SECRET)
    monkeypatch.setattr(miro_auth, "connect_with_credentials", MagicMock(side_effect=TimeoutError("never approved " + CLIENT_ID)))
    code, data = run_json(capsys, "auth", "login", "--timeout", "7")
    assert code == 3 and "7 seconds" in data["message"] and CLIENT_ID not in json.dumps(data)
    monkeypatch.setattr(miro_auth, "connect_with_credentials", MagicMock(side_effect=CredentialStoreUnavailable("none")))
    code, data = run_json(capsys, "auth", "login")
    assert code == 3 and "credential store" in data["message"]


def test_auth_logout(monkeypatch, capsys) -> None:
    disconnect = MagicMock(return_value=True)
    monkeypatch.setattr(miro_auth, "disconnect", disconnect)
    code, data = run_json(capsys, "auth", "logout")
    assert code == 0 and data == {"disconnected": True, "revoked": True}
    disconnect.assert_called_with(revoke=True)
    code, data = run_json(capsys, "auth", "logout", "--no-revoke")
    disconnect.assert_called_with(revoke=False)
    code, out, _ = run(capsys, "auth", "logout")
    assert code == 0 and "Forgot" in out


# ---------------------------------------------------------------------------
# boards, capture
# ---------------------------------------------------------------------------


RAW_BOARDS = [
    {"id": BOARD, "name": "Roadmap", "team": {"id": "t", "name": "Product"}, "viewLink": "https://miro.com/app/board/uXjVJSz4qHA=/", "owner": {"id": "secretish"}},
    {"id": "uXjVKAAAAAA=", "name": "Retro", "team": {}},
]


def test_boards_lists_normalized_records(monkeypatch, capsys) -> None:
    monkeypatch.setattr(miro_auth, "get_access_token", lambda: TOKEN)
    get = MagicMock(return_value=RAW_BOARDS)
    monkeypatch.setattr(import_service, "get_boards", get)
    code, data = run_json(capsys, "boards")
    assert code == 0 and data["count"] == 2
    assert data["boards"][0] == {"id": BOARD, "name": "Roadmap", "team": "Product", "viewLink": "https://miro.com/app/board/uXjVJSz4qHA=/"}
    assert data["boards"][1]["team"] is None
    assert "owner" not in data["boards"][0] and TOKEN not in json.dumps(data)
    code, data = run_json(capsys, "boards", "--query", "RETRO")
    assert [b["name"] for b in data["boards"]] == ["Retro"]
    code, out, _ = run(capsys, "boards")
    assert BOARD in out and "Roadmap" in out and "[Product]" in out


def test_boards_when_not_connected_or_rejected(monkeypatch, capsys) -> None:
    def not_connected():
        raise miro_auth.NotConnected("Miro is not connected.")

    monkeypatch.setattr(miro_auth, "get_access_token", not_connected)
    code, data = run_json(capsys, "boards")
    assert code == 3 and data["reason"] == "not_connected" and "auth login" in data["next_step"]

    monkeypatch.setattr(miro_auth, "get_access_token", lambda: TOKEN)
    import requests

    response = requests.Response()
    response.status_code = 401
    monkeypatch.setattr(import_service, "get_boards", MagicMock(side_effect=requests.HTTPError(f"401 {TOKEN}", response=response)))
    code, out, err = run(capsys, "boards", "--json")
    assert code == 3 and TOKEN not in out + err
    assert json.loads(out)["reason"] == "not_connected"


def test_capture_streams_events_and_ends_with_a_summary(monkeypatch, capsys, tmp_path) -> None:
    path = tmp_path / "caps" / "websdk-1.json"

    def fake_capture(board, *, timeout_seconds, open_board, on_event):
        on_event({"event": "step", "board_id": BOARD, "message": "Asking the Miro app for a capture."})
        return ImportResult("complete", board_id=BOARD, artifact_path=str(path), websdk_used=True)

    capture = MagicMock(side_effect=fake_capture)
    monkeypatch.setattr(import_service, "run_capture", capture)
    code, out, _ = run(capsys, "capture", "--board", BOARD, "--timeout", "9", "--no-open", "--json")
    assert code == 0
    assert capture.call_args.kwargs["timeout_seconds"] == 9 and capture.call_args.kwargs["open_board"] is False
    lines = json_lines(out)
    assert lines[0]["event"] == "step"
    assert lines[-1]["event"] == "summary" and lines[-1]["exit_code"] == 0
    assert lines[-1]["results"][0]["artifact_path"] == str(path)
    code, out, _ = run(capsys, "capture", "--board", BOARD)
    assert code == 0 and f"capture={path}" in out


def test_capture_exit_codes_follow_the_status(monkeypatch, capsys) -> None:
    for status, expected in (("needs_user", 3), ("failed", 1), ("degraded", 2)):
        monkeypatch.setattr(
            import_service, "run_capture", lambda *a, _s=status, **k: ImportResult(_s, reason="websdk_capture_timeout", next_step="click")
        )
        code, out, _ = run(capsys, "capture", "--board", BOARD, "--json")
        assert code == expected
        assert json_lines(out)[-1]["exit_code"] == expected


# ---------------------------------------------------------------------------
# import
# ---------------------------------------------------------------------------


@pytest.fixture
def recorded(monkeypatch):
    """Replace run_imports and record how the CLI called it."""
    box: dict = {"results": None}

    def fake(boards, options, *, on_event=None, **kw):
        box.update(boards=list(boards), options=options, kw=kw)
        if on_event:
            on_event({"event": "board_started", "board_id": BOARD, "message": "Importing x."})
            on_event({"event": "step", "board_id": BOARD, "message": "Exporting."})
        return box["results"] or [ImportResult("complete", board_id=BOARD, artifact_path="/v/x.canvas", source_json="/v/x.json", websdk_used=True, message="Imported 3 items.")]

    monkeypatch.setattr(import_service, "run_imports", fake)
    return box


def test_import_builds_options_from_flags(recorded, capsys, vault) -> None:
    code, out, _ = run(
        capsys, "import", "--board", BOARD, "--board", "My board", "--vault", str(vault),
        "--format", "native-canvas", "--websdk", "required", "--capture-timeout", "45", "--no-open", "--json",
    )
    assert code == 0
    assert recorded["boards"] == [BOARD, "My board"]
    opts: ImportOptions = recorded["options"]
    assert opts.vault_root == vault
    assert opts.target_dir == vault / "Miro"
    assert opts.output_format == "native-canvas"
    assert opts.websdk == "required" and opts.capture_timeout_seconds == 45
    assert opts.open_board is False and opts.share_attachments is True
    assert opts.view_profile.width == 1920 and opts.view_profile.scale_mode == "balanced"
    assert (opts.theme, opts.text_style_mode, opts.min_font_px, opts.scale) == ("dark", "miro", 8, None)
    assert opts.prefer_experimental is True


def test_import_defaults_match_the_legacy_cli(recorded, capsys, vault) -> None:
    run(capsys, "import", "--board", BOARD, "--vault", str(vault))
    opts = recorded["options"]
    legacy = miro_pipeline.build_parser().parse_args(
        ["--source-json", "x", "--target-dir", "y", "--vault-root", "z"]
    )
    assert opts.output_format == legacy.output_format
    assert opts.view_profile == miro_pipeline.view_profile_from_args(legacy)
    assert (opts.theme, opts.text_style_mode, opts.min_font_px) == (legacy.theme, legacy.text_style_mode, legacy.min_font_px)
    assert opts.websdk == "auto" and opts.open_board is True


def test_import_passes_view_and_attachment_options(recorded, capsys, vault, tmp_path) -> None:
    run(
        capsys, "import", "--board", BOARD, "--vault", str(vault), "--scale", "0.5", "--scale-mode", "readable",
        "--viewport-width", "1000", "--theme", "light", "--text-style-mode", "obsidian", "--min-font-px", "12",
        "--keep-board-attachments", "--install-obsidian-plugins", "--stable-items",
        "--attachment-dir", str(tmp_path / "att"), "--source-dir", str(tmp_path / "src"), "--websdk", "skip",
    )
    opts = recorded["options"]
    assert (opts.scale, opts.view_profile.scale_mode, opts.view_profile.width) == (0.5, "readable", 1000)
    assert (opts.theme, opts.text_style_mode, opts.min_font_px) == ("light", "obsidian", 12)
    assert opts.share_attachments is False and opts.install_obsidian_plugins is True
    assert opts.prefer_experimental is False
    assert opts.attachment_dir == tmp_path / "att" and opts.source_dir == tmp_path / "src"
    assert opts.websdk == "skip"


def test_import_folder_is_relative_to_the_vault_or_absolute_inside_it(recorded, capsys, vault, tmp_path) -> None:
    run(capsys, "import", "--board", BOARD, "--vault", str(vault), "--folder", "Boards/Miro")
    assert recorded["options"].target_dir == vault / "Boards" / "Miro"
    run(capsys, "import", "--board", BOARD, "--vault", str(vault), "--folder", str(vault / "Abs"))
    assert recorded["options"].target_dir == vault / "Abs"
    for bad in (str(tmp_path / "elsewhere"), "../escape"):
        recorded.pop("options", None)
        code, _, err = run(capsys, "import", "--board", BOARD, "--vault", str(vault), "--folder", bad)
        assert code == 1 and "inside the vault" in err
        assert "options" not in recorded


def test_import_websdk_path_is_kept_as_a_path(recorded, capsys, vault, tmp_path) -> None:
    capture = tmp_path / "capture.json"
    run(capsys, "import", "--board", BOARD, "--vault", str(vault), "--websdk", str(capture))
    assert recorded["options"].websdk == capture and recorded["options"].websdk_mode == "file"


def test_import_boards_file_and_validation(recorded, capsys, vault, tmp_path) -> None:
    listing = tmp_path / "boards.txt"
    listing.write_text(
        "# my boards\n\n  Roadmap 2026  \n" + BOARD + "\n   # indented comment\nhttps://miro.com/app/board/uXjVKAAAAAA=/\n",
        encoding="utf-8",
    )
    code, _, _ = run(capsys, "import", "--boards-file", str(listing), "--board", "Extra", "--vault", str(vault))
    assert code == 0
    assert recorded["boards"] == ["Extra", "Roadmap 2026", BOARD, "https://miro.com/app/board/uXjVKAAAAAA=/"]

    code, _, err = run(capsys, "import", "--vault", str(vault))
    assert code == 1 and "--board" in err
    code, _, err = run(capsys, "import", "--board", BOARD, "--vault", str(vault / "missing"))
    assert code == 1 and "does not exist" in err
    code, _, err = run(capsys, "import", "--boards-file", str(tmp_path / "nope.txt"), "--vault", str(vault))
    assert code == 1 and "boards-file" in err


@pytest.mark.parametrize(
    "statuses, expected",
    [
        (["complete"], 0),
        (["complete", "degraded"], 2),
        (["degraded", "needs_user"], 3),
        (["failed", "complete"], 1),
        (["needs_user", "failed"], 1),
    ],
)
def test_import_exit_codes(recorded, capsys, vault, statuses, expected) -> None:
    recorded["results"] = [ImportResult(s, board_id=f"b{i}") for i, s in enumerate(statuses)]
    code, out, _ = run(capsys, "import", "--board", BOARD, "--vault", str(vault), "--json")
    assert code == expected
    assert json_lines(out)[-1]["exit_code"] == expected


def test_import_json_is_json_lines_ending_in_a_summary(recorded, capsys, vault) -> None:
    code, out, _ = run(capsys, "import", "--board", BOARD, "--vault", str(vault), "--json")
    lines = json_lines(out)
    assert [line["event"] for line in lines] == ["board_started", "step", "summary"]
    summary = lines[-1]
    assert summary["exit_code"] == 0
    (result,) = summary["results"]
    assert set(result) == {
        "ref", "board_id", "board_name", "status", "reason", "message", "next_step",
        "artifact_path", "source_json", "websdk_used", "warnings",
    }
    assert result["status"] == "complete" and result["websdk_used"] is True


def test_import_text_output_is_plain_language(recorded, capsys, vault) -> None:
    recorded["results"] = [
        ImportResult(
            "needs_user", board_id=BOARD, board_name="Roadmap", reason="websdk_capture_timeout",
            message="The Miro app did not send a capture.", next_step="Click the app icon.",
        ),
        ImportResult("degraded", board_id="b2", warnings=["REST only"], artifact_path="/v/x.canvas"),
    ]
    code, out, _ = run(capsys, "import", "--board", BOARD, "--vault", str(vault))
    assert code == 3
    assert "[needs_user] Roadmap" in out and "next: Click the app icon." in out
    assert "warning: REST only" in out and "file: /v/x.canvas" in out
    assert "Exporting." in out  # progress steps are shown
    assert not any(line.startswith("{") for line in out.splitlines())


def test_import_end_to_end_with_mocked_miro(capsys, vault, monkeypatch) -> None:
    """The real service behind the real CLI, with the REST pipeline and token mocked."""
    monkeypatch.setattr(miro_auth, "get_access_token", lambda: TOKEN)
    calls = []

    def pipeline(**kwargs):
        calls.append(kwargs)
        kwargs["logger"](f"Exporting with {TOKEN}")
        return PipelineResult(
            source_json=kwargs["source_json"],
            canvas_path=kwargs["target_dir"] / "b.canvas",
            item_count=1,
            asset_stats={},
            scale=1.0,
            scale_context={},
            messages=[],
            completeness={"complete": True},
        )

    monkeypatch.setattr(import_service.application, "run_rest_experimental_pipeline", pipeline)
    code, out, err = run(
        capsys, "import", "--board", f"https://miro.com/app/board/{BOARD}/", "--vault", str(vault),
        "--websdk", "skip", "--format", "native-canvas", "--json",
    )
    assert code == 0, out + err
    assert calls[0]["board_id"] == BOARD and calls[0]["output_format"] == "native-canvas"
    assert TOKEN not in out + err
    assert json_lines(out)[-1]["results"][0]["websdk_used"] is False


def test_import_not_connected_is_needs_user_for_every_board(capsys, vault, monkeypatch) -> None:
    def not_connected():
        raise miro_auth.NotConnected("Miro is not connected.")

    monkeypatch.setattr(miro_auth, "get_access_token", not_connected)
    code, out, _ = run(capsys, "import", "--board", BOARD, "--board", "Other", "--vault", str(vault), "--json")
    assert code == 3
    results = json_lines(out)[-1]["results"]
    assert [r["status"] for r in results] == ["needs_user", "needs_user"]
    assert all("auth login" in r["next_step"] for r in results)


def test_no_command_prints_a_secret(monkeypatch, capsys, vault) -> None:
    """Outputs of every command stay free of the token and credentials in the environment."""
    monkeypatch.setenv("MIRO_ACCESS_TOKEN", TOKEN)
    monkeypatch.setenv("MIRO_CLIENT_ID", CLIENT_ID)
    monkeypatch.setenv("MIRO_CLIENT_SECRET", SECRET)
    monkeypatch.setattr(import_service, "get_boards", MagicMock(return_value=RAW_BOARDS))
    monkeypatch.setattr(import_service, "_probe_port", lambda port: {"port": port, "state": "free"})
    monkeypatch.setattr(import_service.application, "run_rest_experimental_pipeline", MagicMock(side_effect=RuntimeError(f"x {TOKEN}")))
    for argv in (
        ["doctor", "--vault", str(vault)],
        ["auth", "status"],
        ["boards"],
        ["setup", "guide"],
        ["agent-guide"],
        ["import", "--board", BOARD, "--vault", str(vault), "--websdk", "skip"],
    ):
        for extra in ([], ["--json"]):
            code, out, err = run(capsys, *argv, *extra)
            assert TOKEN not in out + err, argv
            assert SECRET not in out + err and CLIENT_ID not in out + err, argv
