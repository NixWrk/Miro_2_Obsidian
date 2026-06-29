from __future__ import annotations

import os
import re
import sys
import threading
from pathlib import Path
from tkinter import filedialog, messagebox
from typing import Callable

import customtkinter as ctk


REPO_ROOT = Path(__file__).resolve().parent
SCRIPTS_DIR = REPO_ROOT / "scripts"
MIRO_JSON_DIR = REPO_ROOT / "Miro_2_Json"
CONVERTER_DIR = REPO_ROOT / "Json_2_Canvas"

sys.path.insert(0, str(SCRIPTS_DIR))
sys.path.insert(0, str(MIRO_JSON_DIR))
sys.path.insert(0, str(CONVERTER_DIR))

from Scale_engine import ViewProfile  # noqa: E402
from miro_downloader import get_boards  # noqa: E402
from miro_oauth_token import authorize_and_get_token, config_from_env  # noqa: E402
from miro_pipeline import run_existing_json_pipeline, run_rest_experimental_pipeline  # noqa: E402
from obsidian_vault_settings import resolve_vault_paths  # noqa: E402


ACCOUNT_SOURCE_MODE = "Miro account"
URL_SOURCE_MODE = "Miro URL"
URL_LIST_SOURCE_MODE = "Miro URL list"
JSON_SOURCE_MODE = "Existing JSON"
MIRO_EXPORT_MODES = {ACCOUNT_SOURCE_MODE, URL_SOURCE_MODE, URL_LIST_SOURCE_MODE}
ZOOM_UNLOCKED_MIN_ZOOM = "0.000244140625"
BOARD_URL_RE = re.compile(r"https://miro\.com/app/board/(?P<id>[^/?#)]+)", flags=re.IGNORECASE)


def board_id_from_text(value: str) -> str:
    value = value.strip()
    match = BOARD_URL_RE.search(value)
    if match:
        return match.group("id")
    return value


def default_web_board_list() -> Path | None:
    root = REPO_ROOT / "work" / "MIRO2OBSIDIAN" / "Obs_Miro"
    if not root.exists():
        return None
    matches = sorted(root.rglob("Web_boards.md"))
    return matches[0] if matches else None


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


def authorize_gui_token(logger: Callable[[str], None] | None = None) -> str:
    def log(message: str) -> None:
        if logger:
            logger(message)

    token = os.environ.get("MIRO_ACCESS_TOKEN")
    if token:
        log("Using MIRO_ACCESS_TOKEN from environment.")
        return token

    if os.environ.get("MIRO_CLIENT_ID") and os.environ.get("MIRO_CLIENT_SECRET"):
        log("Starting OAuth from MIRO_CLIENT_ID/MIRO_CLIENT_SECRET.")
        return authorize_and_get_token(config_from_env())

    raise RuntimeError(
        "Miro OAuth requires a Miro Developer App. Set MIRO_ACCESS_TOKEN, "
        "or set MIRO_CLIENT_ID and MIRO_CLIENT_SECRET for your own app."
    )


class MiroPipelineApp(ctk.CTk):
    def __init__(self) -> None:
        super().__init__()
        self.title("Miro -> Obsidian Canvas")
        self.geometry("1040x740")
        self.minsize(940, 680)

        self.token: str | None = os.environ.get("MIRO_ACCESS_TOKEN")
        self.boards_by_label: dict[str, dict] = {}
        self.selected_account_board_id = ""

        self._build_ui()
        self._log("Ready. Default path: Miro board -> REST experimental JSON + assets -> Canvas.")

    def _build_ui(self) -> None:
        ctk.set_appearance_mode("System")
        ctk.set_default_color_theme("blue")

        for column in range(4):
            self.grid_columnconfigure(column, weight=1 if column == 1 else 0)

        pad = {"padx": 10, "pady": 7}

        title = ctk.CTkLabel(self, text="Miro -> Obsidian Canvas", font=ctk.CTkFont(size=22, weight="bold"))
        title.grid(row=0, column=0, columnspan=4, sticky="w", padx=12, pady=(16, 10))

        ctk.CTkLabel(self, text="Source").grid(row=1, column=0, sticky="e", **pad)
        self.source_mode = ctk.CTkOptionMenu(
            self,
            values=[ACCOUNT_SOURCE_MODE, URL_SOURCE_MODE, URL_LIST_SOURCE_MODE, JSON_SOURCE_MODE],
            command=self.on_source_mode_changed,
        )
        self.source_mode.set(ACCOUNT_SOURCE_MODE)
        self.source_mode.grid(row=1, column=1, columnspan=3, sticky="we", **pad)

        self.path_frame = ctk.CTkFrame(self, fg_color="transparent")
        self.path_frame.grid(row=2, column=0, columnspan=4, sticky="we")
        self.path_frame.grid_columnconfigure(1, weight=1)

        self.account_frame = ctk.CTkFrame(self.path_frame, fg_color="transparent")
        self.account_frame.grid_columnconfigure(1, weight=1)
        ctk.CTkLabel(self.account_frame, text="Board").grid(row=0, column=0, sticky="e", **pad)
        self.board_menu = ctk.CTkOptionMenu(self.account_frame, values=["load boards"], command=self.on_board_selected)
        self.board_menu.grid(row=0, column=1, sticky="we", **pad)
        ctk.CTkButton(self.account_frame, text="Authenticate", width=130, command=self.authorize_and_load_boards).grid(row=0, column=2, **pad)
        self.load_boards_button = ctk.CTkButton(self.account_frame, text="Load boards", width=130, command=self.load_boards)
        self.load_boards_button.grid(row=0, column=3, **pad)

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

        ctk.CTkLabel(self, text="Canvas folder").grid(row=3, column=0, sticky="e", **pad)
        self.target_dir = ctk.CTkEntry(self)
        self.target_dir.grid(row=3, column=1, columnspan=2, sticky="we", **pad)
        ctk.CTkButton(self, text="Browse", width=130, command=self.pick_target_dir).grid(row=3, column=3, **pad)

        ctk.CTkLabel(self, text="Vault root (auto)").grid(row=4, column=0, sticky="e", **pad)
        self.vault_root = ctk.CTkEntry(self)
        self.vault_root.grid(row=4, column=1, columnspan=2, sticky="we", **pad)
        self.vault_root.configure(state="disabled")
        self.vault_root_button = ctk.CTkButton(self, text="Auto", width=130)
        self.vault_root_button.grid(row=4, column=3, **pad)
        self.vault_root_button.configure(state="disabled")

        options = ctk.CTkFrame(self)
        options.grid(row=5, column=0, columnspan=4, sticky="we", padx=10, pady=(10, 4))
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
            text="Allow missing assets",
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

        self.run_button = ctk.CTkButton(self, text="Run pipeline", height=40, command=self.run_pipeline)
        self.run_button.grid(row=6, column=3, sticky="e", padx=10, pady=(10, 8))

        self.log = ctk.CTkTextbox(self, height=230)
        self.log.grid(row=7, column=0, columnspan=4, sticky="nsew", padx=10, pady=(4, 10))
        self.grid_rowconfigure(7, weight=1)
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

    def _default_source_json(self, label: str) -> Path:
        canvas_text = self.target_dir.get().strip()
        base = Path(canvas_text) if canvas_text else REPO_ROOT / "work" / "MIRO2OBSIDIAN" / "Miro_2_JSON"
        return base / "_miro_sources" / f"{safe_name(label)}.json"

    def _selected_board_label(self) -> str:
        if self.source_mode.get() == ACCOUNT_SOURCE_MODE:
            selected = self.board_menu.get()
            board = self.boards_by_label.get(selected)
            if board:
                return str(board.get("name") or board.get("id") or "board")
            return "board"
        value = board_id_from_text(self.board_id.get())
        return value or "board"

    def _authorize_token(self) -> str:
        self.token = authorize_gui_token(self._log)
        return self.token

    def _token(self) -> str:
        if self.token:
            return self.token
        return self._authorize_token()

    def authorize_oauth(self) -> None:
        def worker() -> None:
            try:
                self.token = self._authorize_token()
                self._log("OAuth token obtained for this GUI session.")
            except Exception as exc:  # noqa: BLE001
                self._log(f"OAuth failed: {exc}")
                self.after(0, lambda: messagebox.showerror("OAuth failed", str(exc)))

        threading.Thread(target=worker, daemon=True).start()

    def _apply_boards(self, boards: list[dict]) -> None:
        labels = []
        by_label: dict[str, dict] = {}
        for board in boards:
            name = str(board.get("name") or board.get("id") or "board")
            label = f"{name} ({board.get('id')})"
            labels.append(label)
            by_label[label] = board
        self.boards_by_label = by_label
        self.after(0, lambda: self.board_menu.configure(values=labels or ["load boards"]))
        if labels:
            self.after(0, lambda: self.board_menu.set(labels[0]))
            self.after(0, lambda: self.on_board_selected(labels[0]))
        self._log(f"Loaded boards: {len(labels)}")

    def authorize_and_load_boards(self) -> None:
        def worker() -> None:
            try:
                token = self._authorize_token()
                self._log("OAuth token obtained for this GUI session.")
                self._apply_boards(get_boards(token))
            except Exception as exc:  # noqa: BLE001
                self._log(f"OAuth failed: {exc}")
                self.after(0, lambda: messagebox.showerror("OAuth failed", str(exc)))

        threading.Thread(target=worker, daemon=True).start()

    def load_boards(self) -> None:
        def worker() -> None:
            try:
                self._apply_boards(get_boards(self._token()))
            except Exception as exc:  # noqa: BLE001
                self._log(f"Board load failed: {exc}")
                self.after(0, lambda: messagebox.showerror("Board load failed", str(exc)))

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
        if mode in MIRO_EXPORT_MODES:
            self.allow_missing_assets_checkbox.grid(
                row=1,
                column=4,
                columnspan=2,
                sticky="w",
                padx=8,
                pady=(0, 8),
            )
        else:
            self.allow_missing_assets_checkbox.grid_remove()

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

    def _run_one_board(
        self,
        *,
        board_id: str,
        label: str,
        source_json: Path,
        target_dir: Path,
        vault_root: Path,
        attachment_dir: Path | None,
        profile: ViewProfile,
        min_font_px: int,
    ):
        return run_rest_experimental_pipeline(
            board_id=board_id,
            token=self._token(),
            source_json=source_json,
            target_dir=target_dir,
            vault_root=vault_root,
            scale=self._parse_float_or_none(self.scale.get()),
            view_profile=profile,
            min_font_px=min_font_px,
            theme=self.theme.get(),
            text_style_mode=self.text_style_mode.get(),
            allow_missing_assets=self.allow_missing_assets.get(),
            install_obsidian_plugins=self.install_obsidian_plugins.get(),
            attachment_dir=attachment_dir,
            logger=lambda message: self._log(f"{label}: {message}"),
        )

    def run_pipeline(self) -> None:
        def worker() -> None:
            self._set_busy(True)
            try:
                source_mode = self.source_mode.get()
                target_text = self.target_dir.get().strip()
                if not target_text:
                    raise ValueError("Canvas folder is required.")
                target_dir = Path(target_text)
                vault_paths = resolve_vault_paths(target_dir)
                vault_root = vault_paths.vault_root
                attachment_dir = vault_paths.attachment_dir
                self.after(0, lambda: self._set_entry(self.vault_root, str(vault_root), disabled=True))

                min_font_px = int(self.min_font_px.get().strip() or "8")
                profile = ViewProfile(
                    min_zoom=float(self.min_zoom.get().strip() or "0.12"),
                    min_font_px=min_font_px,
                    scale_mode=self.scale_mode.get(),
                )
                if source_mode == JSON_SOURCE_MODE:
                    source_text = self.json_path.get().strip()
                    if not source_text:
                        raise ValueError("Choose a JSON file.")
                    result = run_existing_json_pipeline(
                        source_json=Path(source_text),
                        target_dir=target_dir,
                        vault_root=vault_root,
                        scale=self._parse_float_or_none(self.scale.get()),
                        view_profile=profile,
                        min_font_px=min_font_px,
                        theme=self.theme.get(),
                        text_style_mode=self.text_style_mode.get(),
                        install_obsidian_plugins=self.install_obsidian_plugins.get(),
                        attachment_dir=attachment_dir,
                        logger=self._log,
                    )
                elif source_mode == URL_LIST_SOURCE_MODE:
                    list_text = self.url_list_path.get().strip()
                    if not list_text:
                        raise ValueError("Choose a URL list file.")
                    list_path = Path(list_text)
                    refs = board_refs_from_file(list_path)
                    if not refs:
                        raise ValueError(f"No Miro board links found in {list_path}")
                    source_root = target_dir / "_miro_sources"
                    last_result = None
                    for index, (ref_id, label) in enumerate(refs, start=1):
                        board_dir = target_dir / safe_name(label)
                        board_json = source_root / f"{safe_name(label)}.json"
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
                        )
                    result = last_result
                else:
                    if source_mode == ACCOUNT_SOURCE_MODE:
                        board_id = self.selected_account_board_id
                        if not board_id:
                            raise ValueError("Load boards and choose a board.")
                        label = self._selected_board_label()
                    else:
                        board_id = board_id_from_text(self.board_id.get())
                        if not board_id:
                            raise ValueError("Paste a Miro board link.")
                        label = board_id
                    result = self._run_one_board(
                        board_id=board_id,
                        label=label,
                        source_json=self._default_source_json(label),
                        target_dir=target_dir,
                        vault_root=vault_root,
                        attachment_dir=attachment_dir,
                        profile=profile,
                        min_font_px=min_font_px,
                    )
                done_path = str(result.canvas_path) if result else str(target_dir)
                self._log(f"Done: {done_path}")
                self.after(0, lambda: messagebox.showinfo("Pipeline complete", done_path))
            except Exception as exc:  # noqa: BLE001
                self._log(f"Pipeline failed: {exc}")
                self.after(0, lambda: messagebox.showerror("Pipeline failed", str(exc)))
            finally:
                self._set_busy(False)

        threading.Thread(target=worker, daemon=True).start()


if __name__ == "__main__":
    app = MiroPipelineApp()
    app.mainloop()
