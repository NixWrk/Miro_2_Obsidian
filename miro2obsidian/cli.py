"""Machine-readable commands for scripts and agents.

Dispatched from ``scripts.miro_pipeline.main`` when the first argument is one
of :data:`SUBCOMMANDS`. Every command except ``mcp`` (the stdio MCP server, see
:mod:`miro2obsidian.mcp_server`) accepts ``--json``: a single JSON object,
or JSON Lines for the streaming commands (``capture``, ``import``) which end
with ``{"event": "summary", "results": [...], "exit_code": n}``. Nothing here
ever prints a token, Client secret or board content, and secrets are never
accepted as command-line arguments.

Exit codes: 0 ok/complete, 2 degraded, 3 needs_user (a person must act),
1 failure or usage error. Argument errors exit 1 (not argparse's usual 2) so 2
always means "degraded".
"""

from __future__ import annotations

import argparse
import getpass
import json
import os
import sys
import webbrowser
from pathlib import Path
from typing import Any, Sequence

from Json_2_Canvas.output_formats import ADVANCED_CANVAS, OUTPUT_FORMATS
from Json_2_Canvas.Scale_engine import DEFAULT_FIT_MARGIN, ViewProfile
from miro2obsidian import app_setup, import_service, mcp_server, miro_auth
from miro2obsidian.agent_guide import AGENT_GUIDE
from miro2obsidian.credential_store import CredentialStoreUnavailable

SUBCOMMANDS = ("doctor", "setup", "auth", "boards", "capture", "import", "agent-guide", "mcp")
PROGRAM = "miro2obsidian"
CLIENT_ID_ENV = "MIRO_CLIENT_ID"
CLIENT_SECRET_ENV = "MIRO_CLIENT_SECRET"
DEFAULT_LOGIN_TIMEOUT = 300

EXIT_OK, EXIT_FAILED, EXIT_DEGRADED, EXIT_NEEDS_USER = 0, 1, 2, 3


class _Parser(argparse.ArgumentParser):
    """Usage errors exit 1; exit code 2 is reserved for "degraded"."""

    def error(self, message: str) -> None:  # type: ignore[override]
        self.print_usage(sys.stderr)
        sys.stderr.write(f"{self.prog}: error: {message}\n")
        raise SystemExit(EXIT_FAILED)


def _out(text: str = "") -> None:
    print(text, flush=True)


def _json_out(payload: Any) -> None:
    print(json.dumps(payload, ensure_ascii=False, default=str), flush=True)


def _json_flag(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--json", action="store_true", help="Machine-readable output.")


def build_parser() -> argparse.ArgumentParser:
    parser = _Parser(
        prog=PROGRAM,
        description="Set up Miro access and import boards into an Obsidian vault.",
    )
    sub = parser.add_subparsers(dest="command", required=True, parser_class=_Parser)

    doc = sub.add_parser("doctor", help="Report the environment and what to do next.")
    doc.add_argument("--vault", type=Path, help="Obsidian vault folder to check.")
    doc.add_argument("--verify", action="store_true", help="Also ask Miro whether the saved connection works.")
    _json_flag(doc)

    setup = sub.add_parser("setup", help="Create your own Miro app (checklist and manifest).")
    setup_sub = setup.add_subparsers(dest="setup_command", required=True, parser_class=_Parser)
    for name, helptext in (
        ("guide", "Print the step-by-step checklist."),
        ("manifest", "Print the Miro app manifest (YAML)."),
        ("open", "Open the Miro Developer Hub in the browser."),
    ):
        leaf = setup_sub.add_parser(name, help=helptext)
        _json_flag(leaf)
        if name != "open":
            leaf.add_argument("--app-name", default=app_setup.DEFAULT_APP_NAME)
            leaf.add_argument("--sdk-port", type=int, default=app_setup.DEFAULT_SDK_PORT)
            leaf.add_argument("--oauth-port", type=int, default=app_setup.DEFAULT_OAUTH_PORT)

    auth = sub.add_parser("auth", help="Connect, check or forget the Miro connection.")
    auth_sub = auth.add_subparsers(dest="auth_command", required=True, parser_class=_Parser)
    status = auth_sub.add_parser("status", help="Show whether Miro is connected.")
    status.add_argument("--verify", action="store_true", help="Ask Miro whether the token works.")
    _json_flag(status)
    login = auth_sub.add_parser(
        "login",
        help=(
            f"Connect your Miro app. Credentials come from {CLIENT_ID_ENV}/{CLIENT_SECRET_ENV}, "
            "a hidden prompt, or --form; never from arguments."
        ),
    )
    login.add_argument("--form", action="store_true", help="Enter the credentials in a local browser form.")
    login.add_argument("--no-browser", action="store_true", help="Print URLs instead of opening a browser.")
    login.add_argument("--timeout", type=int, default=DEFAULT_LOGIN_TIMEOUT, help="Seconds to wait for approval.")
    _json_flag(login)
    logout = auth_sub.add_parser("logout", help="Forget the saved connection.")
    logout.add_argument("--no-revoke", action="store_true", help="Do not ask Miro to revoke the token.")
    _json_flag(logout)

    boards = sub.add_parser("boards", help="List boards visible to the connected app.")
    boards.add_argument("--query", help="Only boards whose name contains this text.")
    _json_flag(boards)

    capture = sub.add_parser("capture", help="Obtain a Web SDK capture of one board.")
    capture.add_argument("--board", required=True, metavar="REF", help="Board id, URL or name.")
    capture.add_argument("--timeout", type=float, default=import_service.DEFAULT_CAPTURE_TIMEOUT_SECONDS)
    capture.add_argument("--no-open", action="store_true", help="Do not open the board in the browser.")
    _json_flag(capture)

    imp = sub.add_parser("import", help="Import boards into a vault.")
    imp.add_argument("--board", action="append", default=[], metavar="REF", help="Board id, URL or name (repeatable).")
    imp.add_argument("--boards-file", type=Path, help="File with one board reference per line; # starts a comment.")
    imp.add_argument("--vault", type=Path, required=True)
    imp.add_argument("--folder", help="Folder for the boards, relative to the vault or absolute inside it (default: Miro).")
    imp.add_argument("--format", dest="output_format", choices=list(OUTPUT_FORMATS), default=ADVANCED_CANVAS)
    imp.add_argument(
        "--websdk",
        default="auto",
        metavar="auto|required|skip|PATH",
        help="auto: use the Miro app's capture when possible; required: never fall back to REST only; "
        "skip: REST only; or the path of a capture file.",
    )
    imp.add_argument("--capture-timeout", type=float, default=import_service.DEFAULT_CAPTURE_TIMEOUT_SECONDS)
    imp.add_argument("--no-open", action="store_true", help="Do not open boards in the browser.")
    imp.add_argument("--source-dir", type=Path, help="Where board JSON is kept (default: <vault>/_miro_sources).")
    imp.add_argument("--attachment-dir", type=Path)
    imp.add_argument("--keep-board-attachments", action="store_true")
    imp.add_argument("--install-obsidian-plugins", action="store_true")
    imp.add_argument("--stable-items", action="store_true", help="Use stable v2 items instead of v2-experimental.")
    imp.add_argument("--scale", type=float)
    view = ViewProfile()
    imp.add_argument("--scale-mode", choices=["balanced", "overview", "readable"], default=view.scale_mode)
    imp.add_argument("--viewport-width", type=int, default=view.width)
    imp.add_argument("--viewport-height", type=int, default=view.height)
    imp.add_argument("--min-zoom", type=float, default=view.min_zoom)
    imp.add_argument("--fit-margin", type=float, default=DEFAULT_FIT_MARGIN)
    imp.add_argument("--min-node-width", type=int, default=view.min_node_w)
    imp.add_argument("--min-node-height", type=int, default=view.min_node_h)
    imp.add_argument("--min-font-px", type=int, default=view.min_font_px)
    imp.add_argument("--theme", choices=["dark", "light"], default="dark")
    imp.add_argument("--text-style-mode", choices=["miro", "obsidian"], default="miro")
    _json_flag(imp)

    guide = sub.add_parser("agent-guide", help="Print the procedure for AI agents.")
    _json_flag(guide)

    mcp = sub.add_parser(
        "mcp",
        help="Run the MCP server (stdio) so MCP-capable agents can set up and run imports.",
        description="Run the Model Context Protocol server on stdin/stdout, or print the configuration "
        "that registers it with an MCP client.",
    )
    mcp.add_argument("--print-config", action="store_true", help="Print a ready-to-use client configuration and exit.")
    mcp.add_argument(
        "--client",
        choices=list(mcp_server.CLIENT_CHOICES),
        default="generic",
        help="Which client --print-config targets (default: generic mcpServers JSON).",
    )
    return parser


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------


def _read_refs(boards: Sequence[str], boards_file: Path | None) -> list[str]:
    refs = [b.strip() for b in boards if b and b.strip()]
    if boards_file is not None:
        for line in Path(boards_file).read_text(encoding="utf-8-sig").splitlines():
            line = line.strip()
            if line and not line.startswith("#"):
                refs.append(line)
    return refs


def _resolve_folder(vault: Path, folder: str | None) -> Path:
    if not folder:
        return vault / import_service.DEFAULT_FOLDER_NAME
    path = Path(folder)
    if not path.is_absolute():
        path = vault / path
    return path


def _result_exit(result: import_service.ImportResult) -> int:
    return import_service.exit_code_for_status(result.status)


def _print_result_text(result: dict[str, Any]) -> None:
    label = result.get("board_name") or result.get("board_id") or result.get("ref") or "board"
    _out(f"[{result['status']}] {label}")
    if result.get("message"):
        _out(f"  {result['message']}")
    for warning in result.get("warnings") or []:
        _out(f"  warning: {warning}")
    if result.get("artifact_path"):
        _out(f"  file: {result['artifact_path']}")
    if result.get("source_json"):
        _out(f"  source: {result['source_json']}")
    if result.get("reason"):
        _out(f"  reason: {result['reason']}")
    if result.get("next_step"):
        _out(f"  next: {result['next_step']}")


def _stream_printer(as_json: bool):
    def on_event(event: dict[str, Any]) -> None:
        if as_json:
            _json_out(event)
            return
        kind = event.get("event")
        if kind == "step":
            _out(f"  {event.get('message', '')}")
        elif kind == "board_started":
            _out(f"{event.get('message', '')}")

    return on_event


def _finish_results(results: Sequence[import_service.ImportResult], as_json: bool) -> int:
    code = import_service.batch_exit_code(results)
    dicts = [r.to_dict() for r in results]
    if as_json:
        _json_out({"event": "summary", "results": dicts, "exit_code": code})
    else:
        for item in dicts:
            _print_result_text(item)
    return code


def _problem(result: import_service.ImportResult, as_json: bool) -> int:
    """Report a single failure/needs_user result for non-streaming commands."""
    if as_json:
        _json_out(result.to_dict())
    else:
        _print_result_text(result.to_dict())
    return _result_exit(result)


# ---------------------------------------------------------------------------
# commands
# ---------------------------------------------------------------------------


def _cmd_doctor(args: argparse.Namespace) -> int:
    report = import_service.doctor(args.vault, verify_online=args.verify)
    if args.json:
        _json_out(report)
    else:
        conn = report.get("connection") or {}
        _out(f"miro2obsidian {report.get('version')} (Python {report['python']['version']})")
        _out(f"Miro connection: {conn.get('message') or ('connected' if conn.get('connected') else 'not connected')}")
        sdk = (report.get("websdk_app") or {})
        _out(f"Web SDK app files: {'present' if sdk.get('present') else 'MISSING'}")
        ports = report.get("ports") or {}
        for key, label in (("oauth_callback", "OAuth port"), ("websdk", "Web SDK port")):
            info = ports.get(key) or {}
            _out(f"{label} {info.get('port')}: {info.get('state')}")
        vault = report.get("vault") or {}
        if vault.get("checked"):
            _out(
                f"Vault {vault.get('path')}: exists={vault.get('exists')} "
                f"writable={vault.get('writable')} obsidian_config={vault.get('has_obsidian_config')}"
            )
        _out("Next steps:")
        for index, step in enumerate(report["next_steps"], 1):
            _out(f"  {index}. {step}")
    return EXIT_OK if report.get("ready") else EXIT_NEEDS_USER


def _cmd_setup(args: argparse.Namespace) -> int:
    if args.setup_command == "open":
        try:
            opened = bool(webbrowser.open(app_setup.DEVELOPER_HUB_URL))
        except Exception:  # noqa: BLE001
            opened = False
        if args.json:
            _json_out({"opened": opened, "url": app_setup.DEVELOPER_HUB_URL})
        else:
            _out(
                "Opened the Miro Developer Hub in your browser."
                if opened
                else f"Could not open a browser. Open this page yourself: {app_setup.DEVELOPER_HUB_URL}"
            )
        return EXIT_OK
    try:
        kwargs = {"app_name": args.app_name, "sdk_port": args.sdk_port, "oauth_port": args.oauth_port}
        if args.setup_command == "manifest":
            manifest = app_setup.app_manifest_yaml(**kwargs)
            if args.json:
                _json_out({"manifest": manifest})
            else:
                sys.stdout.write(manifest)
            return EXIT_OK
        steps = app_setup.setup_steps(**kwargs)
    except ValueError as exc:
        sys.stderr.write(f"{PROGRAM}: error: {exc}\n")
        return EXIT_FAILED
    if args.json:
        _json_out({"steps": steps})
        return EXIT_OK
    _out("Create your own Miro app (one time). Miro's screen labels may differ slightly from these.")
    for number, step in enumerate(steps, 1):
        _out("")
        _out(f"{number}. {step['title']}" + ("" if step["actor"] == "person" else "  [run by the program]"))
        _out(f"   {step['instructions']}")
        if step.get("url"):
            _out(f"   Open: {step['url']}")
        for label, value in step["copy_values"].items():
            if "\n" in value:
                _out(f"   {label}:")
                for line in value.rstrip("\n").splitlines():
                    _out(f"       {line}")
            else:
                _out(f"   {label}: {value}")
    return EXIT_OK


def _scrub(text: str, *secrets: str) -> str:
    for secret in secrets:
        if secret:
            text = text.replace(secret, "***")
    return text


def _cmd_auth_status(args: argparse.Namespace) -> int:
    try:
        status = miro_auth.connection_status(verify_online=args.verify)
    except Exception as exc:  # noqa: BLE001
        return _problem(import_service.error_result(exc), args.json)
    payload = status.to_dict()
    if not status.connected:
        payload["next_step"] = import_service.CONNECT_COMMANDS
    if args.json:
        _json_out(payload)
    else:
        _out(status.message)
        if status.problem and status.problem != status.message:
            _out(f"Problem: {status.problem}")
        if not status.connected:
            _out(f"Next: {import_service.CONNECT_COMMANDS}")
    return EXIT_OK if status.connected else EXIT_NEEDS_USER


def _prompt_credentials() -> tuple[str, str] | None:
    if not sys.stdin.isatty():
        return None
    client_id = input("Miro Client ID: ").strip()
    client_secret = getpass.getpass("Miro Client secret (hidden): ").strip()
    return (client_id, client_secret) if client_id and client_secret else None


def _login_needs_user(args: argparse.Namespace, message: str, next_step: str, reason: str) -> int:
    result = import_service.ImportResult("needs_user", reason=reason, message=message, next_step=next_step)
    return _problem(result, args.json)


def _cmd_auth_login(args: argparse.Namespace) -> int:
    def authorize_url(url: str) -> None:
        if args.json:
            _json_out({"event": "authorize_url", "url": url})
        elif args.no_browser:
            _out(f"Open this URL in your browser and approve access: {url}")
        else:
            _out("Waiting for you to approve access in Miro (a browser window should have opened).")

    if args.form:
        return _login_with_form(args)

    client_id = os.environ.get(CLIENT_ID_ENV, "").strip()
    client_secret = os.environ.get(CLIENT_SECRET_ENV, "").strip()
    if not (client_id and client_secret):
        prompted = _prompt_credentials()
        if prompted is None:
            return _login_needs_user(
                args,
                "No Miro credentials are available to this command.",
                f"Run `{PROGRAM} auth login --form` (the person enters the credentials in a local "
                f"browser form), or set {CLIENT_ID_ENV} and {CLIENT_SECRET_ENV} in the environment "
                "yourself before running this command. Never pass them as arguments.",
                "not_connected",
            )
        client_id, client_secret = prompted
    try:
        status = miro_auth.connect_with_credentials(
            client_id,
            client_secret,
            open_browser=not args.no_browser,
            on_authorize_url=authorize_url,
            timeout_seconds=args.timeout,
        )
    except CredentialStoreUnavailable:
        return _login_needs_user(
            args,
            "Miro approved the app, but no operating system credential store is available to save the connection.",
            "Install a supported keyring backend, or set MIRO_ACCESS_TOKEN for each run.",
            "not_connected",
        )
    except TimeoutError:
        return _login_needs_user(
            args,
            f"Access was not approved in Miro within {args.timeout} seconds.",
            f"Run `{PROGRAM} auth login` again and approve access in the browser window.",
            "not_connected",
        )
    except Exception as exc:  # noqa: BLE001 - never echo secrets
        text = _scrub(f"{type(exc).__name__}: {exc}", client_id, client_secret)
        result = import_service.ImportResult(
            "failed",
            reason="error",
            message=text[:500],
            next_step=(
                "Check the Client ID and Client secret, that the redirect URI "
                "http://localhost:8765/callback is set in the Miro app, and that port 8765 is free "
                f"(`{PROGRAM} doctor`)."
            ),
        )
        return _problem(result, args.json)
    return _report_connected(args, status.to_dict())


def _report_connected(args: argparse.Namespace, payload: dict[str, Any]) -> int:
    if args.json:
        _json_out({"event": "connected", **payload})
    else:
        _out(payload.get("message") or "Miro is connected.")
    return EXIT_OK if payload.get("connected") else EXIT_NEEDS_USER


def _login_with_form(args: argparse.Namespace) -> int:
    from miro2obsidian import browser_setup

    def report(url: str) -> None:
        if args.json:
            _json_out({"event": "form_url", "url": url})
        elif args.no_browser:
            _out(f"Open this form in your browser and paste your Client ID and Client secret there: {url}")
        else:
            _out(f"Opened a local form in your browser ({url}). Paste your Client ID and Client secret "
                 "there, then approve access in Miro.")

    state = browser_setup.run_form(
        open_browser=not args.no_browser,
        timeout_seconds=args.timeout,
        report=report,
    )
    if state.status == "complete":
        try:
            payload = miro_auth.connection_status().to_dict()
        except Exception:  # noqa: BLE001
            payload = {"connected": True, "message": "Miro is connected."}
        return _report_connected(args, payload)
    if state.status == "failed":
        result = import_service.ImportResult(
            "failed",
            reason="error",
            message=f"The connection failed ({state.error or 'unknown error'}).",
            next_step=(
                "Check the Client ID and Client secret, that the redirect URI "
                "http://localhost:8765/callback is set in the Miro app, and that port 8765 is free; "
                f"then run `{PROGRAM} auth login --form` again."
            ),
        )
        return _problem(result, args.json)
    return _login_needs_user(
        args,
        f"The form was not completed within {args.timeout} seconds.",
        f"Run `{PROGRAM} auth login --form` again and finish the form and the approval in Miro.",
        "not_connected",
    )


def _cmd_auth_logout(args: argparse.Namespace) -> int:
    try:
        revoked = miro_auth.disconnect(revoke=not args.no_revoke)
    except CredentialStoreUnavailable:
        return _login_needs_user(
            args,
            "No operating system credential store is available, so nothing was saved or removed.",
            "Nothing to do; unset MIRO_ACCESS_TOKEN if you used it.",
            "not_connected",
        )
    payload = {"disconnected": True, "revoked": bool(revoked)}
    if args.json:
        _json_out(payload)
    else:
        _out("Forgot the saved Miro connection." + (" Miro confirmed the revocation." if revoked else ""))
    return EXIT_OK


def _cmd_auth(args: argparse.Namespace) -> int:
    return {"status": _cmd_auth_status, "login": _cmd_auth_login, "logout": _cmd_auth_logout}[
        args.auth_command
    ](args)


def _cmd_boards(args: argparse.Namespace) -> int:
    try:
        token = miro_auth.get_access_token()
    except (miro_auth.NotConnected, miro_auth.TokenRefreshFailed, CredentialStoreUnavailable) as exc:
        return _problem(import_service.not_connected_result(exc), args.json)
    try:
        boards = import_service.list_boards(token, query=args.query)
    except Exception as exc:  # noqa: BLE001
        return _problem(import_service.error_result(exc, secrets=[token]), args.json)
    if args.json:
        _json_out({"boards": boards, "count": len(boards)})
    elif not boards:
        _out("No boards found. The app sees only boards of the team it is installed in.")
    else:
        for board in boards:
            team = f"  [{board['team']}]" if board.get("team") else ""
            _out(f"{board['id']}  {board['name']}{team}")
            if board.get("viewLink"):
                _out(f"    {board['viewLink']}")
    return EXIT_OK


def _cmd_capture(args: argparse.Namespace) -> int:
    result = import_service.run_capture(
        args.board,
        timeout_seconds=args.timeout,
        open_board=not args.no_open,
        on_event=_stream_printer(args.json),
    )
    if args.json:
        _json_out({"event": "summary", "results": [result.to_dict()], "exit_code": _result_exit(result)})
    elif result.status == "complete":
        _out(f"capture={result.artifact_path}")
    else:
        _print_result_text(result.to_dict())
    return _result_exit(result)


def _cmd_import(args: argparse.Namespace, parser: argparse.ArgumentParser) -> int:
    try:
        refs = _read_refs(args.board, args.boards_file)
    except (OSError, UnicodeError) as exc:
        parser.error(f"cannot read --boards-file: {exc}")
    if not refs:
        parser.error("give at least one --board REF or a --boards-file")
    vault = args.vault
    if not vault.is_dir():
        parser.error(f"the vault folder does not exist: {vault}")
    folder = _resolve_folder(vault, args.folder)
    view = ViewProfile(
        width=args.viewport_width,
        height=args.viewport_height,
        min_zoom=args.min_zoom,
        fit_margin=args.fit_margin,
        min_node_w=args.min_node_width,
        min_node_h=args.min_node_height,
        min_font_px=args.min_font_px,
        scale_mode=args.scale_mode,
    )
    try:
        options = import_service.ImportOptions(
            vault_root=vault,
            target_dir=folder,
            output_format=args.output_format,
            websdk=args.websdk,
            capture_timeout_seconds=args.capture_timeout,
            open_board=not args.no_open,
            source_dir=args.source_dir,
            share_attachments=not args.keep_board_attachments,
            install_obsidian_plugins=args.install_obsidian_plugins,
            attachment_dir=args.attachment_dir,
            scale=args.scale,
            view_profile=view,
            min_font_px=args.min_font_px,
            theme=args.theme,
            text_style_mode=args.text_style_mode,
            prefer_experimental=not args.stable_items,
        )
        results = import_service.run_imports(refs, options, on_event=_stream_printer(args.json))
    except ValueError as exc:
        parser.error(str(exc))
    return _finish_results(results, args.json)


def _cmd_agent_guide(args: argparse.Namespace) -> int:
    if args.json:
        _json_out({"guide": AGENT_GUIDE})
    else:
        sys.stdout.write(AGENT_GUIDE)
    return EXIT_OK


def _cmd_mcp(args: argparse.Namespace) -> int:
    if args.print_config:
        sys.stdout.write(mcp_server.render_config(args.client))
        return EXIT_OK
    return mcp_server.serve_stdio()


def main(argv: Sequence[str] | None = None) -> int:
    """Run a subcommand; returns the process exit code."""
    parser = build_parser()
    try:
        args = parser.parse_args(list(sys.argv[1:] if argv is None else argv))
    except SystemExit as exc:
        return exc.code if isinstance(exc.code, int) else EXIT_FAILED
    handlers = {
        "doctor": _cmd_doctor,
        "setup": _cmd_setup,
        "auth": _cmd_auth,
        "boards": _cmd_boards,
        "capture": _cmd_capture,
        "agent-guide": _cmd_agent_guide,
        "mcp": _cmd_mcp,
    }
    try:
        if args.command == "import":
            return _cmd_import(args, parser)
        return handlers[args.command](args)
    except SystemExit as exc:
        return exc.code if isinstance(exc.code, int) else EXIT_FAILED
    except KeyboardInterrupt:
        sys.stderr.write("Interrupted.\n")
        return EXIT_FAILED


if __name__ == "__main__":
    raise SystemExit(main())
