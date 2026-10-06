from __future__ import annotations

import os
import json
import re
import threading
import webbrowser
from dataclasses import dataclass
from pathlib import Path
from miro2obsidian.desktop_ui import filedialog, messagebox
from typing import Callable

from miro2obsidian import desktop_ui as ctk


REPO_ROOT = Path(__file__).resolve().parent
SCRIPTS_DIR = REPO_ROOT / "scripts"
MIRO_JSON_DIR = REPO_ROOT / "Miro_2_Json"
CONVERTER_DIR = REPO_ROOT / "Json_2_Canvas"
DEFAULT_EXPORT_ROOT = Path.home() / "Documents" / "Miro 2 Obsidian"
BOARD_LIST_ENV = "MIRO_BOARD_LIST"

from Json_2_Canvas.output_formats import (  # noqa: E402
    ADVANCED_CANVAS,
    MIRO_CANVAS,
    NATIVE_CANVAS,
    OUTPUT_FORMATS,
    RAW_JSON,
)
from Json_2_Canvas.Scale_engine import ViewProfile  # noqa: E402
from Miro_2_Json.miro_downloader import get_boards  # noqa: E402
from miro2obsidian.app_setup import MIRO_APPS_URL  # noqa: E402
from scripts.miro_oauth_token import (  # noqa: E402
    OAuthConfig,
    authorize_and_get_token,
    callback_recovery_hint,
    config_from_env,
    session_oauth_config,
)
from miro2obsidian.agent_runner import parse_agent_command, run_agent  # noqa: E402
from miro2obsidian.credential_store import (  # noqa: E402
    CredentialStoreUnavailable,
    clear_access_token,
    load_access_token,
    save_access_token,
)
from miro2obsidian.application import (  # noqa: E402
    pipeline_result_is_degraded,
    run_existing_json_pipeline,
    run_rest_experimental_pipeline,
)
from scripts.obsidian_vault_settings import resolve_vault_paths  # noqa: E402


ACCOUNT_SOURCE_MODE = "Miro account"
URL_SOURCE_MODE = "Miro URL"
URL_LIST_SOURCE_MODE = "Miro URL list"
JSON_SOURCE_MODE = "Existing JSON"
MIRO_EXPORT_MODES = {ACCOUNT_SOURCE_MODE, URL_SOURCE_MODE, URL_LIST_SOURCE_MODE}
ZOOM_UNLOCKED_MIN_ZOOM = "0.000244140625"
MANUAL_WORKFLOW = "Manual"
CODE_WORKFLOW = "Code automation"
AGENT_WORKFLOW = "Agent"
WORKFLOW_HINTS = {
    MANUAL_WORKFLOW: "You control Miro and may supply a downloaded Web SDK JSON.",
    CODE_WORKFLOW: "Code exports REST, assets, and Canvas; steps appear in the log.",
    AGENT_WORKFLOW: "A configured agent handles browser steps; the app validates its output.",
}
BOARD_URL_RE = re.compile(r"https://miro\.com/app/board/(?P<id>[^/?#)]+)", flags=re.IGNORECASE)


def board_id_from_text(value: str) -> str:
    value = value.strip()
    match = BOARD_URL_RE.search(value)
    if match:
        return match.group("id")
    return value


def default_web_board_list() -> Path | None:
    configured = os.environ.get(BOARD_LIST_ENV, "").strip()
    if not configured:
        return None
    path = Path(configured).expanduser()
    return path if path.is_file() else None


def board_refs_from_markdown(path: Path) -> list[tuple[str, str]]:
    refs: list[tuple[str, str]] = []
    seen: set[str] = set()
    text = path.read_text(encoding="utf-8-sig")
    link_re = re.compile(r"\[(?P<label>[^\]]+)\]\((?P<url>https://miro\.com/app/board/(?P<id>[^/?#)]+)[^)]*)\)")
    for match in link_re.finditer(text):
        board_id = match.group("id")
        if board_id in seen:
            continue
        seen.add(board_id)
        refs.append((board_id, match.group("label").strip() or board_id))
    return refs


def board_refs_from_file(path: Path) -> list[tuple[str, str]]:
    if path.suffix.lower() == ".json":
        import json

        payload = json.loads(path.read_text(encoding="utf-8-sig"))
        boards = payload.get("boards") if isinstance(payload, dict) else payload
        if not isinstance(boards, list):
            return []
        refs: list[tuple[str, str]] = []
        for board in boards:
            if isinstance(board, dict) and board.get("id"):
                refs.append((str(board["id"]), str(board.get("name") or board["id"])))
        return refs
    return board_refs_from_markdown(path)


def safe_name(value: str) -> str:
    cleaned = re.sub(r"[^0-9A-Za-z._=-]+", "_", value.strip())
    cleaned = re.sub(r"_+", "_", cleaned).strip("._ ")
    return cleaned or "board"


def board_output_name(label: str, board_id: str) -> str:
    return f"{safe_name(label)}_{safe_name(board_id)}"


def default_source_json_path(target_text: str, label: str, board_id: str) -> Path:
    base = Path(target_text.strip()) if target_text.strip() else DEFAULT_EXPORT_ROOT
    return base / "_miro_sources" / f"{board_output_name(label, board_id)}.json"


@dataclass(frozen=True)
class ConversionOptions:
    scale: float | None
    theme: str
    text_style_mode: str
    output_format: str
    allow_missing_assets: bool
    prefer_experimental: bool
    install_obsidian_plugins: bool
    share_attachments: bool = True


#: One line under the Format menu saying what the selected format is for.
FORMAT_HINTS = {
    ADVANCED_CANVAS: "For the Advanced Canvas plugin: extended Canvas styling.",
    NATIVE_CANVAS: "Plain Obsidian, no plugin required: Markdown text, no HTML.",
    MIRO_CANVAS: "For the miro-canvas plugin: draws the Miro look from the source board.",
    RAW_JSON: "Portable Miro export: JSON, comments, attachments and provenance. No Obsidian required.",
}


def _name_from_payload(value: object) -> str:
    if isinstance(value, dict):
        return str(value.get("name") or value.get("title") or value.get("id") or "").strip()
    return ""


def board_label(board: dict) -> str:
    name = str(board.get("name") or board.get("id") or "board")
    team = _name_from_payload(board.get("team"))
    collection = (
        _name_from_payload(board.get("project"))
        or _name_from_payload(board.get("collection"))
        or _name_from_payload(board.get("folder"))
    )
    context = " / ".join(part for part in (team, collection) if part)
    prefix = f"{context} - " if context else ""
    return f"{prefix}{name} ({board.get('id')})"


def explain_code_step(message: str) -> str | None:
    if message.startswith("Exporting the complete board through"):
        return "Code: requesting all board items, comments, and required assets from Miro."
    if message.startswith("Merging verified Web SDK export:"):
        return "Code: checking the Web SDK capture and merging it with REST data."
    if message.startswith("Converting through the single Converter.py path"):
        return "Code: converting the checked source into an Obsidian Canvas."
    if message.startswith("Canvas written:"):
        return "Code: Canvas written; checking output format and attachments."
    return None


def show_error_later(after: Callable[[int, Callable[[], None]], object], title: str, error: BaseException) -> None:
    message = str(error)
    after(0, lambda: messagebox.showerror(title, message))


def authorize_gui_token(
    logger: Callable[[str], None] | None = None,
    *,
    config: OAuthConfig | None = None,
) -> str:
    def log(message: str) -> None:
        if logger:
            logger(message)

    token = os.environ.get("MIRO_ACCESS_TOKEN") if config is None else None
    if token:
        log("Using MIRO_ACCESS_TOKEN from environment.")
        return token

    try:
        config = config or config_from_env()
    except ValueError as exc:
        raise RuntimeError(
            "Direct Miro export needs credentials. Use Set up Miro app in this GUI, "
            "or configure MIRO_CLIENT_ID and MIRO_CLIENT_SECRET for your own Miro app. "
            "Existing JSON works without Miro auth. "
            "MIRO_ACCESS_TOKEN is only a developer shortcut when it came from your own app. "
            "The old Miro->JSON GUI looked app-free only because bundled app secrets existed."
        ) from exc

    log("Starting OAuth from configured Miro app credentials.")
    hint = callback_recovery_hint(config)
    if hint:
        log(hint)
    return authorize_and_get_token(config)


class MiroPipelineApp(ctk.CTk):
    def __init__(self) -> None:
        super().__init__()
        self.title("Miro Full Exporter")
        self.geometry("1360x920")
        self.minsize(1150, 760)

        self.token: str | None = os.environ.get("MIRO_ACCESS_TOKEN")
        self.oauth_config: OAuthConfig | None = None
        self._credential_saved_in_session = False
        self.active_workflow_mode = MANUAL_WORKFLOW
        self.agent_command_spec: list[str] | None = None
        self.token_lock = threading.Lock()
        self.boards_by_label: dict[str, dict] = {}
        self.selected_account_board_id = ""

        self._build_ui()
        self._log("Ready. Default path: Miro board -> REST experimental JSON + assets -> Canvas.")

    def _build_ui(self) -> None:
        from miro2obsidian.desktop_wizard import GuidedWorkflow

        self.guided = GuidedWorkflow(self)
        scenario, source, destination, progress = self.guided.pages

        for column in range(4):
            scenario.grid_columnconfigure(column, weight=1 if column == 1 else 0)

        pad = {"padx": 10, "pady": 7}

        title = ctk.CTkLabel(scenario, text="Bring your boards home.", font=ctk.CTkFont(size=28, weight="bold"))
        title.grid(row=0, column=0, columnspan=2, sticky="w", padx=12, pady=(16, 10))
        ctk.CTkLabel(scenario, text="Workflow").grid(row=0, column=2, sticky="e", **pad)
        self.workflow_mode = ctk.CTkOptionMenu(
            scenario,
            values=[MANUAL_WORKFLOW, CODE_WORKFLOW, AGENT_WORKFLOW],
            command=self.guided.workflow_changed,
            width=180,
        )
        self.workflow_mode.set(MANUAL_WORKFLOW)
        self.workflow_mode.grid(row=0, column=3, sticky="we", **pad)

        ctk.CTkLabel(source, text="Source").grid(row=1, column=0, sticky="e", **pad)
        self.source_mode = ctk.CTkOptionMenu(
            source,
            values=[ACCOUNT_SOURCE_MODE, URL_SOURCE_MODE, URL_LIST_SOURCE_MODE, JSON_SOURCE_MODE],
            command=self.guided.source_changed,
        )
        self.source_mode.set(ACCOUNT_SOURCE_MODE)
        self.source_mode.grid(row=1, column=1, columnspan=3, sticky="we", **pad)

        self.path_frame = ctk.CTkFrame(source, fg_color="transparent")
        self.path_frame.grid(row=2, column=0, columnspan=4, sticky="we")
        self.path_frame.grid_columnconfigure(1, weight=1)

        self.account_frame = ctk.CTkFrame(self.path_frame, fg_color="transparent")
        self.account_frame.grid_columnconfigure(1, weight=1)
        ctk.CTkLabel(self.account_frame, text="Board").grid(row=0, column=0, sticky="e", **pad)
        self.board_menu = ctk.CTkOptionMenu(self.account_frame, values=["Authenticate first"], command=self.on_board_selected)
        self.board_menu.grid(row=0, column=1, sticky="we", **pad)
        ctk.CTkButton(self.account_frame, text="Authenticate / refresh", width=170, command=self.authenticate_and_refresh_boards).grid(row=0, column=2, columnspan=2, **pad)
        ctk.CTkButton(self.account_frame, text="Switch Miro team", command=self.reauthorize_and_refresh_boards).grid(row=1, column=1, sticky="w", **pad)
        ctk.CTkButton(self.account_frame, text="Set up Miro app", variant="primary", width=170, command=self.open_miro_setup).grid(row=1, column=2, columnspan=2, **pad)
        ctk.CTkButton(self.account_frame, text="Forget saved token", command=self.forget_miro_connection).grid(row=2, column=2, columnspan=2, **pad)

        self.url_frame = ctk.CTkFrame(self.path_frame, fg_color="transparent")
        self.url_frame.grid_columnconfigure(1, weight=1)
        ctk.CTkLabel(self.url_frame, text="Board URL").grid(row=0, column=0, sticky="e", **pad)
        self.board_id = ctk.CTkEntry(self.url_frame, placeholder_text="https://miro.com/app/board/...")
        self.board_id.grid(row=0, column=1, columnspan=2, sticky="we", **pad)
        ctk.CTkButton(self.url_frame, text="Authenticate", width=130, command=self.authorize_oauth).grid(row=0, column=3, **pad)

        self.url_list_frame = ctk.CTkFrame(self.path_frame, fg_color="transparent")
        self.url_list_frame.grid_columnconfigure(1, weight=1)
        ctk.CTkLabel(self.url_list_frame, text="URL list").grid(row=0, column=0, sticky="e", **pad)
        self.url_list_path = ctk.CTkEntry(self.url_list_frame)
        self.url_list_path.grid(row=0, column=1, sticky="we", **pad)
        ctk.CTkButton(self.url_list_frame, text="Authenticate", width=130, command=self.authorize_oauth).grid(row=0, column=2, **pad)
        ctk.CTkButton(self.url_list_frame, text="Browse", width=130, command=self.pick_url_list).grid(row=0, column=3, **pad)

        self.json_frame = ctk.CTkFrame(self.path_frame, fg_color="transparent")
        self.json_frame.grid_columnconfigure(1, weight=1)
        ctk.CTkLabel(self.json_frame, text="JSON file").grid(row=0, column=0, sticky="e", **pad)
        self.json_path = ctk.CTkEntry(self.json_frame)
        self.json_path.grid(row=0, column=1, columnspan=2, sticky="we", **pad)
        ctk.CTkButton(self.json_frame, text="Browse", width=130, command=self.pick_json_file).grid(row=0, column=3, **pad)

        self.destination_label = ctk.CTkLabel(destination, text="Export folder")
        self.destination_label.grid(row=3, column=0, sticky="e", **pad)
        self.target_dir = ctk.CTkEntry(destination)
        self.target_dir.grid(row=3, column=1, columnspan=2, sticky="we", **pad)
        ctk.CTkButton(destination, text="Browse", width=130, command=self.pick_target_dir).grid(row=3, column=3, **pad)

        ctk.CTkLabel(destination, text="Vault root (auto)").grid(row=4, column=0, sticky="e", **pad)
        self.vault_root = ctk.CTkEntry(destination)
        self.vault_root.grid(row=4, column=1, columnspan=2, sticky="we", **pad)
        self.vault_root.configure(state="disabled")
        self.vault_root_button = ctk.CTkButton(destination, text="Auto", width=130)
        self.vault_root_button.grid(row=4, column=3, **pad)
        self.vault_root_button.configure(state="disabled")

        options = self.guided.advanced
        for column in range(4):
            options.grid_columnconfigure(column, weight=1 if column in {1, 3} else 0)

        ctk.CTkLabel(options, text="Scale mode").grid(row=0, column=0, sticky="e", padx=8, pady=8)
        self.scale_mode = ctk.CTkOptionMenu(options, values=["balanced", "overview", "readable"])
        self.scale_mode.set("readable")
        self.scale_mode.grid(row=0, column=1, columnspan=1, sticky="we", padx=8, pady=8)

        ctk.CTkLabel(options, text="Text").grid(row=0, column=2, sticky="e", padx=8, pady=8)
        self.text_style_mode = ctk.CTkOptionMenu(options, values=["miro", "obsidian"])
        self.text_style_mode.set("miro")
        self.text_style_mode.grid(row=0, column=3, columnspan=1, sticky="we", padx=8, pady=8)

        ctk.CTkLabel(options, text="Theme").grid(row=1, column=0, sticky="e", padx=8, pady=8)
        self.theme = ctk.CTkOptionMenu(options, values=["dark", "light"])
        self.theme.set("dark")
        self.theme.grid(row=1, column=1, columnspan=1, sticky="we", padx=8, pady=8)

        ctk.CTkLabel(options, text="Scale").grid(row=1, column=2, sticky="e", padx=8, pady=8)
        self.scale = ctk.CTkEntry(options, placeholder_text="auto")
        self.scale.grid(row=1, column=3, columnspan=1, sticky="we", padx=8, pady=8)

        ctk.CTkLabel(options, text="Min zoom").grid(row=2, column=0, sticky="e", padx=8, pady=(0, 8))
        self.min_zoom = ctk.CTkEntry(options)
        self.min_zoom.insert(0, ZOOM_UNLOCKED_MIN_ZOOM)
        self.min_zoom.grid(row=2, column=1, columnspan=1, sticky="we", padx=8, pady=(0, 8))

        ctk.CTkLabel(options, text="Min font").grid(row=2, column=2, sticky="e", padx=8, pady=(0, 8))
        self.min_font_px = ctk.CTkEntry(options)
        self.min_font_px.insert(0, "8")
        self.min_font_px.grid(row=2, column=3, columnspan=1, sticky="we", padx=8, pady=(0, 8))

        self.allow_missing_assets = ctk.BooleanVar(value=False)
        self.allow_missing_assets_checkbox = ctk.CTkCheckBox(
            self.guided.export_options,
            text="Allow degraded export/source",
            variable=self.allow_missing_assets,
        )
        self.allow_missing_assets_checkbox.grid(
            row=7, column=0, columnspan=2,
            sticky="w",
            padx=8,
            pady=(0, 8),
        )

        self.stable_items = ctk.BooleanVar(value=False)
        self.stable_items_checkbox = ctk.CTkCheckBox(
            self.guided.export_options,
            text="Use stable REST items",
            variable=self.stable_items,
        )
        self.stable_items_checkbox.grid(
            row=7, column=2, columnspan=2,
            sticky="w",
            padx=8,
            pady=(0, 8),
        )

        self.install_obsidian_plugins = ctk.BooleanVar(value=False)
        self.install_obsidian_plugins_checkbox = ctk.CTkCheckBox(
            options,
            text="Install Advanced Canvas + zoom unlock",
            variable=self.install_obsidian_plugins,
            command=self.on_install_plugins_changed,
        )
        self.install_obsidian_plugins_checkbox.grid(
            row=8, column=0, columnspan=4,
            sticky="w",
            padx=8,
            pady=(0, 8),
        )

        self.share_attachments = ctk.BooleanVar(value=True)
        self.share_attachments_checkbox = ctk.CTkCheckBox(
            options,
            text="Store identical attachments once",
            variable=self.share_attachments,
        )
        self.share_attachments_checkbox.grid(
            row=9, column=0, columnspan=4,
            sticky="w",
            padx=8,
            pady=(0, 8),
        )

        self.format_label = ctk.CTkLabel(destination, text="Format")
        self.format_label.grid(row=5, column=0, sticky="e", padx=8, pady=(0, 8))
        self.output_format = ctk.CTkOptionMenu(
            destination, values=list(OUTPUT_FORMATS), command=self.guided.format_changed
        )
        self.output_format.set(RAW_JSON)
        self.output_format.grid(row=5, column=1, columnspan=3, sticky="we", padx=8, pady=(0, 8))

        self.format_hint = ctk.CTkLabel(
            destination,
            text=FORMAT_HINTS[RAW_JSON],
            wraplength=700, justify="left",
            text_color="gray60",
            anchor="w",
        )
        self.format_hint.grid(
            row=6, column=0, columnspan=4, sticky="we", padx=8, pady=(0, 8)
        )

        ctk.CTkLabel(self.guided.sdk, text="Web SDK JSON").grid(row=5, column=0, sticky="e", padx=8, pady=(0, 8))
        self.websdk_path = ctk.CTkEntry(self.guided.sdk, placeholder_text="Optional whole-board download")
        self.websdk_path.grid(row=6, column=0, columnspan=3, sticky="we", padx=8, pady=(0, 8))
        ctk.CTkButton(self.guided.sdk, text="Browse", command=self.pick_websdk_file).grid(
            row=6, column=3, columnspan=1, sticky="we", padx=8, pady=(0, 8)
        )

        self.workflow_hint = ctk.CTkLabel(
            scenario, text=WORKFLOW_HINTS[MANUAL_WORKFLOW], anchor="w", text_color="gray60", wraplength=470, justify="left"
        )
        self.workflow_hint.grid(row=6, column=0, columnspan=4, sticky="we", padx=12, pady=(10, 8))
        self.agent_settings_button = ctk.CTkButton(
            scenario, text="Configure agent", command=self.open_agent_settings, state="disabled"
        )
        self.agent_settings_button.grid(row=7, column=0, columnspan=4, sticky="w", padx=12, pady=12)
        self.run_button = ctk.CTkButton(self.action_bar, text="Run pipeline", height=44, fg_color=ctk.COLORS["yellow"], hover_color="#f4cf3e", text_color="#242137", command=self.guided.start)
        self.run_button.grid(row=1, column=2, sticky="e", padx=10, pady=(10, 8))

        self.log = ctk.CTkTextbox(progress, height=150, localize=True)
        self.log.grid(row=8, column=0, columnspan=4, sticky="nsew", padx=10, pady=(4, 10))
        progress.grid_rowconfigure(8, weight=1)
        self.on_source_mode_changed(ACCOUNT_SOURCE_MODE)
        self.guided.finish()

    def _log(self, message: str) -> None:
        def append() -> None:
            self.log.configure(state="normal")
            self.log.insert("end", message + "\n")
            self.log.see("end")
            self.log.configure(state="disabled")

        self.after(0, append)

    def _set_busy(self, busy: bool) -> None:
        self.after(0, lambda: self.guided.set_busy(busy))

    def _set_entry(self, entry: ctk.CTkEntry, value: str, *, disabled: bool = False) -> None:
        entry.configure(state="normal")
        entry.delete(0, "end")
        entry.insert(0, value)
        if disabled:
            entry.configure(state="disabled")

    def _selected_board_label(self) -> str:
        if self.source_mode.get() == ACCOUNT_SOURCE_MODE:
            selected = self.board_menu.get()
            board = self.boards_by_label.get(selected)
            if board:
                return str(board.get("name") or board.get("id") or "board")
            return "board"
        value = board_id_from_text(self.board_id.get())
        return value or "board"

    def open_miro_setup(self) -> None:
        dialog = ctk.CTkToplevel(self)
        dialog.title("Set up your Miro app")
        dialog.geometry("760x590")
        dialog.transient(self)
        dialog.grid_columnconfigure(1, weight=1)
        ctk.CTkLabel(
            dialog,
            text=(
                "No app yet? Open Miro Settings > Your apps and click Create new app "
                "below the Developer Hub banner. Choose a Developer team, then set App URL to "
                "http://localhost:8766/index.html and OAuth redirect URI to "
                "http://localhost:8765/callback. Select boards:read and team:read, "
                "then install the app in the board's team. Leave 'Expire user "
                "authorization token' unchecked for unattended Code mode. "
                "Finish email sign-in and OAuth in the same browser. "
                "Enter Client ID and Client secret only after configuring the app."
            ),
            wraplength=520,
            justify="left",
        ).grid(row=0, column=0, columnspan=3, padx=16, pady=(18, 12), sticky="w")
        ctk.CTkLabel(dialog, text="Client ID").grid(row=3, column=0, padx=16, pady=8, sticky="e")
        client_id_entry = ctk.CTkEntry(dialog)
        client_id_entry.grid(row=3, column=1, padx=(16, 8), pady=8, sticky="we")
        ctk.CTkLabel(dialog, text="Client secret").grid(row=4, column=0, padx=16, pady=8, sticky="e")
        secret_entry = ctk.CTkEntry(dialog, show="*")
        secret_entry.grid(row=4, column=1, padx=(16, 8), pady=8, sticky="we")
        def paste_credential(entry: ctk.CTkEntry) -> None:
            try:
                value = dialog.clipboard_get()
            except Exception:  # noqa: BLE001
                messagebox.showerror("Miro app", "Clipboard is empty.", parent=dialog)
                return
            entry.delete(0, "end")
            entry.insert(0, value)

        ctk.CTkButton(
            dialog,
            text="Paste",
            width=70,
            command=lambda: paste_credential(client_id_entry),
        ).grid(row=3, column=2, padx=(0, 16), pady=8)
        ctk.CTkButton(
            dialog,
            text="Paste",
            width=70,
            command=lambda: paste_credential(secret_entry),
        ).grid(row=4, column=2, padx=(0, 16), pady=8)
        ctk.CTkLabel(
            dialog,
            text="These values stay in this program's memory for this session.",
            wraplength=580,
        ).grid(row=5, column=0, columnspan=3, padx=16, pady=8, sticky="w")

        def use_credentials() -> None:
            try:
                config = session_oauth_config(client_id_entry.get(), secret_entry.get())
            except ValueError as exc:
                messagebox.showerror("Miro app", str(exc), parent=dialog)
                return
            with self.token_lock:
                self.oauth_config = config
                self.token = None
                self._credential_saved_in_session = False
                self._clear_saved_token()
            secret_entry.delete(0, "end")
            dialog.destroy()
            self._log("Miro app credentials ready for this session.")
            self.authenticate_and_refresh_boards()

        ctk.CTkButton(
            dialog,
            text="Open Your apps",
            command=lambda: webbrowser.open(MIRO_APPS_URL),
        ).grid(row=1, column=0, columnspan=3, padx=16, pady=8, sticky="w")
        ctk.CTkButton(
            dialog, text="Connect", variant="primary", command=use_credentials
        ).grid(row=6, column=1, columnspan=2, padx=16, pady=16, sticky="we")
        credential_widgets = [child for child in dialog.winfo_children()
                              if child.grid_info().get("row", 0) >= 3]
        for child in credential_widgets:
            child.grid_remove()

        def show_credentials():
            for child in credential_widgets:
                child.grid()
            ready.grid_remove()
            client_id_entry.focus_set()

        ready = ctk.CTkButton(dialog, text="I have configured my Miro app — connect", command=show_credentials)
        ready.grid(row=2, column=0, columnspan=3, sticky="w", padx=16, pady=8)

    def _clear_saved_token(self) -> None:
        try:
            clear_access_token()
        except CredentialStoreUnavailable:
            self._log("No OS credential store is available; session token cleared.")

    def _authorize_token(self) -> str:
        with self.token_lock:
            mode = self.__dict__.get("active_workflow_mode", MANUAL_WORKFLOW)
            persistent = mode in {CODE_WORKFLOW, AGENT_WORKFLOW}
            if not self.token and persistent:
                try:
                    self.token = load_access_token()
                except CredentialStoreUnavailable as exc:
                    self._log(str(exc))
                if self.token:
                    self._credential_saved_in_session = True
                    self._log("Using the Miro token from the OS credential store.")
            if not self.token:
                self.token = authorize_gui_token(self._log, config=self.oauth_config)
            if persistent and not self.__dict__.get("_credential_saved_in_session", False):
                try:
                    save_access_token(self.token)
                except CredentialStoreUnavailable as exc:
                    self._log(f"Token available for this session only: {exc}")
                else:
                    self._credential_saved_in_session = True
                    self._log("Miro token saved in the OS credential store for future runs.")
            return self.token

    def _token(self) -> str:
        return self._authorize_token()

    def authorize_oauth(self) -> None:
        def worker() -> None:
            try:
                self.token = self._authorize_token()
                self._log("OAuth token obtained for this GUI session.")
            except Exception as exc:  # noqa: BLE001
                self._log(f"OAuth failed: {exc}")
                show_error_later(self.after, "OAuth failed", exc)

        threading.Thread(target=worker, daemon=True).start()

    def _apply_boards(self, boards: list[dict]) -> None:
        labels = []
        by_label: dict[str, dict] = {}
        sorted_boards = sorted(
            boards,
            key=lambda board: (
                _name_from_payload(board.get("team")).casefold(),
                _name_from_payload(board.get("project")).casefold(),
                str(board.get("name") or "").casefold(),
                str(board.get("id") or ""),
            ),
        )
        for board in sorted_boards:
            base_label = board_label(board)
            label = base_label
            suffix = 2
            while label in by_label:
                label = f"{base_label} #{suffix}"
                suffix += 1
            labels.append(label)
            by_label[label] = board
        self.boards_by_label = by_label
        self.after(0, lambda: self.board_menu.configure(values=labels or ["No boards available"]))
        if self.__dict__.get("guided") is not None:
            self.after(0, lambda: self.guided.boards_loaded(bool(labels)))
        if labels:
            self.after(0, lambda: self.board_menu.set(labels[0]))
            self.after(0, lambda: self.on_board_selected(labels[0]))
        team_keys = {
            str((board.get("team") or {}).get("id") or (board.get("team") or {}).get("name") or "")
            for board in boards
        }
        teams = len({team for team in team_keys if team})
        self._log(f"Loaded boards: {len(labels)} across {teams} team(s) visible to this Miro app/user.")

    def forget_miro_connection(self) -> None:
        with self.token_lock:
            self.token = None
            self._credential_saved_in_session = False
            self._clear_saved_token()
        self.boards_by_label = {}
        self.selected_account_board_id = ""
        self.board_menu.configure(values=["Authenticate first"])
        self.board_menu.set("Authenticate first")
        if self.__dict__.get("guided") is not None:
            self.guided.boards_loaded(False)
        self._log("Saved Miro token removed from the OS credential store.")

    def reauthorize_and_refresh_boards(self) -> None:
        with self.token_lock:
            self.token = None
            self._credential_saved_in_session = False
            self._clear_saved_token()
        self.boards_by_label = {}
        self.selected_account_board_id = ""
        self.board_menu.configure(values=["Authenticate first"])
        self.board_menu.set("Authenticate first")
        if self.__dict__.get("guided") is not None:
            self.guided.boards_loaded(False)
        self._log("Choose the team that owns the target board in Miro OAuth.")
        self.authenticate_and_refresh_boards()

    def authenticate_and_refresh_boards(self) -> None:
        def worker() -> None:
            try:
                token = self._token()
                if self.token:
                    self._log("Miro token ready for this GUI session.")
                self._apply_boards(get_boards(token))
            except Exception as exc:  # noqa: BLE001
                self._log(f"OAuth failed: {exc}")
                show_error_later(self.after, "OAuth failed", exc)

        threading.Thread(target=worker, daemon=True).start()

    def on_board_selected(self, label: str) -> None:
        board = self.boards_by_label.get(label)
        if not board:
            return
        self.selected_account_board_id = str(board.get("id") or "")
        self.fill_default_paths()

    def fill_default_paths(self) -> None:
        if self.source_mode.get() == URL_LIST_SOURCE_MODE:
            default_board_list = default_web_board_list()
            if not self.url_list_path.get().strip() and default_board_list:
                self._set_entry(self.url_list_path, str(default_board_list))
            return

    def pick_url_list(self) -> None:
        path = filedialog.askopenfilename(filetypes=[("Board lists", "*.md *.json"), ("All files", "*.*")])
        if path:
            self._set_entry(self.url_list_path, path)

    def pick_json_file(self) -> None:
        path = filedialog.askopenfilename(filetypes=[("JSON files", "*.json")])
        if path:
            self._set_entry(self.json_path, path)

    def pick_websdk_file(self) -> None:
        path = filedialog.askopenfilename(filetypes=[("Web SDK JSON", "*.json")])
        if path:
            self._set_entry(self.websdk_path, path)

    def on_workflow_mode_changed(self, mode: str) -> None:
        self.active_workflow_mode = mode
        self.workflow_hint.configure(text=WORKFLOW_HINTS.get(mode, ""))
        self.agent_settings_button.configure(state="normal" if mode == AGENT_WORKFLOW else "disabled")
        if mode == CODE_WORKFLOW:
            self._log("Code mode: REST and assets run automatically; the OS vault stores the token when available.")
        elif mode == AGENT_WORKFLOW:
            self._log("Agent mode: a configured local agent will handle browser-dependent steps.")
        else:
            self._log("Manual mode: choose each source and run the pipeline yourself.")

    def open_agent_settings(self) -> None:
        dialog = ctk.CTkToplevel(self)
        dialog.title("Agent command")
        dialog.geometry("760x300")
        dialog.transient(self)
        dialog.grab_set()
        ctk.CTkLabel(
            dialog,
            text="JSON argument array for any local agent adapter. Leave blank for the default.",
            wraplength=610,
        ).pack(fill="x", padx=16, pady=(16, 8))
        entry = ctk.CTkEntry(dialog)
        entry.pack(fill="x", padx=16, pady=8)
        if self.agent_command_spec:
            entry.insert(0, json.dumps(self.agent_command_spec))
        ctk.CTkLabel(
            dialog, text="Example: [\"python\", \"/path/to/adapter.py\"]. Never put secrets here.",
            text_color="gray60",
        ).pack(fill="x", padx=16, pady=4)

        def save_command() -> None:
            raw = entry.get().strip()
            try:
                command = parse_agent_command(raw) if raw else None
            except ValueError as exc:
                messagebox.showerror("Agent command", str(exc), parent=dialog)
                return
            self.agent_command_spec = command
            dialog.destroy()
            self._log("Agent command configured for this session." if command else "Using the default agent adapter.")

        ctk.CTkButton(dialog, text="Use", variant="primary", command=save_command).pack(pady=(4, 14))
        entry.focus_set()

    def pick_target_dir(self) -> None:
        path = filedialog.askdirectory()
        if path:
            self._set_entry(self.target_dir, path)
            if self.output_format.get() == RAW_JSON:
                self._set_entry(self.vault_root, "", disabled=True)
                self.fill_default_paths()
                return
            try:
                paths = resolve_vault_paths(Path(path))
                self._set_entry(self.vault_root, str(paths.vault_root), disabled=True)
                if paths.attachment_dir:
                    self._log(f"Attachments follow Obsidian setting: {paths.attachment_dir}")
                else:
                    self._log("No custom Obsidian attachment folder found; attachments stay beside the Canvas.")
            except Exception as exc:  # noqa: BLE001
                self._log(f"Vault autodetect failed: {exc}")
            self.fill_default_paths()

    def _parse_float_or_none(self, value: str) -> float | None:
        value = value.strip().replace(",", ".")
        return None if not value else float(value)

    def on_format_changed(self, format_value: str) -> None:
        self.format_hint.configure(text=FORMAT_HINTS.get(format_value, ""))

    def on_install_plugins_changed(self) -> None:
        if self.install_obsidian_plugins.get():
            self.scale_mode.set("readable")
            self.min_zoom.delete(0, "end")
            self.min_zoom.insert(0, ZOOM_UNLOCKED_MIN_ZOOM)
        elif self.min_zoom.get().strip() == ZOOM_UNLOCKED_MIN_ZOOM:
            self.scale_mode.set("balanced")
            self.min_zoom.delete(0, "end")
            self.min_zoom.insert(0, "0.12")

    def _show_path_frame(self, visible_frame: ctk.CTkFrame) -> None:
        for frame in (self.account_frame, self.url_frame, self.url_list_frame, self.json_frame):
            frame.grid_remove()
        visible_frame.grid(row=0, column=0, columnspan=4, sticky="we")

    def on_source_mode_changed(self, mode: str) -> None:
        self.allow_missing_assets.set(False)
        self.allow_missing_assets_checkbox.configure(
            text=(
                "Allow missing assets (degraded)"
                if mode in MIRO_EXPORT_MODES
                else "Allow incomplete/unverified JSON"
            )
        )
        self.allow_missing_assets_checkbox.grid(
            row=7, column=0, columnspan=2,
            sticky="w",
            padx=8,
            pady=(0, 8),
        )

        if mode == ACCOUNT_SOURCE_MODE:
            self._show_path_frame(self.account_frame)
            self.fill_default_paths()
        elif mode == URL_SOURCE_MODE:
            self._show_path_frame(self.url_frame)
        elif mode == URL_LIST_SOURCE_MODE:
            self._show_path_frame(self.url_list_frame)
            self.fill_default_paths()
        else:
            self._show_path_frame(self.json_frame)
        self.guided.context()

    def _run_one_board(
        self,
        *,
        board_id: str,
        label: str,
        source_json: Path,
        target_dir: Path,
        vault_root: Path | None,
        attachment_dir: Path | None,
        profile: ViewProfile,
        min_font_px: int,
        options: ConversionOptions,
        websdk_json: Path | None = None,
        narrate: bool = False,
    ):
        def log_step(message: str) -> None:
            if narrate:
                explanation = explain_code_step(message)
                if explanation:
                    self._log(explanation)
            self._log(f"{label}: {message}")

        return run_rest_experimental_pipeline(
            board_id=board_id,
            token=self._token(),
            source_json=source_json,
            target_dir=target_dir,
            vault_root=vault_root,
            scale=options.scale,
            view_profile=profile,
            min_font_px=min_font_px,
            theme=options.theme,
            text_style_mode=options.text_style_mode,
            output_format=options.output_format,
            allow_missing_assets=options.allow_missing_assets,
            prefer_experimental=options.prefer_experimental,
            install_obsidian_plugins=options.install_obsidian_plugins,
            attachment_dir=attachment_dir,
            share_attachments=options.share_attachments,
            websdk_json=websdk_json,
            logger=log_step,
        )

    def run_pipeline(self) -> None:
        try:
            source_mode = self.source_mode.get()
            workflow_mode = self.workflow_mode.get()
            target_text = self.target_dir.get().strip()
            if not target_text:
                raise ValueError("Choose an export folder first.")
            json_path_text = self.json_path.get().strip()
            websdk_path_text = self.websdk_path.get().strip() if source_mode in {ACCOUNT_SOURCE_MODE, URL_SOURCE_MODE} else ""
            if websdk_path_text and workflow_mode != AGENT_WORKFLOW and source_mode not in {ACCOUNT_SOURCE_MODE, URL_SOURCE_MODE}:
                raise ValueError("Web SDK JSON can be paired with one Miro board at a time.")
            if websdk_path_text and workflow_mode != AGENT_WORKFLOW and not Path(websdk_path_text).is_file():
                raise ValueError("Choose an existing whole-board Web SDK JSON file.")
            url_list_text = self.url_list_path.get().strip()
            board_text = self.board_id.get()
            account_board_id = self.selected_account_board_id
            account_label = self._selected_board_label() if source_mode == ACCOUNT_SOURCE_MODE else ""
            raw_export = self.output_format.get() == RAW_JSON
            min_font_px = 8 if raw_export else int(self.min_font_px.get().strip() or "8")
            profile = ViewProfile() if raw_export else ViewProfile(
                min_zoom=float(self.min_zoom.get().strip() or "0.12"),
                min_font_px=min_font_px,
                scale_mode=self.scale_mode.get(),
            )
            options = ConversionOptions(
                scale=None if raw_export else self._parse_float_or_none(self.scale.get()),
                theme=self.theme.get(),
                text_style_mode=self.text_style_mode.get(),
                output_format=self.output_format.get(),
                allow_missing_assets=self.allow_missing_assets.get(),
                prefer_experimental=not self.stable_items.get(),
                install_obsidian_plugins=(self.install_obsidian_plugins.get() and self.output_format.get() == ADVANCED_CANVAS),
                share_attachments=self.share_attachments.get(),
            )
            agent_command_spec = self.agent_command_spec
        except Exception as exc:  # noqa: BLE001
            self._log(f"Pipeline failed: {exc}")
            show_error_later(self.after, "Pipeline failed", exc)
            return

        self.run_button.configure(state="disabled")

        def worker() -> None:
            try:
                run_results = []
                target_dir = Path(target_text)
                if options.output_format == RAW_JSON:
                    vault_root = None
                    attachment_dir = None
                else:
                    vault_paths = resolve_vault_paths(target_dir)
                    vault_root = vault_paths.vault_root
                    attachment_dir = vault_paths.attachment_dir
                    self.after(0, lambda: self._set_entry(self.vault_root, str(vault_root), disabled=True))

                if workflow_mode == AGENT_WORKFLOW:
                    if source_mode not in {ACCOUNT_SOURCE_MODE, URL_SOURCE_MODE}:
                        raise ValueError("Agent mode currently needs one Miro board or board URL.")
                    board_id = (
                        account_board_id
                        if source_mode == ACCOUNT_SOURCE_MODE
                        else board_id_from_text(board_text)
                    )
                    if not board_id:
                        raise ValueError("Choose or paste a Miro board before starting Agent mode.")
                    self._log("Agent 1/3: opening a dedicated Miro browser profile for the agent.")
                    self._log("Agent browser: first sign-in or MFA may still need the account owner.")
                    outcome = run_agent(
                        board_url=f"https://miro.com/app/board/{board_id}/",
                        target_dir=target_dir,
                        vault_root=vault_root or target_dir,
                        output_format=options.output_format,
                        repo_root=REPO_ROOT,
                        command=agent_command_spec,
                        on_status=self._log,
                    )
                    if outcome.status == "needs_user":
                        if outcome.reason == "browser_unavailable":
                            message = (
                                "This agent session cannot control a signed-in browser. "
                                "Use Code automation for REST or configure an agent adapter "
                                "with browser access."
                            )
                        elif outcome.reason == "agent_network_unavailable":
                            message = (
                                "The agent cannot reach its service from this environment. "
                                "Check the agent's network access and retry."
                            )
                        elif outcome.reason == "login":
                            message = "Sign in to Miro in the dedicated browser, then retry Agent mode."
                        else:
                            message = "Check Miro sign-in, consent, and team approval; then retry."
                        self._log(f"Agent paused: {message}")
                        self.after(0, lambda message=message: messagebox.showwarning("Miro needs attention", message))
                    elif outcome.status == "failed":
                        raise RuntimeError("The agent could not complete the board export.")
                    else:
                        done_path = str(outcome.artifact_path)
                        self._log(f"Agent 3/3: validated result at {done_path}")
                        self.after(0, lambda: self.guided.show_result(
                            Path(done_path), outcome.source_json, options.output_format))
                    return

                if workflow_mode == CODE_WORKFLOW:
                    self._log("Code: checking the destination and selected source.")
                    if source_mode == JSON_SOURCE_MODE:
                        self._log("Code: reading local JSON; Miro access is unnecessary.")
                    elif not websdk_path_text:
                        self._log("Code: this run will use REST only; no Web SDK capture was selected.")

                if source_mode == JSON_SOURCE_MODE:
                    source_text = json_path_text
                    if not source_text:
                        raise ValueError("Choose a JSON file.")
                    result = run_existing_json_pipeline(
                        source_json=Path(source_text),
                        target_dir=target_dir,
                        vault_root=vault_root,
                        scale=options.scale,
                        view_profile=profile,
                        min_font_px=min_font_px,
                        theme=options.theme,
                        text_style_mode=options.text_style_mode,
                        allow_incomplete_source=options.allow_missing_assets,
                        output_format=options.output_format,
                        install_obsidian_plugins=options.install_obsidian_plugins,
                        attachment_dir=attachment_dir,
                        share_attachments=options.share_attachments,
                        logger=self._log,
                    )
                    run_results.append(result)
                elif source_mode == URL_LIST_SOURCE_MODE:
                    list_text = url_list_text
                    if not list_text:
                        raise ValueError("Choose a URL list file.")
                    list_path = Path(list_text)
                    refs = board_refs_from_file(list_path)
                    if not refs:
                        raise ValueError(f"No Miro board links found in {list_path}")
                    source_root = target_dir / "_miro_sources"
                    last_result = None
                    for index, (ref_id, label) in enumerate(refs, start=1):
                        output_name = board_output_name(label, ref_id)
                        board_dir = target_dir / output_name
                        board_json = source_root / f"{output_name}.json"
                        self._log(f"[{index}/{len(refs)}] Processing {label}")
                        last_result = self._run_one_board(
                            board_id=ref_id,
                            label=label,
                            source_json=board_json,
                            target_dir=board_dir,
                            vault_root=vault_root,
                            attachment_dir=attachment_dir,
                            profile=profile,
                            min_font_px=min_font_px,
                            options=options,
                            narrate=workflow_mode == CODE_WORKFLOW,
                        )
                        run_results.append(last_result)
                    result = last_result
                else:
                    if source_mode == ACCOUNT_SOURCE_MODE:
                        board_id = account_board_id
                        if not board_id:
                            raise ValueError("Authenticate and choose a board.")
                        label = account_label
                    else:
                        board_id = board_id_from_text(board_text)
                        if not board_id:
                            raise ValueError("Paste a Miro board link.")
                        label = board_id
                    result = self._run_one_board(
                        board_id=board_id,
                        label=label,
                        source_json=default_source_json_path(target_text, label, board_id),
                        target_dir=target_dir,
                        vault_root=vault_root,
                        attachment_dir=attachment_dir,
                        profile=profile,
                        min_font_px=min_font_px,
                        options=options,
                        websdk_json=Path(websdk_path_text) if websdk_path_text else None,
                        narrate=workflow_mode == CODE_WORKFLOW,
                    )
                    run_results.append(result)
                done_path = str(result.canvas_path) if result else str(target_dir)
                degraded = [item for item in run_results if pipeline_result_is_degraded(item)]
                if degraded:
                    details = "\n".join(str(item.source_json) for item in degraded)
                    self._log(f"Completed with incomplete source data: {len(degraded)} board(s).")
                    self.after(
                        0,
                        lambda details=details: messagebox.showwarning(
                            "Pipeline incomplete",
                            f"Missing source data or assets:\n{details}",
                        ),
                    )
                else:
                    if workflow_mode == CODE_WORKFLOW:
                        self._log("Code: export finished; the output passed the pipeline checks.")
                    self._log(f"Done: {done_path}")
                if result:
                    self.after(0, lambda: self.guided.show_result(
                        result.canvas_path, result.source_json, options.output_format,
                        degraded=bool(degraded), item_count=result.item_count))
            except Exception as exc:  # noqa: BLE001
                self._log(f"Pipeline failed: {exc}")
                show_error_later(self.after, "Pipeline failed", exc)
            finally:
                self._set_busy(False)

        threading.Thread(target=worker, daemon=True).start()


def main() -> None:
    app = MiroPipelineApp()
    app.mainloop()


if __name__ == "__main__":
    main()
