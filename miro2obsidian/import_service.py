"""The single orchestration layer for importing Miro boards into a vault.

The command line (``miro2obsidian import``), the GUI, an MCP server and any
agent all call :func:`run_imports`; they only differ in how they present the
results. The service

* turns board references (id, URL or name) into boards (:func:`resolve_boards`);
* obtains a fresh Web SDK capture through the loopback handoff when it can, and
  runs the REST pipeline *immediately afterwards* (REST and Web SDK exports of
  one board must be less than 60 minutes apart);
* reports every board as an :class:`ImportResult` whose ``status`` is one of
  ``complete``, ``degraded``, ``needs_user`` or ``failed`` with a plain-language
  ``message`` and one actionable ``next_step``;
* streams structured events and never exposes a token, secret or the content of
  a board.

Environment problems never raise out of :func:`doctor`; they are reported.
"""

from __future__ import annotations

import difflib
import json
import os
import platform
import re
import shutil
import socket
import sys
import webbrowser
from contextlib import ExitStack
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Sequence
from urllib.parse import quote, unquote, urlsplit
from urllib.request import ProxyHandler, build_opener

import requests

from Json_2_Canvas.output_formats import ADVANCED_CANVAS, normalize_output_format
from Json_2_Canvas.Scale_engine import ViewProfile
from Miro_2_Json.miro_downloader import get_boards
from miro2obsidian import application, miro_auth, paths
from miro2obsidian.credential_store import CredentialStoreUnavailable
from miro2obsidian.websdk_capture import (
    CaptureError,
    CaptureRejected,
    CaptureServer,
    CaptureTimeout,
    board_url,
)
from miro2obsidian.websdk_server import (
    API_APP_NAME,
    DEFAULT_PORT,
    board_dirname,
    websdk_directory,
)
from scripts.obsidian_vault_settings import resolve_attachment_dir

__all__ = [
    "BoardResolutionError",
    "DEFAULT_CAPTURE_TIMEOUT_SECONDS",
    "FRESH_CAPTURE_MAX_AGE_MINUTES",
    "ImportOptions",
    "ImportResult",
    "ResolvedBoard",
    "batch_exit_code",
    "doctor",
    "error_result",
    "exit_code_for_status",
    "fetch_board_name",
    "list_boards",
    "not_connected_result",
    "parse_board_ref",
    "resolve_boards",
    "run_capture",
    "run_imports",
]

PROGRAM = "miro2obsidian"
STATUSES = ("complete", "degraded", "needs_user", "failed")
DEFAULT_CAPTURE_TIMEOUT_SECONDS = 180.0
#: A stored Web SDK capture is reused only when it is this young. The union
#: with the REST export rejects sources more than 60 minutes apart; the REST
#: export runs after the capture and can take a while, so keep generous slack.
FRESH_CAPTURE_MAX_AGE_MINUTES = 30.0
OAUTH_PORT = 8765
DEFAULT_FOLDER_NAME = "Miro"
DEFAULT_SOURCE_DIR_NAME = "_miro_sources"
MAX_CANDIDATES = 10
_MAX_MESSAGE = 600

_ID_RE = re.compile(r"(?:[A-Za-z0-9_-]{6,}={1,2}|[0-9]{10,})")
_URL_ID_RE = re.compile(r"/app/(?:board|live-embed)/([^/?#]+)")
_UNSAFE_NAME = re.compile(r'[<>:"/\\|?*\x00-\x1f]')
_RESERVED_NAMES = frozenset(
    {"CON", "PRN", "AUX", "NUL", *(f"COM{i}" for i in range(1, 10)), *(f"LPT{i}" for i in range(1, 10))}
)

EventCallback = Callable[[dict[str, Any]], None]

CONNECT_COMMANDS = (
    f"Run `{PROGRAM} setup guide` to create your Miro app (once), then "
    f"`{PROGRAM} auth login --form` to connect it."
)


# ---------------------------------------------------------------------------
# Board references
# ---------------------------------------------------------------------------


class BoardResolutionError(ValueError):
    """A board reference matched no board, or more than one.

    ``reason`` is ``"board_not_found"`` or ``"board_ambiguous"``;
    ``candidates`` lists up to 10 ``{"id", "name"}`` records to choose from.
    """

    def __init__(
        self,
        message: str,
        *,
        ref: str,
        reason: str = "board_not_found",
        candidates: Sequence[dict[str, Any]] = (),
    ) -> None:
        super().__init__(message)
        self.ref = ref
        self.reason = reason
        self.candidates = [dict(c) for c in candidates][:MAX_CANDIDATES]


@dataclass(frozen=True)
class ResolvedBoard:
    board_id: str
    name: str | None = None
    view_link: str | None = None
    team: str | None = None
    ref: str | None = None

    @property
    def url(self) -> str:
        return board_url(self.board_id)

    def label(self) -> str:
        return self.name or self.board_id


def parse_board_ref(ref: str) -> str | None:
    """Return the board id when ``ref`` is an id or a Miro board URL, else ``None``.

    ``None`` means "treat it as a board name". A URL that is not a Miro board
    URL raises :class:`BoardResolutionError`.
    """
    text = str(ref or "").strip()
    if not text:
        return None
    if re.match(r"^https?://", text, re.IGNORECASE):
        parts = urlsplit(text)
        host = (parts.hostname or "").lower()
        match = _URL_ID_RE.match(parts.path)
        if (host == "miro.com" or host.endswith(".miro.com")) and match:
            return unquote(match.group(1)).strip()
        raise BoardResolutionError(
            f"'{_clip(text, 80)}' is not a Miro board URL. A board URL looks like "
            "https://miro.com/app/board/<board id>/.",
            ref=text,
        )
    if _ID_RE.fullmatch(text):
        return text
    return None


def _normalize_board(record: dict[str, Any]) -> dict[str, Any] | None:
    board_id = str(record.get("id") or "").strip()
    if not board_id:
        return None
    team = record.get("team")
    team_name = team.get("name") if isinstance(team, dict) else team
    return {
        "id": board_id,
        "name": str(record.get("name") or "").strip(),
        "team": str(team_name).strip() if team_name else None,
        "viewLink": record.get("viewLink") or None,
    }


def list_boards(token: str, *, query: str | None = None) -> list[dict[str, Any]]:
    """Boards visible to the connected app as ``{id, name, team, viewLink}`` records."""
    boards = [b for b in (_normalize_board(r) for r in get_boards(token)) if b]
    if query:
        needle = query.casefold()
        boards = [b for b in boards if needle in b["name"].casefold()]
    return boards


def _candidates(boards: Sequence[dict[str, Any]]) -> list[dict[str, Any]]:
    return [{"id": b["id"], "name": b["name"]} for b in boards[:MAX_CANDIDATES]]


def _candidate_text(candidates: Sequence[dict[str, Any]]) -> str:
    return "; ".join(f"{c['name'] or '(untitled)'} ({c['id']})" for c in candidates)


def _resolved(record: dict[str, Any], ref: str) -> ResolvedBoard:
    return ResolvedBoard(
        board_id=record["id"],
        name=record["name"] or None,
        view_link=record.get("viewLink"),
        team=record.get("team"),
        ref=ref,
    )


def resolve_boards(
    refs: Sequence[str],
    *,
    token: str,
    boards: list[dict[str, Any]] | None = None,
) -> list[ResolvedBoard]:
    """Resolve board ids, URLs and names.

    A reference is a board id, a ``https://miro.com/app/board/<id>/`` URL, or a
    board name (case-insensitive exact match, else a unique substring match).
    A missing or ambiguous name raises :class:`BoardResolutionError` listing up
    to 10 candidates. Miro is asked for the board list (``get_boards``) only
    when some reference is a name and ``boards`` was not supplied.
    """
    cache: list[dict[str, Any]] | None = None
    if boards is not None:
        cache = [b for b in (_normalize_board(r) for r in boards) if b]

    def listing() -> list[dict[str, Any]]:
        nonlocal cache
        if cache is None:
            cache = list_boards(token)
        return cache

    resolved: list[ResolvedBoard] = []
    for raw in refs:
        ref = str(raw or "").strip()
        if not ref:
            raise BoardResolutionError("A board reference is empty.", ref=ref)
        direct = parse_board_ref(ref)
        if direct is not None:
            known = next((b for b in cache or [] if b["id"] == direct), None)
            resolved.append(_resolved(known, ref) if known else ResolvedBoard(direct, ref=ref))
            continue
        records = listing()
        by_id = [b for b in records if b["id"] == ref]
        if by_id:
            resolved.append(_resolved(by_id[0], ref))
            continue
        needle = ref.casefold()
        exact = [b for b in records if b["name"].casefold() == needle]
        pool = exact or [b for b in records if needle in b["name"].casefold()]
        if len(pool) == 1:
            resolved.append(_resolved(pool[0], ref))
            continue
        if len(pool) > 1:
            shown = _candidates(pool)
            raise BoardResolutionError(
                f"'{_clip(ref, 80)}' matches {len(pool)} boards: {_candidate_text(shown)}"
                f"{' ...' if len(pool) > len(shown) else ''}. "
                "Use the board id or its URL to choose one.",
                ref=ref,
                reason="board_ambiguous",
                candidates=shown,
            )
        names = [b["name"] for b in records if b["name"]]
        close = difflib.get_close_matches(ref, names, n=MAX_CANDIDATES, cutoff=0.4)
        suggestions = [b for b in records if b["name"] in close] or list(records)
        shown = _candidates(suggestions)
        hint = f" Boards the app can see: {_candidate_text(shown)}." if shown else (
            " The connected app can see no boards (is it installed in the team that owns them?)."
        )
        raise BoardResolutionError(
            f"No board is named like '{_clip(ref, 80)}'.{hint}",
            ref=ref,
            reason="board_not_found",
            candidates=shown,
        )
    if cache:
        # A listing fetched for a later name also names the earlier id references.
        names = {b["id"]: b for b in cache}
        resolved = [
            _resolved(names[r.board_id], r.ref or r.board_id) if not r.name and r.board_id in names else r
            for r in resolved
        ]
    return resolved


def fetch_board_name(token: str, board_id: str, *, timeout: float = 15.0) -> str | None:
    """Best-effort board title for naming files; ``None`` on any problem."""
    try:
        response = requests.get(
            f"https://api.miro.com/v2/boards/{quote(board_id, safe='=')}",
            headers={"Authorization": f"Bearer {token}"},
            timeout=timeout,
        )
        if response.status_code != 200:
            return None
        name = response.json().get("name")
        return str(name).strip() or None
    except Exception:  # noqa: BLE001 - a missing title only affects the file name
        return None


# ---------------------------------------------------------------------------
# Options and results
# ---------------------------------------------------------------------------

WEBSDK_MODES = ("auto", "required", "skip")


@dataclass(frozen=True)
class ImportOptions:
    """What to import and where to put it.

    ``target_dir`` defaults to ``<vault>/Miro`` and ``source_dir`` to
    ``<vault>/_miro_sources``; ``target_dir`` must lie inside the vault.
    ``websdk`` is ``"auto"`` (use a Web SDK capture when one can be obtained,
    else continue REST-only and report ``degraded``), ``"required"`` (never
    degrade; ask the person instead), ``"skip"`` (REST only on purpose) or the
    path of a Web SDK capture file (single board only). ``output_format`` and
    the view options default to the same values as the command line.
    """

    vault_root: Path
    target_dir: Path | None = None
    output_format: str = ADVANCED_CANVAS
    websdk: str | Path = "auto"
    capture_timeout_seconds: float = DEFAULT_CAPTURE_TIMEOUT_SECONDS
    open_board: bool = True
    source_dir: Path | None = None
    share_attachments: bool = True
    install_obsidian_plugins: bool = False
    attachment_dir: Path | None = None
    scale: float | None = None
    view_profile: ViewProfile | None = None
    min_font_px: int = 8
    theme: str = "dark"
    text_style_mode: str = "miro"
    prefer_experimental: bool = True
    #: Accept a board whose assets cannot all be downloaded (reported as degraded).
    allow_missing_assets: bool = False

    def __post_init__(self) -> None:
        vault = Path(self.vault_root)
        object.__setattr__(self, "vault_root", vault)
        object.__setattr__(self, "output_format", normalize_output_format(self.output_format))
        target = Path(self.target_dir) if self.target_dir else vault / DEFAULT_FOLDER_NAME
        if not target.is_absolute():
            target = vault / target
        object.__setattr__(self, "target_dir", target)
        if not _is_inside(target, vault):
            raise ValueError("The Canvas folder must be inside the vault.")
        source = Path(self.source_dir) if self.source_dir else vault / DEFAULT_SOURCE_DIR_NAME
        object.__setattr__(self, "source_dir", source)
        if self.attachment_dir is not None:
            object.__setattr__(self, "attachment_dir", Path(self.attachment_dir))
        websdk = self.websdk
        if isinstance(websdk, str) and websdk.lower() in WEBSDK_MODES:
            object.__setattr__(self, "websdk", websdk.lower())
        elif isinstance(websdk, (str, Path)) and str(websdk).strip():
            object.__setattr__(self, "websdk", Path(websdk))
        else:
            raise ValueError("websdk must be 'auto', 'required', 'skip' or a file path.")
        if float(self.capture_timeout_seconds) <= 0:
            raise ValueError("capture_timeout_seconds must be positive.")

    @property
    def websdk_mode(self) -> str:
        return "file" if isinstance(self.websdk, Path) else str(self.websdk)


def _is_inside(path: Path, root: Path) -> bool:
    try:
        return os.path.commonpath([os.path.realpath(path), os.path.realpath(root)]) == os.path.realpath(root)
    except ValueError:
        return False


@dataclass
class ImportResult:
    """The outcome for one board. ``to_dict()`` is JSON-safe and secret-free."""

    status: str
    board_id: str | None = None
    board_name: str | None = None
    reason: str | None = None
    message: str = ""
    next_step: str | None = None
    artifact_path: str | None = None
    source_json: str | None = None
    websdk_used: bool = False
    warnings: list[str] = field(default_factory=list)
    ref: str | None = None

    def __post_init__(self) -> None:
        if self.status not in STATUSES:
            raise ValueError(f"Unknown import status: {self.status}")

    def to_dict(self) -> dict[str, Any]:
        return {
            "ref": self.ref,
            "board_id": self.board_id,
            "board_name": self.board_name,
            "status": self.status,
            "reason": self.reason,
            "message": self.message,
            "next_step": self.next_step,
            "artifact_path": self.artifact_path,
            "source_json": self.source_json,
            "websdk_used": bool(self.websdk_used),
            "warnings": list(self.warnings),
        }


def exit_code_for_status(status: str) -> int:
    """0 complete, 2 degraded, 3 needs_user, 1 failed."""
    return {"complete": 0, "degraded": 2, "needs_user": 3}.get(status, 1)


def batch_exit_code(results: Sequence[ImportResult]) -> int:
    """Worst outcome wins: any failure 1, else any needs_user 3, else degraded 2, else 0."""
    statuses = {r.status for r in results}
    if not statuses:
        return 1
    if "failed" in statuses:
        return 1
    if "needs_user" in statuses:
        return 3
    if "degraded" in statuses:
        return 2
    return 0


# ---------------------------------------------------------------------------
# Events
# ---------------------------------------------------------------------------


def _clip(text: str, limit: int = _MAX_MESSAGE) -> str:
    text = " ".join(str(text).split())
    return text if len(text) <= limit else text[: limit - 3] + "..."


class _Emitter:
    """Sends structured events; scrubs known secrets from every string."""

    def __init__(self, callback: EventCallback | None) -> None:
        self._callback = callback
        self._secrets: list[str] = []

    def add_secret(self, value: str | None) -> None:
        if value and len(value) >= 6 and value not in self._secrets:
            self._secrets.append(value)

    def clean(self, text: Any) -> str:
        value = str(text)
        for secret in self._secrets:
            value = value.replace(secret, "***")
        return re.sub(r"(?i)\bbearer\s+[A-Za-z0-9._~+/=-]{8,}", "Bearer ***", value)

    def _scrub(self, value: Any) -> Any:
        if isinstance(value, str):
            return self.clean(value)
        if isinstance(value, dict):
            return {k: self._scrub(v) for k, v in value.items()}
        if isinstance(value, (list, tuple)):
            return [self._scrub(v) for v in value]
        return value

    def __call__(self, event: str, **fields: Any) -> None:
        if self._callback is None:
            return
        payload = {"event": event, **{k: self._scrub(v) for k, v in fields.items() if v is not None}}
        try:
            self._callback(payload)
        except Exception:  # noqa: BLE001 - a broken listener must not stop the import
            pass


# ---------------------------------------------------------------------------
# Failure classification
# ---------------------------------------------------------------------------


def _connect_next_step() -> str:
    return CONNECT_COMMANDS


def not_connected_result(exc: Exception, ref: str | None = None) -> ImportResult:
    """``needs_user`` result for NotConnected, TokenRefreshFailed or an unusable credential store."""
    return _not_connected_result(exc, ref)


def error_result(exc: BaseException, *, secrets: Sequence[str] = ()) -> ImportResult:
    """Classify any exception raised while talking to Miro (same mapping as imports).

    ``secrets`` are scrubbed from the message. The result's ``status`` tells a
    caller whether a person must act (``needs_user``) or the run failed.
    """
    emit = _Emitter(None)
    for value in secrets:
        emit.add_secret(value)
    return _failure_result(exc, board=None, name=None, websdk_used=False, emit=emit)


def _not_connected_result(exc: Exception, ref: str | None = None) -> ImportResult:
    if isinstance(exc, miro_auth.TokenRefreshFailed):
        return ImportResult(
            "needs_user",
            reason="token_refresh_failed",
            message=_clip(str(exc)),
            next_step=(
                f"Reconnect Miro: run `{PROGRAM} auth login --form` and approve access. "
                "If it keeps failing, create the app again (`"
                f"{PROGRAM} setup guide`)."
                if getattr(exc, "needs_reauthorization", True)
                else "Check the network connection and run the same command again."
            ),
            ref=ref,
        )
    if isinstance(exc, CredentialStoreUnavailable):
        return ImportResult(
            "needs_user",
            reason="not_connected",
            message="No operating system credential store is available to hold the Miro connection.",
            next_step=(
                "Set the environment variable MIRO_ACCESS_TOKEN for this run (the person "
                "must do this; never paste the token into a chat), or install a supported "
                "keyring backend."
            ),
            ref=ref,
        )
    return ImportResult(
        "needs_user",
        reason="not_connected",
        message=_clip(str(exc)) or "Miro is not connected.",
        next_step=_connect_next_step(),
        ref=ref,
    )


def _http_status(exc: BaseException) -> int | None:
    response = getattr(exc, "response", None)
    code = getattr(response, "status_code", None)
    return code if isinstance(code, int) else None


def _failure_result(
    exc: BaseException,
    *,
    board: ResolvedBoard | None,
    name: str | None,
    websdk_used: bool,
    emit: _Emitter,
) -> ImportResult:
    """Map an exception to a status/reason/next_step. Text is scrubbed of secrets."""
    text = emit.clean(f"{exc}")
    base = {
        "board_id": board.board_id if board else None,
        "board_name": name,
        "ref": board.ref if board else None,
        "websdk_used": websdk_used,
    }
    status_code = _http_status(exc)
    if isinstance(exc, PermissionError) or "WinError 5" in text or "Access is denied" in text:
        return ImportResult(
            "needs_user",
            reason="file_locked",
            message="A file could not be written; it is probably open in Obsidian or not writable.",
            next_step="Close the board in Obsidian and retry.",
            **base,
        )
    if status_code == 401:
        return ImportResult(
            "needs_user",
            reason="not_connected",
            message="Miro rejected the saved connection (it was revoked or has expired).",
            next_step=f"Reconnect Miro: run `{PROGRAM} auth login --form`.",
            **base,
        )
    if status_code == 403:
        return ImportResult(
            "needs_user",
            reason="app_setup_required",
            message="Miro says the app is not allowed to read this board.",
            next_step=(
                "Install the Miro app into the team that owns this board (a team "
                f"administrator may have to approve it), then retry. See `{PROGRAM} setup guide`."
            ),
            **base,
        )
    if status_code == 404:
        return ImportResult(
            "failed",
            reason="board_not_found",
            message="Miro does not know this board, or the app cannot see it.",
            next_step=f"Run `{PROGRAM} boards` to list the boards the app can see and use one of those ids.",
            **base,
        )
    if status_code == 429:
        return ImportResult(
            "failed",
            reason="error",
            message="Miro is rate limiting requests.",
            next_step="Wait a few minutes and run the same command again.",
            **base,
        )
    lowered = text.lower()
    if "asset download incomplete" in lowered or "asset validation incomplete" in lowered:
        return ImportResult(
            "failed",
            reason="missing_assets",
            message=_clip(f"Some files attached to the board could not be downloaded: {text}"),
            next_step="Run the same command again; if it keeps failing, report the message above.",
            **base,
        )
    if websdk_used and isinstance(exc, ValueError):
        return ImportResult(
            "failed",
            reason="incomplete_source",
            message=_clip(f"The REST export and the Web SDK capture could not be combined: {text}"),
            next_step=(
                "Run the same command again so the board is captured afresh, or use `--websdk skip` "
                "for a REST-only import."
            ),
            **base,
        )
    return ImportResult(
        "failed",
        reason="error",
        message=_clip(f"{type(exc).__name__}: {text}"),
        next_step=f"Run `{PROGRAM} doctor` to check the setup, then try again.",
        **base,
    )


# ---------------------------------------------------------------------------
# Running imports
# ---------------------------------------------------------------------------


def _safe_stem(name: str | None, board_id: str, used: set[str]) -> str:
    stem = _UNSAFE_NAME.sub("_", name or "").strip(" .")[:80]
    if not stem:
        stem = board_dirname(board_id)
    if stem.split(".", 1)[0].upper() in _RESERVED_NAMES:
        stem = f"_{stem}"
    candidate = stem
    if candidate.casefold() in used:
        candidate = f"{stem}-{board_dirname(board_id)[-8:]}"
    used.add(candidate.casefold())
    return candidate


def _timeout_next_step(board: ResolvedBoard) -> str:
    return (
        "On the open board, click the Miro to Obsidian app icon in the left toolbar "
        "(More apps, then the app) and wait for the export to finish, then run the same "
        "command again. If the icon is missing, install the app into the team that owns "
        f"this board (see `{PROGRAM} setup guide`). Board: {board.url}"
    )


@dataclass
class _Batch:
    mode: str  # auto | required | skip | file
    timeout_seconds: float
    open_board: bool
    token: str
    emit: _Emitter
    server: Any | None
    server_error: str | None
    opener: Callable[[str], Any] | None
    websdk_file: Path | None = None
    used_stems: set[str] = field(default_factory=set)


@dataclass
class _Capture:
    path: Path | None = None
    result: ImportResult | None = None  # an early, final outcome for the board
    warning: str | None = None
    degraded_reason: str | None = None


def _step(batch: _Batch, board: ResolvedBoard, message: str, **extra: Any) -> None:
    batch.emit("step", board_id=board.board_id, message=message, **extra)


def _open_board(batch: _Batch, board: ResolvedBoard) -> None:
    url = board.url
    if not batch.open_board:
        _step(batch, board, f"Open this board in Miro to start the capture: {url}", board_url=url)
        return
    try:
        opened = (batch.opener or webbrowser.open)(url)
    except Exception:  # noqa: BLE001 - a missing browser must not stop the wait
        opened = False
    if opened is False:
        _step(batch, board, f"Could not open a browser. Open this board in Miro yourself: {url}", board_url=url)
    else:
        _step(
            batch,
            board,
            "Opened the board in the browser. If the export does not start within about 20 "
            "seconds, click the Miro to Obsidian app icon in the board's left toolbar "
            "(More apps, then the app).",
            board_url=url,
        )


def _capture_unavailable(
    batch: _Batch, board: ResolvedBoard, name: str | None, *, why: str, timeout: bool = False
) -> _Capture:
    required = batch.mode == "required"
    if timeout:
        reason = "websdk_capture_timeout" if required else "websdk_unavailable"
    else:
        reason = "websdk_unavailable"
    if required:
        if timeout:
            return _Capture(
                result=ImportResult(
                    "needs_user",
                    board_id=board.board_id,
                    board_name=name,
                    ref=board.ref,
                    reason="websdk_capture_timeout",
                    message=_clip(why),
                    next_step=_timeout_next_step(board),
                )
            )
        return _Capture(
            result=ImportResult(
                "failed",
                board_id=board.board_id,
                board_name=name,
                ref=board.ref,
                reason="websdk_unavailable",
                message=_clip(why),
                next_step=(
                    f"Run `{PROGRAM} doctor` (it reports what holds port {DEFAULT_PORT}), fix "
                    "that, and run the same command again; or use `--websdk auto` for a "
                    "REST-only import."
                ),
            )
        )
    return _Capture(
        warning=(
            f"{_clip(why)} Continuing with the REST export only: items and files the Miro REST "
            "API does not expose (some shapes, text styling and positions available only "
            "inside the board) are missing from this import."
        ),
        degraded_reason=reason,
    )


def _acquire_capture(batch: _Batch, board: ResolvedBoard, name: str | None) -> _Capture:
    mode = batch.mode
    if mode == "skip":
        return _Capture()
    if mode == "file":
        path = Path(batch.websdk_file)  # type: ignore[arg-type]
        if not path.is_file():
            return _Capture(
                result=ImportResult(
                    "failed",
                    board_id=board.board_id,
                    board_name=name,
                    ref=board.ref,
                    reason="websdk_unavailable",
                    message=f"The Web SDK file does not exist: {path}",
                    next_step="Pass the path of a capture saved by the Miro app, or use `--websdk auto`.",
                )
            )
        _step(batch, board, f"Using the supplied Web SDK capture: {path}")
        return _Capture(path=path)
    server = batch.server
    if server is None:
        return _capture_unavailable(
            batch,
            board,
            name,
            why=batch.server_error or "The Web SDK capture server could not be started.",
        )
    try:
        found = server.latest_capture(
            board.board_id, max_age_hours=FRESH_CAPTURE_MAX_AGE_MINUTES / 60.0
        )
    except Exception:  # noqa: BLE001 - fall through to a new capture
        found = None
    if found:
        _step(
            batch,
            board,
            f"Using a Web SDK capture of this board younger than {FRESH_CAPTURE_MAX_AGE_MINUTES:g} minutes.",
        )
        return _Capture(path=Path(found))
    request = None
    timeout_s = float(batch.timeout_seconds)
    try:
        request = server.request_capture(board.board_id)
        _step(batch, board, "Asking the Miro app for a capture of the board.")
        _open_board(batch, board)
        path = request.wait(
            timeout_seconds=timeout_s,
            on_status=lambda m: _step(batch, board, m),
        )
        _step(batch, board, "Web SDK capture received and validated.")
        return _Capture(path=Path(path))
    except CaptureTimeout:
        return _capture_unavailable(
            batch,
            board,
            name,
            why=f"The Miro app did not send a capture of the board within {timeout_s:g} seconds.",
            timeout=True,
        )
    except CaptureRejected as exc:
        return _capture_unavailable(
            batch, board, name, why=f"The Web SDK capture was refused: {batch.emit.clean(exc)}"
        )
    except CaptureError as exc:
        return _capture_unavailable(
            batch, board, name, why=f"The Web SDK capture failed: {batch.emit.clean(exc)}"
        )
    finally:
        if request is not None:
            try:
                request.cancel()
            except Exception:  # noqa: BLE001
                pass


def _completeness_issues(completeness: dict[str, Any]) -> list[str]:
    issues = completeness.get("issues")
    return [str(i) for i in issues][:5] if isinstance(issues, list) else []


def _import_board(batch: _Batch, options: ImportOptions, board: ResolvedBoard) -> ImportResult:
    emit = batch.emit
    name = board.name
    if name is None:
        name = fetch_board_name(batch.token, board.board_id)
    emit("board_started", board_id=board.board_id, board_name=name, message=f"Importing {name or board.board_id}.")

    capture = _acquire_capture(batch, board, name)
    if capture.result is not None:
        return capture.result

    stem = _safe_stem(name, board.board_id, batch.used_stems)
    source_json = options.source_dir / f"{stem}.json"
    attachment_dir = options.attachment_dir or resolve_attachment_dir(
        options.vault_root, options.target_dir
    )
    _step(batch, board, "Exporting the board through Miro's REST API." if capture.path is None
          else "Exporting the board through Miro's REST API and merging the Web SDK capture.")
    try:
        pipeline = application.run_rest_experimental_pipeline(
            board_id=board.board_id,
            token=batch.token,
            source_json=source_json,
            target_dir=options.target_dir,
            vault_root=options.vault_root,
            scale=options.scale,
            view_profile=options.view_profile,
            min_font_px=options.min_font_px,
            theme=options.theme,
            text_style_mode=options.text_style_mode,
            prefer_experimental=options.prefer_experimental,
            websdk_json=capture.path,
            output_format=options.output_format,
            install_obsidian_plugins=options.install_obsidian_plugins,
            attachment_dir=attachment_dir,
            share_attachments=options.share_attachments,
            allow_missing_assets=options.allow_missing_assets,
            logger=lambda m: _step(batch, board, m),
        )
    except Exception as exc:  # noqa: BLE001 - one board failing must not stop the batch
        return _failure_result(
            exc, board=board, name=name, websdk_used=capture.path is not None, emit=emit
        )

    warnings: list[str] = []
    if capture.warning:
        warnings.append(capture.warning)
    status = "complete"
    reason: str | None = None
    next_step: str | None = f"Open {pipeline.canvas_path} in Obsidian."
    kind = "JSON export" if pipeline.output_kind == "raw_json" else "Canvas"
    message = f"Imported {pipeline.item_count} items into a {kind}."
    if application.pipeline_result_is_degraded(pipeline):
        status = "degraded"
        reason = "incomplete_source"
        issues = _completeness_issues(pipeline.completeness)
        warnings.extend(issues)
        message = f"Imported {pipeline.item_count} items, but the source is reported incomplete."
        next_step = "Read the warnings, then run the import again or accept the gaps; the artifact is usable."
    elif capture.degraded_reason:
        status = "degraded"
        reason = capture.degraded_reason
        message = f"Imported {pipeline.item_count} items from REST only (no Web SDK capture)."
        next_step = (
            "For the full export click the Miro to Obsidian app icon on the open board (or "
            f"install the app in the board's team, see `{PROGRAM} setup guide`) and run the "
            "same import again with `--websdk required`."
        )
    elif batch.mode == "skip":
        warnings.append("Web SDK capture was skipped on request; this is a REST-only import.")
    return ImportResult(
        status,
        board_id=board.board_id,
        board_name=name,
        reason=reason,
        message=message,
        next_step=next_step,
        artifact_path=str(pipeline.canvas_path),
        source_json=str(pipeline.source_json),
        websdk_used=capture.path is not None,
        warnings=warnings,
        ref=board.ref,
    )


def _finish(emit: _Emitter, board: ResolvedBoard | None, result: ImportResult) -> ImportResult:
    if result.board_id is None and board is not None:
        result.board_id = board.board_id
    data = result.to_dict()
    for key in ("message", "next_step", "reason"):
        data[key] = emit.clean(data[key]) if data[key] else data[key]
    result.message, result.next_step, result.reason = data["message"], data["next_step"], data["reason"]
    result.warnings = [emit.clean(w) for w in result.warnings]
    if result.status == "needs_user":
        emit(
            "needs_user",
            board_id=result.board_id,
            reason=result.reason,
            message=result.message,
            next_step=result.next_step,
        )
    emit("board_finished", board_id=result.board_id, status=result.status, result=result.to_dict())
    return result


def _counts(results: Sequence[ImportResult]) -> dict[str, int]:
    return {status: sum(1 for r in results if r.status == status) for status in STATUSES}


def run_imports(
    boards: Sequence[ResolvedBoard | str],
    options: ImportOptions,
    *,
    on_event: EventCallback | None = None,
    token_provider: Callable[[], str] | None = None,
    capture_server_factory: Callable[[], Any] | None = None,
    opener: Callable[[str], Any] | None = None,
) -> list[ImportResult]:
    """Import every board; return one :class:`ImportResult` per input, in order.

    The Miro token is fetched once. When Web SDK is ``auto`` or ``required`` one
    capture server serves the whole batch. Each board is captured and exported
    in turn so the two sources stay minutes (not hours) apart. A failure of one
    board never stops the others. Events (``board_started``, ``step``,
    ``needs_user``, ``board_finished``, ``batch_finished``) go to ``on_event``
    and never contain secrets.

    ``token_provider`` defaults to ``miro_auth.get_access_token`` and
    ``capture_server_factory`` to ``CaptureServer`` (both looked up when called,
    so tests can substitute them); ``opener`` opens a URL (default
    ``webbrowser.open``).
    """
    token_provider = token_provider or miro_auth.get_access_token
    capture_server_factory = capture_server_factory or CaptureServer
    items = list(boards)
    if options.websdk_mode == "file" and len(items) > 1:
        raise ValueError("A Web SDK file can only be used when importing a single board.")
    emit = _Emitter(on_event)
    results: list[ImportResult | None] = [None] * len(items)

    def done(index: int, board: ResolvedBoard | None, result: ImportResult) -> None:
        results[index] = _finish(emit, board, result)

    def finish_batch() -> list[ImportResult]:
        final = [r for r in results if r is not None]
        emit("batch_finished", counts=_counts(final), exit_code=batch_exit_code(final),
             message=f"Finished {len(final)} board(s).")
        return final

    def ref_of(item: ResolvedBoard | str) -> str:
        return item.ref or item.board_id if isinstance(item, ResolvedBoard) else str(item)

    try:
        token = token_provider()
    except (miro_auth.NotConnected, miro_auth.TokenRefreshFailed, CredentialStoreUnavailable) as exc:
        for index, item in enumerate(items):
            board = item if isinstance(item, ResolvedBoard) else None
            result = _not_connected_result(exc, ref_of(item))
            result.board_id = board.board_id if board else _direct_id(item)
            done(index, board, result)
        return finish_batch()
    emit.add_secret(token)

    # Resolve references; list boards at most once, and only if a name needs it.
    resolved: dict[int, ResolvedBoard] = {}
    listing: list[dict[str, Any]] | None = None
    listing_error: Exception | None = None
    names_present = any(
        not isinstance(item, ResolvedBoard) and _safe_direct_id(item) is None for item in items
    )
    if names_present:
        try:
            listing = list_boards(token)
        except Exception as exc:  # noqa: BLE001
            listing_error = exc
    for index, item in enumerate(items):
        if isinstance(item, ResolvedBoard):
            resolved[index] = item
            continue
        ref = str(item)
        try:
            if listing_error is not None and _safe_direct_id(item) is None:
                raise listing_error
            resolved[index] = resolve_boards([ref], token=token, boards=listing)[0]
        except BoardResolutionError as exc:
            done(
                index,
                None,
                ImportResult(
                    "failed",
                    ref=ref,
                    reason=exc.reason,
                    message=_clip(str(exc), 1500),
                    next_step=(
                        f"Run `{PROGRAM} boards` and pass the exact board id or URL with --board."
                    ),
                ),
            )
        except Exception as exc:  # noqa: BLE001 - listing boards failed
            result = _failure_result(exc, board=None, name=None, websdk_used=False, emit=emit)
            result.ref = ref
            done(index, None, result)

    pending = [(i, b) for i, b in sorted(resolved.items())]
    if not pending:
        return finish_batch()

    with ExitStack() as stack:
        server = None
        server_error: str | None = None
        if options.websdk_mode in ("auto", "required"):
            try:
                server = stack.enter_context(capture_server_factory())
            except CaptureError as exc:
                server_error = emit.clean(exc)
            except Exception as exc:  # noqa: BLE001
                server_error = emit.clean(f"{type(exc).__name__}: {exc}")
        batch = _Batch(
            options.websdk_mode,
            float(options.capture_timeout_seconds),
            options.open_board,
            token,
            emit,
            server,
            server_error,
            opener,
            websdk_file=options.websdk if isinstance(options.websdk, Path) else None,
        )
        for index, board in pending:
            try:
                result = _import_board(batch, options, board)
            except Exception as exc:  # noqa: BLE001 - last line of defence for the batch
                result = _failure_result(
                    exc, board=board, name=board.name, websdk_used=False, emit=emit
                )
            done(index, board, result)
    return finish_batch()


def _safe_direct_id(item: ResolvedBoard | str) -> str | None:
    if isinstance(item, ResolvedBoard):
        return item.board_id
    try:
        return parse_board_ref(str(item))
    except BoardResolutionError:
        return None


def _direct_id(item: ResolvedBoard | str) -> str | None:
    return _safe_direct_id(item)


def run_capture(
    board: ResolvedBoard | str,
    *,
    timeout_seconds: float = DEFAULT_CAPTURE_TIMEOUT_SECONDS,
    open_board: bool = True,
    on_event: EventCallback | None = None,
    token_provider: Callable[[], str] | None = None,
    capture_server_factory: Callable[[], Any] | None = None,
    opener: Callable[[str], Any] | None = None,
) -> ImportResult:
    """Obtain a validated Web SDK capture of one board and report where it is.

    ``artifact_path`` of the result is the capture file. No REST export runs and
    no Miro token is needed unless ``board`` is a name. ``needs_user`` (with
    reason ``websdk_capture_timeout``) means the app icon must be clicked.
    """
    token_provider = token_provider or miro_auth.get_access_token
    capture_server_factory = capture_server_factory or CaptureServer
    emit = _Emitter(on_event)
    resolved: ResolvedBoard | None = board if isinstance(board, ResolvedBoard) else None
    ref = board.ref if isinstance(board, ResolvedBoard) else str(board)
    if resolved is None:
        try:
            direct = parse_board_ref(str(board))
            if direct is not None:
                resolved = ResolvedBoard(direct, ref=ref)
            else:
                try:
                    token = token_provider()
                except (miro_auth.NotConnected, miro_auth.TokenRefreshFailed, CredentialStoreUnavailable) as exc:
                    return _finish(emit, None, _not_connected_result(exc, ref))
                emit.add_secret(token)
                resolved = resolve_boards([ref], token=token)[0]
        except BoardResolutionError as exc:
            return _finish(
                emit,
                None,
                ImportResult(
                    "failed",
                    ref=ref,
                    reason=exc.reason,
                    message=_clip(str(exc), 1500),
                    next_step=f"Run `{PROGRAM} boards` and pass the exact board id or URL with --board.",
                ),
            )
        except Exception as exc:  # noqa: BLE001
            result = _failure_result(exc, board=None, name=None, websdk_used=False, emit=emit)
            result.ref = ref
            return _finish(emit, None, result)
    with ExitStack() as stack:
        server = None
        server_error: str | None = None
        try:
            server = stack.enter_context(capture_server_factory())
        except CaptureError as exc:
            server_error = emit.clean(exc)
        batch = _Batch(
            "required", float(timeout_seconds), open_board, "", emit, server, server_error, opener
        )
        emit("board_started", board_id=resolved.board_id, board_name=resolved.name,
             message=f"Capturing {resolved.label()}.")
        outcome = _acquire_capture(batch, resolved, resolved.name)
    if outcome.result is not None:
        result = outcome.result
    else:
        result = ImportResult(
            "complete",
            board_id=resolved.board_id,
            board_name=resolved.name,
            ref=ref,
            message="A fresh Web SDK capture is stored.",
            next_step=f"Run `{PROGRAM} import --board {resolved.board_id} --vault <vault>` within "
            f"{FRESH_CAPTURE_MAX_AGE_MINUTES:g} minutes to use it.",
            artifact_path=str(outcome.path),
            websdk_used=True,
        )
    return _finish(emit, resolved, result)


# ---------------------------------------------------------------------------
# Doctor
# ---------------------------------------------------------------------------


def _section(fn: Callable[[], Any]) -> Any:
    try:
        return fn()
    except Exception as exc:  # noqa: BLE001 - doctor reports problems, never raises them
        return {"error": type(exc).__name__}


def _package_version() -> str:
    try:
        from importlib.metadata import version

        return version("miro-2-obsidian")
    except Exception:  # noqa: BLE001
        return "unknown"


def _probe_port(port: int) -> dict[str, Any]:
    """``free``, ``websdk_server`` (our handoff server answers) or ``in_use``."""
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=0.5):
            pass
    except OSError:
        return {"port": port, "state": "free"}
    try:
        opener = build_opener(ProxyHandler({}))
        with opener.open(f"http://127.0.0.1:{port}/api/session", timeout=2) as response:
            data = json.loads(response.read(65536))
        if isinstance(data, dict) and data.get("app") == API_APP_NAME:
            return {"port": port, "state": "websdk_server"}
    except Exception:  # noqa: BLE001
        pass
    return {"port": port, "state": "in_use"}


def _fresh_capture_count() -> dict[str, Any]:
    from miro2obsidian.websdk_capture import _capture_files, _capture_time

    root = paths.default_capture_dir()
    info: dict[str, Any] = {
        "dir": str(root),
        "exists": root.is_dir(),
        "fresh_count": 0,
        "max_age_minutes": FRESH_CAPTURE_MAX_AGE_MINUTES,
    }
    if not root.is_dir():
        return info
    cutoff = datetime.now(timezone.utc).timestamp() - FRESH_CAPTURE_MAX_AGE_MINUTES * 60
    count = 0
    for board_dir in root.iterdir():
        if board_dir.is_dir():
            count += sum(1 for p in _capture_files(board_dir) if _capture_time(p) >= cutoff)
    info["fresh_count"] = count
    return info


def _playwright_browsers_dir() -> Path:
    override = os.environ.get("PLAYWRIGHT_BROWSERS_PATH")
    if override and override != "0":
        return Path(override)
    if os.name == "nt":
        return Path(os.environ.get("LOCALAPPDATA") or Path.home() / "AppData" / "Local") / "ms-playwright"
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Caches" / "ms-playwright"
    return Path.home() / ".cache" / "ms-playwright"


def _browser_report() -> dict[str, Any]:
    import importlib.util

    root = _playwright_browsers_dir()
    try:
        downloaded = any(root.glob("chromium-*")) if root.is_dir() else False
    except OSError:
        downloaded = False
    system = next(
        (
            n
            for n in ("chrome", "google-chrome", "chromium", "chromium-browser", "msedge", "microsoft-edge")
            if shutil.which(n)
        ),
        None,
    )
    try:
        webbrowser.get()
        default_ok = True
    except webbrowser.Error:
        default_ok = False
    return {
        "playwright_installed": importlib.util.find_spec("playwright") is not None,
        "playwright_chromium_downloaded": downloaded,
        "system_browser": system,
        "default_browser_available": default_ok,
    }


def _vault_report(vault_root: Path | None) -> dict[str, Any]:
    if vault_root is None:
        return {"checked": False}
    vault = Path(vault_root)
    exists = vault.is_dir()
    return {
        "checked": True,
        "path": str(vault),
        "exists": exists,
        "writable": bool(exists and os.access(vault, os.W_OK)),
        "has_obsidian_config": bool(exists and (vault / ".obsidian").is_dir()),
    }


def doctor(
    vault_root: Path | None = None, *, verify_online: bool = False
) -> dict[str, Any]:
    """A JSON-safe report of the environment with ordered ``next_steps``.

    Contains no token, secret or client id. ``verify_online`` additionally asks
    Miro whether the saved connection still works. Never raises for an
    environment problem; a failing check shows up as ``{"error": ...}``.
    """
    connection = _section(lambda: miro_auth.connection_status(verify_online=verify_online).to_dict())
    store_available = (
        connection.get("store_available", True) if isinstance(connection, dict) else True
    )
    ports = {
        "oauth_callback": _section(lambda: _probe_port(OAUTH_PORT)),
        "websdk": _section(lambda: _probe_port(DEFAULT_PORT)),
    }
    websdk_app = _section(
        lambda: {"present": True, "path": str(websdk_directory())}
    )
    if isinstance(websdk_app, dict) and websdk_app.get("error") == "FileNotFoundError":
        websdk_app = {"present": False, "path": None}
    vault = _section(lambda: _vault_report(vault_root))
    report: dict[str, Any] = {
        "version": _package_version(),
        "python": {
            "version": platform.python_version(),
            "executable": sys.executable,
            "platform": platform.platform(),
        },
        "frozen": bool(getattr(sys, "frozen", False)),
        "connection": connection,
        "credential_store": {"available": bool(store_available)},
        "ports": ports,
        "websdk_app": websdk_app,
        "captures": _section(_fresh_capture_count),
        "vault": vault,
        "browser": _section(_browser_report),
    }
    steps = _next_steps(report)
    report["ready"] = not any(s["blocking"] for s in steps)
    report["next_steps"] = [s["message"] for s in steps]
    return report


def _next_steps(report: dict[str, Any]) -> list[dict[str, Any]]:
    steps: list[dict[str, Any]] = []

    def add(message: str, *, blocking: bool = True) -> None:
        steps.append({"message": message, "blocking": blocking})

    vault = report.get("vault") or {}
    if vault.get("checked"):
        if not vault.get("exists"):
            add(f"The vault folder {vault.get('path')} does not exist. Ask the person for the right path.")
        elif not vault.get("writable"):
            add(f"The vault folder {vault.get('path')} is not writable for this user. Choose another folder or fix its permissions.")
        elif not vault.get("has_obsidian_config"):
            add(
                "The folder has no .obsidian directory, so it may not be an Obsidian vault. "
                "Confirm the path with the person.",
                blocking=False,
            )
    app = report.get("websdk_app") or {}
    if app.get("present") is False:
        add("The Miro Web SDK app files are missing from this installation. Reinstall miro2obsidian.")
    connection = report.get("connection") or {}
    store = report.get("credential_store") or {}
    if not connection.get("connected"):
        if connection.get("problem") and store.get("available") is not False:
            add(f"Miro connection problem: {connection['problem']}")
        if store.get("available") is False:
            add(
                "No operating system credential store is available. Ask the person to set the "
                "environment variable MIRO_ACCESS_TOKEN for the run, or install a keyring backend."
            )
        add(
            f"Miro is not connected. Run `{PROGRAM} setup guide` and relay each step to the person "
            f"(creating the Miro app is a human step), then run `{PROGRAM} auth login --form`."
        )
    elif connection.get("problem"):
        add(f"Miro connection warning: {connection['problem']}", blocking=False)
    ports = report.get("ports") or {}
    sdk = ports.get("websdk") or {}
    if sdk.get("state") == "in_use":
        add(
            f"Port {DEFAULT_PORT} is used by another program, so the Miro app cannot send "
            "captures. Stop that program; imports will otherwise be REST-only (degraded).",
            blocking=False,
        )
    oauth = ports.get("oauth_callback") or {}
    if oauth.get("state") in {"in_use", "websdk_server"}:
        add(
            f"Port {OAUTH_PORT} is busy; `{PROGRAM} auth login` needs it for Miro's redirect. "
            "Stop what is using it before connecting.",
            blocking=False,
        )
    if not steps:
        target = vault.get("path") if vault.get("checked") else "<vault>"
        add(
            f"Ready. List boards with `{PROGRAM} boards --json`, then run "
            f"`{PROGRAM} import --board <name, id or URL> --vault {target} --json`.",
            blocking=False,
        )
    elif not vault.get("checked"):
        add(f"Pass --vault <path> to `{PROGRAM} doctor` to check the Obsidian vault.", blocking=False)
    return steps
