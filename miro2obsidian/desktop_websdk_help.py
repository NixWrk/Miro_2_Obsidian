"""Inline instructions for the optional manual Web SDK capture."""

from miro2obsidian.app_setup import APP_URL
from miro2obsidian.export_methods import (
    BATCH_HELP, LIMITS, OUTPUT_COVERAGE, REST_COVERAGE, SDK_COVERAGE, UNION_COVERAGE,
)

WEBSDK_COMMAND = "miro2obsidian websdk-serve --port 8766"

INTRO = "The default REST + Web SDK method requires this file. It adds board data that REST may not expose. To continue without it, explicitly select REST only (less data) above."
STEPS = (
    "1. Open PowerShell / Terminal, run the command below, and keep that terminal open until the JSON is downloaded. If the command is unavailable, use the source-checkout command below.",
    "2. In Developer Hub → Your apps, open the Miro app you created. Save the App URL / SDK URI below, enable SDK authorization if shown, and install / authorize the app in the team that owns this board. Keep the OAuth redirect URI on port 8765.",
    "3. Open the same board in Miro in your browser. In the left toolbar, choose + More apps / + More tools and select your app by the name you gave it (for example, Miro Full Exporter).",
    "4. In the app panel, choose Export board (Export selection is not suitable). Save the downloaded JSON on your computer.",
    "5. Return here, choose that JSON with Browse, and run the export soon afterward. Both captures must describe the same board, be at most 24 hours old and at most 60 minutes apart.",
)
TROUBLESHOOTING = "App missing? Check installation in the board's team. Connection refused? Keep the local server running and check the App URL. Opening localhost alone does not capture a Miro board; open the app inside Miro."
SOURCE_COMMAND = r".\.venv\Scripts\python.exe -m scripts.miro_pipeline websdk-serve --port 8766"
SOURCE_HELP = "From this repository on Windows, run the command below in its folder instead. Keep the terminal open."


class WebSDKHelp:
    def __init__(self, app, parent):
        from miro2obsidian import desktop_ui as ctk

        self.app = app
        self.frame = ctk.CTkFrame(parent, fg_color="transparent")
        self.frame.grid(row=7, column=0, columnspan=4, sticky="we", padx=12, pady=12)
        self.frame.grid_columnconfigure(0, weight=1)
        self.notes = []
        self.coverage = ctk.CTkFrame(parent, fg_color="transparent")
        self.coverage.grid(row=1, column=0, columnspan=4, sticky="we", padx=12, pady=8)
        self.coverage.grid_columnconfigure(0, weight=1)
        self.coverage_labels = []
        for row, text in enumerate(("What each method saves", REST_COVERAGE, SDK_COVERAGE, UNION_COVERAGE, LIMITS, OUTPUT_COVERAGE)):
            label = ctk.CTkLabel(self.coverage, text=text, wraplength=640, justify="left", anchor="w")
            label.grid(row=row, column=0, sticky="we", pady=4)
            self.coverage_labels.append(label)
        self.batch_note = ctk.CTkLabel(parent, text=BATCH_HELP, wraplength=640, justify="left", anchor="w")
        self.batch_note.grid(row=4, column=0, columnspan=4, sticky="we", padx=12, pady=8)
        self.note("How to download the board file", 0, heading=True)
        self.note(INTRO, 1)
        self.note(STEPS[0], 2)
        self.command, self.command_copy = self.copy_row("Server command", WEBSDK_COMMAND, 3)
        self.note(SOURCE_HELP, 4)
        self.source_command, self.source_copy = self.copy_row("Source-checkout command (Windows)", SOURCE_COMMAND, 5)
        self.note(STEPS[1], 6)
        self.app_url, self.url_copy = self.copy_row("App URL / SDK URI", APP_URL, 7)
        for row, text in enumerate(STEPS[2:], 8):
            self.note(text, row)
        self.note(TROUBLESHOOTING, 11)
        self.feedback = ctk.CTkLabel(self.frame, text="", anchor="w")
        self.feedback.grid(row=12, column=0, sticky="we", pady=4)
        self.frame.bind("<Configure>", self.resize)
        self.coverage.bind("<Configure>", self.resize_coverage)

    def note(self, text, row, *, heading=False):
        from miro2obsidian import desktop_ui as ctk

        kwargs = {"font": ctk.CTkFont(size=18, weight="bold")} if heading else {}
        label = ctk.CTkLabel(self.frame, text=text, wraplength=640, justify="left", anchor="w", **kwargs)
        label.grid(row=row, column=0, sticky="we", pady=(8, 4))
        self.notes.append(label)

    def copy_row(self, label, value, row):
        from miro2obsidian import desktop_ui as ctk

        frame = ctk.CTkFrame(self.frame, fg_color="transparent")
        frame.grid(row=row, column=0, sticky="we", pady=4)
        frame.grid_columnconfigure(0, weight=1)
        ctk.CTkLabel(frame, text=label, anchor="w").grid(row=0, column=0, sticky="we", pady=4)
        entry = ctk.CTkEntry(frame)
        entry.insert(0, value)
        entry.configure(state="readonly")
        entry.grid(row=1, column=0, sticky="we", padx=(0, 8))
        button = ctk.CTkButton(frame, text="Copy", width=100, command=lambda: self.copy(value))
        button.grid(row=1, column=1)
        return entry, button

    def copy(self, value):
        try:
            self.app.clipboard_clear()
            self.app.clipboard_append(value)
            self.feedback.configure(text="Copied.")
        except Exception:
            self.feedback.configure(text="Copy failed. Select the address and press Ctrl+C.")

    def resize(self, event):
        for label in self.notes:
            label.configure(wraplength=max(240, event.width - 16))

    def resize_coverage(self, event):
        for label in (*self.coverage_labels, self.batch_note):
            label.configure(wraplength=max(240, event.width - 16))
