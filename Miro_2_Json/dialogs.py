# dialogs.py
# -*- coding: utf-8 -*-
"""
Все диалоговые окна и виджеты GUI для Miro Downloader.

Содержит:
  - FileProgress      — строка прогресса для одного файла
  - MethodDialog      — выбор версии API (Stable / Experimental)
  - PublicBoardDialog — ввод публичной ссылки или ID доски
  - StrategyDialog    — выбор стратегии при конфликтах имён файлов
"""

import re
from pathlib import Path
from tkinter import messagebox
from urllib.parse import unquote

import customtkinter as ctk


# =============================================================================
# FileProgress — виджет прогресса одного файла
# =============================================================================

class FileProgress(ctk.CTkFrame):

    def __init__(self, master, filename: str):
        super().__init__(master)
        self.label = ctk.CTkLabel(self, text=filename, anchor="w")
        self.label.pack(side="left", fill="x", expand=True, padx=5)
        self.pb = ctk.CTkProgressBar(self, width=150)
        self.pb.pack(side="right", padx=5)
        self.pb.set(0.0)

    def set_progress(self, done: int, total: int | None):
        if total and total > 0:
            self.pb.set(done / total)

    def set_done(self):
        self.pb.set(1.0)

    def set_message(self, text: str):
        self.label.configure(text=text)

    def set_error(self, msg: str):
        try:
            self.pb.configure(progress_color="red")
        except Exception:
            pass
        self.pb.set(0.0)
        orig = self.label.cget("text")
        self.label.configure(text=f"❌ {orig} — {msg}")

    def set_skipped(self, msg: str | None = None):
        try:
            self.pb.configure(progress_color="orange")
        except Exception:
            pass
        self.pb.set(0.0)
        if msg:
            orig = self.label.cget("text")
            self.label.configure(text=f"⏭ {orig} — {msg}")


# =============================================================================
# MethodDialog — выбор версии API
# =============================================================================

class MethodDialog(ctk.CTkToplevel):
    """Модальное окно выбора методики API (Stable / Experimental)."""

    def __init__(self, master, current_is_experimental: bool = True):
        super().__init__(master)
        self.title("Методика API")
        self.geometry("400x220")
        self.resizable(False, False)
        self.result = None  # True -> experimental, False -> stable

        ctk.CTkLabel(
            self, text="Выберите методику получения элементов:"
        ).pack(padx=16, pady=(16, 8), anchor="w")

        self.var = ctk.StringVar(
            value="V2 Experimental" if current_is_experimental else "V2 Stable"
        )
        ctk.CTkOptionMenu(
            self, variable=self.var, values=["V2 Stable", "V2 Experimental"]
        ).pack(padx=16, pady=(4, 16), fill="x")

        btn_row = ctk.CTkFrame(self)
        btn_row.pack(fill="x", padx=16, pady=(8, 16))
        ctk.CTkButton(btn_row, text="Отмена", command=self._cancel, height=36)\
            .pack(side="right", padx=6)
        ctk.CTkButton(btn_row, text="ОК", command=self._ok, height=36)\
            .pack(side="right", padx=6)

        self.transient(master)
        self.grab_set()
        self.focus_set()

    def _ok(self):
        self.result = (self.var.get() == "V2 Experimental")
        self.destroy()

    def _cancel(self):
        self.result = None
        self.destroy()


# =============================================================================
# PublicBoardDialog — ввод ссылки / ID публичной доски
# =============================================================================

class PublicBoardDialog(ctk.CTkToplevel):
    """Окно для ввода публичной ссылки или ID доски."""

    def __init__(self, master):
        super().__init__(master)
        self.title("Публичная доска")
        self.geometry("520x160")
        self.resizable(False, False)
        self.result = None  # board_id или None

        ctk.CTkLabel(self, text="Вставьте ссылку на доску (или ID):").pack(
            padx=16, pady=(16, 8), anchor="w"
        )

        self.entry = ctk.CTkEntry(
            self, placeholder_text="https://miro.com/app/board/uXjVExample123=/ ..."
        )
        self.entry.pack(padx=16, fill="x")

        btn_row = ctk.CTkFrame(self)
        btn_row.pack(fill="x", padx=16, pady=(12, 16))
        ctk.CTkButton(btn_row, text="Отмена", command=self._cancel, height=36)\
            .pack(side="right", padx=6)
        ctk.CTkButton(btn_row, text="ОК", command=self._ok, height=36)\
            .pack(side="right", padx=6)

        self.transient(master)
        self.grab_set()
        self.focus_set()
        self.entry.focus_set()

    @staticmethod
    def _parse_board_id(text: str) -> str | None:
        """Принимает полный URL или голый ID; возвращает board_id или None."""
        if not text:
            return None
        s = text.strip()
        if all(ch.isalnum() or ch in "-_=." for ch in s) and "/" not in s:
            return s
        m = re.search(r"/board/([A-Za-z0-9_\-=]+)", s)
        if m:
            return unquote(m.group(1))
        return None

    def _ok(self):
        bid = self._parse_board_id(self.entry.get())
        if not bid:
            messagebox.showerror("Ошибка", "Не удалось распознать ID доски. Проверьте ссылку.")
            return
        self.result = bid
        self.destroy()

    def _cancel(self):
        self.result = None
        self.destroy()


# =============================================================================
# StrategyDialog — выбор стратегии при конфликтах имён
# =============================================================================

class StrategyDialog(ctk.CTkToplevel):
    """Модальное окно выбора стратегии при конфликтах имён файлов."""

    def __init__(self, master, conflicts: list[Path]):
        super().__init__(master)
        self.title("Конфликт имён файлов")
        self.geometry("600x500")
        self.resizable(False, False)
        self.result = None

        ctk.CTkLabel(
            self, text="Найдены существующие файлы. Что сделать?"
        ).pack(padx=16, pady=(16, 8), anchor="w")

        box_frame = ctk.CTkFrame(self)
        box_frame.pack(fill="both", expand=True, padx=16, pady=(0, 12))

        self.conflicts_tb = ctk.CTkTextbox(box_frame, height=260, wrap="none")
        self.conflicts_tb.pack(side="top", fill="both", expand=True)

        max_show = 100
        for p in conflicts[:max_show]:
            self.conflicts_tb.insert("end", f"• {p}\n")
        if len(conflicts) > max_show:
            self.conflicts_tb.insert("end", f"… и ещё {len(conflicts) - max_show} файлов\n")
        self.conflicts_tb.configure(state="disabled")

        self.choice = ctk.StringVar(value="rename")
        rb_frame = ctk.CTkFrame(self)
        rb_frame.pack(fill="x", padx=16, pady=(8, 16))
        ctk.CTkRadioButton(
            rb_frame, text="Перезаписать все", variable=self.choice, value="overwrite"
        ).pack(anchor="w", pady=4)
        ctk.CTkRadioButton(
            rb_frame, text="Сохранить как новые (с индексами)", variable=self.choice, value="rename"
        ).pack(anchor="w", pady=4)
        ctk.CTkRadioButton(
            rb_frame, text="Пропустить все", variable=self.choice, value="skip"
        ).pack(anchor="w", pady=4)

        btn_row = ctk.CTkFrame(self)
        btn_row.pack(fill="x", padx=16, pady=(8, 16))
        ctk.CTkButton(
            btn_row, text="Отмена", command=self._cancel, height=36
        ).pack(side="right", padx=6)
        ctk.CTkButton(
            btn_row, text="Продолжить", command=self._ok, height=36
        ).pack(side="right", padx=6)

        self.transient(master)
        self.grab_set()
        self.focus_set()

    def _ok(self):
        self.result = self.choice.get()
        self.destroy()

    def _cancel(self):
        self.result = None
        self.destroy()
