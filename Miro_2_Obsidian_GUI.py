from __future__ import annotations

import os
import json
import re
import threading
import webbrowser
from dataclasses import dataclass
from pathlib import Path
from tkinter import filedialog, messagebox
from typing import Callable

import customtkinter as ctk


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
from miro2obsidian import gui_support, miro_auth  # noqa: E402
from miro2obsidian.agent_runner import parse_agent_command, run_agent  # noqa: E402
from miro2obsidian.application import (  # noqa: E402
    pipeline_result_is_degraded,
    run_existing_json_pipeline,
)
from miro2obsidian.import_service import (  # noqa: E402
    ImportOptions,
    ResolvedBoard,
    run_imports,
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
    MANUAL_WORKFLOW: "You choose each source. Web SDK: let the app capture it, skip it, or give a downloaded file.",
    CODE_WORKFLOW: "Code opens the board, captures it, exports REST and assets, and writes the Canvas; steps appear in the log.",
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
    ADVANCED_CANVAS: "For the Advanced Canvas plugin: today's default, richest styling.",
    NATIVE_CANVAS: "Plain Obsidian, no plugin required: Markdown text, no HTML.",
    MIRO_CANVAS: "For the miro-canvas plugin: draws the Miro look from the source board.",
    RAW_JSON: "Just the Miro data: no Canvas file, only the exported JSON.",
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
    if message.startswith("Asking the Miro app for a capture"):
        return "Code: asking the Miro app inside the board for the data REST cannot provide."
    if message.startswith("Exporting the board through Miro's REST API"):
        return "Code: requesting all board items, comments, and required assets from Miro."
    if message.startswith("Merging verified Web SDK export:"):
        return "Code: checking the Web SDK capture and merging it with REST data."
    if message.startswith("Converting through the single Converter.py path"):
        return "Code: converting the checked source into an Obsidian Canvas."
    if message.startswith("Canvas written:"):
        return "Code: Canvas written; checking output format and attachments."
    return None


def show_error_later(after: Callable[[int, Callable[[], None]], object], title: str, error: BaseException) -> None:
    message = gui_support.explain_connection_error(error)
    message, log_path = gui_support.extract_diagnostics_log(message)
    if log_path:
        message = f"{message}\n\nDiagnostics log (for troubleshooting):\n{log_path}"
    after(0, lambda: messagebox.showerror(title, message))


def authorize_gui_token(logger: Callable[[str], None] | None = None) -> str:
    """A Miro token for this call, from ``miro_auth`` (kept for ``Miro_2_Json.GUI.resolve_gui_token``).

    ``MIRO_ACCESS_TOKEN`` is honored by ``miro_auth``; otherwise the saved, self-renewing
    connection is used. Raises ``RuntimeError`` with a plain-language message when
    Miro is not connected; connecting happens in the Set up Miro app wizard.
    """
    try:
        token = miro_auth.get_access_token()
    except (
        miro_auth.NotConnected,
        miro_auth.TokenRefreshFailed,
        miro_auth.CredentialStoreUnavailable,
    ) as exc:
        raise RuntimeError(gui_support.explain_connection_error(exc)) from exc
    if logger:
        logger("Using the saved Miro connection.")
    return token


def selected_board_inputs(
    source_mode: str,
    *,
    account_board_id: str = "",
    account_label: str = "",
    board_text: str = "",
    url_list_text: str = "",
) -> list[ResolvedBoard | str]:
    """The boards a run should import, in the form ``run_imports`` accepts."""
    if source_mode == ACCOUNT_SOURCE_MODE:
        if not account_board_id:
            raise ValueError("Connect to Miro and choose a board.")
        return [ResolvedBoard(account_board_id, name=account_label or None)]
    if source_mode == URL_SOURCE_MODE:
        text = board_text.strip()
        if not text:
            raise ValueError("Paste a Miro board link.")
        return [board_id_from_text(text) if BOARD_URL_RE.search(text) else text]
    if source_mode == URL_LIST_SOURCE_MODE:
        if not url_list_text.strip():
            raise ValueError("Choose a URL list file.")
        list_path = Path(url_list_text.strip())
        refs = board_refs_from_file(list_path)
        if not refs:
            raise ValueError(f"No Miro board links found in {list_path}")
        return [ResolvedBoard(ref_id, name=label) for ref_id, label in refs]
    raise ValueError("This source does not read boards from Miro.")


def build_import_options(
    *,
    vault_root: Path,
    target_dir: Path,
    attachment_dir: Path | None,
    options: ConversionOptions,
    profile: ViewProfile,
    min_font_px: int,
    websdk: str | Path,
) -> ImportOptions:
    """GUI form values as the shared import service's options."""
    return ImportOptions(
        vault_root=vault_root,
        target_dir=target_dir,
        source_dir=target_dir / "_miro_sources",
        output_format=options.output_format,
        websdk=websdk,
        share_attachments=options.share_attachments,
        install_obsidian_plugins=options.install_obsidian_plugins,
        attachment_dir=attachment_dir,
        scale=options.scale,
        view_profile=profile,
        min_font_px=min_font_px,
        theme=options.theme,
        text_style_mode=options.text_style_mode,
        prefer_experimental=options.prefer_experimental,
        allow_missing_assets=options.allow_missing_assets,
    )


@dataclass(frozen=True)
class RunRequest:
    """Everything a run needs, read from the form on the UI thread."""

    source_mode: str
    workflow_mode: str
    target_text: str
    options: ConversionOptions
    profile: ViewProfile
    min_font_px: int
    websdk: str | Path | None = None
    json_path_text: str = ""
    url_list_text: str = ""
    board_text: str = ""
    account_board_id: str = ""
    account_label: str = ""
    agent_command_spec: list[str] | None = None


class SetupWizard(ctk.CTkToplevel):
    """Step-by-step creation of the user's own Miro app, ending in the Connect form."""

    def __init__(self, app: "MiroPipelineApp", *, settings_file: Path | None = None) -> None:
        super().__init__(app)
        self.app = app
        self.settings_file = settings_file
        self.title("Set up your Miro app")
        self.geometry("700x600")
        self.minsize(580, 520)
        self.transient(app)
        self.steps = gui_support.wizard_steps()
        last = gui_support.load_settings(settings_file).get(gui_support.SETUP_STEP_KEY)
        self.index = gui_support.resume_step_index(self.steps, last)
        self._connecting = False

        self.grid_columnconfigure(0, weight=1)
        self.grid_rowconfigure(2, weight=1)
        self.progress = ctk.CTkLabel(self, text="", anchor="w", text_color="gray60")
        self.progress.grid(row=0, column=0, sticky="we", padx=18, pady=(14, 0))
        self.step_title = ctk.CTkLabel(
            self, text="", anchor="w", font=ctk.CTkFont(size=18, weight="bold"), wraplength=640, justify="left"
        )
        self.step_title.grid(row=1, column=0, sticky="we", padx=18, pady=(2, 6))
        self.body = ctk.CTkTextbox(self, wrap="word", height=170)
        self.body.grid(row=2, column=0, sticky="nsew", padx=18, pady=4)
        self.copy_frame = ctk.CTkFrame(self, fg_color="transparent")
        self.copy_frame.grid(row=3, column=0, sticky="we", padx=18, pady=4)
        self.copy_frame.grid_columnconfigure(1, weight=1)

        self.form_frame = ctk.CTkFrame(self)
        self.form_frame.grid_columnconfigure(1, weight=1)
        ctk.CTkLabel(self.form_frame, text="Client ID").grid(row=0, column=0, padx=10, pady=6, sticky="e")
        self.client_id_entry = ctk.CTkEntry(self.form_frame)
        self.client_id_entry.grid(row=0, column=1, padx=6, pady=6, sticky="we")
        ctk.CTkButton(
            self.form_frame, text="Paste", width=70, command=lambda: self.paste_into(self.client_id_entry)
        ).grid(row=0, column=2, padx=(0, 10), pady=6)
        ctk.CTkLabel(self.form_frame, text="Client secret").grid(row=1, column=0, padx=10, pady=6, sticky="e")
        self.secret_entry = ctk.CTkEntry(self.form_frame, show="*")
        self.secret_entry.grid(row=1, column=1, padx=6, pady=6, sticky="we")
        ctk.CTkButton(
            self.form_frame, text="Paste", width=70, command=lambda: self.paste_into(self.secret_entry)
        ).grid(row=1, column=2, padx=(0, 10), pady=6)
        self.connect_button = ctk.CTkButton(self.form_frame, text="Connect", command=self.connect)
        self.connect_button.grid(row=2, column=1, padx=6, pady=(4, 10), sticky="we")
        self.form_frame.grid(row=4, column=0, sticky="we", padx=18, pady=6)

        self.status = ctk.CTkLabel(self, text="", anchor="w", wraplength=640, justify="left")
        self.status.grid(row=5, column=0, sticky="we", padx=18, pady=2)

        nav = ctk.CTkFrame(self, fg_color="transparent")
        nav.grid(row=6, column=0, sticky="we", padx=18, pady=(4, 14))
        nav.grid_columnconfigure(2, weight=1)
        self.back_button = ctk.CTkButton(nav, text="Back", width=90, command=self.back)
        self.back_button.grid(row=0, column=0, padx=(0, 8))
        self.open_button = ctk.CTkButton(nav, text="Open in browser", command=self.open_step_url)
        self.open_button.grid(row=0, column=1, padx=8)
        self.next_button = ctk.CTkButton(nav, text="Next", width=90, command=self.next)
        self.next_button.grid(row=0, column=3, padx=8)
        ctk.CTkButton(nav, text="Close", width=90, fg_color="gray40", command=self.destroy).grid(
            row=0, column=4, padx=(8, 0)
        )
        self.show_step()

    @property
    def step(self) -> dict:
        return self.steps[self.index]

    def show_step(self) -> None:
        step = self.step
        last = self.index == len(self.steps) - 1
        self.progress.configure(text=f"Step {self.index + 1} of {len(self.steps)}")
        self.step_title.configure(text=step["title"])
        text = step["instructions"]
        if step.get("after_note"):
            text += "\n\nFirst export: " + step["after_note"]
        self.body.configure(state="normal")
        self.body.delete("1.0", "end")
        self.body.insert("1.0", text)
        self.body.configure(state="disabled")

        for child in self.copy_frame.winfo_children():
            child.destroy()
        for row, (label, value) in enumerate(step.get("copy_values", {}).items()):
            ctk.CTkButton(
                self.copy_frame,
                text=gui_support.copy_button_label(label),
                width=170,
                command=lambda label=label, value=value: self.copy(label, value),
            ).grid(row=row, column=0, padx=(0, 10), pady=3, sticky="w")
            preview = value if "\n" not in value else f"{len(value.splitlines())} lines"
            ctk.CTkLabel(
                self.copy_frame,
                text=preview if len(preview) <= 70 else preview[:67] + "...",
                anchor="w",
                text_color="gray60",
            ).grid(row=row, column=1, sticky="we", pady=3)

        if step.get("url"):
            self.open_button.grid()
        else:
            self.open_button.grid_remove()
        if step.get("form"):
            self.form_frame.grid()
            self.client_id_entry.focus_set()
        else:
            self.form_frame.grid_remove()
        self.back_button.configure(state="normal" if self.index else "disabled")
        if last:
            self.next_button.grid_remove()
        else:
            self.next_button.grid()
        self.status.configure(text="")

    def back(self) -> None:
        if self.index > 0 and not self._connecting:
            self.index -= 1
            self.show_step()

    def next(self) -> None:
        if self.index >= len(self.steps) - 1:
            return
        gui_support.save_settings({gui_support.SETUP_STEP_KEY: str(self.step["id"])}, self.settings_file)
        self.index += 1
        self.show_step()

    def open_step_url(self) -> None:
        url = self.step.get("url")
        if url:
            webbrowser.open(url)

    def copy(self, label: str, value: str) -> None:
        self.clipboard_clear()
        self.clipboard_append(value)
        self.status.configure(text=f"Copied: {label}. Paste it where Miro asks for it.")

    def paste_into(self, entry: ctk.CTkEntry) -> None:
        try:
            value = self.clipboard_get()
        except Exception:  # noqa: BLE001
            messagebox.showerror("Miro app", "The clipboard is empty.", parent=self)
            return
        entry.delete(0, "end")
        entry.insert(0, value.strip())

    def connect(self) -> None:
        if self._connecting:
            return
        client_id = self.client_id_entry.get().strip()
        client_secret = self.secret_entry.get().strip()
        if not client_id or not client_secret:
            messagebox.showerror("Miro app", "Enter both the Client ID and the Client secret.", parent=self)
            return
        self._connecting = True
        self.connect_button.configure(state="disabled")
        self.status.configure(text="Waiting for you to approve access in the browser window that just opened...")
        self.app.connect_miro_app(
            client_id,
            client_secret,
            on_success=lambda status: self._ui(lambda: self._connected(status)),
            on_error=lambda message: self._ui(lambda: self._connect_failed(message)),
        )

    def _ui(self, callback: Callable[[], None]) -> None:
        try:
            if self.winfo_exists():
                self.after(0, callback)
        except Exception:  # noqa: BLE001 - the window was closed meanwhile
            pass

    def _connected(self, status: object) -> None:
        self._connecting = False
        self.secret_entry.delete(0, "end")
        gui_support.save_settings({gui_support.SETUP_STEP_KEY: gui_support.CONNECT_STEP_ID}, self.settings_file)
        team = getattr(status, "team_name", None)
        text = f"Connected to team {team}." if team else "Connected to Miro."
        messagebox.showinfo("Miro connected", text, parent=self)
        self.destroy()

    def _connect_failed(self, message: str) -> None:
        self._connecting = False
        self.connect_button.configure(state="normal")
        self.status.configure(text=f"Could not connect: {message}")
        messagebox.showerror("Miro app", message, parent=self)


class MiroPipelineApp(ctk.CTk):
    def __init__(self) -> None:
        super().__init__()
        self.title("Miro -> Obsidian Canvas")
        self.geometry("1040x800")
        self.minsize(940, 740)

        self.active_workflow_mode = MANUAL_WORKFLOW
        self.agent_command_spec: list[str] | None = None
        self.connect_lock = threading.Lock()
        self.boards_by_label: dict[str, dict] = {}
        self.selected_account_board_id = ""
        self.setup_wizard: SetupWizard | None = None

        self._build_ui()
        self._log("Ready. Default path: Miro board -> REST experimental JSON + assets -> Canvas.")
        # Start the status check from inside the event loop: worker threads may only
        # schedule UI updates once mainloop() is running.
        self.after(100, self.refresh_connection_status)

    def _build_ui(self) -> None:
        ctk.set_appearance_mode("System")
        ctk.set_default_color_theme("blue")

        for column in range(4):
            self.grid_columnconfigure(column, weight=1 if column == 1 else 0)

        pad = {"padx": 10, "pady": 7}

        title = ctk.CTkLabel(self, text="Miro -> Obsidian Canvas", font=ctk.CTkFont(size=22, weight="bold"))
        title.grid(row=0, column=0, columnspan=2, sticky="w", padx=12, pady=(16, 10))
        ctk.CTkLabel(self, text="Workflow").grid(row=0, column=2, sticky="e", **pad)
        self.workflow_mode = ctk.CTkOptionMenu(
            self,
            values=[MANUAL_WORKFLOW, CODE_WORKFLOW, AGENT_WORKFLOW],
            command=self.on_workflow_mode_changed,
            width=180,
        )
        self.workflow_mode.set(MANUAL_WORKFLOW)
        self.workflow_mode.grid(row=0, column=3, sticky="we", **pad)

        self.connection_label = ctk.CTkLabel(
            self, text="Checking the Miro connection...", anchor="w", text_color="gray60", justify="left"
        )
        self.connection_label.grid(row=1, column=0, columnspan=4, sticky="we", padx=12, pady=(0, 2))

        ctk.CTkLabel(self, text="Source").grid(row=2, column=0, sticky="e", **pad)
        self.source_mode = ctk.CTkOptionMenu(
            self,
            values=[ACCOUNT_SOURCE_MODE, URL_SOURCE_MODE, URL_LIST_SOURCE_MODE, JSON_SOURCE_MODE],
            command=self.on_source_mode_changed,
        )
        self.source_mode.set(ACCOUNT_SOURCE_MODE)
        self.source_mode.grid(row=2, column=1, columnspan=3, sticky="we", **pad)

        self.path_frame = ctk.CTkFrame(self, fg_color="transparent")
        self.path_frame.grid(row=3, column=0, columnspan=4, sticky="we")
        self.path_frame.grid_columnconfigure(1, weight=1)

        self.account_frame = ctk.CTkFrame(self.path_frame, fg_color="transparent")
        self.account_frame.grid_columnconfigure(1, weight=1)
        ctk.CTkLabel(self.account_frame, text="Board").grid(row=0, column=0, sticky="e", **pad)
        self.board_menu = ctk.CTkOptionMenu(self.account_frame, values=["Connect first"], command=self.on_board_selected)
        self.board_menu.grid(row=0, column=1, sticky="we", **pad)
        ctk.CTkButton(self.account_frame, text="Refresh boards", width=170, command=self.authenticate_and_refresh_boards).grid(row=0, column=2, columnspan=2, **pad)
        ctk.CTkButton(self.account_frame, text="Switch Miro team", command=self.reauthorize_and_refresh_boards).grid(row=1, column=1, sticky="we", **pad)
        ctk.CTkButton(self.account_frame, text="Set up Miro app", width=170, command=self.open_miro_setup).grid(row=1, column=2, columnspan=2, **pad)
        ctk.CTkButton(self.account_frame, text="Forget saved token", command=self.forget_miro_connection).grid(row=2, column=2, columnspan=2, **pad)

        self.url_frame = ctk.CTkFrame(self.path_frame, fg_color="transparent")
        self.url_frame.grid_columnconfigure(1, weight=1)
        ctk.CTkLabel(self.url_frame, text="Board URL").grid(row=0, column=0, sticky="e", **pad)
        self.board_id = ctk.CTkEntry(self.url_frame, placeholder_text="https://miro.com/app/board/...")
        self.board_id.grid(row=0, column=1, columnspan=2, sticky="we", **pad)
        ctk.CTkButton(self.url_frame, text="Check connection", width=130, command=self.check_connection).grid(row=0, column=3, **pad)

        self.url_list_frame = ctk.CTkFrame(self.path_frame, fg_color="transparent")
        self.url_list_frame.grid_columnconfigure(1, weight=1)
        ctk.CTkLabel(self.url_list_frame, text="URL list").grid(row=0, column=0, sticky="e", **pad)
        self.url_list_path = ctk.CTkEntry(self.url_list_frame)
        self.url_list_path.grid(row=0, column=1, sticky="we", **pad)
        ctk.CTkButton(self.url_list_frame, text="Check connection", width=130, command=self.check_connection).grid(row=0, column=2, **pad)
        ctk.CTkButton(self.url_list_frame, text="Browse", width=130, command=self.pick_url_list).grid(row=0, column=3, **pad)

        self.json_frame = ctk.CTkFrame(self.path_frame, fg_color="transparent")
        self.json_frame.grid_columnconfigure(1, weight=1)
        ctk.CTkLabel(self.json_frame, text="JSON file").grid(row=0, column=0, sticky="e", **pad)
        self.json_path = ctk.CTkEntry(self.json_frame)
        self.json_path.grid(row=0, column=1, columnspan=2, sticky="we", **pad)
        ctk.CTkButton(self.json_frame, text="Browse", width=130, command=self.pick_json_file).grid(row=0, column=3, **pad)

        ctk.CTkLabel(self, text="Canvas folder").grid(row=4, column=0, sticky="e", **pad)
        self.target_dir = ctk.CTkEntry(self)
        self.target_dir.grid(row=4, column=1, columnspan=2, sticky="we", **pad)
        ctk.CTkButton(self, text="Browse", width=130, command=self.pick_target_dir).grid(row=4, column=3, **pad)

        ctk.CTkLabel(self, text="Vault root (auto)").grid(row=5, column=0, sticky="e", **pad)
        self.vault_root = ctk.CTkEntry(self)
        self.vault_root.grid(row=5, column=1, columnspan=2, sticky="we", **pad)
        self.vault_root.configure(state="disabled")
        self.vault_root_button = ctk.CTkButton(self, text="Auto", width=130)
        self.vault_root_button.grid(row=5, column=3, **pad)
        self.vault_root_button.configure(state="disabled")

        options = ctk.CTkFrame(self)
        options.grid(row=6, column=0, columnspan=4, sticky="we", padx=10, pady=(10, 4))
        for column in range(8):
            options.grid_columnconfigure(column, weight=1 if column in {1, 3, 5, 7} else 0)

        ctk.CTkLabel(options, text="Scale mode").grid(row=0, column=0, sticky="e", padx=8, pady=8)
        self.scale_mode = ctk.CTkOptionMenu(options, values=["balanced", "overview", "readable"])
        self.scale_mode.set("readable")
        self.scale_mode.grid(row=0, column=1, sticky="we", padx=8, pady=8)

        ctk.CTkLabel(options, text="Text").grid(row=0, column=2, sticky="e", padx=8, pady=8)
        self.text_style_mode = ctk.CTkOptionMenu(options, values=["miro", "obsidian"])
        self.text_style_mode.set("miro")
        self.text_style_mode.grid(row=0, column=3, sticky="we", padx=8, pady=8)

        ctk.CTkLabel(options, text="Theme").grid(row=0, column=4, sticky="e", padx=8, pady=8)
        self.theme = ctk.CTkOptionMenu(options, values=["dark", "light"])
        self.theme.set("dark")
        self.theme.grid(row=0, column=5, sticky="we", padx=8, pady=8)

        ctk.CTkLabel(options, text="Scale").grid(row=0, column=6, sticky="e", padx=8, pady=8)
        self.scale = ctk.CTkEntry(options, placeholder_text="auto")
        self.scale.grid(row=0, column=7, sticky="we", padx=8, pady=8)

        ctk.CTkLabel(options, text="Min zoom").grid(row=1, column=0, sticky="e", padx=8, pady=(0, 8))
        self.min_zoom = ctk.CTkEntry(options)
        self.min_zoom.insert(0, ZOOM_UNLOCKED_MIN_ZOOM)
        self.min_zoom.grid(row=1, column=1, sticky="we", padx=8, pady=(0, 8))

        ctk.CTkLabel(options, text="Min font").grid(row=1, column=2, sticky="e", padx=8, pady=(0, 8))
        self.min_font_px = ctk.CTkEntry(options)
        self.min_font_px.insert(0, "8")
        self.min_font_px.grid(row=1, column=3, sticky="we", padx=8, pady=(0, 8))

        self.allow_missing_assets = ctk.BooleanVar(value=False)
        self.allow_missing_assets_checkbox = ctk.CTkCheckBox(
            options,
            text="Allow degraded export/source",
            variable=self.allow_missing_assets,
        )
        self.allow_missing_assets_checkbox.grid(
            row=1,
            column=4,
            columnspan=2,
            sticky="w",
            padx=8,
            pady=(0, 8),
        )

        self.stable_items = ctk.BooleanVar(value=False)
        self.stable_items_checkbox = ctk.CTkCheckBox(
            options,
            text="Use stable REST items",
            variable=self.stable_items,
        )
        self.stable_items_checkbox.grid(
            row=2,
            column=4,
            columnspan=2,
            sticky="w",
            padx=8,
            pady=(0, 8),
        )

        self.install_obsidian_plugins = ctk.BooleanVar(value=True)
        self.install_obsidian_plugins_checkbox = ctk.CTkCheckBox(
            options,
            text="Install Advanced Canvas + zoom unlock",
            variable=self.install_obsidian_plugins,
            command=self.on_install_plugins_changed,
        )
        self.install_obsidian_plugins_checkbox.grid(
            row=1,
            column=6,
            columnspan=2,
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
            row=3,
            column=0,
            columnspan=4,
            sticky="w",
            padx=8,
            pady=(0, 8),
        )

        ctk.CTkLabel(options, text="Format").grid(row=2, column=0, sticky="e", padx=8, pady=(0, 8))
        self.output_format = ctk.CTkOptionMenu(
            options, values=list(OUTPUT_FORMATS), command=self.on_format_changed
        )
        self.output_format.set(ADVANCED_CANVAS)
        self.output_format.grid(row=2, column=1, sticky="we", padx=8, pady=(0, 8))

        self.format_hint = ctk.CTkLabel(
            options,
            text=FORMAT_HINTS[ADVANCED_CANVAS],
            text_color="gray60",
            anchor="w",
        )
        self.format_hint.grid(
            row=2, column=2, columnspan=6, sticky="we", padx=8, pady=(0, 8)
        )

        ctk.CTkLabel(options, text="Web SDK").grid(row=4, column=0, sticky="e", padx=8, pady=(0, 8))
        self.websdk_choice = ctk.CTkOptionMenu(
            options, values=list(gui_support.WEBSDK_CHOICES), command=self.on_websdk_choice_changed
        )
        self.websdk_choice.set(gui_support.default_websdk_choice(MANUAL_WORKFLOW))
        self.websdk_choice.grid(row=4, column=1, columnspan=2, sticky="we", padx=8, pady=(0, 8))
        self.websdk_path = ctk.CTkEntry(options, placeholder_text="Whole-board Web SDK JSON (From file)")
        self.websdk_path.grid(row=4, column=3, columnspan=3, sticky="we", padx=8, pady=(0, 8))
        self.websdk_browse = ctk.CTkButton(options, text="Browse", command=self.pick_websdk_file)
        self.websdk_browse.grid(row=4, column=6, columnspan=2, sticky="we", padx=8, pady=(0, 8))

        self.workflow_hint = ctk.CTkLabel(
            self, text=WORKFLOW_HINTS[MANUAL_WORKFLOW], anchor="w", text_color="gray60", wraplength=520, justify="left"
        )
        self.workflow_hint.grid(row=7, column=0, columnspan=2, sticky="we", padx=12, pady=(10, 8))
        self.agent_settings_button = ctk.CTkButton(
            self, text="Configure agent", command=self.open_agent_settings, state="disabled"
        )
        self.agent_settings_button.grid(row=7, column=2, sticky="we", padx=10, pady=(10, 8))
        self.run_button = ctk.CTkButton(self, text="Run pipeline", height=40, command=self.run_pipeline)
        self.run_button.grid(row=7, column=3, sticky="e", padx=10, pady=(10, 8))

        self.run_status = ctk.CTkLabel(self, text="", anchor="w", wraplength=520, justify="left")
        self.run_status.grid(row=8, column=0, columnspan=2, sticky="we", padx=12, pady=(0, 4))
        self.copy_agent_button = ctk.CTkButton(
            self, text="Copy instructions for my agent", command=self.copy_agent_instructions
        )
        self.copy_agent_button.grid(row=8, column=2, columnspan=2, sticky="we", padx=10, pady=(0, 4))

        self.log = ctk.CTkTextbox(self, height=150)
        self.log.grid(row=9, column=0, columnspan=4, sticky="nsew", padx=10, pady=(4, 10))
        self.grid_rowconfigure(9, weight=1)
        self.on_source_mode_changed(ACCOUNT_SOURCE_MODE)

    def _log(self, message: str) -> None:
        def append() -> None:
            self.log.configure(state="normal")
            self.log.insert("end", message + "\n")
            self.log.see("end")
            self.log.configure(state="disabled")

        self.after(0, append)

    def _set_busy(self, busy: bool) -> None:
        self.after(0, lambda: self.run_button.configure(state="disabled" if busy else "normal"))

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

    def _ui(self, callback: Callable[[], None]) -> None:
        try:
            self.after(0, callback)
        except Exception:  # noqa: BLE001 - the window is closing
            pass

    def open_miro_setup(self) -> None:
        existing = self.setup_wizard
        try:
            if existing is not None and existing.winfo_exists():
                existing.lift()
                existing.focus_set()
                return
        except Exception:  # noqa: BLE001
            pass
        self.setup_wizard = SetupWizard(self)

    def refresh_connection_status(self, *, verify: bool = False) -> None:
        """Update the status line from the saved connection (in a worker thread)."""

        def worker() -> None:
            try:
                status = miro_auth.connection_status(verify_online=verify)
                text = gui_support.connection_status_line(status)
            except Exception as exc:  # noqa: BLE001 - never let a status check break the GUI
                status = None
                text = f"Could not read the Miro connection: {exc}"
            self._ui(lambda: self.connection_label.configure(text=text))
            if verify and status is not None:
                self._log(text)

        threading.Thread(target=worker, daemon=True).start()

    def _token(self) -> str:
        """A Miro token for this call; ``miro_auth`` refreshes and persists it."""
        return authorize_gui_token()

    def connect_miro_app(
        self,
        client_id: str,
        client_secret: str,
        *,
        on_success: Callable[[object], None] | None = None,
        on_error: Callable[[str], None] | None = None,
        reconnect: bool = False,
    ) -> None:
        """Run Miro OAuth for the user's own app in a worker thread; the GUI stays responsive."""

        def worker() -> None:
            if not self.connect_lock.acquire(blocking=False):
                message = "A connection attempt is already running."
                self._log(message)
                if on_error:
                    on_error(message)
                return
            try:
                if reconnect:
                    status = miro_auth.reconnect_with_saved_app(report=self._log)
                else:
                    status = miro_auth.connect_with_credentials(client_id, client_secret, report=self._log)
            except miro_auth.NotConnected:
                self._log("No Miro app is saved yet; opening the setup.")
                self._ui(self.open_miro_setup)
                if on_error:
                    on_error("No Miro app is saved yet. Set it up first.")
                return
            except Exception as exc:  # noqa: BLE001
                message = gui_support.explain_connection_error(exc)
                self._log(f"Connecting failed: {message}")
                if on_error:
                    on_error(message)
                else:
                    show_error_later(self.after, "Miro connection failed", exc)
                return
            finally:
                self.connect_lock.release()
            team = status.team_name
            self._log(f"Connected to Miro team {team}." if team else "Connected to Miro.")
            self._ui(lambda: self.connection_label.configure(text=gui_support.connection_status_line(status)))
            if on_success:
                on_success(status)
            if self._source_mode_value() == ACCOUNT_SOURCE_MODE:
                self.authenticate_and_refresh_boards()

        threading.Thread(target=worker, daemon=True).start()

    def _source_mode_value(self) -> str:
        try:
            return self.source_mode.get()
        except Exception:  # noqa: BLE001
            return ""

    def check_connection(self) -> None:
        """Ask Miro whether the saved connection works; open the setup when there is none."""

        def worker() -> None:
            try:
                status = miro_auth.connection_status(verify_online=True)
            except Exception as exc:  # noqa: BLE001
                self._log(f"Could not check the connection: {exc}")
                return
            text = gui_support.connection_status_line(status)
            self._ui(lambda: self.connection_label.configure(text=text))
            self._log(text)
            if not status.connected:
                self._ui(self.open_miro_setup)

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
        if labels:
            self.after(0, lambda: self.board_menu.set(labels[0]))
            self.after(0, lambda: self.on_board_selected(labels[0]))
        team_keys = {
            str((board.get("team") or {}).get("id") or (board.get("team") or {}).get("name") or "")
            for board in boards
        }
        teams = len({team for team in team_keys if team})
        self._log(f"Loaded boards: {len(labels)} across {teams} team(s) visible to this Miro app/user.")

    def _reset_board_menu(self) -> None:
        self.boards_by_label = {}
        self.selected_account_board_id = ""
        self.board_menu.configure(values=["Connect first"])
        self.board_menu.set("Connect first")

    def forget_miro_connection(self) -> None:
        if not messagebox.askyesno(
            "Forget saved token",
            "Remove the saved Miro connection from this computer?\n\n"
            "The program also asks Miro to revoke it. To export boards again you "
            "will have to connect again (Set up Miro app).",
        ):
            return
        self._reset_board_menu()

        def worker() -> None:
            try:
                revoked = miro_auth.disconnect()
            except miro_auth.CredentialStoreUnavailable as exc:
                self._log(f"The saved connection could not be removed: {exc}")
            else:
                self._log(
                    "Saved Miro connection removed"
                    + (" and revoked at Miro." if revoked else " (Miro could not confirm the revocation; "
                       "you can remove the app's access in your Miro profile settings).")
                )
                if os.environ.get("MIRO_ACCESS_TOKEN"):
                    self._log("MIRO_ACCESS_TOKEN is still set in the environment and will be used.")
            self.refresh_connection_status()

        threading.Thread(target=worker, daemon=True).start()

    def reauthorize_and_refresh_boards(self) -> None:
        """Switch Miro team: authorize again with the saved app credentials."""
        self._reset_board_menu()
        self._log("Choose the team that owns the target board in the Miro window that opens.")
        self.connect_miro_app("", "", reconnect=True)

    def authenticate_and_refresh_boards(self) -> None:
        def worker() -> None:
            try:
                token = miro_auth.get_access_token()
            except miro_auth.NotConnected:
                self._log("Miro is not connected yet; opening the setup.")
                self._ui(self.open_miro_setup)
                return
            except Exception as exc:  # noqa: BLE001
                message = gui_support.explain_connection_error(exc)
                self._log(f"Could not get a Miro token: {message}")
                show_error_later(self.after, "Miro connection", exc)
                return
            try:
                self._apply_boards(get_boards(token))
            except Exception as exc:  # noqa: BLE001
                self._log(f"Listing boards failed: {exc}")
                show_error_later(self.after, "Listing boards failed", exc)

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
            self.websdk_choice.set(gui_support.WEBSDK_FILE)
            self._set_entry(self.websdk_path, path)
            self.on_websdk_choice_changed(gui_support.WEBSDK_FILE)

    def on_websdk_choice_changed(self, choice: str) -> None:
        from_file = choice == gui_support.WEBSDK_FILE
        self.websdk_path.configure(state="normal" if from_file else "disabled")
        self.websdk_browse.configure(state="normal" if from_file else "disabled")

    def _update_websdk_controls(self) -> None:
        """The Web SDK menu only matters when a run reads boards from Miro without an agent."""
        relevant = (
            self.active_workflow_mode != AGENT_WORKFLOW
            and self.source_mode.get() in MIRO_EXPORT_MODES
        )
        self.websdk_choice.configure(state="normal" if relevant else "disabled")
        if relevant:
            self.on_websdk_choice_changed(self.websdk_choice.get())
        else:
            self.websdk_path.configure(state="disabled")
            self.websdk_browse.configure(state="disabled")

    def on_workflow_mode_changed(self, mode: str) -> None:
        self.active_workflow_mode = mode
        self.workflow_hint.configure(text=WORKFLOW_HINTS.get(mode, ""))
        self.agent_settings_button.configure(state="normal" if mode == AGENT_WORKFLOW else "disabled")
        has_file = bool(self.websdk_path.get().strip())
        self.websdk_choice.set(gui_support.default_websdk_choice(mode, has_file=has_file))
        self._update_websdk_controls()
        if mode == CODE_WORKFLOW:
            self._log("Code mode: the program opens the board, captures it, exports REST and assets and writes the Canvas.")
        elif mode == AGENT_WORKFLOW:
            self._log("Agent mode: a configured local agent will handle browser-dependent steps.")
        else:
            self._log("Manual mode: choose each source and run the pipeline yourself.")

    def open_agent_settings(self) -> None:
        dialog = ctk.CTkToplevel(self)
        dialog.title("Agent command")
        dialog.geometry("650x190")
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

        ctk.CTkButton(dialog, text="Use", command=save_command).pack(pady=(4, 14))
        entry.focus_set()

    def pick_target_dir(self) -> None:
        path = filedialog.askdirectory()
        if path:
            self._set_entry(self.target_dir, path)
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
            row=1,
            column=4,
            columnspan=2,
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
        self._update_websdk_controls()

    def _set_run_status(self, text: str) -> None:
        self._ui(lambda: self.run_status.configure(text=text))

    def _on_import_event(self, event: dict, *, narrate: bool = False) -> None:
        """Show the import service's events in the log (and the capture instruction above it)."""
        line = gui_support.format_import_event(event)
        if line is None:
            return
        if narrate and event.get("event") == "step":
            explanation = explain_code_step(line)
            if explanation:
                self._log(explanation)
        board = event.get("board_id")
        self._log(f"{board}: {line}" if board and event.get("event") == "step" else line)
        if gui_support.is_capture_wait_event(event):
            self._set_run_status(line)
        elif event.get("event") in {"board_finished", "batch_finished"}:
            self._set_run_status("")

    def _collect_run_request(self) -> RunRequest:
        source_mode = self.source_mode.get()
        workflow_mode = self.workflow_mode.get()
        target_text = self.target_dir.get().strip()
        if not target_text:
            raise ValueError("Canvas folder is required.")
        websdk: str | Path | None = None
        if workflow_mode != AGENT_WORKFLOW and source_mode in MIRO_EXPORT_MODES:
            websdk = gui_support.resolve_websdk_option(
                self.websdk_choice.get(),
                self.websdk_path.get(),
                single_board=source_mode in {ACCOUNT_SOURCE_MODE, URL_SOURCE_MODE},
            )
        min_font_px = int(self.min_font_px.get().strip() or "8")
        profile = ViewProfile(
            min_zoom=float(self.min_zoom.get().strip() or "0.12"),
            min_font_px=min_font_px,
            scale_mode=self.scale_mode.get(),
        )
        options = ConversionOptions(
            scale=self._parse_float_or_none(self.scale.get()),
            theme=self.theme.get(),
            text_style_mode=self.text_style_mode.get(),
            output_format=self.output_format.get(),
            allow_missing_assets=self.allow_missing_assets.get(),
            prefer_experimental=not self.stable_items.get(),
            install_obsidian_plugins=self.install_obsidian_plugins.get(),
            share_attachments=self.share_attachments.get(),
        )
        return RunRequest(
            source_mode=source_mode,
            workflow_mode=workflow_mode,
            target_text=target_text,
            options=options,
            profile=profile,
            min_font_px=min_font_px,
            websdk=websdk,
            json_path_text=self.json_path.get().strip(),
            url_list_text=self.url_list_path.get().strip(),
            board_text=self.board_id.get(),
            account_board_id=self.selected_account_board_id,
            account_label=self._selected_board_label() if source_mode == ACCOUNT_SOURCE_MODE else "",
            agent_command_spec=self.agent_command_spec,
        )

    def run_pipeline(self) -> None:
        try:
            request = self._collect_run_request()
        except Exception as exc:  # noqa: BLE001
            self._log(f"Pipeline failed: {exc}")
            show_error_later(self.after, "Pipeline failed", exc)
            return

        self.run_button.configure(state="disabled")
        threading.Thread(target=self._run_worker, args=(request,), daemon=True).start()

    def _run_worker(self, request: RunRequest) -> None:
        try:
            outcomes = self._execute_request(request)
            self._present_outcomes(outcomes)
        except Exception as exc:  # noqa: BLE001
            self._log(f"Pipeline failed: {exc}")
            show_error_later(self.after, "Pipeline failed", exc)
        finally:
            self._set_run_status("")
            self._set_busy(False)

    def _execute_request(self, request: RunRequest) -> list[gui_support.BoardOutcome]:
        """Run one request to the end and return one outcome per board."""
        target_dir = Path(request.target_text)
        vault_paths = resolve_vault_paths(target_dir)
        vault_root = vault_paths.vault_root
        attachment_dir = vault_paths.attachment_dir
        self.after(0, lambda: self._set_entry(self.vault_root, str(vault_root), disabled=True))
        options = request.options
        code_mode = request.workflow_mode == CODE_WORKFLOW

        if request.workflow_mode == AGENT_WORKFLOW:
            return [self._run_agent(request, target_dir, vault_root)]

        if request.source_mode == JSON_SOURCE_MODE:
            if not request.json_path_text:
                raise ValueError("Choose a JSON file.")
            if code_mode:
                self._log("Code: reading local JSON; Miro access is unnecessary.")
            result = run_existing_json_pipeline(
                source_json=Path(request.json_path_text),
                target_dir=target_dir,
                vault_root=vault_root,
                scale=options.scale,
                view_profile=request.profile,
                min_font_px=request.min_font_px,
                theme=options.theme,
                text_style_mode=options.text_style_mode,
                allow_incomplete_source=options.allow_missing_assets,
                output_format=options.output_format,
                install_obsidian_plugins=options.install_obsidian_plugins,
                attachment_dir=attachment_dir,
                share_attachments=options.share_attachments,
                logger=self._log,
            )
            return [
                gui_support.outcome_from_pipeline(
                    result, degraded=pipeline_result_is_degraded(result)
                )
            ]

        inputs = selected_board_inputs(
            request.source_mode,
            account_board_id=request.account_board_id,
            account_label=request.account_label,
            board_text=request.board_text,
            url_list_text=request.url_list_text,
        )
        if code_mode:
            self._log("Code: checking the vault and selected source.")
            if request.websdk == "auto":
                self._log("Code: the board will open in your browser so the Miro app can send its data.")
            elif request.websdk == "skip":
                self._log("Code: this run will use REST only; Web SDK is off.")
            else:
                self._log("Code: using the Web SDK file you selected.")
        import_options = build_import_options(
            vault_root=vault_root,
            target_dir=target_dir,
            attachment_dir=attachment_dir,
            options=options,
            profile=request.profile,
            min_font_px=request.min_font_px,
            websdk=request.websdk if request.websdk is not None else "auto",
        )
        results = run_imports(
            inputs,
            import_options,
            on_event=lambda event: self._on_import_event(event, narrate=code_mode),
        )
        return [gui_support.outcome_from_import_result(result) for result in results]

    def _run_agent(
        self, request: RunRequest, target_dir: Path, vault_root: Path
    ) -> gui_support.BoardOutcome:
        if request.source_mode not in {ACCOUNT_SOURCE_MODE, URL_SOURCE_MODE}:
            raise ValueError("Agent mode currently needs one Miro board or board URL.")
        board_id = (
            request.account_board_id
            if request.source_mode == ACCOUNT_SOURCE_MODE
            else board_id_from_text(request.board_text)
        )
        if not board_id:
            raise ValueError("Choose or paste a Miro board before starting Agent mode.")
        self._log("Agent 1/3: opening a dedicated Miro browser profile for the agent.")
        self._log("Agent browser: first sign-in or MFA may still need the account owner.")
        outcome = run_agent(
            board_url=f"https://miro.com/app/board/{board_id}/",
            target_dir=target_dir,
            vault_root=vault_root,
            output_format=request.options.output_format,
            repo_root=REPO_ROOT,
            command=request.agent_command_spec,
            on_status=self._log,
        )
        return gui_support.outcome_from_agent(outcome, name=request.account_label or board_id)

    def _present_outcomes(self, outcomes: list[gui_support.BoardOutcome]) -> None:
        """Log every board's result and show one dialog for the worst one."""
        for outcome in outcomes:
            for line in gui_support.outcome_lines(outcome):
                self._log(line)
        summary = gui_support.summarize_outcomes(outcomes)
        show = {"info": messagebox.showinfo, "warning": messagebox.showwarning}.get(
            summary.level, messagebox.showerror
        )
        self.after(0, lambda: show(summary.title, summary.text))

    def _agent_instructions_text(self) -> str:
        target_text = self.target_dir.get().strip()
        vault_root: Path | None = None
        if target_text:
            try:
                vault_root = resolve_vault_paths(Path(target_text)).vault_root
            except Exception:  # noqa: BLE001 - the instructions then ask for the vault path
                vault_root = None
        try:
            inputs = selected_board_inputs(
                self.source_mode.get(),
                account_board_id=self.selected_account_board_id,
                account_label=self._selected_board_label() if self.source_mode.get() == ACCOUNT_SOURCE_MODE else "",
                board_text=self.board_id.get(),
                url_list_text=self.url_list_path.get().strip(),
            )
        except Exception:  # noqa: BLE001 - no board chosen yet is fine
            inputs = []
        refs = [item.url if isinstance(item, ResolvedBoard) else item for item in inputs]
        websdk: str | Path = "auto"
        if self.active_workflow_mode != AGENT_WORKFLOW and self.source_mode.get() in MIRO_EXPORT_MODES:
            try:
                websdk = gui_support.resolve_websdk_option(
                    self.websdk_choice.get(), self.websdk_path.get(), single_board=len(refs) <= 1
                )
            except ValueError:
                websdk = "auto"
        return gui_support.build_agent_instructions(
            cli_command=gui_support.agent_cli_command(),
            vault_root=vault_root,
            target_dir=Path(target_text) if target_text else None,
            output_format=self.output_format.get(),
            boards=refs,
            websdk=str(websdk),
        )

    def copy_agent_instructions(self) -> None:
        try:
            text = self._agent_instructions_text()
        except Exception as exc:  # noqa: BLE001
            self._log(f"Could not build the instructions: {exc}")
            show_error_later(self.after, "Copy instructions", exc)
            return
        self.clipboard_clear()
        self.clipboard_append(text)
        self._log("Instructions for your agent copied. Paste them into your agent's chat.")
        messagebox.showinfo(
            "Copied",
            "The instructions are on your clipboard.\n\nPaste them into your AI agent's chat. "
            "They contain no Miro credentials.",
        )


def main() -> None:
    app = MiroPipelineApp()
    app.mainloop()


if __name__ == "__main__":
    main()
