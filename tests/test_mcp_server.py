"""MCP server: protocol handling, tools with mocked services, stdout hygiene, secrets."""

from __future__ import annotations

import io
import json
import os
import subprocess
import sys
import threading
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock

import jsonschema
import pytest

from miro2obsidian import browser_setup, cli, import_service, mcp_server, miro_auth
from miro2obsidian.agent_guide import AGENT_GUIDE
from miro2obsidian.credential_store import CredentialStoreUnavailable
from miro2obsidian.import_service import ImportResult

SECRET = "client-secret-VALUE-123"
CLIENT_ID = "client-id-VALUE-456"
TOKEN = "tok-SECRET-0123456789"
REPO = Path(__file__).resolve().parents[1]

EXPECTED_TOOLS = {
    "doctor",
    "setup_guide",
    "app_manifest",
    "auth_status",
    "auth_login_form",
    "auth_logout",
    "boards_list",
    "capture_board",
    "import_boards",
    "agent_guide",
}


class Session:
    """Drives one McpServer through in-memory streams."""

    def __init__(self) -> None:
        self.server = mcp_server.McpServer(version="9.9.9")
        self.lines: list[str] = []
        self._next = 0

    def raw(self, *lines: str) -> list[dict]:
        out = io.StringIO()
        self.server.serve(io.StringIO("\n".join(lines) + "\n"), out)
        self.lines = [line for line in out.getvalue().split("\n") if line]
        return [json.loads(line) for line in self.lines]

    def send(self, *messages: dict) -> list[dict]:
        return self.raw(*(json.dumps(m) for m in messages))

    def request(self, method: str, params: dict | None = None) -> dict:
        self._next += 1
        message: dict = {"jsonrpc": "2.0", "id": self._next, "method": method}
        if params is not None:
            message["params"] = params
        replies = [m for m in self.send(message) if m.get("id") == self._next]
        assert len(replies) == 1
        return replies[0]

    def call(self, name: str, arguments: dict | None = None, **params) -> dict:
        reply = self.request("tools/call", {"name": name, "arguments": arguments or {}, **params})
        assert "error" not in reply, reply
        return reply["result"]


@pytest.fixture(autouse=True)
def isolated(monkeypatch, tmp_path):
    for name in ("MIRO_ACCESS_TOKEN", "MIRO_CLIENT_ID", "MIRO_CLIENT_SECRET"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setattr(import_service, "get_boards", MagicMock(side_effect=AssertionError("network")))
    monkeypatch.setattr("webbrowser.open", MagicMock(return_value=True))


@pytest.fixture
def session() -> Session:
    return Session()


@pytest.fixture
def vault(tmp_path) -> Path:
    path = tmp_path / "vault"
    (path / ".obsidian").mkdir(parents=True)
    return path


# ---------------------------------------------------------------------------
# protocol
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("version", mcp_server.SUPPORTED_PROTOCOL_VERSIONS)
def test_initialize_answers_a_supported_version_with_the_same_version(session, version) -> None:
    reply = session.request("initialize", {"protocolVersion": version, "capabilities": {}, "clientInfo": {}})
    result = reply["result"]
    assert result["protocolVersion"] == version
    assert "tools" in result["capabilities"]
    assert result["serverInfo"] == {"name": "miro2obsidian", "version": "9.9.9"}


def test_initialize_falls_back_to_the_latest_version(session) -> None:
    reply = session.request("initialize", {"protocolVersion": "1999-01-01"})
    assert reply["result"]["protocolVersion"] == "2025-06-18"
    assert mcp_server.SUPPORTED_PROTOCOL_VERSIONS == ("2025-06-18", "2025-03-26", "2024-11-05")


def test_initialize_requires_a_protocol_version(session) -> None:
    assert session.request("initialize", {})["error"]["code"] == -32602


def test_initialized_and_cancelled_notifications_get_no_reply(session) -> None:
    replies = session.send(
        {"jsonrpc": "2.0", "method": "notifications/initialized"},
        {"jsonrpc": "2.0", "method": "notifications/cancelled", "params": {"requestId": 1}},
        {"jsonrpc": "2.0", "method": "notifications/whatever"},
        {"jsonrpc": "2.0", "id": 7, "method": "ping"},
    )
    assert replies == [{"jsonrpc": "2.0", "id": 7, "result": {}}]


def test_unknown_method_is_32601(session) -> None:
    error = session.request("resources/list")["error"]
    assert error["code"] == -32601


def test_parse_error_is_32700_and_the_server_keeps_going(session) -> None:
    replies = session.raw("{not json", json.dumps({"jsonrpc": "2.0", "id": 1, "method": "ping"}))
    assert replies[0] == {"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": "Parse error"}}
    assert replies[1]["result"] == {}


@pytest.mark.parametrize(
    "message",
    [
        "[]",
        "[1]",
        "42",
        '"text"',
        '{"jsonrpc": "1.0", "id": 1, "method": "ping"}',
        '{"jsonrpc": "2.0", "id": 1, "method": 5}',
        '{"jsonrpc": "2.0", "id": 1}',
        '{"jsonrpc": "2.0", "id": true, "method": "ping"}',
    ],
)
def test_invalid_requests_are_32600(session, message) -> None:
    (reply,) = session.raw(message)
    assert reply["error"]["code"] == -32600


def test_non_object_params_are_32602(session) -> None:
    (reply,) = session.raw(json.dumps({"jsonrpc": "2.0", "id": 1, "method": "tools/list", "params": [1]}))
    assert reply["error"]["code"] == -32602


def test_responses_from_the_client_are_ignored(session) -> None:
    assert session.raw(json.dumps({"jsonrpc": "2.0", "id": 5, "result": {}})) == []


def test_set_level_validates(session) -> None:
    assert session.request("logging/setLevel", {"level": "debug"})["result"] == {}
    assert session.request("logging/setLevel", {"level": "loud"})["error"]["code"] == -32602


# ---------------------------------------------------------------------------
# tools/list
# ---------------------------------------------------------------------------


def test_tools_list_has_exactly_the_documented_names(session) -> None:
    tools = session.request("tools/list")["result"]["tools"]
    assert {t["name"] for t in tools} == EXPECTED_TOOLS
    assert len(tools) == len(EXPECTED_TOOLS)


def test_every_input_schema_is_valid_json_schema_and_closed(session) -> None:
    for tool in session.request("tools/list")["result"]["tools"]:
        schema = tool["inputSchema"]
        jsonschema.Draft202012Validator.check_schema(schema)
        assert schema["type"] == "object"
        assert schema["additionalProperties"] is False
        assert len(tool["description"]) > 40


def test_schemas_for_the_documented_parameters(session) -> None:
    tools = {t["name"]: t["inputSchema"] for t in session.request("tools/list")["result"]["tools"]}
    assert set(tools["import_boards"]["properties"]) == {
        "boards", "vault", "folder", "format", "websdk", "capture_timeout_seconds", "open_board",
    }
    assert tools["import_boards"]["required"] == ["boards", "vault"]
    assert tools["import_boards"]["properties"]["format"]["enum"] == [
        "advanced-canvas", "native-canvas", "miro-canvas", "raw-json",
    ]
    assert tools["import_boards"]["properties"]["websdk"]["enum"] == ["auto", "required", "skip"]
    assert set(tools["doctor"]["properties"]) == {"vault", "verify"}
    assert set(tools["capture_board"]["properties"]) == {"board", "timeout_seconds", "open_board"}
    assert tools["capture_board"]["required"] == ["board"]
    assert set(tools["boards_list"]["properties"]) == {"query"}
    assert set(tools["auth_logout"]["properties"]) == {"revoke"}
    assert set(tools["auth_login_form"]["properties"]) == {"open_browser"}
    assert set(tools["auth_status"]["properties"]) == {"verify"}
    for name in ("setup_guide", "app_manifest", "agent_guide"):
        assert tools[name]["properties"] == {}


def test_descriptions_warn_about_untrusted_board_content(session) -> None:
    tools = {t["name"]: t["description"] for t in session.request("tools/list")["result"]["tools"]}
    for name in ("boards_list", "capture_board", "import_boards"):
        assert "untrusted" in tools[name]
    assert "relay" in tools["setup_guide"].lower()


# ---------------------------------------------------------------------------
# argument validation
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("name", "arguments"),
    [
        ("doctor", {"vault": 5}),
        ("doctor", {"verify": "yes"}),
        ("doctor", {"bogus": 1}),
        ("setup_guide", {"anything": True}),
        ("auth_status", {"verify": 1}),
        ("auth_login_form", {"open_browser": "no"}),
        ("auth_logout", {"revoke": None}),
        ("boards_list", {"query": ["a"]}),
        ("capture_board", {}),
        ("capture_board", {"board": ""}),
        ("capture_board", {"board": "x", "timeout_seconds": "30"}),
        ("capture_board", {"board": "x", "timeout_seconds": True}),
        ("capture_board", {"board": "x", "timeout_seconds": 1}),
        ("import_boards", {"vault": "/v"}),
        ("import_boards", {"boards": ["a"]}),
        ("import_boards", {"boards": "a", "vault": "/v"}),
        ("import_boards", {"boards": [], "vault": "/v"}),
        ("import_boards", {"boards": [1], "vault": "/v"}),
        ("import_boards", {"boards": ["a"], "vault": "/v", "format": "pdf"}),
        ("import_boards", {"boards": ["a"], "vault": "/v", "websdk": "/some/file.json"}),
        ("import_boards", {"boards": ["a"], "vault": "/v", "open_board": "true"}),
    ],
)
def test_wrong_arguments_are_32602_and_never_run_a_service(session, monkeypatch, name, arguments) -> None:
    for target in ("doctor", "run_imports", "run_capture", "list_boards"):
        monkeypatch.setattr(import_service, target, MagicMock(side_effect=AssertionError("must not run")))
    reply = session.request("tools/call", {"name": name, "arguments": arguments})
    assert reply["error"]["code"] == -32602


def test_unknown_tool_and_bad_call_params_are_32602(session) -> None:
    assert session.request("tools/call", {"name": "nope"})["error"]["code"] == -32602
    assert session.request("tools/call", {})["error"]["code"] == -32602
    assert session.request("tools/call", {"name": 3})["error"]["code"] == -32602
    assert session.request("tools/call", {"name": "doctor", "arguments": "x"})["error"]["code"] == -32602


def test_missing_arguments_default_to_empty(session) -> None:
    result = session.call("agent_guide")
    assert result["structuredContent"] == {"guide": AGENT_GUIDE}


# ---------------------------------------------------------------------------
# tools
# ---------------------------------------------------------------------------


def test_result_envelope_has_text_structured_content_and_flag(session) -> None:
    result = session.call("app_manifest")
    assert result["isError"] is False
    (block,) = result["content"]
    assert block["type"] == "text"
    assert json.loads(block["text"]) == result["structuredContent"]
    assert "appName:" in result["structuredContent"]["yaml"]


def test_doctor_passes_arguments_through(session, monkeypatch, vault) -> None:
    doctor = MagicMock(return_value={"ready": False, "next_steps": ["Connect Miro."]})
    monkeypatch.setattr(import_service, "doctor", doctor)
    result = session.call("doctor", {"vault": str(vault), "verify": True})
    doctor.assert_called_once_with(vault, verify_online=True)
    assert result["structuredContent"]["next_steps"] == ["Connect Miro."]
    assert result["isError"] is False
    session.call("doctor")
    doctor.assert_called_with(None, verify_online=False)


def test_setup_guide_returns_steps_and_the_relay_note(session) -> None:
    data = session.call("setup_guide")["structuredContent"]
    assert [s["actor"] for s in data["steps"]].count("person") >= 1
    assert "person" in data["note"] and "auth_login_form" in data["note"]


def test_auth_status_connected_and_not_connected(session, monkeypatch) -> None:
    connected = miro_auth.ConnectionStatus(connected=True, source="vault-v2", team_name="Team", message="Connected.")
    monkeypatch.setattr(miro_auth, "connection_status", MagicMock(return_value=connected))
    data = session.call("auth_status", {"verify": True})["structuredContent"]
    miro_auth.connection_status.assert_called_once_with(verify_online=True)
    assert data["connected"] is True and data["status"] == "complete" and data["team_name"] == "Team"

    missing = miro_auth.ConnectionStatus(connected=False, message="Miro is not connected.")
    monkeypatch.setattr(miro_auth, "connection_status", MagicMock(return_value=missing))
    result = session.call("auth_status")
    assert result["isError"] is False
    assert result["structuredContent"]["status"] == "needs_user"
    assert "auth_login_form" in result["structuredContent"]["next_step"]


def test_auth_status_failure_is_an_error_result(session, monkeypatch) -> None:
    monkeypatch.setattr(miro_auth, "connection_status", MagicMock(side_effect=RuntimeError("boom")))
    result = session.call("auth_status")
    assert result["isError"] is True and result["structuredContent"]["status"] == "failed"


def test_auth_logout(session, monkeypatch) -> None:
    disconnect = MagicMock(return_value=True)
    monkeypatch.setattr(miro_auth, "disconnect", disconnect)
    assert session.call("auth_logout")["structuredContent"] == {"disconnected": True, "revoked": True}
    disconnect.assert_called_with(revoke=True)
    session.call("auth_logout", {"revoke": False})
    disconnect.assert_called_with(revoke=False)


def test_auth_logout_without_a_credential_store_needs_the_user(session, monkeypatch) -> None:
    monkeypatch.setattr(miro_auth, "disconnect", MagicMock(side_effect=CredentialStoreUnavailable("none")))
    result = session.call("auth_logout")
    assert result["isError"] is False and result["structuredContent"]["status"] == "needs_user"


BOARDS = [{"id": "uXjVJSz4qHA=", "name": "Roadmap", "team": "T", "viewLink": "https://miro.com/app/board/x/"}]


def test_boards_list(session, monkeypatch) -> None:
    monkeypatch.setattr(miro_auth, "get_access_token", MagicMock(return_value=TOKEN))
    list_boards = MagicMock(return_value=BOARDS)
    monkeypatch.setattr(import_service, "list_boards", list_boards)
    data = session.call("boards_list", {"query": "road"})["structuredContent"]
    list_boards.assert_called_once_with(TOKEN, query="road")
    assert data["boards"] == BOARDS and data["count"] == 1 and "untrusted" in data["note"]
    assert TOKEN not in json.dumps(data)


def test_boards_list_when_not_connected_needs_the_user(session, monkeypatch) -> None:
    monkeypatch.setattr(miro_auth, "get_access_token", MagicMock(side_effect=miro_auth.NotConnected("no")))
    result = session.call("boards_list")
    assert result["isError"] is False
    assert result["structuredContent"]["status"] == "needs_user"
    assert result["structuredContent"]["next_step"]


def test_capture_board(session, monkeypatch) -> None:
    captured = ImportResult("complete", board_id="b1", artifact_path="/caps/b1.json", websdk_used=True)
    run_capture = MagicMock(return_value=captured)
    monkeypatch.setattr(import_service, "run_capture", run_capture)
    result = session.call("capture_board", {"board": "b1", "timeout_seconds": 30, "open_board": False})
    assert run_capture.call_args.args == ("b1",)
    assert run_capture.call_args.kwargs["timeout_seconds"] == 30.0
    assert run_capture.call_args.kwargs["open_board"] is False
    assert result["structuredContent"]["artifact_path"] == "/caps/b1.json"
    assert result["structuredContent"]["exit_code"] == 0 and result["isError"] is False


@pytest.mark.parametrize(
    ("status", "is_error"), [("complete", False), ("degraded", False), ("needs_user", False), ("failed", True)]
)
def test_is_error_only_for_failed(session, monkeypatch, vault, status, is_error) -> None:
    monkeypatch.setattr(
        import_service, "run_imports", MagicMock(return_value=[ImportResult(status, board_id="b1", message="m")])
    )
    result = session.call("import_boards", {"boards": ["b1"], "vault": str(vault)})
    assert result["isError"] is is_error
    assert result["structuredContent"]["results"][0]["status"] == status


def test_import_boards_builds_options_and_summarises(session, monkeypatch, vault) -> None:
    run_imports = MagicMock(
        return_value=[
            ImportResult("complete", board_id="a", artifact_path="/v/Miro/a.canvas"),
            ImportResult("degraded", board_id="b", warnings=["REST only"]),
            ImportResult("needs_user", board_id="c", reason="websdk_capture_timeout", next_step="Click the icon."),
        ]
    )
    monkeypatch.setattr(import_service, "run_imports", run_imports)
    result = session.call(
        "import_boards",
        {
            "boards": ["a", "b", "c"],
            "vault": str(vault),
            "folder": "Boards",
            "format": "native-canvas",
            "websdk": "required",
            "capture_timeout_seconds": 60,
            "open_board": False,
        },
    )
    refs, options = run_imports.call_args.args
    assert refs == ["a", "b", "c"]
    assert options.vault_root == vault and options.target_dir == vault / "Boards"
    assert options.output_format == "native-canvas" and options.websdk == "required"
    assert options.capture_timeout_seconds == 60.0 and options.open_board is False
    data = result["structuredContent"]
    assert [r["status"] for r in data["results"]] == ["complete", "degraded", "needs_user"]
    assert data["summary"] == {
        "exit_code": 3,
        "counts": {"complete": 1, "degraded": 1, "needs_user": 1, "failed": 0},
    }
    assert result["isError"] is False


def test_import_boards_defaults_match_the_command_line(session, monkeypatch, vault) -> None:
    run_imports = MagicMock(return_value=[ImportResult("complete", board_id="a")])
    monkeypatch.setattr(import_service, "run_imports", run_imports)
    session.call("import_boards", {"boards": ["a"], "vault": str(vault)})
    options = run_imports.call_args.args[1]
    assert options.target_dir == vault / "Miro"
    assert options.output_format == "advanced-canvas" and options.websdk == "auto" and options.open_board is True


def test_import_boards_rejects_a_missing_vault_and_a_folder_outside_it(session, monkeypatch, tmp_path, vault) -> None:
    monkeypatch.setattr(import_service, "run_imports", MagicMock(side_effect=AssertionError("must not run")))
    missing = session.call("import_boards", {"boards": ["a"], "vault": str(tmp_path / "nope")})
    assert missing["isError"] is True and missing["structuredContent"]["reason"] == "vault_not_found"
    outside = session.call(
        "import_boards", {"boards": ["a"], "vault": str(vault), "folder": str(tmp_path / "elsewhere")}
    )
    assert outside["isError"] is True and "inside the vault" in outside["structuredContent"]["message"]


def test_import_boards_not_connected_is_needs_user(session, monkeypatch, vault) -> None:
    def provider():
        raise miro_auth.NotConnected("no connection")

    real = import_service.run_imports
    monkeypatch.setattr(
        import_service,
        "run_imports",
        lambda refs, options, **kw: real(refs, options, token_provider=provider, **kw),
    )
    result = session.call("import_boards", {"boards": ["uXjVJSz4qHA="], "vault": str(vault)})
    assert result["isError"] is False
    assert result["structuredContent"]["results"][0]["status"] == "needs_user"
    assert result["structuredContent"]["summary"]["exit_code"] == 3


def test_progress_and_log_notifications_for_import_boards(session, monkeypatch, vault) -> None:
    def fake(refs, options, *, on_event=None, **_):
        on_event({"event": "board_started", "board_id": "a", "message": "Importing Roadmap."})
        on_event({"event": "step", "board_id": "a", "message": "Opened the board in the browser."})
        on_event({"event": "needs_user", "board_id": "a", "message": "Click the icon.", "next_step": "Then rerun."})
        on_event({"event": "board_finished", "board_id": "a", "status": "complete",
                  "result": {"board_name": "Roadmap", "message": "done"}})
        on_event({"event": "batch_finished", "message": "Finished 1 board(s)."})
        return [ImportResult("complete", board_id="a")]

    monkeypatch.setattr(import_service, "run_imports", fake)
    session.send(
        {"jsonrpc": "2.0", "id": 1, "method": "tools/call",
         "params": {"name": "import_boards", "arguments": {"boards": ["a"], "vault": str(vault)},
                    "_meta": {"progressToken": "tok-1"}}}
    )
    messages = [json.loads(line) for line in session.lines]
    progress = [m for m in messages if m.get("method") == "notifications/progress"]
    logs = [m for m in messages if m.get("method") == "notifications/message"]
    assert [p["params"]["progressToken"] for p in progress] == ["tok-1"] * 5
    values = [p["params"]["progress"] for p in progress]
    assert values == sorted(set(values)) and values[0] == 1
    assert "Importing Roadmap." in progress[0]["params"]["message"]
    assert len(logs) == 5
    assert {m["params"]["level"] for m in logs} == {"info", "warning"}
    assert messages[-1]["id"] == 1 and "result" in messages[-1]  # the response comes last


def test_no_progress_without_a_token_but_logs_still_flow(session, monkeypatch, vault) -> None:
    def fake(refs, options, *, on_event=None, **_):
        on_event({"event": "step", "message": "Working."})
        return [ImportResult("complete", board_id="a")]

    monkeypatch.setattr(import_service, "run_imports", fake)
    session.call("import_boards", {"boards": ["a"], "vault": str(vault)})
    methods = [json.loads(line).get("method") for line in session.lines]
    assert "notifications/progress" not in methods and "notifications/message" in methods


def test_integer_progress_tokens_work_and_log_level_filters(session, monkeypatch, vault) -> None:
    def fake(refs, options, *, on_event=None, **_):
        on_event({"event": "step", "message": "Working."})
        return [ImportResult("complete", board_id="a")]

    monkeypatch.setattr(import_service, "run_imports", fake)
    session.request("logging/setLevel", {"level": "error"})
    session.send(
        {"jsonrpc": "2.0", "id": 9, "method": "tools/call",
         "params": {"name": "import_boards", "arguments": {"boards": ["a"], "vault": str(vault)},
                    "_meta": {"progressToken": 77}}}
    )
    messages = [json.loads(line) for line in session.lines]
    assert [m["params"]["progressToken"] for m in messages if m.get("method") == "notifications/progress"] == [77]
    assert not [m for m in messages if m.get("method") == "notifications/message"]


def test_agent_guide_tool(session) -> None:
    assert session.call("agent_guide")["structuredContent"]["guide"] == AGENT_GUIDE
    assert "miro2obsidian mcp" in AGENT_GUIDE


# ---------------------------------------------------------------------------
# the login form
# ---------------------------------------------------------------------------


def test_auth_login_form_returns_the_url_and_is_single_instance(session, monkeypatch) -> None:
    release = threading.Event()
    calls: list[dict] = []

    def fake_form(*, open_browser, timeout_seconds, report, **_):
        calls.append({"open_browser": open_browser, "timeout": timeout_seconds})
        report("http://127.0.0.1:54321/")
        release.wait(10)
        return SimpleNamespace(status="complete", error="")

    monkeypatch.setattr(browser_setup, "run_form", fake_form)
    try:
        first = session.call("auth_login_form", {"open_browser": False})["structuredContent"]
        assert first["url"] == "http://127.0.0.1:54321/"
        assert first["already_running"] is False
        assert "paste their Client ID and Client secret" in first["instructions"]
        assert first["instructions"].endswith("Then call auth_status.")

        second = session.call("auth_login_form")["structuredContent"]
        assert second["url"] == first["url"] and second["already_running"] is True
        assert len(calls) == 1 and calls[0]["open_browser"] is False

        monkeypatch.setattr(
            miro_auth, "connection_status", MagicMock(return_value=miro_auth.ConnectionStatus(connected=False))
        )
        assert session.call("auth_status")["structuredContent"]["login_form"] == "running"
    finally:
        release.set()
    session.server._form._thread.join(5)
    assert session.server.login_form_state() == "connected"

    again = session.call("auth_login_form")["structuredContent"]  # a finished form can be restarted
    assert again["already_running"] is False and len(calls) == 2
    session.server._form._thread.join(5)


def test_auth_login_form_reports_a_form_that_cannot_start(session, monkeypatch) -> None:
    monkeypatch.setattr(browser_setup, "run_form", MagicMock(side_effect=OSError("address in use")))
    result = session.call("auth_login_form")
    assert result["isError"] is True and result["structuredContent"]["status"] == "failed"
    assert "OSError" in result["structuredContent"]["message"]
    assert "address in use" not in json.dumps(result)


# ---------------------------------------------------------------------------
# secrets and stdout hygiene
# ---------------------------------------------------------------------------


def test_no_secret_reaches_any_output(session, monkeypatch, vault) -> None:
    monkeypatch.setenv("MIRO_CLIENT_SECRET", SECRET)
    monkeypatch.setenv("MIRO_CLIENT_ID", CLIENT_ID)
    monkeypatch.setattr(miro_auth, "get_access_token", MagicMock(return_value=TOKEN))
    monkeypatch.setattr(
        import_service, "list_boards", MagicMock(side_effect=RuntimeError(f"401 for Bearer {TOKEN} {SECRET}"))
    )
    monkeypatch.setattr(import_service, "doctor", MagicMock(side_effect=RuntimeError(f"{CLIENT_ID} leaked")))

    def leaky(refs, options, *, on_event=None, **_):
        on_event({"event": "step", "message": f"using Bearer {TOKEN} and {SECRET}"})
        return [ImportResult("degraded", board_id="a", message=f"token {SECRET}", warnings=[f"id {CLIENT_ID}"])]

    monkeypatch.setattr(import_service, "run_imports", leaky)
    session.call("boards_list")
    session.call("doctor")
    session.send(
        {"jsonrpc": "2.0", "id": 1, "method": "tools/call",
         "params": {"name": "import_boards", "arguments": {"boards": ["a"], "vault": str(vault)},
                    "_meta": {"progressToken": 1}}}
    )
    everything = "\n".join(session.lines)
    assert "Bearer ***" in everything or "***" in everything
    for secret in (SECRET, CLIENT_ID, TOKEN):
        assert secret not in everything


def test_unexpected_exceptions_become_error_results_without_secrets(session, monkeypatch) -> None:
    monkeypatch.setenv("MIRO_CLIENT_SECRET", SECRET)
    monkeypatch.setattr(import_service, "doctor", MagicMock(side_effect=RuntimeError(f"bad {SECRET}")))
    result = session.call("doctor")
    assert result["isError"] is True and SECRET not in json.dumps(result)


def test_stdout_carries_only_json_rpc_lines_even_if_a_service_prints(session, monkeypatch, capsys, vault) -> None:
    def noisy(refs, options, *, on_event=None, **_):
        print("stray text on stdout")
        return [ImportResult("complete", board_id="a")]

    monkeypatch.setattr(import_service, "run_imports", noisy)
    out = io.StringIO()
    server = mcp_server.McpServer()
    request = {"jsonrpc": "2.0", "id": 1, "method": "tools/call",
               "params": {"name": "import_boards", "arguments": {"boards": ["a"], "vault": str(vault)}}}
    monkeypatch.setattr(sys, "stdin", io.StringIO(json.dumps(request) + "\n"))
    # serve_stdio redirects sys.stdout to stderr while serving and writes the protocol to the real stream.
    real_stdout = io.StringIO()
    monkeypatch.setattr(sys, "stdout", real_stdout)
    assert mcp_server.serve_stdio() == 0
    del out, server
    lines = [line for line in real_stdout.getvalue().split("\n") if line]
    assert len(lines) == 1 and json.loads(lines[0])["id"] == 1
    assert "stray text" not in real_stdout.getvalue()


def test_every_line_is_a_single_json_object(session, monkeypatch) -> None:
    session.send(
        {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-06-18"}},
        {"jsonrpc": "2.0", "method": "notifications/initialized"},
        {"jsonrpc": "2.0", "id": 2, "method": "tools/list"},
        {"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {"name": "setup_guide"}},
    )
    assert len(session.lines) == 3
    for line in session.lines:
        assert "\n" not in line and json.loads(line)["jsonrpc"] == "2.0"
        assert line.isascii()


# ---------------------------------------------------------------------------
# CLI integration and --print-config
# ---------------------------------------------------------------------------


def test_mcp_is_a_cli_subcommand(monkeypatch) -> None:
    assert "mcp" in cli.SUBCOMMANDS
    served = MagicMock(return_value=0)
    monkeypatch.setattr(mcp_server, "serve_stdio", served)
    assert cli.main(["mcp"]) == 0
    served.assert_called_once_with()


def test_print_config_generic_is_mcp_servers_json(capsys) -> None:
    assert cli.main(["mcp", "--print-config"]) == 0
    entry = json.loads(capsys.readouterr().out)["mcpServers"]["miro2obsidian"]
    assert os.path.isabs(entry["command"]) and entry["args"][-1] == "mcp"
    assert entry["args"][:2] == ["-m", "scripts.miro_pipeline"] or entry["command"].endswith("miro2obsidian")


def test_print_config_claude_desktop_matches_generic(capsys) -> None:
    cli.main(["mcp", "--print-config", "--client", "generic"])
    generic = capsys.readouterr().out
    cli.main(["mcp", "--print-config", "--client", "claude-desktop"])
    assert capsys.readouterr().out == generic


def test_print_config_claude_code_command(capsys) -> None:
    cli.main(["mcp", "--print-config", "--client", "claude-code"])
    text = capsys.readouterr().out.strip()
    assert text.startswith("claude mcp add miro2obsidian ")
    assert " -- " in text and text.endswith(" mcp")


def test_print_config_codex_block(capsys) -> None:
    cli.main(["mcp", "--print-config", "--client", "codex"])
    text = capsys.readouterr().out
    assert text.startswith("[mcp_servers.miro2obsidian]\n")
    assert f"command = {json.dumps(mcp_server.launch_command()[0][0])}" in text
    assert '"mcp"]' in text


def test_print_config_for_an_installed_console_script(monkeypatch, tmp_path, capsys) -> None:
    exe = tmp_path / "miro2obsidian"
    exe.write_text("#!/bin/sh\n")
    monkeypatch.setattr(sys, "argv", [str(exe), "mcp", "--print-config"])
    cli.main(["mcp", "--print-config"])
    entry = json.loads(capsys.readouterr().out)["mcpServers"]["miro2obsidian"]
    assert entry == {"command": str(exe.resolve()), "args": ["mcp"]}


def test_print_config_rejects_unknown_clients(capsys) -> None:
    assert cli.main(["mcp", "--print-config", "--client", "vim"]) == 1


def test_release_self_test_imports_the_server() -> None:
    assert "mcp_server" in (REPO / "release" / "release_self_test.py").read_text(encoding="utf-8")


# ---------------------------------------------------------------------------
# end to end
# ---------------------------------------------------------------------------


def test_subprocess_initialize_and_tools_list() -> None:
    env = {**os.environ, "PYTHONPATH": str(REPO), "PYTHONIOENCODING": "utf-8"}
    for name in ("MIRO_ACCESS_TOKEN", "MIRO_CLIENT_ID", "MIRO_CLIENT_SECRET"):
        env.pop(name, None)
    requests = [
        {"jsonrpc": "2.0", "id": 1, "method": "initialize",
         "params": {"protocolVersion": "2025-06-18", "capabilities": {},
                    "clientInfo": {"name": "pytest", "version": "0"}}},
        {"jsonrpc": "2.0", "method": "notifications/initialized"},
        {"jsonrpc": "2.0", "id": 2, "method": "tools/list"},
        {"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {"name": "app_manifest"}},
    ]
    completed = subprocess.run(
        [sys.executable, "-m", "scripts.miro_pipeline", "mcp"],
        input="\n".join(json.dumps(r) for r in requests) + "\n",
        capture_output=True,
        text=True,
        cwd=REPO,
        env=env,
        timeout=120,
    )
    assert completed.returncode == 0, completed.stderr
    lines = [line for line in completed.stdout.splitlines() if line.strip()]
    replies = {m["id"]: m for m in map(json.loads, lines)}  # every stdout line is JSON
    assert len(lines) == 3
    assert replies[1]["result"]["protocolVersion"] == "2025-06-18"
    assert replies[1]["result"]["serverInfo"]["name"] == "miro2obsidian"
    assert {t["name"] for t in replies[2]["result"]["tools"]} == EXPECTED_TOOLS
    assert "appName" in replies[3]["result"]["structuredContent"]["yaml"]
