"""Run any local agent through a small JSON protocol, with Codex as a fallback."""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Sequence
from urllib.parse import urlsplit

from miro2obsidian.browser_bridge import BrowserLoginRequired, start_browser_bridge
from miro2obsidian.schema import CURRENT_SCHEMA_VERSION, validate_board
from scripts.merge_miro_sources import validate_canonical_export


AGENT_RESULT_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": ["status", "artifact_path", "source_json"],
    "properties": {
        "status": {"type": "string", "enum": ["complete", "needs_user", "failed"]},
        "artifact_path": {"type": ["string", "null"]},
        "source_json": {"type": ["string", "null"]},
        "reason": {
            "type": ["string", "null"],
            "enum": ["login", "mfa", "admin_approval", "browser_unavailable", "agent_network_unavailable", "other", None],
        },
    },
}
# Codex structured output requires every declared property in ``required``.
# Generic adapters may omit reason, so their protocol keeps the optional field.
CODEX_RESULT_SCHEMA = {**AGENT_RESULT_SCHEMA, "required": [*AGENT_RESULT_SCHEMA["required"], "reason"]}
AGENT_COMMAND_ENV = "MIRO2OBSIDIAN_AGENT_COMMAND"
BROWSER_MODE_ENV = "MIRO2OBSIDIAN_AGENT_BROWSER"
_BROWSER_PROBE_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": ["browser"],
    "properties": {"browser": {"type": "string", "enum": ["ready", "blocked", "unavailable"]}},
}


@dataclass(frozen=True)
class AgentOutcome:
    status: str
    artifact_path: Path | None = None
    source_json: Path | None = None
    reason: str | None = None


def _canonical_board_url(board_url: str) -> str:
    parsed = urlsplit(board_url)
    match = re.fullmatch(r"/app/board/([A-Za-z0-9_=-]+)/?", parsed.path)
    if (
        parsed.scheme != "https"
        or parsed.netloc.lower() != "miro.com"
        or parsed.query
        or parsed.fragment
        or not match
    ):
        raise ValueError("Agent mode needs a valid https://miro.com/app/board/... URL.")
    return f"https://miro.com/app/board/{match.group(1)}/"


def build_agent_prompt(
    *,
    board_url: str,
    target_dir: Path,
    vault_root: Path,
    output_format: str,
    source_checkout: bool = True,
    browser_cdp_url: str | None = None,
) -> str:
    """Give the agent paths and rules, never OAuth credentials or tokens."""
    board_url = _canonical_board_url(board_url)
    repository_hint = (
        "Read AGENTS.md and the miro2obsidian-import skill first. "
        if source_checkout
        else "Use the installed miro2obsidian CLI and its documented export workflow. "
    )
    browser_hint = (
        "A dedicated Chromium browser is already open on the target board. "
        f"Connect to {browser_cdp_url} over CDP using Playwright; this loopback "
        "endpoint is available for this run only. Use the existing browser page "
        "and profile, not a new browser or the chat's in-app browser. "
        "If Miro requires first sign-in, allow the account owner time to finish "
        "it in that window before reporting needs_user. "
        if browser_cdp_url else
        "First take a read-only browser control snapshot. If no browser UI tool "
        "works, return needs_user with reason browser_unavailable immediately. "
    )
    raw_export = output_format == "raw-json"
    destination_hint = (
        f"Export root: {json.dumps(str(vault_root))}\n"
        f"Export folder: {json.dumps(str(target_dir))}\n"
        if raw_export else
        f"Vault root: {json.dumps(str(vault_root))}\n"
        f"Canvas folder: {json.dumps(str(target_dir))}\n"
    )
    return (
        ("Complete the standalone Miro Full Exporter export. " if raw_export else "Complete the Miro to Obsidian import. ") + repository_hint +
        "The user has authorized a live "
        "export and work in the selected destination. Preserve unrelated changes. "
        "Never read, print, persist, or request Miro secrets or tokens; if the "
        "existing authenticated browser permits it, transfer app credentials "
        "only with UI Copy/Paste controls. Reuse a working Miro app before "
        "creating another. Do not commit or push.\n"
        f"Board URL: {json.dumps(board_url)}\n"
        + destination_hint +
        f"Output format: {json.dumps(output_format)}\n"
        "Use the strict REST export, Web SDK whole-board capture when accessible, "
        "canonical merge and asset checks. "
        + ("Write JSON and its attachment sidecar; Obsidian and Canvas are not required. " if raw_export else "Validate the written Canvas. ") +
        "Operate the Miro "
        "browser UI yourself for app setup and Web SDK export where possible. "
        + browser_hint +
        "If login, MFA, or administrator approval prevents progress, return "
        "needs_user with the matching reason. Do not claim maximum coverage without a verified Web SDK "
        "capture. Return only the requested JSON status, absolute artifact "
        "path, and absolute canonical source_json path. Save the canonical JSON "
        + ("inside the selected export folder. " if raw_export else "inside the selected vault. ") +
        "Use null paths unless complete."
    )


def _source_checkout(repo_root: Path) -> bool:
    return (repo_root / "AGENTS.md").is_file() and (
        repo_root / ".agents" / "skills" / "miro2obsidian-import" / "SKILL.md"
    ).is_file()


def _child_env() -> dict[str, str]:
    """An agent receives paths and instructions, not ambient Miro credentials."""
    return {key: value for key, value in os.environ.items() if not (
        key.upper().startswith("MIRO_") and ("TOKEN" in key.upper() or "SECRET" in key.upper() or "CLIENT_ID" in key.upper())
    )}


def parse_agent_command(raw: str) -> list[str]:
    """Parse an argument vector without involving a platform-specific shell."""
    try:
        command = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise ValueError("Agent command must be a JSON array of arguments.") from exc
    if not isinstance(command, list) or not command or any(
        not isinstance(part, str) or not part for part in command
    ):
        raise ValueError("Agent command must be a nonempty JSON array of strings.")
    return command


def _configured_command(command: Sequence[str] | None) -> list[str] | None:
    if command is None:
        raw = os.environ.get(AGENT_COMMAND_ENV, "").strip()
        if not raw:
            return None
        command = parse_agent_command(raw)
    if not isinstance(command, (list, tuple)) or not command or any(
        not isinstance(part, str) or not part for part in command
    ):
        raise ValueError("Agent command must be a nonempty JSON array of strings.")
    executable = shutil.which(command[0])
    if not executable:
        raise RuntimeError("Configured agent executable was not found.")
    return [executable, *command[1:]]


def _pipeline_command() -> list[str]:
    if getattr(sys, "frozen", False):
        name = "miro2obsidian.exe" if os.name == "nt" else "miro2obsidian"
        gui_executable = Path(sys.executable)
        candidates = [gui_executable.with_name(name)]
        if sys.platform == "darwin" and gui_executable.parent.name == "MacOS":
            candidates.append(gui_executable.parents[3] / name)
        for executable in candidates:
            if executable.is_file():
                return [str(executable)]
        raise RuntimeError("The packaged CLI executable is missing beside the GUI.")
    return [sys.executable, "-m", "scripts.miro_pipeline"]


def _verified_source(path_text: str, *, vault_root: Path, board_url: str) -> Path:
    source = Path(path_text).resolve(strict=True)
    if not source.is_file() or not source.is_relative_to(vault_root.resolve()):
        raise ValueError("Agent canonical source must be inside the selected vault.")
    board_id = _canonical_board_url(board_url).split("/app/board/", 1)[1].strip("/")
    payload = json.loads(source.read_text(encoding="utf-8-sig"))
    validate_canonical_export(payload, expected_board_id=board_id)
    return source


def _verified_artifact(
    path_text: str, *, target_dir: Path, vault_root: Path, output_format: str
) -> Path:
    path = Path(path_text).resolve(strict=True)
    if not path.is_file() or not path.is_relative_to(target_dir.resolve()):
        raise ValueError("Agent artifact must be a file inside the selected Canvas folder.")
    if output_format == "raw-json":
        if path.suffix.lower() != ".json":
            raise ValueError("Agent output is not a JSON export.")
        payload = json.loads(path.read_text(encoding="utf-8-sig"))
        completeness = payload.get("completeness") if isinstance(payload, dict) else None
        if not isinstance(completeness, dict) or completeness.get("complete") is not True:
            raise ValueError("Agent JSON export is incomplete.")
    else:
        if path.suffix.lower() != ".canvas":
            raise ValueError("Agent output is not a Canvas.")
        board = json.loads(path.read_text(encoding="utf-8-sig"))
        issues = validate_board(board, version=CURRENT_SCHEMA_VERSION)
        if issues:
            raise ValueError(f"Agent Canvas failed validation: {issues[0]}")
        for node in board.get("nodes", []):
            if node.get("type") != "file":
                continue
            reference = node.get("file")
            if not isinstance(reference, str):
                raise ValueError("Agent Canvas has an invalid file reference.")
            asset = (vault_root / reference).resolve()
            if not asset.is_relative_to(vault_root.resolve()) or not asset.is_file():
                raise ValueError("Agent Canvas references a missing or outside-vault file.")
    return path


def _verified_outcome(
    result: object, *, board_url: str, target_dir: Path, vault_root: Path, output_format: str
) -> AgentOutcome:
    if not isinstance(result, dict) or result.get("status") not in {"complete", "needs_user", "failed"}:
        raise ValueError("The agent returned an invalid status.")
    if not {"artifact_path", "source_json"}.issubset(result) or set(result) - {
        "status", "artifact_path", "source_json", "reason"
    }:
        raise ValueError("The agent response does not match the result protocol.")
    reason = result.get("reason")
    if reason not in {None, "login", "mfa", "admin_approval", "browser_unavailable", "agent_network_unavailable", "other"}:
        raise ValueError("The agent returned an invalid reason.")
    if result["status"] != "complete":
        if result["artifact_path"] is not None or result["source_json"] is not None:
            raise ValueError("An incomplete agent run cannot claim output files.")
        return AgentOutcome(result["status"], reason=reason)
    if not isinstance(result.get("artifact_path"), str):
        raise ValueError("The agent did not return an artifact path.")
    if not isinstance(result.get("source_json"), str):
        raise ValueError("The agent did not return a canonical source path.")
    source = _verified_source(result["source_json"], vault_root=vault_root, board_url=board_url)
    artifact = _verified_artifact(
        result["artifact_path"],
        target_dir=target_dir,
        vault_root=vault_root,
        output_format=output_format,
    )
    return AgentOutcome("complete", artifact, source)


def _codex_browser_probe(executable: str, working_directory: Path) -> str:
    """Distinguish an unavailable browser from a blocked agent connection."""
    with tempfile.TemporaryDirectory(prefix="miro2obsidian-browser-probe-") as temp:
        schema_path = Path(temp) / "schema.json"
        result_path = Path(temp) / "result.json"
        diagnostics_path = Path(temp) / "diagnostics.log"
        schema_path.write_text(json.dumps(_BROWSER_PROBE_SCHEMA), encoding="utf-8")
        command = [
            executable, "exec", "--ephemeral", "--approve-for-me", "-C", str(working_directory),
            "--output-schema", str(schema_path), "--output-last-message", str(result_path), "-",
        ]
        try:
            with diagnostics_path.open("wb") as diagnostics:
                completed = subprocess.run(
                    command,
                    input=(
                        "Check whether a browser UI automation tool can take one read-only browser "
                        "state snapshot in this session. Do not visit Miro or read credentials. "
                        "Return ready if it works, blocked if it errors, unavailable if no tool exists. "
                        "Return only schema JSON."
                    ),
                    text=True,
                    stdout=subprocess.DEVNULL,
                    stderr=diagnostics,
                    timeout=60,
                    check=False,
                    env=_child_env(),
                )
        except subprocess.TimeoutExpired:
            return _probe_failure_reason(diagnostics_path)
        if completed.returncode != 0 or not result_path.is_file():
            return _probe_failure_reason(diagnostics_path)
        try:
            result = json.loads(result_path.read_text(encoding="utf-8"))
            return "ready" if result.get("browser") == "ready" else "browser_unavailable"
        except (json.JSONDecodeError, OSError):
            return _probe_failure_reason(diagnostics_path)


def _probe_failure_reason(diagnostics_path: Path) -> str:
    try:
        with diagnostics_path.open("rb") as diagnostics:
            diagnostics.seek(max(0, diagnostics.seek(0, os.SEEK_END) - 4096))
            tail = diagnostics.read().decode("utf-8", errors="replace").lower()
    except OSError:
        return "browser_unavailable"
    network_errors = ("waiting for network", "os error 10013", "connection failed: error sending request")
    return "agent_network_unavailable" if any(error in tail for error in network_errors) else "browser_unavailable"


def run_agent(
    *,
    board_url: str,
    target_dir: Path,
    vault_root: Path,
    output_format: str,
    repo_root: Path,
    timeout_seconds: int = 1800,
    command: Sequence[str] | None = None,
    on_status: Callable[[str], None] | None = None,
    _browser_cdp_url: str | None = None,
) -> AgentOutcome:
    """Use a JSON-stdio agent adapter, or the bundled Codex CLI adapter."""
    repo_root = repo_root.resolve()
    target_dir = target_dir.resolve()
    vault_root = vault_root.resolve()
    if not target_dir.is_relative_to(vault_root):
        raise ValueError("Canvas folder must be inside the selected vault.")
    browser_mode = os.environ.get(BROWSER_MODE_ENV, "managed").strip().lower()
    if browser_mode not in {"managed", "external"}:
        raise ValueError(f"{BROWSER_MODE_ENV} must be managed or external.")
    if browser_mode == "managed" and _browser_cdp_url is None:
        try:
            with start_browser_bridge(_canonical_board_url(board_url), on_status=on_status) as browser:
                return run_agent(
                    board_url=board_url,
                    target_dir=target_dir,
                    vault_root=vault_root,
                    output_format=output_format,
                    repo_root=repo_root,
                    timeout_seconds=timeout_seconds,
                    command=command,
                    on_status=on_status,
                    _browser_cdp_url=browser.cdp_url,
                )
        except BrowserLoginRequired:
            return AgentOutcome("needs_user", reason="login")
    if on_status:
        on_status("Agent 2/3: exporting Miro sources." if output_format == "raw-json" else "Agent 2/3: exporting Miro sources and building Canvas.")
    prompt = build_agent_prompt(
        board_url=board_url,
        target_dir=target_dir,
        vault_root=vault_root,
        output_format=output_format,
        source_checkout=_source_checkout(repo_root),
        browser_cdp_url=_browser_cdp_url,
    )
    pipeline_command = _pipeline_command()
    custom_command = _configured_command(command)
    if custom_command is not None:
        agent_cwd = repo_root if _source_checkout(repo_root) else vault_root
        request = {
            "protocol_version": 1,
            "board_url": _canonical_board_url(board_url),
            "target_dir": str(target_dir),
            "vault_root": str(vault_root),
            "output_format": output_format,
            "working_directory": str(agent_cwd),
            "pipeline_command": pipeline_command,
            "websdk_server_command": [*pipeline_command, "websdk-serve", "--port", "8766"],
            "browser_cdp_url": _browser_cdp_url,
            "prompt": prompt,
            "result_schema": AGENT_RESULT_SCHEMA,
        }
        try:
            completed = subprocess.run(
                custom_command,
                input=json.dumps(request),
                text=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                timeout=timeout_seconds,
                check=False,
                cwd=agent_cwd,
                env=_child_env(),
            )
        except subprocess.TimeoutExpired:
            raise TimeoutError("The agent did not finish the Miro import in time.") from None
        if completed.returncode != 0:
            raise RuntimeError("The configured agent failed; check its local diagnostics.")
        if len(completed.stdout) > 65536:
            raise ValueError("The agent response is too large.")
        try:
            result = json.loads(completed.stdout)
        except json.JSONDecodeError:
            raise ValueError("The agent did not return valid JSON.") from None
        return _verified_outcome(
            result,
            board_url=board_url,
            target_dir=target_dir,
            vault_root=vault_root,
            output_format=output_format,
        )

    executable = shutil.which("codex")
    if not executable:
        raise RuntimeError(
            f"No agent configured. Set {AGENT_COMMAND_ENV} or install the Codex CLI."
        )
    agent_cwd = repo_root if _source_checkout(repo_root) else vault_root
    if _browser_cdp_url is None:
        probe_result = _codex_browser_probe(executable, agent_cwd)
        if probe_result != "ready":
            return AgentOutcome("needs_user", reason=probe_result)
    with tempfile.TemporaryDirectory(prefix="miro2obsidian-agent-") as temp:
        schema_path = Path(temp) / "result.schema.json"
        result_path = Path(temp) / "result.json"
        schema_path.write_text(json.dumps(CODEX_RESULT_SCHEMA), encoding="utf-8")
        command = [
            executable,
            "exec",
            "--ephemeral",
            "--approve-for-me",
            "-C",
            str(agent_cwd),
            "--output-schema",
            str(schema_path),
            "--output-last-message",
            str(result_path),
            "-",
        ]
        if not vault_root.is_relative_to(agent_cwd):
            command[2:2] = ["--add-dir", str(vault_root)]
        try:
            completed = subprocess.run(
                command,
                input=prompt,
                text=True,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=timeout_seconds,
                check=False,
                env=_child_env(),
            )
        except subprocess.TimeoutExpired:
            raise TimeoutError("The agent did not finish the Miro import in time.") from None
        if completed.returncode != 0 or not result_path.is_file():
            raise RuntimeError("Codex could not finish Agent mode. Check sign-in and browser tools.")
        result = json.loads(result_path.read_text(encoding="utf-8"))
    return _verified_outcome(
        result,
        board_url=board_url,
        target_dir=target_dir,
        vault_root=vault_root,
        output_format=output_format,
    )
