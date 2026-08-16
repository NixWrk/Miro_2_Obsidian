# GUI.py
# -*- coding: utf-8 -*-
"""
Главное окно приложения Miro Downloader.

Отвечает только за UI: построение интерфейса, отображение прогресса
и передачу пользовательских действий в download_worker.
"""

import os
import threading
from functools import partial
from pathlib import Path
from threading import Event
from tkinter import filedialog, messagebox

import customtkinter as ctk

from auth import authorize_and_get_token
from dialogs import FileProgress, PublicBoardDialog, StrategyDialog
from download_worker import run_download
from miro_downloader import get_boards
from utils import safe_filename


def resolve_gui_token() -> str:
    token = os.environ.get("MIRO_ACCESS_TOKEN")
    if token:
        return token
    return authorize_and_get_token()


def board_choice_label(board: dict) -> str:
    board_id = str(board.get("id") or "board")
    name = str(board.get("name") or board_id)
    team = str((board.get("team") or {}).get("name") or "").strip()
    prefix = f"{team} / " if team else ""
    return f"{prefix}{name} ({board_id})"


# =============================================================================
# Главное окно приложения
# =============================================================================

class MiroDownloaderApp(ctk.CTk):

    # ------------------------------------------------------------------
    # Инициализация
    # ------------------------------------------------------------------

    def __init__(self):
        super().__init__()

        self.title("Miro Downloader")
        self.geometry("1000x700")
        self.minsize(1000, 700)

        # Состояние
        self.token: str | None = None
        self.boards_by_name: dict = {}
        self.public_board_id: str | None = None
        self._last_board_choice = "Доски"
        self.prefer_experimental: bool = True
        self.file_rows: dict[str, FileProgress] = {}
        self.total_files: int = 0
        self.done_files: int = 0

        self._build_ui()
        self.protocol("WM_DELETE_WINDOW", self.on_close)

    # ------------------------------------------------------------------
    # Построение UI
    # ------------------------------------------------------------------

    def _build_ui(self):
        # Ряд 1: авторизация, выбор доски, папка
        row1 = ctk.CTkFrame(self)
        row1.pack(pady=10, padx=10, fill="x")

        self.auth_btn = ctk.CTkButton(row1, text="Авторизоваться", command=self.authorize)
        self.auth_btn.pack(side="left", padx=5)

        self.board_menu = ctk.CTkOptionMenu(
            row1, values=["Доски"], command=self._on_board_choice_changed
        )
        self.board_menu.set("Доски")
        self.board_menu.pack(side="left", padx=5, fill="x", expand=True)

        self.dir_entry = ctk.CTkEntry(row1, placeholder_text="Папка для сохранения", width=500)
        self.dir_entry.pack(side="left", padx=5, fill="x", expand=True)

        ctk.CTkButton(row1, text="Выбрать", command=self.choose_dir)\
            .pack(side="left", padx=5)

        # Ряд 2: опции и кнопка скачать
        row2 = ctk.CTkFrame(self)
        row2.pack(pady=5, padx=10, fill="x")

        self.rename_files = ctk.BooleanVar(value=True)
        ctk.CTkCheckBox(row2, text="Переименовывать файлы", variable=self.rename_files)\
            .pack(side="left", padx=5)

        ctk.CTkLabel(row2, text="Методика API:").pack(side="left", padx=(12, 6))
        self.api_method_var = ctk.StringVar(value="V2 Experimental")
        ctk.CTkOptionMenu(
            row2,
            variable=self.api_method_var,
            values=["V2 Stable", "V2 Experimental"],
            command=self._on_method_change,
            width=180,
        ).pack(side="left", padx=5)

        self.start_btn = ctk.CTkButton(row2, text="Скачать", command=self.start_download)
        self.start_btn.pack(side="left", padx=5)

        # Общий прогрессбар
        progress_row = ctk.CTkFrame(self)
        progress_row.pack(pady=5, fill="x", padx=10)

        self.overall_pb = ctk.CTkProgressBar(progress_row, width=850)
        self.overall_pb.pack(side="left", padx=5, fill="x", expand=True)
        self.overall_pb.set(0.0)

        self.progress_label = ctk.CTkLabel(progress_row, text="0 / 0")
        self.progress_label.pack(side="right", padx=5)

        # Скроллируемый фрейм для строк прогресса файлов
        self.log_frame = ctk.CTkScrollableFrame(self, width=970, height=500)
        self.log_frame.pack(pady=10, padx=10, fill="both", expand=True)

        # Текстовый лог (сообщения)
        self.log_text = ctk.CTkTextbox(self, width=970, height=120)
        self.log_text.pack(pady=(0, 10), padx=10, fill="x")
        self.log_text.configure(state="disabled")

    # ------------------------------------------------------------------
    # Лог и прогресс
    # ------------------------------------------------------------------

    def log(self, text: str):
        """Добавляет строку в лог-панель из любого потока."""
        def _append():
            ctk.CTkLabel(
                self.log_frame, text=text,
                anchor="w", justify="left", wraplength=940,
            ).pack(fill="x", padx=6, pady=2)
        self.after(0, _append)

    def update_overall_progress(self, done: int, total: int):
        def _update():
            if total > 0:
                self.overall_pb.set(done / total)
                self.progress_label.configure(text=f"{done} / {total}")
        self.after(0, _update)

    def _reset_overall_progress(self, total: int):
        self.total_files = total
        self.done_files = 0
        self.overall_pb.set(0.0)
        self.progress_label.configure(text=f"0 / {self.total_files}")

    def _clear_log(self):
        for w in self.log_frame.winfo_children():
            w.destroy()
        self.file_rows.clear()

    # ------------------------------------------------------------------
    # Обработчики UI
    # ------------------------------------------------------------------

    def _on_method_change(self, selected: str):
        self.prefer_experimental = (selected == "V2 Experimental")
        self.log(f"Методика установлена: {selected}")

    def _on_board_choice_changed(self, selected: str):
        if selected == "Публичная доска":
            dlg = PublicBoardDialog(self)
            self.wait_window(dlg)
            if dlg.result:
                self.public_board_id = dlg.result
                self.log(f"Выбрана публичная доска: ID={self.public_board_id}")
                self._last_board_choice = selected
            else:
                self.board_menu.set(self._last_board_choice)
        else:
            self._last_board_choice = selected

    def authorize(self):
        try:
            self.token = resolve_gui_token()
            if self.token:
                boards = get_boards(self.token)
                self.boards_by_name = {board_choice_label(board): board for board in boards}
                if self.boards_by_name:
                    names = ["Публичная доска"] + list(self.boards_by_name.keys())
                    self.board_menu.configure(values=names)
                    self.board_menu.set(names[1] if len(names) > 1 else names[0])
                    self._last_board_choice = self.board_menu.get()
            else:
                messagebox.showerror("Ошибка", "Не удалось получить токен")
        except Exception as e:
            messagebox.showerror("Ошибка", f"Не удалось авторизоваться: {e}")

    def choose_dir(self):
        directory = filedialog.askdirectory()
        if directory:
            self.dir_entry.delete(0, "end")
            self.dir_entry.insert(0, directory)

    # ------------------------------------------------------------------
    # Диалоги — мост между фоновым потоком и GUI
    # ------------------------------------------------------------------

    def _ask_in_main_thread(self, fn, timeout: int):
        """Run fn in Tk's thread and propagate timeout or callback failures."""
        done = Event()
        result = {"val": None}
        error: dict[str, BaseException] = {}

        def _run():
            try:
                result["val"] = fn()
            except BaseException as exc:
                error["exception"] = exc
            finally:
                done.set()

        self.after(0, _run)
        if not done.wait(timeout=timeout):
            raise TimeoutError("Timed out waiting for the Tk main thread.")
        if error:
            raise error["exception"]
        return result["val"]

    def ask_strategy(self, conflicts: list[Path]) -> str | None:
        uniq = list(dict.fromkeys(conflicts))
        return self._ask_in_main_thread(
            lambda: self._show_strategy_dialog(uniq),
            timeout=300,
        )

    def _show_strategy_dialog(self, conflicts: list[Path]) -> str | None:
        dlg = StrategyDialog(self, conflicts)
        self.wait_window(dlg)
        return dlg.result

    def ask_continue_forbidden(self, src: str, status: int, msg: str) -> bool:
        def _ask():
            text = (
                f"{src}: доступ запрещён ({status}).\n{msg}\n\n"
                f"Продолжить скачивание без этих данных?"
            )
            return bool(messagebox.askyesno("Доступ ограничен", text))
        return bool(self._ask_in_main_thread(_ask, timeout=300))

    def ask_exp_fallback(self, n_partial: int) -> bool:
        def _ask():
            text = (
                f"Experimental API прервался после получения {n_partial} элементов.\n\n"
                f"Переключиться на Stable V2 и загрузить items заново?\n"
                f"(частичные данные будут очищены)\n\n"
                f"Нажмите «Да» для переключения на Stable,\n"
                f"«Нет» — чтобы продолжить с тем что получено."
            )
            return bool(messagebox.askyesno("Ошибка Experimental API", text))
        return bool(self._ask_in_main_thread(_ask, timeout=120))

    # ------------------------------------------------------------------
    # Колбэки для строк прогресса файлов
    # ------------------------------------------------------------------

    def _prepare_rows(self, id_to_final: dict[str, Path], all_items: list[dict]):
        def _build():
            self._reset_overall_progress(len(all_items))
            self.file_rows.clear()
            for it in all_items:
                row = FileProgress(self.log_frame, id_to_final[it["id"]].name)
                row.pack(fill="x", pady=2)
                self.file_rows[it["id"]] = row
        self._ask_in_main_thread(_build, timeout=30)

    def _on_file_start(self, item_id: str, name: str) -> FileProgress:
        return self.file_rows[item_id]

    def _on_file_done(self, item_id: str):
        def _done():
            row = self.file_rows.get(item_id)
            if row:
                row.set_done()
        self.after(0, _done)

    def _on_file_fail(self, item_id: str, msg: str):
        def _fail():
            row = self.file_rows.get(item_id)
            if not row:
                return
            if "пустой url" in msg.lower():
                row.set_skipped("пустой URL")
            else:
                row.set_error(msg)
        self.after(0, _fail)

    # ------------------------------------------------------------------
    # Запуск скачивания
    # ------------------------------------------------------------------

    def start_download(self):
        if not self.token:
            messagebox.showerror("Ошибка", "Сначала авторизуйтесь.")
            return
        choice = self.board_menu.get()
        if not choice or choice == "Доски":
            messagebox.showerror("Ошибка", "Выберите доску.")
            return
        if not self.dir_entry.get():
            messagebox.showerror("Ошибка", "Выберите папку для сохранения.")
            return

        # Определяем board_id и безопасные имена
        if choice == "Публичная доска":
            if not self.public_board_id:
                messagebox.showerror("Ошибка", "Сначала вставьте ссылку на публичную доску.")
                return
            board_id = self.public_board_id
            safe_team = safe_filename("Публичная")
            safe_board = safe_filename(board_id)
        else:
            board = self.boards_by_name[choice]
            board_id = board["id"]
            team_name = (board.get("team") or {}).get("name", "Без команды")
            safe_team = safe_filename(team_name)
            safe_board = safe_filename(f"{board.get('name') or 'board'}_{board_id}")

        save_base = Path(self.dir_entry.get())
        rename_files = bool(self.rename_files.get())

        # Блокируем кнопку, чистим лог
        self.start_btn.configure(state="disabled")
        self._clear_log()

        def worker():
            try:
                result = run_download(
                    board_id=board_id,
                    token=self.token,
                    save_base=save_base,
                    safe_team=safe_team,
                    safe_board=safe_board,
                    rename_files=rename_files,
                    prefer_experimental=self.prefer_experimental,
                    log=self.log,
                    ask_strategy=self.ask_strategy,
                    ask_continue_forbidden=self.ask_continue_forbidden,
                    ask_exp_fallback=self.ask_exp_fallback,
                    on_prepare_rows=self._prepare_rows,
                    on_file_start=self._on_file_start,
                    on_file_done=self._on_file_done,
                    on_file_fail=self._on_file_fail,
                    on_overall_progress=self.update_overall_progress,
                    gui_root=self,
                )
                if result is None:
                    self.log("Скачивание отменено.")
                    return
                self.after(
                    0,
                    lambda: messagebox.showinfo("Готово", f"JSON сохранён:\n{result}"),
                )
            except Exception as e:
                self.after(0, partial(messagebox.showerror, "Ошибка", f"Ошибка при загрузке: {e}"))
            finally:
                self.after(0, lambda: self.start_btn.configure(state="normal"))

        threading.Thread(target=worker, daemon=True).start()

    # ------------------------------------------------------------------
    # Завершение
    # ------------------------------------------------------------------

    def on_close(self):
        self.destroy()


# =============================================================================
# Entry point
# =============================================================================

if __name__ == "__main__":
    ctk.set_appearance_mode("System")
    ctk.set_default_color_theme("blue")
    app = MiroDownloaderApp()
    app.mainloop()
