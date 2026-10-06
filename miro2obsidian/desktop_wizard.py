"""Contextual navigation around the existing desktop application service."""

from pathlib import Path
import webbrowser

from miro2obsidian import desktop_ui as ctk
from Json_2_Canvas.output_formats import MIRO_CANVAS, OUTPUT_FORMATS, RAW_JSON
from miro2obsidian.desktop_actions import open_output_folder, obsidian_uri

EXPORT_DATA = "Export data"
FOR_OBSIDIAN = "For Obsidian"
MIRO_CANVAS_URL = "https://github.com/NixWrk/Obsidian-Plugin---Miro-Canvas"


class GuidedWorkflow:
    def __init__(self, app):
        self.app = app
        self.step = 0
        self.busy = False
        self.connected = False
        self.boards_ready = False
        self.canvas_format = MIRO_CANVAS
        self.result_frame = None
        app.workspace = ctk.build_workspace(app)
        app.workspace.grid_columnconfigure(0, weight=1)
        self.pages = [ctk.CTkFrame(app.workspace, fg_color="transparent") for _ in range(4)]
        for page in self.pages:
            page.grid_columnconfigure(1, weight=1)
        self.advanced = ctk.CTkFrame(self.pages[2])
        self.export_options = ctk.CTkFrame(self.pages[2], fg_color="transparent")
        self.sdk = ctk.CTkFrame(self.pages[1])
        self.sdk.grid_columnconfigure(1, weight=1)
        self.sdk_open = False
        self.advanced_open = False
        self.error = ctk.CTkLabel(app.action_bar, text="", anchor="w", wraplength=700)
        self.error.grid(row=1, column=0, columnspan=4, sticky="we", padx=12, pady=4)
        self.back = ctk.CTkButton(app.action_bar, text="Back", command=self.previous)
        self.next = ctk.CTkButton(app.action_bar, text="Continue", variant="primary", command=self.advance)

    def finish(self):
        a = self.app
        ctk.CTkLabel(self.pages[1], text="Choose a Miro board or an existing export.", anchor="w").grid(
            row=0, column=0, columnspan=4, sticky="we", padx=12, pady=16)
        self.destination_hint = ctk.CTkLabel(self.pages[2], text="Choose any folder for the JSON and attachments.", anchor="w")
        self.destination_hint.grid(
            row=0, column=0, columnspan=4, sticky="we", padx=12, pady=16)
        ctk.CTkLabel(self.pages[2], text="Destination").grid(row=1, column=0, sticky="e", padx=8, pady=8)
        a.export_purpose = ctk.CTkOptionMenu(self.pages[2], values=[EXPORT_DATA, FOR_OBSIDIAN], command=self.purpose_changed)
        a.export_purpose.set(EXPORT_DATA)
        a.export_purpose.grid(row=1, column=1, columnspan=3, sticky="we", padx=8, pady=8)
        ctk.CTkLabel(self.pages[3], text="Export progress", font=ctk.CTkFont(size=28, weight="bold")).grid(
            row=0, column=0, columnspan=4, sticky="w", padx=12, pady=16)
        self.advanced_toggle = ctk.CTkButton(self.pages[2], text="Advanced settings", command=self.toggle_advanced)
        self.advanced_toggle.grid(row=7, column=0, columnspan=4, sticky="w", padx=12, pady=16)
        self.export_options.grid(row=9, column=0, columnspan=4, sticky="we", padx=12, pady=8)
        # Vault discovery is automatic, so its disabled controls add no decision.
        a.vault_root.grid_remove()
        a.vault_root_button.grid_remove()
        for child in self.pages[2].winfo_children():
            if isinstance(child, ctk.CTkLabel) and getattr(child, "_original_text", "") == "Vault root (auto)":
                child.grid_remove()
        self.sdk_toggle = ctk.CTkButton(self.pages[1], text="Additional board data", command=self.toggle_sdk)
        self.sdk_toggle.grid(row=4, column=0, columnspan=4, sticky="w", padx=12, pady=12)
        self.connection_extras = []
        for child in a.account_frame.winfo_children():
            if getattr(child, "_original_text", "") in {"Switch Miro team", "Forget saved token"}:
                self.connection_extras.append(child)
                child.grid_remove()
        self.connection_open = False
        ctk.CTkButton(a.account_frame, text="Connection options", command=self.toggle_connection).grid(
            row=3, column=0, columnspan=4, sticky="w", padx=10, pady=8)
        for row, child in enumerate(self.connection_extras, 4):
            child.grid(row=row, column=0, columnspan=4, sticky="w", padx=10, pady=7)
            child.grid_remove()
        self.order_source_controls()
        self.context()
        self.show(0)

    def order_source_controls(self):
        """Place prerequisites before the choices they unlock, in reading order."""
        a = self.app
        page = self.pages[1]
        for child in page.winfo_children():
            if getattr(child, "_original_text", "") == "Source" or child is a.source_mode:
                child.grid_configure(row=1)
        if hasattr(a, "connection_label"):
            a.connection_label.grid_configure(row=2)
        a.path_frame.grid_configure(row=3)
        self.refresh_button = None
        for child in a.account_frame.winfo_children():
            text = getattr(child, "_original_text", "")
            if text == "Set up Miro app":
                child.grid_configure(row=0, column=0, columnspan=4, sticky="w")
            elif text in {"Refresh boards", "Authenticate / refresh"}:
                self.refresh_button = child
                child.grid_configure(row=1, column=0, columnspan=4, sticky="w")
            elif text == "Board":
                child.grid_configure(row=2, column=0)
        a.board_menu.grid_configure(row=2, column=1, columnspan=3)
        a.board_menu.configure(state="disabled")
        for frame in (a.url_frame, a.url_list_frame):
            for child in frame.winfo_children():
                child.grid_configure(row=int(child.grid_info()["row"]) + 1)
            ctk.CTkButton(frame, text="Set up Miro app", variant="primary", command=a.open_miro_setup).grid(
                row=0, column=0, columnspan=4, sticky="w", padx=10, pady=7)
        if hasattr(a, "connection_label") and self.refresh_button:
            self.refresh_button.configure(state="disabled")

    def connection_changed(self, connected):
        self.connected = connected
        if self.refresh_button:
            self.refresh_button.configure(state="normal" if connected else "disabled")
        if not connected:
            self.boards_loaded(False)
        self.context()

    def boards_loaded(self, ready):
        self.boards_ready = ready
        self.app.board_menu.configure(state="normal" if ready else "disabled")
        self.context()

    def show(self, step):
        self.step = step
        for page in self.pages:
            page.grid_remove()
        self.pages[step].grid(row=0, column=0, sticky="nsew", padx=12, pady=12)
        self.error.configure(text="")
        for index, label in enumerate(self.app.journey_labels):
            label.configure(fg_color="#403654" if index == step else "transparent")
        self.back.grid(row=2, column=0, sticky="w", padx=12, pady=12)
        self.back.configure(state="disabled" if step == 0 or self.busy else "normal")
        self.next.grid_remove()
        self.app.run_button.grid_remove()
        if step < 2:
            self.next.grid(row=2, column=2, sticky="e", padx=12, pady=12)
        else:
            self.app.run_button.grid(row=2, column=2, sticky="e", padx=12, pady=12)
        if hasattr(self.app, "copy_agent_button"):
            self.app.copy_agent_button.grid_remove()
            if step == 2 and self.app.workflow_mode.get() == "Agent":
                self.app.copy_agent_button.grid(row=2, column=1, padx=12, pady=12)
        self.app.workspace._parent_canvas.yview_moveto(0)

    def previous(self):
        if not self.busy:
            self.show(max(0, self.step - 1))

    def source_error(self):
        a = self.app
        mode = a.source_mode.get()
        if mode == "Miro account" and not a.selected_account_board_id:
            return "Connect to Miro and choose a board first."
        if mode == "Miro URL" and not a.board_id.get().strip():
            return "Paste your Miro board URL first."
        if mode in {"Existing JSON", "Miro URL list"}:
            entry = a.json_path if mode == "Existing JSON" else a.url_list_path
            if not Path(entry.get().strip()).is_file():
                return "Choose an existing source file first."
        return ""

    def advance(self):
        if self.busy:
            return
        error = self.source_error() if self.step == 1 else ""
        if error:
            self.error.configure(text=error)
        else:
            self.show(min(2, self.step + 1))

    def start(self):
        if self.busy:
            return
        error = self.source_error()
        if error:
            self.show(1)
        elif not self.app.target_dir.get().strip():
            error = "Choose an export folder first."
            self.show(2)
        if error:
            self.error.configure(text=error)
            return
        if self.result_frame is not None:
            self.result_frame.destroy()
            self.result_frame = None
        self.show(3)
        self.app.run_pipeline()

    def set_busy(self, busy):
        self.busy = busy
        self.app.run_button.configure(state="disabled" if busy else "normal")
        self.back.configure(state="disabled" if busy or self.step == 0 else "normal")
        self.next.configure(state="disabled" if busy else "normal")
        self.app.workflow_mode.configure(state="disabled" if busy else "normal")
        self.app.source_mode.configure(state="disabled" if busy else "normal")
        self.app.export_purpose.configure(state="disabled" if busy else "normal")
        self.app.output_format.configure(state="disabled" if busy else "normal")

    def toggle_advanced(self):
        self.advanced_open = not self.advanced_open
        if self.advanced_open:
            self.advanced.grid(row=8, column=0, columnspan=4, sticky="we", padx=12, pady=8)
        else:
            self.advanced.grid_remove()

    def toggle_sdk(self):
        self.sdk_open = not self.sdk_open
        self.context()

    def toggle_connection(self):
        self.connection_open = not self.connection_open
        for child in self.connection_extras:
            child.grid() if self.connection_open else child.grid_remove()

    def workflow_changed(self, mode):
        self.app.on_workflow_mode_changed(mode)
        values = ["Miro account", "Miro URL"]
        if mode != "Agent":
            values += ["Miro URL list", "Existing JSON"]
        self.app.source_mode.configure(values=values)
        if self.app.source_mode.get() not in values:
            self.app.source_mode.set(values[0])
            self.source_changed(values[0])
        self.context()
        self.show(self.step)

    def source_changed(self, mode):
        self.app.on_source_mode_changed(mode)
        self.context()

    def purpose_changed(self, purpose):
        a = self.app
        if purpose == EXPORT_DATA:
            if a.output_format.get() != RAW_JSON:
                self.canvas_format = a.output_format.get()
            a.output_format.configure(values=list(OUTPUT_FORMATS))
            a.output_format.set(RAW_JSON)
        else:
            a.output_format.set(self.canvas_format)
        self.context()

    def format_changed(self, mode):
        self.app.on_format_changed(mode)
        self.context()

    def context(self):
        a = self.app
        if not hasattr(a, "export_purpose"):
            return  # The source controls are initialized before finish().
        agent = a.workflow_mode.get() == "Agent"
        miro = a.source_mode.get() != "Existing JSON"
        if not miro and a.output_format.get() == RAW_JSON:
            a.output_format.set(self.canvas_format)
        raw_export = a.output_format.get() == RAW_JSON
        a.export_purpose.configure(values=[EXPORT_DATA, FOR_OBSIDIAN] if miro else [FOR_OBSIDIAN])
        a.export_purpose.set(EXPORT_DATA if raw_export else FOR_OBSIDIAN)
        if not raw_export:
            self.canvas_format = a.output_format.get()
        a.output_format.configure(values=list(OUTPUT_FORMATS) if raw_export else [value for value in OUTPUT_FORMATS if value != RAW_JSON])
        a.on_format_changed(a.output_format.get())
        a.destination_label.configure(text="Export folder" if raw_export else "Canvas folder")
        self.destination_hint.configure(text="Choose any folder for the JSON and attachments." if raw_export else "Choose a folder inside your Obsidian vault.")
        for widget in (a.output_format, a.format_label):
            widget.grid_remove() if raw_export else widget.grid()
        # Export controls stay available independently of Canvas layout settings.
        for column, widget in enumerate((a.allow_missing_assets_checkbox, a.stable_items_checkbox)):
            widget.grid(row=0, column=column, sticky="w", padx=8, pady=8)
        a.agent_settings_button.grid() if agent else a.agent_settings_button.grid_remove()
        if hasattr(a, "connection_label"):
            a.connection_label.grid() if miro else a.connection_label.grid_remove()
        a.stable_items_checkbox.grid() if miro else a.stable_items_checkbox.grid_remove()
        a.install_obsidian_plugins_checkbox.grid() if a.output_format.get() == "advanced-canvas" else a.install_obsidian_plugins_checkbox.grid_remove()
        # SDK capture is relevant only to Miro workflows handled by this app.
        sdk = (a.source_mode.get() == "Miro URL" or
               (a.source_mode.get() == "Miro account" and self.boards_ready)) and not agent
        if sdk:
            self.sdk_toggle.grid()
        else:
            self.sdk_toggle.grid_remove()
        if sdk and self.sdk_open:
            self.sdk.grid(row=5, column=0, columnspan=4, sticky="we", padx=12, pady=8)
        else:
            self.sdk.grid_remove()
        if hasattr(a, "websdk_choice"):
            from_file = a.websdk_choice.get() == "From file…"
            for child in (a.websdk_path, a.websdk_browse):
                child.grid() if from_file else child.grid_remove()
        if raw_export:
            self.advanced.grid_remove()
            self.advanced_toggle.grid_remove()
        else:
            self.advanced_toggle.grid()
            if self.advanced_open:
                self.advanced.grid(row=8, column=0, columnspan=4, sticky="we", padx=12, pady=8)

    def show_result(self, path, source_json, output_format, *, degraded=False, item_count=None):
        """Offer actions on the written export without running another import."""
        if self.result_frame is not None:
            self.result_frame.destroy()
        self.result_frame = ctk.CTkFrame(self.pages[3], fg_color="transparent")
        self.result_frame.grid(row=1, column=0, columnspan=4, sticky="we", padx=12, pady=12)
        title = "Written with gaps" if degraded else "Export complete"
        ctk.CTkLabel(self.result_frame, text=title, font=ctk.CTkFont(size=22, weight="bold")).pack(anchor="w", pady=8)
        summary = "JSON, comments, attachments and source evidence are saved." if output_format == RAW_JSON else "The Canvas and its source export are saved."
        ctk.CTkLabel(self.result_frame, text=summary, wraplength=700, justify="left").pack(anchor="w", pady=4)
        if degraded:
            ctk.CTkLabel(self.result_frame, text="Some source data or required assets are missing. See the export log for details.", wraplength=700, justify="left").pack(anchor="w", pady=4)
        if item_count is not None:
            ctk.CTkLabel(self.result_frame, text=f"Items: {item_count}").pack(anchor="w", pady=4)
        ctk.CTkLabel(self.result_frame, text=str(path), wraplength=700, justify="left").pack(anchor="w", pady=4)
        ctk.CTkButton(self.result_frame, text="Open folder", command=lambda: self.open_result(path.parent)).pack(anchor="w", pady=6)
        if output_format != RAW_JSON:
            ctk.CTkButton(self.result_frame, text="Open in Obsidian", variant="primary", command=lambda: webbrowser.open(obsidian_uri(path))).pack(anchor="w", pady=6)
        if source_json:
            ctk.CTkButton(self.result_frame, text="Prepare for Miro Canvas", command=lambda: self.prepare_canvas(source_json)).pack(anchor="w", pady=6)
        ctk.CTkLabel(self.result_frame, text="Work with this board in Obsidian using Miro Canvas: sticky notes, shapes and comments.", wraplength=700, justify="left").pack(anchor="w", pady=(14, 4))
        ctk.CTkButton(self.result_frame, text="Learn about Miro Canvas", command=lambda: webbrowser.open(MIRO_CANVAS_URL)).pack(anchor="w", pady=6)
        ctk.CTkButton(self.result_frame, text="Export another board", command=lambda: self.show(1)).pack(anchor="w", pady=6)
        self.show(3)
        self.app.run_button.grid_remove()

    def open_result(self, folder):
        try:
            open_output_folder(folder)
        except OSError as exc:
            self.app._log(f"Could not open the folder: {exc}")

    def prepare_canvas(self, source_json):
        if self.busy:
            return
        a = self.app
        a.workflow_mode.set("Manual")
        self.workflow_changed("Manual")
        a.source_mode.set("Existing JSON")
        a._set_entry(a.json_path, str(source_json))
        a.output_format.set(MIRO_CANVAS)
        self.source_changed("Existing JSON")
        a._set_entry(a.target_dir, "")
        a._set_entry(a.vault_root, "", disabled=True)
        self.show(2)
