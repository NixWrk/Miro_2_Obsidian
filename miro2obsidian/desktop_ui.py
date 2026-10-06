"""Native presentation adapters sharing the web palette and translations.

Only labels are localized. Entries, copied values and menu return values retain
their original data. Export behavior remains in the application service.
"""

import copy
import weakref
import tkinter
from tkinter import filedialog as native_filedialog

import customtkinter as native

from miro2obsidian.desktop_strings import translate
from miro2obsidian.ui_preferences import load_preferences, save_preferences
from miro2obsidian.ui_theme import COLORS, DARK_COLORS


def __getattr__(name):
    return getattr(native, name)


def color(name):
    return (COLORS[name], DARK_COLORS[name])


def install_theme():
    theme = copy.deepcopy(native.ThemeManager.theme)
    theme["CTkFont"].update(family="Segoe UI", size=14)
    for kind, values in theme.items():
        if not isinstance(values, dict) or not kind.startswith("CTk"):
            continue
        for key in ("text_color",):
            if key in values:
                values[key] = color("ink")
        if "border_color" in values:
            values["border_color"] = color("border")
        if "text_color_disabled" in values:
            values["text_color_disabled"] = color("muted")
        if "corner_radius" in values:
            values["corner_radius"] = 6
    for kind in ("CTk", "CTkToplevel", "CTkTextbox", "CTkEntry", "CTkFrame", "CTkScrollableFrame"):
        if kind in theme:
            theme[kind]["fg_color"] = color("canvas" if kind in {"CTk", "CTkToplevel"} else "surface")
    theme["CTkFrame"]["top_fg_color"] = color("surface")
    theme["CTkFrame"]["corner_radius"] = 12
    theme["DropdownMenu"].update(fg_color=color("surface"), hover_color=color("purple_soft"), text_color=color("ink"))
    for kind in ("CTkButton", "CTkOptionMenu", "CTkCheckBox", "CTkSwitch", "CTkSegmentedButton"):
        values = theme[kind]
        for key in ("fg_color", "button_color", "selected_color", "progress_color"):
            if key in values:
                values[key] = color("button")
        for key in ("hover_color", "button_hover_color", "selected_hover_color"):
            if key in values:
                values[key] = color("button_hover")
    for kind in ("CTkButton", "CTkOptionMenu", "CTkSegmentedButton"):
        theme[kind]["text_color"] = ["#ffffff", "#ffffff"]
    theme["CTkButton"].update(fg_color=color("control"), hover_color=color("control_hover"),
                               text_color=color("ink"), border_width=1)
    theme["CTkOptionMenu"].update(fg_color=color("control"), button_color=color("control"),
                                   button_hover_color=color("control_hover"), text_color=color("ink"))
    native.ThemeManager.theme = theme


class Presentation:
    def __init__(self):
        self.preferences = load_preferences()
        self.widgets = weakref.WeakSet()
        native.set_appearance_mode(self.preferences["theme"])

    def text(self, value):
        return translate(value, self.preferences["language"])

    def change(self, key, value):
        self.preferences[key] = value
        native.set_appearance_mode(self.preferences["theme"])
        try:
            save_preferences(self.preferences)
        except OSError:
            pass  # Appearance still works when the OS profile is read-only.
        for widget in list(self.widgets):
            if widget.winfo_exists():
                widget.retranslate()


def presentation(master):
    while master is not None:
        if "ui" in master.__dict__:
            return master.ui
        master = getattr(master, "master", None)
    return None


class CTk(native.CTk):
    def __init__(self, *args, **kwargs):
        install_theme()
        super().__init__(*args, **kwargs)
        self.ui = Presentation()


def preference_controls(master, *, dark_rail=False):
    ui = presentation(master)
    frame = native.CTkFrame(master, fg_color="transparent")
    label_color = "#eeeaf5" if dark_rail else color("ink")
    frame.grid_columnconfigure(0, weight=1)
    CTkLabel(frame, text="Language", text_color=label_color).grid(row=0, column=0, padx=6, pady=(6, 2), sticky="w")
    languages = native.CTkSegmentedButton(frame, values=["EN", "RU"],
                                         command=lambda value: ui.change("language", value.lower()))
    languages.set(ui.preferences["language"].upper())
    languages.grid(row=1, column=0, padx=6, pady=(2, 8), sticky="we")
    CTkLabel(frame, text="Appearance", text_color=label_color).grid(row=2, column=0, padx=6, pady=(6, 2), sticky="w")
    theme = CTkOptionMenu(frame, values=["light", "dark"], command=lambda value: ui.change("theme", value), width=140)
    theme.set(ui.preferences["theme"])
    theme.grid(row=3, column=0, padx=6, pady=(2, 8), sticky="we")
    if not dark_rail:
        # Dialogs have room for a compact horizontal preference bar.
        languages.grid(row=0, column=1, padx=6, pady=6)
        for widget in frame.winfo_children():
            if isinstance(widget, CTkLabel) and widget._original_text == "Appearance":
                widget.grid(row=0, column=2, padx=(16, 6), pady=6)
        theme.grid(row=0, column=3, padx=6, pady=6)
    # Controls in other open windows follow a preference changed here.
    original = theme.retranslate
    def refresh():
        original()
        theme.set(ui.preferences["theme"])
        languages.set(ui.preferences["language"].upper())
    theme.retranslate = refresh
    return frame


class CTkToplevel(native.CTkToplevel):
    def __init__(self, master=None, *args, **kwargs):
        super().__init__(master, *args, **kwargs)
        self.ui = presentation(master)
        self._original_title = ""
        if self.ui:
            self.ui.widgets.add(self)
            self.after_idle(self._add_preferences)

    def title(self, value=None):
        if value is None:
            return super().title()
        self._original_title = value
        ui = getattr(self, "ui", None)
        return super().title(ui.text(value) if ui else value)

    def retranslate(self):
        super().title(self.ui.text(self._original_title))

    def _add_preferences(self):
        if not self.winfo_exists():
            return
        controls = preference_controls(self)
        if any(child.winfo_manager() == "pack" for child in self.winfo_children()):
            controls.pack(side="bottom", fill="x", padx=12, pady=8)
        else:
            columns, rows = self.grid_size()
            controls.grid(row=rows, column=0, columnspan=max(1, columns), sticky="we", padx=12, pady=8)


class TextWidget:
    def __init__(self, master, *args, **kwargs):
        self._presentation = presentation(master)
        self._original_text = kwargs.get("text", "")
        if kwargs.get("text_color") == "gray60":
            kwargs["text_color"] = color("muted")
        if self._presentation and "text" in kwargs:
            kwargs["text"] = self._presentation.text(self._original_text)
        super().__init__(master, *args, **kwargs)
        if self._presentation:
            self._presentation.widgets.add(self)

    def configure(self, *args, **kwargs):
        if "text" in kwargs:
            self._original_text = kwargs["text"]
            if self._presentation:
                kwargs["text"] = self._presentation.text(self._original_text)
        return super().configure(*args, **kwargs)

    def retranslate(self):
        super().configure(text=self._presentation.text(self._original_text))


class CTkLabel(TextWidget, native.CTkLabel):
    pass


class CTkButton(TextWidget, native.CTkButton):
    def __init__(self, master, *args, variant="secondary", **kwargs):
        kwargs.setdefault("height", 34)
        if variant == "primary":
            kwargs.setdefault("fg_color", color("button"))
            kwargs.setdefault("hover_color", color("button_hover"))
            kwargs.setdefault("text_color", "#ffffff")
            kwargs.setdefault("border_width", 0)
        super().__init__(master, *args, **kwargs)


class CTkCheckBox(TextWidget, native.CTkCheckBox):
    pass


class CTkEntry(native.CTkEntry):
    def __init__(self, master, *args, **kwargs):
        self._presentation = presentation(master)
        self._placeholder = kwargs.get("placeholder_text")
        if self._presentation and self._placeholder:
            kwargs["placeholder_text"] = self._presentation.text(self._placeholder)
        super().__init__(master, *args, **kwargs)
        if self._presentation:
            self._presentation.widgets.add(self)

    def retranslate(self):
        if self._placeholder:
            super().configure(placeholder_text=self._presentation.text(self._placeholder))


class CTkOptionMenu(native.CTkOptionMenu):
    def __init__(self, master, *args, **kwargs):
        self._presentation = presentation(master)
        self._original_values = kwargs.get("values", [])
        callback = kwargs.get("command")
        if callback:
            kwargs["command"] = lambda _value: callback(self.get())
        super().__init__(master, *args, **kwargs)
        if self._presentation:
            self._presentation.widgets.add(self)
            self.retranslate()

    def get(self):
        displayed = super().get()
        if self._presentation:
            for value in self._original_values:
                if displayed == self._presentation.text(value):
                    return value
        return displayed

    def set(self, value):
        return super().set(self._presentation.text(value) if self._presentation else value)

    def configure(self, *args, **kwargs):
        if "values" in kwargs:
            self._original_values = kwargs["values"]
            if self._presentation:
                kwargs["values"] = [self._presentation.text(value) for value in self._original_values]
        return super().configure(*args, **kwargs)

    def retranslate(self):
        # Canonical selection must survive a language change. Keep it separately
        # because the old display string belongs to the previous language.
        selected = super().get()
        for value in self._original_values:
            if selected in {value, translate(value, "ru"), translate(value, "en")}:
                selected = value
                break
        super().configure(values=[self._presentation.text(value) for value in self._original_values])
        self.set(selected)


class CTkTextbox(native.CTkTextbox):
    def __init__(self, master, *args, localize=False, **kwargs):
        self._presentation = presentation(master)
        self._localize = localize
        self._original_content = ""
        super().__init__(master, *args, **kwargs)
        if localize and self._presentation:
            self._presentation.widgets.add(self)

    def insert(self, index, text, *args):
        if self._localize and self._presentation:
            self._original_content += text
            text = self._presentation.text(text)
        return super().insert(index, text, *args)

    def delete(self, first, last=None):
        if self._localize:
            self._original_content = ""
        return super().delete(first, last)

    def retranslate(self):
        state = self.cget("state")
        view = self._textbox.yview()
        super().configure(state="normal")
        super().delete("1.0", "end")
        super().insert("1.0", self._presentation.text(self._original_content))
        self._textbox.yview_moveto(view[0])
        super().configure(state=state)


def build_workspace(app):
    """The shared rail and scrollable content area for either GUI version."""
    app.grid_columnconfigure(1, weight=1)
    app.grid_rowconfigure(0, weight=1)
    rail = native.CTkFrame(app, fg_color=color("rail"), corner_radius=14, width=255)
    rail.grid(row=0, column=0, rowspan=2, sticky="ns", padx=(20, 0), pady=20)
    rail.grid_propagate(False)
    rail.grid_columnconfigure(0, weight=1)
    rail.grid_rowconfigure(6, weight=1)
    CTkLabel(rail, text="Miro Full Exporter", font=native.CTkFont(size=18, weight="bold"),
             text_color=COLORS["yellow"]).grid(row=0, column=0, padx=18, pady=(28, 14), sticky="w")
    CTkLabel(rail, text="Maximum public-API data, saved on your computer.", wraplength=215, justify="left",
             text_color="#c5bfd7").grid(row=1, column=0, padx=18, pady=(0, 24), sticky="w")
    app.journey_labels = []
    for row, text in enumerate(("01   Choose a workflow", "02   Choose a source", "03   Choose a destination", "04   Export progress"), 2):
        label = CTkLabel(rail, text=text, anchor="w", height=44, corner_radius=9,
                 fg_color="#403654" if row == 2 else "transparent", text_color="#f7f4ff"
                 )
        label.grid(row=row, column=0, sticky="we", padx=14, pady=6)
        app.journey_labels.append(label)
    controls = preference_controls(rail, dark_rail=True)
    controls.grid(row=7, column=0, padx=18, pady=16, sticky="we")
    CTkLabel(rail, text="Runs on your computer", text_color="#c5bfd7").grid(row=8, column=0, pady=(0, 20))
    content = native.CTkScrollableFrame(app, fg_color=color("surface"), corner_radius=14)
    content.grid(row=0, column=1, sticky="nsew", padx=20, pady=20)
    app.action_bar = native.CTkFrame(app, fg_color=color("surface"), corner_radius=14)
    app.action_bar.grid(row=1, column=1, sticky="we", padx=20, pady=(0, 20))
    app.action_bar.grid_columnconfigure(0, weight=1)
    return content


class Dialogs:
    def _show(self, title, message, *, parent=None, question=False, **_kwargs):
        parent = parent or tkinter._default_root
        dialog = CTkToplevel(parent)
        dialog.title(title)
        dialog.geometry("640x380")
        dialog.transient(parent)
        answer = [False]
        CTkLabel(dialog, text=title, font=native.CTkFont(size=22, weight="bold")).pack(padx=24, pady=(24, 12))
        body = CTkTextbox(dialog, wrap="word", height=160, localize=True)
        body.pack(fill="both", expand=True, padx=24, pady=8)
        body.insert("1.0", str(message))
        body.configure(state="disabled")
        def finish(value):
            answer[0] = value
            dialog.destroy()
        controls = native.CTkFrame(dialog, fg_color="transparent")
        controls.pack(pady=12)
        CTkButton(controls, text="Yes" if question else "OK", command=lambda: finish(True)).pack(side="left", padx=8)
        if question:
            CTkButton(controls, text="Cancel", command=lambda: finish(False)).pack(side="left", padx=8)
        dialog.after(100, dialog.grab_set)
        dialog.wait_window()
        return answer[0]

    def showerror(self, title, message, **kwargs):
        return self._show(title, message, **kwargs)

    showwarning = showerror
    showinfo = showerror

    def askyesno(self, title, message, **kwargs):
        return self._show(title, message, question=True, **kwargs)


messagebox = Dialogs()


class FileDialogs:
    def __getattr__(self, name):
        def choose(**kwargs):
            ui = presentation(tkinter._default_root)
            if ui:
                if "filetypes" in kwargs:
                    kwargs["filetypes"] = [(ui.text(label), pattern) for label, pattern in kwargs["filetypes"]]
                kwargs["title"] = ui.text(kwargs.get("title", "Choose a file" if name != "askdirectory" else "Choose a folder"))
            return getattr(native_filedialog, name)(**kwargs)
        return choose


filedialog = FileDialogs()
