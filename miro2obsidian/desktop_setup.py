"""Miro connection steps inside the main desktop window."""

import webbrowser

from miro2obsidian import desktop_ui as ctk
from miro2obsidian.app_setup import (
    ACCESS_HELP, APP_NAME, APP_URL, CONFIG_HELP, CONNECT_HELP, CREATE_HELP,
    MIRO_APPS_URL, REDIRECT_URI, SCOPES, TEAM_HELP, TOKEN_HELP,
)
from miro2obsidian import gui_support


class ConnectionSetup:
    def __init__(self, app):
        self.app = app
        saved = gui_support.load_settings().get('last_completed_setup_step')
        self.step = {'create': 1, 'configure': 2}.get(saved, 0)
        self.busy = False
        self.page = ctk.CTkFrame(app.workspace, fg_color="transparent")
        self.page.grid_columnconfigure(0, weight=1)
        ctk.CTkLabel(self.page, text="Connect Miro", font=ctk.CTkFont(size=28, weight="bold")).grid(row=0, column=0, sticky="w", padx=16, pady=(16, 8))
        navigation = ctk.CTkFrame(self.page, fg_color="transparent")
        navigation.grid(row=1, column=0, sticky="we", padx=16, pady=8)
        self.tabs = []
        for index, title in enumerate(("1. Create app", "2. Configure app", "3. Connect")):
            button = ctk.CTkButton(navigation, text=title, command=lambda step=index: self.show(step))
            button.grid(row=0, column=index, padx=(0, 8), pady=4)
            self.tabs.append(button)
        self.panels = [ctk.CTkFrame(self.page, fg_color="transparent") for _ in range(3)]
        for panel in self.panels:
            panel.grid_columnconfigure(0, weight=1)
        create, configure, connect = self.panels
        self.note(create, CREATE_HELP, 0)
        ctk.CTkButton(create, text="Open Developer Hub", variant="primary", command=lambda: webbrowser.open(MIRO_APPS_URL)).grid(row=1, column=0, sticky="w", padx=16, pady=8)
        self.copy_row(create, "Developer Hub address", MIRO_APPS_URL, 2)
        self.copy_row(create, "App name", APP_NAME, 3)
        self.note(create, TEAM_HELP, 4)
        ctk.CTkLabel(create, text="Authorization token", font=ctk.CTkFont(size=18, weight="bold")).grid(row=5, column=0, sticky="w", padx=16, pady=(16, 4))
        self.note(create, TOKEN_HELP, 6)
        ctk.CTkButton(create, text="I already have a configured app", command=lambda: self.show(2)).grid(row=7, column=0, sticky="w", padx=16, pady=8)
        self.note(configure, CONFIG_HELP, 0)
        self.copy_row(configure, "App URL / SDK URI", APP_URL, 1)
        self.copy_row(configure, "Redirect URI for OAuth 2.0", REDIRECT_URI, 2)
        self.copy_row(configure, "Permissions (scopes)", " ".join(SCOPES), 3)
        self.note(connect, CONNECT_HELP, 0)
        self.note(connect, ACCESS_HELP, 1)
        fields = ctk.CTkFrame(connect, fg_color="transparent")
        fields.grid(row=2, column=0, sticky="we", padx=16, pady=8)
        fields.grid_columnconfigure(1, weight=1)
        self.client_id = ctk.CTkEntry(fields)
        self.client_secret = ctk.CTkEntry(fields, show="*")
        for row, (label, entry) in enumerate((("Client ID", self.client_id), ("Client secret", self.client_secret))):
            ctk.CTkLabel(fields, text=label).grid(row=row, column=0, sticky="w", padx=(0, 12), pady=10)
            entry.grid(row=row, column=1, sticky="we", padx=(0, 8), pady=10)
            ctk.CTkButton(fields, text="Paste", width=85, command=lambda target=entry: self.paste(target)).grid(row=row, column=2, pady=10)
        self.feedback = ctk.CTkLabel(self.page, text="", wraplength=740, justify="left", anchor="w")
        self.feedback.grid(row=3, column=0, sticky="we", padx=16, pady=8)
        actions = ctk.CTkFrame(self.page, fg_color="transparent")
        actions.grid(row=4, column=0, sticky="we", padx=16, pady=16)
        actions.grid_columnconfigure(1, weight=1)
        self.close_button = ctk.CTkButton(actions, text="Return to source", command=self.close)
        self.close_button.grid(row=0, column=0, padx=(0, 8))
        self.back = ctk.CTkButton(actions, text="Back", command=lambda: self.show(self.step - 1))
        self.back.grid(row=0, column=1, sticky="e", padx=8)
        self.next = ctk.CTkButton(actions, text="Continue", variant="primary", command=self.advance)
        self.next.grid(row=0, column=2, padx=(8, 0))
        self.show(self.step)

    def note(self, parent, text, row):
        ctk.CTkLabel(parent, text=text, wraplength=740, justify="left", anchor="w").grid(row=row, column=0, sticky="we", padx=16, pady=8)

    def copy_row(self, parent, label, value, row):
        frame = ctk.CTkFrame(parent, fg_color="transparent")
        frame.grid(row=row, column=0, sticky="we", padx=16, pady=8)
        frame.grid_columnconfigure(0, weight=1)
        ctk.CTkLabel(frame, text=label).grid(row=0, column=0, sticky="w", pady=(0, 4))
        entry = ctk.CTkEntry(frame)
        entry.insert(0, value)
        entry.configure(state="readonly")
        entry.grid(row=1, column=0, sticky="we", padx=(0, 8))
        ctk.CTkButton(frame, text="Copy", width=100, command=lambda: self.copy(value)).grid(row=1, column=1)

    def show(self, step):
        if self.busy:
            return
        self.step = max(0, min(2, step))
        for page in self.app.guided.pages:
            page.grid_remove()
        self.app.action_bar.grid_remove()
        self.page.grid(row=0, column=0, sticky="nsew", padx=12, pady=12)
        for index, panel in enumerate(self.panels):
            panel.grid_remove()
            self.tabs[index].configure(state="disabled" if index == self.step else "normal")
        self.panels[self.step].grid(row=2, column=0, sticky="we")
        self.feedback.configure(text="")
        self.back.configure(state="disabled" if self.step == 0 else "normal")
        self.next.configure(text="Connect" if self.step == 2 else "Continue")
        self.app.workspace._parent_canvas.yview_moveto(0)

    def copy(self, value):
        try:
            self.app.clipboard_clear()
            self.app.clipboard_append(value)
            self.feedback.configure(text="Copied.")
        except Exception:  # Clipboard failure must stay in this page.
            self.feedback.configure(text="Copy failed. Select the address and press Ctrl+C.")

    def paste(self, entry):
        try:
            value = self.app.clipboard_get()
        except Exception:
            self.feedback.configure(text="Clipboard is empty.")
            return
        entry.delete(0, "end")
        entry.insert(0, value)

    def advance(self):
        if self.busy:
            return
        if self.step < 2:
            gui_support.save_settings({'last_completed_setup_step': ('create', 'configure')[self.step]})
            self.show(self.step + 1)
            return
        client_id = self.client_id.get().strip()
        secret = self.client_secret.get().strip()
        if not client_id or not secret:
            self.feedback.configure(text="Enter both the Miro Client ID and Client secret.")
            (self.client_id if not client_id else self.client_secret).focus_set()
            return
        self.set_busy(True)
        self.feedback.configure(text="Waiting for Miro authorization. Finish it in your browser.")
        self.app.connect_miro_app(
            client_id, secret,
            on_success=lambda _status: self.app._ui(self.complete),
            on_error=lambda message: self.app._ui(lambda: self.failed(message)),
        )

    def set_busy(self, busy):
        self.busy = busy
        for widget in (*self.tabs, self.back, self.next, self.close_button, self.client_id, self.client_secret):
            widget.configure(state="disabled" if busy else "normal")
        if not busy:
            self.tabs[self.step].configure(state="disabled")
            self.back.configure(state="disabled" if self.step == 0 else "normal")

    def complete(self):
        self.set_busy(False)
        gui_support.save_settings({'last_completed_setup_step': 'connect'})
        self.close()

    def failed(self, message):
        self.set_busy(False)
        self.feedback.configure(text="Connection failed. Check the app credentials, redirect URI, and Miro permissions.")

    def close(self):
        if self.busy:
            return
        self.client_secret.delete(0, "end")
        self.client_id.delete(0, "end")
        self.page.destroy()
        self.app._setup_view = None
        self.app.action_bar.grid()
        self.app.guided.show(1)
