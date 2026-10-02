"""Import orchestration: board resolution, capture/REST sequencing, statuses, events, doctor.

Nothing here contacts Miro: the REST pipeline, board listing, token provider
and capture server are all replaced.
"""

from __future__ import annotations

import json
import socket
import threading
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest
import requests

from Json_2_Canvas.output_formats import ADVANCED_CANVAS
from miro2obsidian import import_service, miro_auth
from miro2obsidian.application import PipelineResult
from miro2obsidian.credential_store import CredentialStoreUnavailable
from miro2obsidian.import_service import (
    BoardResolutionError,
    ImportOptions,
    ImportResult,
    ResolvedBoard,
    batch_exit_code,
    doctor,
    exit_code_for_status,
    parse_board_ref,
    resolve_boards,
    run_capture,
    run_imports,
)
from miro2obsidian.websdk_capture import (
    CaptureRejected,
    CaptureServer,
    CaptureServerUnavailable,
    CaptureTimeout,
)

TOKEN = "tok-SECRET-0123456789"
ID_A = "uXjVJSz4qHA="
ID_B = "uXjVKAAAAAA="
ID_C = "uXjVKCCCCCC="

BOARDS = [
    {"id": ID_A, "name": "Roadmap 2026", "team": {"id": "t1", "name": "Product"}, "viewLink": "https://miro.com/app/board/uXjVJSz4qHA=/"},
    {"id": ID_B, "name": "Retro", "team": {"id": "t1", "name": "Product"}},
    {"id": ID_C, "name": "roadmap archive", "team": {"id": "t2", "name": "Ops"}},
]


@pytest.fixture(autouse=True)
def no_network(monkeypatch):
    """Anything that would reach Miro fails the test instead."""
    boom = MagicMock(side_effect=AssertionError("network used in a test"))
    monkeypatch.setattr(import_service, "get_boards", boom)
    monkeypatch.setattr(import_service, "fetch_board_name", lambda token, board_id, **kw: None)
    monkeypatch.setattr(requests, "get", boom)
    return boom


@pytest.fixture
def vault(tmp_path) -> Path:
    path = tmp_path / "vault"
    (path / ".obsidian").mkdir(parents=True)
    return path


def options(vault: Path, **kwargs) -> ImportOptions:
    kwargs.setdefault("open_board", False)
    return ImportOptions(vault_root=vault, **kwargs)


# ---------------------------------------------------------------------------
# Board resolution
# ---------------------------------------------------------------------------


def test_ids_and_urls_resolve_without_listing_boards(no_network) -> None:
    refs = [
        ID_A,
        f"https://miro.com/app/board/{ID_B}/",
        f"https://miro.com/app/board/{ID_C}/?moveToWidget=3458764&cot=14",
        "  https://miro.com/app/board/uXjVJSz4qHA%3D/  ",
    ]
    resolved = resolve_boards(refs, token=TOKEN)
    assert [b.board_id for b in resolved] == [ID_A, ID_B, ID_C, ID_A]
    assert all(b.name is None for b in resolved)
    no_network.assert_not_called()


def test_url_that_is_not_a_miro_board_is_rejected() -> None:
    for ref in ("https://example.com/app/board/uXjVJSz4qHA=/", "https://miro.com/app/dashboard/"):
        with pytest.raises(BoardResolutionError) as caught:
            resolve_boards([ref], token=TOKEN)
        assert caught.value.reason == "board_not_found"


def test_name_matching_exact_is_case_insensitive(monkeypatch) -> None:
    get = MagicMock(return_value=BOARDS)
    monkeypatch.setattr(import_service, "get_boards", get)
    (board,) = resolve_boards(["rEtRo"], token=TOKEN)
    assert (board.board_id, board.name, board.team) == (ID_B, "Retro", "Product")
    get.assert_called_once_with(TOKEN)


def test_exact_name_beats_substring_matches(monkeypatch) -> None:
    monkeypatch.setattr(import_service, "get_boards", MagicMock(return_value=BOARDS))
    (board,) = resolve_boards(["ROADMAP ARCHIVE"], token=TOKEN)
    assert board.board_id == ID_C


def test_unique_substring_matches(monkeypatch) -> None:
    monkeypatch.setattr(import_service, "get_boards", MagicMock(return_value=BOARDS))
    (board,) = resolve_boards(["2026"], token=TOKEN)
    assert board.board_id == ID_A
    assert board.view_link and board.view_link.endswith("/")


def test_ambiguous_name_lists_candidates(monkeypatch) -> None:
    monkeypatch.setattr(import_service, "get_boards", MagicMock(return_value=BOARDS))
    with pytest.raises(BoardResolutionError) as caught:
        resolve_boards(["roadmap"], token=TOKEN)
    error = caught.value
    assert error.reason == "board_ambiguous"
    assert {c["id"] for c in error.candidates} == {ID_A, ID_C}
    assert "Roadmap 2026" in str(error) and ID_C in str(error)


def test_missing_name_lists_up_to_ten_candidates(monkeypatch) -> None:
    many = [{"id": f"id{i:03d}xxxxx=", "name": f"Board {i}"} for i in range(25)]
    monkeypatch.setattr(import_service, "get_boards", MagicMock(return_value=many))
    with pytest.raises(BoardResolutionError) as caught:
        resolve_boards(["zzz nothing"], token=TOKEN)
    assert caught.value.reason == "board_not_found"
    assert 0 < len(caught.value.candidates) <= 10
    assert "zzz nothing" in str(caught.value)
    ambiguous = resolve_boards  # 25 matches for "Board" is ambiguous and capped as well
    with pytest.raises(BoardResolutionError) as caught:
        ambiguous(["board"], token=TOKEN)
    assert len(caught.value.candidates) == 10


def test_missing_name_when_app_sees_no_boards(monkeypatch) -> None:
    monkeypatch.setattr(import_service, "get_boards", MagicMock(return_value=[]))
    with pytest.raises(BoardResolutionError, match="no boards"):
        resolve_boards(["anything"], token=TOKEN)


def test_boards_are_listed_once_and_only_for_names(monkeypatch) -> None:
    get = MagicMock(return_value=BOARDS)
    monkeypatch.setattr(import_service, "get_boards", get)
    resolved = resolve_boards([ID_B, "Retro", "2026", ID_C], token=TOKEN)
    assert [b.board_id for b in resolved] == [ID_B, ID_B, ID_A, ID_C]
    assert resolved[0].name == "Retro"  # enriched from the listing that was needed anyway
    get.assert_called_once()


def test_supplied_boards_are_used_instead_of_calling_miro(no_network) -> None:
    resolved = resolve_boards(["retro"], token=TOKEN, boards=BOARDS)
    assert resolved[0].board_id == ID_B
    no_network.assert_not_called()


def test_name_equal_to_a_board_id_in_the_listing_resolves_by_id() -> None:
    plain = [{"id": "abc", "name": "Other"}]
    (board,) = resolve_boards(["abc"], token=TOKEN, boards=plain)
    assert board.board_id == "abc"


def test_empty_reference_is_rejected() -> None:
    with pytest.raises(BoardResolutionError):
        resolve_boards(["  "], token=TOKEN)


def test_parse_board_ref_heuristics() -> None:
    assert parse_board_ref(ID_A) == ID_A
    assert parse_board_ref("3458764512345678901") == "3458764512345678901"
    assert parse_board_ref("Roadmap 2026") is None
    assert parse_board_ref("Retro") is None
    assert parse_board_ref("") is None


# ---------------------------------------------------------------------------
# Options
# ---------------------------------------------------------------------------


def test_option_defaults_follow_the_cli(vault) -> None:
    opts = ImportOptions(vault_root=vault)
    assert opts.target_dir == vault / "Miro"
    assert opts.source_dir == vault / "_miro_sources"
    assert opts.output_format == ADVANCED_CANVAS
    assert opts.websdk == "auto" and opts.websdk_mode == "auto"
    assert opts.capture_timeout_seconds == 180
    assert opts.open_board is True and opts.share_attachments is True
    assert opts.install_obsidian_plugins is False and opts.attachment_dir is None
    assert (opts.theme, opts.text_style_mode, opts.min_font_px) == ("dark", "miro", 8)


def test_option_validation(vault, tmp_path) -> None:
    with pytest.raises(ValueError, match="inside the vault"):
        ImportOptions(vault_root=vault, target_dir=tmp_path / "elsewhere")
    with pytest.raises(ValueError, match="inside the vault"):
        ImportOptions(vault_root=vault, target_dir=vault / ".." / "elsewhere")
    with pytest.raises(ValueError):
        ImportOptions(vault_root=vault, output_format="docx")
    with pytest.raises(ValueError):
        ImportOptions(vault_root=vault, websdk="  ")
    with pytest.raises(ValueError):
        ImportOptions(vault_root=vault, capture_timeout_seconds=0)
    assert ImportOptions(vault_root=vault, target_dir=Path("Sub/Dir")).target_dir == vault / "Sub" / "Dir"
    assert ImportOptions(vault_root=vault, websdk="SKIP").websdk == "skip"
    file_opts = ImportOptions(vault_root=vault, websdk="capture.json")
    assert file_opts.websdk == Path("capture.json") and file_opts.websdk_mode == "file"


def test_result_dict_is_json_safe_and_complete() -> None:
    result = ImportResult("degraded", board_id=ID_A, reason="websdk_unavailable", warnings=["w"], artifact_path="/v/x.canvas")
    data = result.to_dict()
    assert json.loads(json.dumps(data)) == data
    assert set(data) == {
        "ref", "board_id", "board_name", "status", "reason", "message", "next_step",
        "artifact_path", "source_json", "websdk_used", "warnings",
    }
    with pytest.raises(ValueError):
        ImportResult("great")


def test_exit_codes() -> None:
    assert [exit_code_for_status(s) for s in ("complete", "degraded", "needs_user", "failed")] == [0, 2, 3, 1]
    make = lambda *statuses: [ImportResult(s) for s in statuses]  # noqa: E731
    assert batch_exit_code(make("complete", "complete")) == 0
    assert batch_exit_code(make("complete", "degraded")) == 2
    assert batch_exit_code(make("degraded", "needs_user")) == 3
    assert batch_exit_code(make("needs_user", "failed", "complete")) == 1
    assert batch_exit_code([]) == 1


# ---------------------------------------------------------------------------
# Running imports
# ---------------------------------------------------------------------------


class FakeRequest:
    def __init__(self, server: "FakeServer", board_id: str) -> None:
        self.server, self.board_id, self.cancelled = server, board_id, False

    def wait(self, *, timeout_seconds, on_status=None):
        self.server.calls.append(("wait", self.board_id, timeout_seconds))
        if on_status:
            on_status("Still waiting for the Miro app to send the capture (30 s elapsed)...")
        outcome = self.server.outcomes.get(self.board_id, self.server.default_outcome)
        if isinstance(outcome, BaseException):
            raise outcome
        return outcome

    def cancel(self) -> None:
        self.cancelled = True
        self.server.cancelled.append(self.board_id)


class FakeServer:
    """Stands in for CaptureServer: records the order of calls."""

    def __init__(self, tmp_path: Path, *, latest=None, outcomes=None, default_outcome=None, request_error=None):
        self.latest = latest or {}
        self.outcomes = outcomes or {}
        self.default_outcome = default_outcome or (lambda: None)
        self.request_error = request_error
        self.calls: list[tuple] = []
        self.cancelled: list[str] = []
        self.tmp_path = tmp_path
        self.entered = self.closed = False

    def __enter__(self):
        self.entered = True
        return self

    def __exit__(self, *exc) -> None:
        self.closed = True

    def make_capture(self, board_id: str) -> Path:
        path = self.tmp_path / f"capture-{board_id.strip('=')}.json"
        path.write_text("{}", encoding="utf-8")
        return path

    def latest_capture(self, board_id, *, max_age_hours=24.0):
        self.calls.append(("latest", board_id, max_age_hours))
        return self.latest.get(board_id)

    def request_capture(self, board_id):
        self.calls.append(("request", board_id))
        if self.request_error:
            raise self.request_error
        if board_id not in self.outcomes and callable(self.default_outcome):
            self.outcomes[board_id] = self.make_capture(board_id)
        return FakeRequest(self, board_id)


class PipelineRecorder:
    def __init__(self, vault: Path, *, fail: dict | None = None, completeness=None, calls: list | None = None):
        self.vault = vault
        self.fail = fail or {}
        self.completeness = completeness or {"complete": True}
        self.calls = calls if calls is not None else []

    def __call__(self, **kwargs):
        self.calls.append(kwargs)
        problem = self.fail.get(kwargs["board_id"])
        if problem is not None:
            if kwargs.get("logger"):
                kwargs["logger"](f"about to fail using {kwargs['token']}")
            raise problem
        if kwargs.get("logger"):
            kwargs["logger"]("Exporting the complete board through REST v2-experimental.")
        stem = kwargs["source_json"].stem
        return PipelineResult(
            source_json=kwargs["source_json"],
            canvas_path=kwargs["target_dir"] / f"{stem}.canvas",
            item_count=3,
            asset_stats={},
            scale=1.0,
            scale_context={},
            messages=[],
            completeness=self.completeness,
        )


@pytest.fixture
def pipeline(vault, monkeypatch):
    recorder = PipelineRecorder(vault)
    monkeypatch.setattr(import_service.application, "run_rest_experimental_pipeline", recorder)
    return recorder


def run(boards, opts, server=None, *, token=TOKEN, events=None, opener=None, factory=None):
    return run_imports(
        boards,
        opts,
        on_event=events.append if events is not None else None,
        token_provider=lambda: token,
        capture_server_factory=factory or (lambda: server),
        opener=opener,
    )


def named(board_id: str, name: str | None = None) -> ResolvedBoard:
    return ResolvedBoard(board_id, name)


def test_websdk_file_is_used_without_a_capture_server(vault, pipeline, tmp_path) -> None:
    capture = tmp_path / "saved.json"
    capture.write_text("{}", encoding="utf-8")
    factory = MagicMock()
    (result,) = run([named(ID_A, "Roadmap")], options(vault, websdk=capture), factory=factory)
    factory.assert_not_called()
    assert pipeline.calls[0]["websdk_json"] == capture
    assert (result.status, result.websdk_used, result.reason) == ("complete", True, None)


def test_missing_websdk_file_fails_that_board(vault, pipeline, tmp_path) -> None:
    (result,) = run([named(ID_A)], options(vault, websdk=tmp_path / "nope.json"))
    assert (result.status, result.reason) == ("failed", "websdk_unavailable")
    assert pipeline.calls == []


def test_websdk_file_with_several_boards_is_refused(vault, pipeline, tmp_path) -> None:
    with pytest.raises(ValueError, match="single board"):
        run([named(ID_A), named(ID_B)], options(vault, websdk=tmp_path / "x.json"))


def test_fresh_latest_capture_is_used_and_nothing_is_opened(vault, pipeline, tmp_path) -> None:
    server = FakeServer(tmp_path)
    existing = server.make_capture("existing")
    server.latest[ID_A] = existing
    opener = MagicMock()
    (result,) = run([named(ID_A, "Roadmap")], options(vault, open_board=True), server, opener=opener)
    assert pipeline.calls[0]["websdk_json"] == existing
    assert [c[0] for c in server.calls] == ["latest"]
    # younger than the 60 minute REST/Web SDK skew limit, with slack
    assert 0 < server.calls[0][2] <= 0.5
    opener.assert_not_called()
    assert (result.status, result.websdk_used) == ("complete", True)


def test_capture_is_requested_then_rest_runs_right_after(vault, pipeline, tmp_path) -> None:
    server = FakeServer(tmp_path)
    opened: list[str] = []
    order: list[str] = []
    real_call = pipeline.__call__

    def tracing(**kwargs):
        order.append("rest")
        return real_call(**kwargs)

    with patch.object(import_service.application, "run_rest_experimental_pipeline", tracing):
        orig_wait = FakeRequest.wait

        def wait(self, **kw):
            order.append("capture")
            return orig_wait(self, **kw)

        with patch.object(FakeRequest, "wait", wait):
            (result,) = run(
                [named(ID_A, "Roadmap")],
                options(vault, open_board=True, capture_timeout_seconds=42),
                server,
                opener=lambda url: opened.append(url) or True,
            )
    assert order == ["capture", "rest"]
    assert opened == [f"https://miro.com/app/board/{ID_A}/"]
    assert ("request", ID_A) in server.calls and ("wait", ID_A, 42.0) in server.calls
    assert server.cancelled == [ID_A]
    assert pipeline.calls[0]["websdk_json"] == server.outcomes[ID_A]
    assert result.status == "complete" and result.websdk_used is True
    assert server.entered and server.closed


def test_open_board_false_announces_the_url_instead(vault, pipeline, tmp_path) -> None:
    server = FakeServer(tmp_path)
    opener = MagicMock()
    events: list[dict] = []
    run([named(ID_A)], options(vault, open_board=False), server, opener=opener, events=events)
    opener.assert_not_called()
    assert any(
        e["event"] == "step" and f"https://miro.com/app/board/{ID_A}/" in e["message"] for e in events
    )


def test_unopenable_browser_still_waits(vault, pipeline, tmp_path) -> None:
    server = FakeServer(tmp_path)
    events: list[dict] = []
    (result,) = run(
        [named(ID_A)], options(vault, open_board=True), server,
        opener=MagicMock(side_effect=RuntimeError("no browser")), events=events,
    )
    assert result.status == "complete"
    assert any("Could not open a browser" in e.get("message", "") for e in events)


def test_capture_timeout_in_auto_mode_degrades_to_rest_only(vault, pipeline, tmp_path) -> None:
    server = FakeServer(tmp_path, outcomes={ID_A: CaptureTimeout("No capture arrived within 180 s.")})
    (result,) = run([named(ID_A, "Roadmap")], options(vault), server)
    assert pipeline.calls[0]["websdk_json"] is None
    assert (result.status, result.reason, result.websdk_used) == ("degraded", "websdk_unavailable", False)
    assert result.artifact_path and result.source_json
    assert result.warnings and "REST export only" in result.warnings[0]
    assert "websdk required" in result.next_step.replace("--", "")
    assert server.cancelled == [ID_A]


def test_capture_timeout_in_required_mode_needs_the_user(vault, pipeline, tmp_path) -> None:
    server = FakeServer(tmp_path, outcomes={ID_A: CaptureTimeout("slow")})
    events: list[dict] = []
    (result,) = run([named(ID_A, "Roadmap")], options(vault, websdk="required"), server, events=events)
    assert pipeline.calls == []
    assert (result.status, result.reason) == ("needs_user", "websdk_capture_timeout")
    assert "icon" in result.next_step and "team" in result.next_step
    assert result.artifact_path is None
    assert [e for e in events if e["event"] == "needs_user"][0]["reason"] == "websdk_capture_timeout"


def test_rejected_capture_degrades_in_auto_and_fails_in_required(vault, pipeline, tmp_path) -> None:
    rejected = {ID_A: CaptureRejected("The exporter sent a capture that failed validation: stale")}
    (auto,) = run([named(ID_A)], options(vault), FakeServer(tmp_path, outcomes=dict(rejected)))
    assert (auto.status, auto.reason) == ("degraded", "websdk_unavailable")
    (req,) = run([named(ID_A)], options(vault, websdk="required"), FakeServer(tmp_path, outcomes=dict(rejected)))
    assert (req.status, req.reason) == ("failed", "websdk_unavailable")


def test_capture_server_that_cannot_start(vault, pipeline) -> None:
    def factory():
        raise CaptureServerUnavailable("Port 8766 is already in use by another program.")

    (auto,) = run([named(ID_A)], options(vault), factory=factory)
    assert (auto.status, auto.reason) == ("degraded", "websdk_unavailable")
    assert "Port 8766" in auto.warnings[0]
    (req,) = run([named(ID_A)], options(vault, websdk="required"), factory=factory)
    assert (req.status, req.reason) == ("failed", "websdk_unavailable")
    assert "doctor" in req.next_step


def test_request_refusal_is_handled(vault, pipeline, tmp_path) -> None:
    server = FakeServer(tmp_path, request_error=CaptureRejected("The server refused the request (403)."))
    (result,) = run([named(ID_A)], options(vault), server)
    assert result.status == "degraded"


def test_skip_never_touches_the_capture_server(vault, pipeline) -> None:
    factory = MagicMock()
    (result,) = run([named(ID_A)], options(vault, websdk="skip"), factory=factory)
    factory.assert_not_called()
    assert pipeline.calls[0]["websdk_json"] is None
    assert (result.status, result.websdk_used) == ("complete", False)
    assert any("skipped" in w for w in result.warnings)


def test_pipeline_receives_the_options(vault, pipeline, tmp_path) -> None:
    opts = options(
        vault,
        target_dir=Path("Boards"),
        output_format="native-canvas",
        websdk="skip",
        share_attachments=False,
        install_obsidian_plugins=True,
        attachment_dir=tmp_path / "att",
        scale=0.5,
        min_font_px=10,
        theme="light",
        text_style_mode="obsidian",
        prefer_experimental=False,
    )
    (result,) = run([named(ID_A, "Road: map/2026")], opts)
    call = pipeline.calls[0]
    assert call["board_id"] == ID_A and call["token"] == TOKEN
    assert call["target_dir"] == vault / "Boards"
    assert call["source_json"] == vault / "_miro_sources" / "Road_ map_2026.json"
    assert call["vault_root"] == vault
    assert call["output_format"] == "native-canvas"
    assert call["share_attachments"] is False and call["install_obsidian_plugins"] is True
    assert call["attachment_dir"] == tmp_path / "att"
    assert (call["scale"], call["min_font_px"], call["theme"], call["text_style_mode"]) == (0.5, 10, "light", "obsidian")
    assert call["prefer_experimental"] is False
    assert "allow_missing_assets" not in call or call["allow_missing_assets"] is False
    assert result.artifact_path == str(vault / "Boards" / "Road_ map_2026.canvas")
    assert result.source_json == str(call["source_json"])


def test_same_named_boards_get_distinct_files(vault, pipeline) -> None:
    run([named(ID_A, "Plan"), named(ID_B, "plan")], options(vault, websdk="skip"))
    assert len({c["source_json"].name.lower() for c in pipeline.calls}) == 2


def test_board_name_is_looked_up_when_only_an_id_is_known(vault, pipeline, monkeypatch) -> None:
    monkeypatch.setattr(import_service, "fetch_board_name", lambda token, board_id, **kw: "Looked Up")
    (result,) = run([ID_A], options(vault, websdk="skip"))
    assert result.board_name == "Looked Up"
    assert pipeline.calls[0]["source_json"].name == "Looked Up.json"


def test_not_connected_marks_every_board_needs_user(vault, pipeline) -> None:
    factory = MagicMock()

    def provider():
        raise miro_auth.NotConnected("Miro is not connected. Connect once with ...")

    events: list[dict] = []
    results = run_imports(
        [ID_A, "Some name", named(ID_B)],
        options(vault),
        on_event=events.append,
        token_provider=provider,
        capture_server_factory=factory,
    )
    assert [r.status for r in results] == ["needs_user"] * 3
    assert {r.reason for r in results} == {"not_connected"}
    assert all("auth login" in r.next_step and "setup guide" in r.next_step for r in results)
    factory.assert_not_called()
    assert pipeline.calls == []
    assert [e["event"] for e in events].count("needs_user") == 3
    assert events[-1]["event"] == "batch_finished" and events[-1]["exit_code"] == 3


def test_refresh_failure_and_missing_store_have_their_own_guidance(vault, pipeline) -> None:
    def refused():
        raise miro_auth.TokenRefreshFailed("Miro refused to renew the saved token (HTTP 400).")

    (result,) = run_imports([ID_A], options(vault), token_provider=refused)
    assert (result.status, result.reason) == ("needs_user", "token_refresh_failed")
    assert "auth login --form" in result.next_step

    def transient():
        raise miro_auth.TokenRefreshFailed("network down", needs_reauthorization=False)

    (result,) = run_imports([ID_A], options(vault), token_provider=transient)
    assert result.reason == "token_refresh_failed" and "again" in result.next_step

    def no_store():
        raise CredentialStoreUnavailable("none")

    (result,) = run_imports([ID_A], options(vault), token_provider=no_store)
    assert (result.status, result.reason) == ("needs_user", "not_connected")
    assert "MIRO_ACCESS_TOKEN" in result.next_step


def test_one_failing_board_does_not_stop_the_batch(vault, monkeypatch) -> None:
    recorder = PipelineRecorder(vault, fail={ID_A: RuntimeError(f"boom with {TOKEN}")})
    monkeypatch.setattr(import_service.application, "run_rest_experimental_pipeline", recorder)
    events: list[dict] = []
    results = run([named(ID_A, "A"), named(ID_B, "B")], options(vault, websdk="skip"), events=events)
    assert [r.status for r in results] == ["failed", "complete"]
    assert results[0].reason == "error" and TOKEN not in results[0].message
    assert [c["board_id"] for c in recorder.calls] == [ID_A, ID_B]
    finished = [e for e in events if e["event"] == "board_finished"]
    assert [e["status"] for e in finished] == ["failed", "complete"]
    assert events[-1] == {
        "event": "batch_finished",
        "counts": {"complete": 1, "degraded": 0, "needs_user": 0, "failed": 1},
        "exit_code": 1,
        "message": "Finished 2 board(s).",
    }


@pytest.mark.parametrize(
    "error",
    [
        PermissionError(13, "Permission denied"),
        OSError("[WinError 5] Access is denied: 'C:/vault/Miro/x.canvas'"),
    ],
)
def test_file_locked_is_reported_as_needs_user(vault, monkeypatch, error) -> None:
    monkeypatch.setattr(
        import_service.application, "run_rest_experimental_pipeline", PipelineRecorder(vault, fail={ID_A: error})
    )
    (result,) = run([named(ID_A)], options(vault, websdk="skip"))
    assert (result.status, result.reason) == ("needs_user", "file_locked")
    assert result.next_step == "Close the board in Obsidian and retry."


def _http_error(code: int) -> requests.HTTPError:
    response = requests.Response()
    response.status_code = code
    return requests.HTTPError(f"{code} Client Error for url: https://api.miro.com/v2/boards/x", response=response)


@pytest.mark.parametrize(
    "error, status, reason",
    [
        (_http_error(401), "needs_user", "not_connected"),
        (_http_error(403), "needs_user", "app_setup_required"),
        (_http_error(404), "failed", "board_not_found"),
        (_http_error(429), "failed", "error"),
        (RuntimeError("Asset download incomplete: 2 missing"), "failed", "missing_assets"),
        (RuntimeError("Asset validation incomplete: x"), "failed", "missing_assets"),
        (ValueError("REST and Web SDK exports differ by more than 60 minutes"), "failed", "error"),
    ],
)
def test_pipeline_errors_are_classified(vault, monkeypatch, error, status, reason) -> None:
    monkeypatch.setattr(
        import_service.application, "run_rest_experimental_pipeline", PipelineRecorder(vault, fail={ID_A: error})
    )
    (result,) = run([named(ID_A)], options(vault, websdk="skip"))
    assert (result.status, result.reason) == (status, reason)
    assert result.message and result.next_step


def test_merge_failure_with_a_capture_is_incomplete_source(vault, monkeypatch, tmp_path) -> None:
    monkeypatch.setattr(
        import_service.application,
        "run_rest_experimental_pipeline",
        PipelineRecorder(vault, fail={ID_A: ValueError("Web SDK export is stale")}),
    )
    server = FakeServer(tmp_path)
    server.latest[ID_A] = server.make_capture("x")
    (result,) = run([named(ID_A)], options(vault), server)
    assert (result.status, result.reason, result.websdk_used) == ("failed", "incomplete_source", True)


def test_degraded_pipeline_result_maps_to_degraded(vault, monkeypatch) -> None:
    recorder = PipelineRecorder(
        vault, completeness={"complete": False, "issues": ["comments missing", "x"]}
    )
    monkeypatch.setattr(import_service.application, "run_rest_experimental_pipeline", recorder)
    (result,) = run([named(ID_A)], options(vault, websdk="skip"))
    assert (result.status, result.reason) == ("degraded", "incomplete_source")
    assert "comments missing" in result.warnings


def test_names_are_resolved_with_one_listing_and_bad_refs_fail_alone(vault, pipeline, monkeypatch) -> None:
    get = MagicMock(return_value=BOARDS)
    monkeypatch.setattr(import_service, "get_boards", get)
    results = run(["retro", "does not exist", "roadmap", ID_C], options(vault, websdk="skip"))
    assert [r.status for r in results] == ["complete", "failed", "failed", "complete"]
    assert results[1].reason == "board_not_found" and "Retro" in results[1].message
    assert results[2].reason == "board_ambiguous" and ID_A in results[2].message
    assert results[0].board_name == "Retro" and results[0].ref == "retro"
    get.assert_called_once_with(TOKEN)
    assert [c["board_id"] for c in pipeline.calls] == [ID_B, ID_C]


def test_listing_failure_fails_only_name_refs(vault, pipeline, monkeypatch) -> None:
    monkeypatch.setattr(import_service, "get_boards", MagicMock(side_effect=_http_error(403)))
    results = run(["some name", ID_A], options(vault, websdk="skip"))
    assert (results[0].status, results[0].reason) == ("needs_user", "app_setup_required")
    assert results[1].status == "complete"


def test_no_get_boards_call_when_all_refs_are_ids(vault, pipeline, no_network) -> None:
    run([ID_A, f"https://miro.com/app/board/{ID_B}/"], options(vault, websdk="skip"))
    no_network.assert_not_called()


def test_events_never_contain_secrets_or_board_content(vault, monkeypatch, tmp_path) -> None:
    recorder = PipelineRecorder(vault, fail={ID_B: RuntimeError(f"HTTP 500 Authorization: Bearer {TOKEN}")})
    monkeypatch.setattr(import_service.application, "run_rest_experimental_pipeline", recorder)
    server = FakeServer(tmp_path)
    events: list[dict] = []
    results = run([named(ID_A, "A"), named(ID_B, "B")], options(vault), server, events=events)
    dumped = json.dumps([events, [r.to_dict() for r in results]])
    assert TOKEN not in dumped
    assert "tok-SECRET" not in dumped
    kinds = {e["event"] for e in events}
    assert kinds == {"board_started", "step", "board_finished", "batch_finished"}
    # every event is a JSON-safe dict carrying its kind
    assert all(json.loads(json.dumps(e)) == e for e in events)
    assert events[0]["event"] == "board_started" and events[0]["board_id"] == ID_A
    assert events[-1]["event"] == "batch_finished"
    assert any(e["event"] == "step" and "REST" in e["message"] for e in events)


def test_a_failing_event_listener_does_not_stop_the_import(vault, pipeline) -> None:
    def broken(_event):
        raise RuntimeError("listener bug")

    (result,) = run_imports(
        [named(ID_A)], options(vault, websdk="skip"), on_event=broken, token_provider=lambda: TOKEN
    )
    assert result.status == "complete"


def test_raw_json_format_is_passed_through(vault, pipeline) -> None:
    (result,) = run([named(ID_A, "A")], options(vault, websdk="skip", output_format="raw-json"))
    assert pipeline.calls[0]["output_format"] == "raw-json"
    assert result.status == "complete"


# ---------------------------------------------------------------------------
# Capture only
# ---------------------------------------------------------------------------


def test_run_capture_returns_the_stored_capture_path(tmp_path) -> None:
    server = FakeServer(tmp_path)
    opened: list[str] = []
    result = run_capture(
        ID_A,
        timeout_seconds=5,
        open_board=True,
        capture_server_factory=lambda: server,
        opener=lambda url: opened.append(url) or True,
        token_provider=MagicMock(side_effect=AssertionError("an id needs no token")),
    )
    assert (result.status, result.websdk_used) == ("complete", True)
    assert result.artifact_path == str(server.outcomes[ID_A])
    assert opened == [f"https://miro.com/app/board/{ID_A}/"]


def test_run_capture_timeout_needs_the_user(tmp_path) -> None:
    server = FakeServer(tmp_path, outcomes={ID_A: CaptureTimeout("slow")})
    result = run_capture(ID_A, capture_server_factory=lambda: server, open_board=False)
    assert (result.status, result.reason) == ("needs_user", "websdk_capture_timeout")


def test_run_capture_resolves_names_and_needs_connection(tmp_path, monkeypatch) -> None:
    monkeypatch.setattr(import_service, "get_boards", MagicMock(return_value=BOARDS))
    server = FakeServer(tmp_path)
    result = run_capture(
        "retro", capture_server_factory=lambda: server, open_board=False, token_provider=lambda: TOKEN
    )
    assert result.board_id == ID_B and result.status == "complete"

    def provider():
        raise miro_auth.NotConnected("not connected")

    result = run_capture("retro", token_provider=provider, capture_server_factory=lambda: server)
    assert (result.status, result.reason) == ("needs_user", "not_connected")


def test_run_capture_server_failure_is_a_failure(tmp_path) -> None:
    def factory():
        raise CaptureServerUnavailable("port busy")

    result = run_capture(ID_A, capture_server_factory=factory, open_board=False)
    assert (result.status, result.reason) == ("failed", "websdk_unavailable")


# ---------------------------------------------------------------------------
# Doctor
# ---------------------------------------------------------------------------


def _status(**kwargs) -> miro_auth.ConnectionStatus:
    return miro_auth.ConnectionStatus(**kwargs)


@pytest.fixture
def quiet_doctor(monkeypatch, tmp_path):
    monkeypatch.setenv("MIRO2OBSIDIAN_CAPTURE_DIR", str(tmp_path / "caps"))
    monkeypatch.setattr(import_service, "_probe_port", lambda port: {"port": port, "state": "free"})
    monkeypatch.setattr(import_service, "websdk_directory", lambda: tmp_path)
    monkeypatch.setattr(
        miro_auth,
        "connection_status",
        lambda **kw: _status(connected=True, source="vault-v2", team_name="Product", message="Miro is connected."),
    )


def test_doctor_reports_a_ready_environment(quiet_doctor, vault) -> None:
    report = doctor(vault)
    assert json.loads(json.dumps(report)) == report
    assert report["ready"] is True
    assert report["connection"]["connected"] is True
    assert report["credential_store"] == {"available": True}
    assert report["vault"] == {
        "checked": True, "path": str(vault), "exists": True, "writable": True, "has_obsidian_config": True,
    }
    assert report["websdk_app"]["present"] is True
    assert report["ports"]["websdk"] == {"port": 8766, "state": "free"}
    assert report["ports"]["oauth_callback"]["port"] == 8765
    assert report["captures"]["fresh_count"] == 0
    assert set(report["browser"]) >= {"playwright_installed", "system_browser"}
    assert report["python"]["version"] and "version" in report and report["frozen"] is False
    assert "Ready" in report["next_steps"][0] and "import" in report["next_steps"][0]


def test_doctor_lists_next_steps_in_priority_order(monkeypatch, tmp_path, quiet_doctor) -> None:
    monkeypatch.setattr(
        miro_auth, "connection_status",
        lambda **kw: _status(connected=False, store_available=True, message="Miro is not connected."),
    )
    monkeypatch.setattr(import_service, "websdk_directory", MagicMock(side_effect=FileNotFoundError("gone")))
    monkeypatch.setattr(
        import_service, "_probe_port",
        lambda port: {"port": port, "state": "in_use" if port == 8766 else "free"},
    )
    report = doctor(tmp_path / "missing-vault")
    assert report["ready"] is False
    steps = report["next_steps"]
    assert "does not exist" in steps[0]
    assert "Web SDK app files are missing" in steps[1]
    assert "not connected" in steps[2] and "setup guide" in steps[2] and "auth login --form" in steps[2]
    assert any("Port 8766" in s for s in steps)
    assert report["websdk_app"] == {"present": False, "path": None}


def test_doctor_without_a_credential_store(monkeypatch, quiet_doctor) -> None:
    monkeypatch.setattr(
        miro_auth, "connection_status",
        lambda **kw: _status(connected=False, store_available=False, problem="No usable OS credential store is available.", message="x"),
    )
    report = doctor()
    assert report["credential_store"] == {"available": False}
    assert any("MIRO_ACCESS_TOKEN" in s for s in report["next_steps"])
    assert report["vault"] == {"checked": False}
    assert any("--vault" in s for s in report["next_steps"])


def test_doctor_never_raises_and_hides_secrets(monkeypatch, quiet_doctor, vault) -> None:
    monkeypatch.setenv("MIRO_ACCESS_TOKEN", TOKEN)
    monkeypatch.setenv("MIRO_CLIENT_SECRET", "client-secret-value")
    monkeypatch.setattr(miro_auth, "connection_status", MagicMock(side_effect=RuntimeError(f"explode {TOKEN}")))
    monkeypatch.setattr(import_service, "_probe_port", MagicMock(side_effect=OSError("nope")))
    monkeypatch.setattr(import_service, "_browser_report", MagicMock(side_effect=ImportError("x")))
    report = doctor(vault, verify_online=True)
    dumped = json.dumps(report)
    assert TOKEN not in dumped and "client-secret-value" not in dumped
    assert report["connection"] == {"error": "RuntimeError"}
    assert report["browser"] == {"error": "ImportError"}
    assert isinstance(report["ready"], bool) and report["next_steps"]


def test_doctor_verify_flag_reaches_the_connection_check(monkeypatch, quiet_doctor) -> None:
    seen: dict = {}

    def status(**kwargs):
        seen.update(kwargs)
        return _status(connected=True, message="ok")

    monkeypatch.setattr(miro_auth, "connection_status", status)
    doctor(verify_online=True)
    assert seen == {"verify_online": True}


def test_doctor_vault_checks(quiet_doctor, tmp_path) -> None:
    plain = tmp_path / "plain"
    plain.mkdir()
    report = doctor(plain)
    assert report["vault"]["has_obsidian_config"] is False
    assert any(".obsidian" in s for s in report["next_steps"])
    # a missing .obsidian is a warning, not a blocker
    assert report["ready"] is True


def test_doctor_counts_only_fresh_captures(quiet_doctor, tmp_path) -> None:
    caps = tmp_path / "caps" / "board-x"
    caps.mkdir(parents=True)
    fresh = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%f")[:-3] + "000Z"
    (caps / f"websdk-{fresh}.json").write_text("{}", encoding="utf-8")
    (caps / "websdk-20200101T000000000000Z.json").write_text("{}", encoding="utf-8")
    assert doctor()["captures"]["fresh_count"] == 1


def test_port_probe_distinguishes_free_foreign_and_our_server(tmp_path) -> None:
    probe = import_service._probe_port
    with socket.socket() as holder:
        holder.bind(("127.0.0.1", 0))
        port = holder.getsockname()[1]
    assert probe(port) == {"port": port, "state": "free"}

    with socket.socket() as foreign:
        foreign.bind(("127.0.0.1", 0))
        foreign.listen(5)
        port = foreign.getsockname()[1]
        answered = threading.Event()

        def accept():
            try:
                conn, _ = foreign.accept()
                conn.close()
            except OSError:
                pass
            answered.set()

        thread = threading.Thread(target=accept, daemon=True)
        thread.start()
        assert probe(port)["state"] == "in_use"
        thread.join(timeout=3)

    exporter = Path(__file__).resolve().parents[1] / "tools" / "miro_websdk_exporter"
    with CaptureServer(port=0, capture_dir=tmp_path / "c", directory=exporter) as server:
        found = probe(server.port)
        assert found == {"port": server.port, "state": "websdk_server"}
        assert server._hub.token not in json.dumps(found)
