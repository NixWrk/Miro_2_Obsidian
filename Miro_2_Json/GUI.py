#GUI

import customtkinter as ctk
import re
from tkinter import filedialog, messagebox
import threading
from pathlib import Path
import os
from functools import partial
import tkinter as tk 
from auth import authorize_and_get_token
from miro_downloader import (
    get_boards,
    get_items_on_board,
    write_json,
    download_all,
    apply_strategy,
    add_browser_links,
    compute_target_filename,
    _dedupe_miro_items
    
)

from utils import safe_filename, allocate_unique_batch_names, make_unique_in_batch




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
        # красим прогресс в красный и показываем ошибку
        try:
            self.pb.configure(progress_color="red")
        except Exception:
            pass
        self.pb.set(0.0)  # не показываем, будто всё скачалось
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

        # кнопки
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

class PublicBoardDialog(ctk.CTkToplevel):
    """Окно для ввода публичной ссылки или ID доски."""
    def __init__(self, master):
        super().__init__(master)
        self.title("Публичная доска")
        self.geometry("520x160")
        self.resizable(False, False)
        self.result = None  # сюда положим board_id или None

        ctk.CTkLabel(self, text="Вставьте ссылку на доску (или ID):").pack(
            padx=16, pady=(16, 8), anchor="w"
        )

        self.entry = ctk.CTkEntry(self, placeholder_text="https://miro.com/app/board/uXjVExample123=/ ...")
        self.entry.pack(padx=16, fill="x")

        btn_row = ctk.CTkFrame(self)
        btn_row.pack(fill="x", padx=16, pady=(12, 16))
        ctk.CTkButton(btn_row, text="Отмена", command=self._cancel, height=36).pack(side="right", padx=6)
        ctk.CTkButton(btn_row, text="ОК", command=self._ok, height=36).pack(side="right", padx=6)

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
        # если это "похожий на ID" токен
        if all(ch.isalnum() or ch in "-_=." for ch in s) and "/" not in s:
            return s
        # пробуем вытащить из URL
        import re
        from urllib.parse import unquote
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



class StrategyDialog(ctk.CTkToplevel):
    """Модальное окно выбора стратегии при конфликтах имён."""
    def __init__(self, master, conflicts: list[Path]):
        super().__init__(master)
        self.title("Конфликт имён файлов")
        self.geometry("600x500")
        self.resizable(False, False)
        self.result = None

        ctk.CTkLabel(
            self, text="Найдены существующие файлы. Что сделать?"
        ).pack(padx=16, pady=(16, 8), anchor="w")

        # список конфликтующих файлов
        box_frame = ctk.CTkFrame(self)
        box_frame.pack(fill="both", expand=True, padx=16, pady=(0, 12))

        # сам textbox с отключённым переносом строк
        self.conflicts_tb = ctk.CTkTextbox(box_frame, height=260, wrap="none")
        self.conflicts_tb.pack(side="top", fill="both", expand=True)

        # заполняем
        max_show = 100
        for p in conflicts[:max_show]:
            self.conflicts_tb.insert("end", f"• {p}\n")
        if len(conflicts) > max_show:
            self.conflicts_tb.insert("end", f"… и ещё {len(conflicts) - max_show} файлов\n")

        # делаем только для чтения
        self.conflicts_tb.configure(state="disabled")

        # выбор стратегии
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

        # кнопки управления
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


class MiroDownloaderApp(ctk.CTk):

    def log(self, text: str):
        """Добавляет строку в лог-панель из любого потока."""
        def _append():
            ctk.CTkLabel(
                self.log_frame,
                text=text,
                anchor="w",
                justify="left",
                wraplength=940
            ).pack(fill="x", padx=6, pady=2)
        self.after(0, _append)

    def choose_method(self):
        dlg = MethodDialog(self, current_is_experimental=self.prefer_experimental)
        self.wait_window(dlg)
        if dlg.result is None:
            return  # пользователь отменил
        self.prefer_experimental = bool(dlg.result)
        self.method_name.set("V2 Experimental" if self.prefer_experimental else "V2 Stable")
        self.log(f"Методика установлена: {self.method_name.get()}")


    def update_overall_progress(self, done: int, total: int):
        """Обновляет общий прогрессбар."""
        if total > 0:
            self.overall_pb.set(done / total)
            self.progress_label.configure(text=f"{done} / {total}")


    def on_file_progress(self, filename: str) -> FileProgress:
        fp = FileProgress(self.log_frame, filename)
        fp.pack(fill="x", pady=2)
        return fp

    def __init__(self):
        super().__init__()

        self.title("Miro Downloader")
        self.geometry("1000x700")
        self.minsize(1000, 700)

        #Выбор версии
        self.prefer_experimental = True
        self.api_method_var = ctk.StringVar(value="V2 Experimental")

        #для скачивания публичной доски
        self.public_board_id: str | None = None
        self._last_board_choice = "Доски"  # чтобы уметь откатываться при отмене


        # данные
        self.token = None
        self.boards_by_name = {}   # name -> full board dict
        self.file_rows = {}
        self.total_files = 0
        self.done_files = 0

        # UI
        self._build_ui()

        # корректное завершение
        self.protocol("WM_DELETE_WINDOW", self.on_close)




    def _build_ui(self):
        # верхний ряд (авторизация, выбор доски, папки)
        frame = ctk.CTkFrame(self)
        frame.pack(pady=10, padx=10, fill="x")

        self.auth_btn = ctk.CTkButton(frame, text="Авторизоваться", command=self.authorize)
        self.auth_btn.pack(side="left", padx=5)

        self.board_menu = ctk.CTkOptionMenu(frame, values=["Доски"], command=self._on_board_choice_changed)
        self.board_menu.set("Доски")
        self.board_menu.pack(side="left", padx=5, fill="x", expand=True)

        self.dir_entry = ctk.CTkEntry(frame, placeholder_text="Папка для сохранения", width=500)
        self.dir_entry.pack(side="left", padx=5, fill="x", expand=True)

        self.dir_btn = ctk.CTkButton(frame, text="Выбрать", command=self.choose_dir)
        self.dir_btn.pack(side="left", padx=5)

        
        # второй ряд (чекбокс, методика, кнопка скачать)
        frame2 = ctk.CTkFrame(self)
        frame2.pack(pady=5, padx=10, fill="x")

        self.rename_files = ctk.BooleanVar(value=True)
        self.rename_cb = ctk.CTkCheckBox(frame2, text="Переименовывать файлы", variable=self.rename_files)
        self.rename_cb.pack(side="left", padx=5)

        # NEW: выпадающий список методики
        ctk.CTkLabel(frame2, text="Методика API:").pack(side="left", padx=(12, 6))
        self.api_method = ctk.CTkOptionMenu(
            frame2,
            variable=self.api_method_var,
            values=["V2 Stable", "V2 Experimental"],
            command=self._on_method_change,  # вызов при смене значения
            width=180
        )
        self.api_method.pack(side="left", padx=5)

        self.start_btn = ctk.CTkButton(frame2, text="Скачать", command=self.start_download)
        self.start_btn.pack(side="left", padx=5)

        # общий прогресс + счётчик
        progress_frame = ctk.CTkFrame(self)
        progress_frame.pack(pady=5, fill="x", padx=10)

        self.overall_pb = ctk.CTkProgressBar(progress_frame, width=850)
        self.overall_pb.pack(side="left", padx=5, fill="x", expand=True)
        self.overall_pb.set(0.0)

        self.progress_label = ctk.CTkLabel(progress_frame, text="0 / 0")
        self.progress_label.pack(side="right", padx=5)

        # лог/прогрессы файлов
        self.log_frame = ctk.CTkScrollableFrame(self, width=970, height=500)
        self.log_frame.pack(pady=10, padx=10, fill="both", expand=True)

        # текстовый лог (для сообщений вроде "подключился...")
        self.log_text = ctk.CTkTextbox(self, width=970, height=120)
        self.log_text.pack(pady=(0, 10), padx=10, fill="x")
        self.log_text.configure(state="disabled")

    def _on_method_change(self, selected: str):
        """Обновляет флаг prefer_experimental при выборе в выпадающем списке."""
        self.prefer_experimental = (selected == "V2 Experimental")
        self.log(f"Методика установлена: {selected}")

    def _on_board_choice_changed(self, selected: str):
        """Если выбрана 'Публичная доска' — спрашиваем ссылку/ID; иначе запоминаем выбор."""
        if selected == "Публичная доска":
            dlg = PublicBoardDialog(self)
            self.wait_window(dlg)
            if dlg.result:
                self.public_board_id = dlg.result
                self.log(f"Выбрана публичная доска: ID={self.public_board_id}")
                self._last_board_choice = selected
            else:
                # отмена -> вернуться к прошлому выбору
                self.board_menu.set(self._last_board_choice)
        else:
            self._last_board_choice = selected


    def authorize(self):
        try:
            self.token = authorize_and_get_token()
            if self.token:
                boards = get_boards(self.token)
                self.boards_by_name = {b["name"]: b for b in boards}
                if self.boards_by_name:
                    names = list(self.boards_by_name.keys())
                    # ДОБАВЛЯЕМ пункт для работы по ссылке
                    names.insert(0, "Публичная доска")
                    self.board_menu.configure(values=names)
                    # по умолчанию оставить первый реальный борд (не «Доски» и не «Публичная доска»)
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

    def _clear_log(self):
        for w in self.log_frame.winfo_children():
            w.destroy()
        self.file_rows.clear()

    def _reset_overall_progress(self, total: int):
        self.total_files = total
        self.done_files = 0
        self.overall_pb.set(0.0)
        self.progress_label.configure(text=f"0 / {self.total_files}")

    def _tick_overall_progress(self):
        self.done_files += 1
        if self.total_files > 0:
            self.overall_pb.set(self.done_files / self.total_files)
            self.progress_label.configure(text=f"{self.done_files} / {self.total_files}")

    def ask_strategy(self, conflicts: list[Path]) -> str | None:
        """Показать GUI-диалог и вернуть стратегию: 'overwrite' | 'rename' | 'skip' | None(отмена)."""
        # Удалим дубликаты путей, сохраняя порядок
        uniq = list(dict.fromkeys([Path(p) for p in conflicts]))
        dlg = StrategyDialog(self, uniq)
        self.wait_window(dlg)
        return dlg.result

    def ask_continue_forbidden(self, src: str, status: int, msg: str) -> bool:
        """
        Показывает диалог «доступ запрещён к <src>» и спрашивает: продолжить без этих данных?
        Возвращает True — продолжать, False — остановить загрузку.
        """
        from threading import Event
        done = Event()
        result = {"val": False}

        def _ask():
            text = (
                f"{src}: доступ запрещён ({status}).\n"
                f"{msg}\n\n"
                f"Продолжить скачивание без этих данных?"
            )
            ans = messagebox.askyesno("Доступ ограничен", text)
            result["val"] = bool(ans)
            done.set()

        self.after(0, _ask)  # показать диалог из главного потока
        done.wait()
        return result["val"]


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

        # --- определяем board_id, safe_team, safe_board
        if choice == "Публичная доска":
            if not self.public_board_id:
                messagebox.showerror("Ошибка", "Сначала вставьте ссылку на публичную доску.")
                return
            board_id = self.public_board_id
            team_name = "Публичная"  # метка для имени файлов/папок
            safe_team = safe_filename(team_name)
            # имени доски у нас пока нет — используем сам ID; (можно позже улучшить, запросив метаданные)
            safe_board = safe_filename(board_id)
        else:
            board = self.boards_by_name[choice]
            board_id = board["id"]
            team_name = (board.get("team") or {}).get("name", "Без команды")
            safe_team = safe_filename(team_name)
            safe_board = safe_filename(board["name"])

        save_base = Path(self.dir_entry.get())
        json_path = save_base / f"{safe_team}_{safe_board}.json"
        attachments_dir = save_base / f"{safe_team}_{safe_board}_files"
        attachments_dir.mkdir(parents=True, exist_ok=True)

        # очистка логов и первичное сообщение
        self._clear_log()
        self.log("Подключаюсь к доске, считаю элементы...")

        def worker():
            try:
                # 1) получаем элементы (если ваш get_items_on_board поддерживает logger, передайте его)
                try:
                    items = get_items_on_board(
                        board_id, self.token,
                        logger=self.log,
                        prefer_experimental_items=self.prefer_experimental,
                        confirm_skip_source=lambda src, status, msg: self.ask_continue_forbidden(src, status, msg),
                    )
                except TypeError:
                    # на случай если в установленной версии нет нового параметра
                    try:
                        items = get_items_on_board(board_id, self.token, self.log, self.prefer_experimental)
                    except TypeError:
                        items = get_items_on_board(board_id, self.token, logger=self.log)
                

                # NEW: убираем дубликаты из разных источников (items и documents иногда отдают дубликаты)
                items = _dedupe_miro_items(items)


                # 2) разбор элементов
                self.after(0, lambda: self.log(f"Элементов получено: {len(items)}"))
                images = [x for x in items if x["type"] == "image"]
                documents = [x for x in items if x["type"] == "document"]
                doc_formats = [x for x in items if x["type"] == "doc_format"]  # NEW
                all_items = images + documents + doc_formats

                # === NEW: готовим желаемые пути, стратегию и окончательные пути ===

                # 1) желаемые (неуникализованные) пути
                wanted_paths = []
                for it in images:
                    base_name = compute_target_filename(it, safe_team, safe_board, self.rename_files.get(), is_image=True)
                    wanted_paths.append(attachments_dir / base_name)
                for it in documents:
                    base_name = compute_target_filename(it, safe_team, safe_board, self.rename_files.get(), is_image=False)
                    wanted_paths.append(attachments_dir / base_name)
                # doc_format -> целимся в PDF (compute_target_filename уже даёт .pdf)
                for it in doc_formats:
                    base_name = compute_target_filename(it, safe_team, safe_board, self.rename_files.get(), is_image=False)
                    wanted_paths.append(attachments_dir / base_name)

                # 2) проверка конфликтов (JSON + вложения на диске)
                future_files = [json_path] + wanted_paths
                conflicts = self._collect_conflicts(future_files)
                if conflicts:
                    from threading import Event
                    done = Event()
                    chosen = {"val": None}
                    def _ask():
                        chosen["val"] = self.ask_strategy(conflicts)
                        done.set()
                    self.after(0, _ask)
                    done.wait()
                    strategy = chosen["val"]
                    if strategy is None:
                        return
                else:
                    strategy = "overwrite"

                # 3) путь для JSON по стратегии
                real_json_path = apply_strategy(json_path, strategy)
                if real_json_path is None:
                    return

                # 4) СНАЧАЛА делаем уникальность внутри партии (всегда!)
                batch_unique_paths = make_unique_in_batch(wanted_paths)

                # 5) ПОТОМ применяем стратегию по отношению к уже существующим на диске
                if strategy == "skip":
                    return
                elif strategy == "overwrite":
                    # перезаписываем существующие, но имена уже уникальны между собой
                    final_paths = batch_unique_paths
                else:  # strategy == "rename"
                    # учитываем и диск, и то, что имена уже уникализованы в партии
                    final_paths = allocate_unique_batch_names(batch_unique_paths)

                # 6) строим id -> окончательный путь (важно: порядок all_items == порядок final_paths)
                id_to_final = {}
                for it, p in zip(all_items, final_paths):
                    id_to_final[it["id"]] = p


                # 6) анонс + строки прогресса с правильными именами
                self.after(0, lambda: self.log(
                    f"Начинаю скачивание {len(all_items)} файлов "
                    f"(изображения: {len(images)}, документы: {len(documents)}, встроенные (doc_format): {len(doc_formats)})..."
                ))


                def _prepare_rows():
                    self._reset_overall_progress(len(all_items))
                    self.file_rows.clear()
                    for it in all_items:
                        row = FileProgress(self.log_frame, id_to_final[it["id"]].name)
                        row.pack(fill="x", pady=2)
                        self.file_rows[it["id"]] = row
                self.after(0, _prepare_rows)

                # 7) скачиваем фазами, чтобы после IMAGES построить карту встраиваемых картинок
                overall_offset = 0
                def on_file_fail(item_id, msg):
                    row = self.file_rows.get(item_id)
                    if not row:
                        return
                    if "пустой url" in msg.lower():
                        row.set_skipped("пустой URL")
                    else:
                        row.set_error(msg)


                # --- Phase 1: IMAGES ---
                if images:
                    self.after(0, lambda: self.log(f"Группа: картинки, файлов: {len(images)}"))

                    def on_file_start(item_id, name):
                        return self.file_rows[item_id]
                    def on_file_done(item_id):
                        self.file_rows[item_id].set_done()
                    def on_overall_progress_group(done, total):
                        self.update_overall_progress(overall_offset + done, len(all_items))

                    download_all(
                        images, attachments_dir, self.token,
                        safe_team, safe_board,
                        is_image=True, strategy=strategy,
                        on_file_start=on_file_start,
                        on_file_done=on_file_done,
                        on_overall_progress=on_overall_progress_group,
                        gui_root=self,
                        id_to_final_path=id_to_final,
                        on_file_fail=on_file_fail, 
                    )
                    overall_offset += len(images)

                # --- Build image src map (после того как у IMAGES заполнился local_name) ---
                def _norm(u: str) -> str | None:
                    if not u:
                        return None
                    u = u.split("?format")[0]  # как при скачивании
                    from urllib.parse import urlsplit
                    parts = urlsplit(u)
                    return f"{parts.scheme}://{parts.netloc}{parts.path}"

                image_src_map: dict[str, Path] = {}
                for it in images:
                    ln = it.get("local_name")
                    if not ln:
                        continue
                    u = (it.get("data") or {}).get("imageUrl")
                    key = _norm(u)
                    if key:
                        image_src_map[key] = attachments_dir / ln

                # --- ПОСЛЕ загрузки IMAGES: карта слотов для doc_format ---
                slot_map: dict[str, dict[str, Path]] = {}
                for img in images:
                    ln = img.get("local_name")
                    parent = img.get("parent") or {}
                    parent_id = parent.get("id")
                    slot_id = (img.get("position") or {}).get("slotId")
                    if not (ln and parent_id and slot_id):
                        continue
                    slot_map.setdefault(str(parent_id), {})[str(slot_id)] = attachments_dir / ln

                # карта для подмены по ID (если вдруг <img src=".../images/<id>..."> встретится)
                image_id_map: dict[str, Path] = {}
                for it in images:
                    ln = it.get("local_name")
                    if not ln:
                        continue
                    u = (it.get("data") or {}).get("imageUrl") or ""
                    m = re.search(r"/images/(\d+)(?:[/?]|$)", u, flags=re.IGNORECASE)
                    if m:
                        image_id_map[m.group(1)] = attachments_dir / ln

                # --- Phase 2: DOCUMENTS ---
                if documents:
                    self.after(0, lambda: self.log(f"Группа: документы, файлов: {len(documents)}"))

                    def on_file_start(item_id, name):
                        return self.file_rows[item_id]
                    def on_file_done(item_id):
                        self.file_rows[item_id].set_done()
                    def on_overall_progress_group(done, total):
                        self.update_overall_progress(overall_offset + done, len(all_items))

                    download_all(
                        documents, attachments_dir, self.token,
                        safe_team, safe_board,
                        is_image=False, strategy=strategy,
                        on_file_start=on_file_start,
                        on_file_done=on_file_done,
                        on_overall_progress=on_overall_progress_group,
                        gui_root=self,
                        id_to_final_path=id_to_final,
                        on_file_fail=on_file_fail, 
                    )

                    overall_offset += len(documents)



                # --- Phase 3: DOC_FORMATS (передаём карты локальных картинок) ---
                if doc_formats:
                    self.after(0, lambda: self.log(f"Группа: встроенные (doc_format), файлов: {len(doc_formats)}"))

                    def on_file_start(item_id, name):
                        return self.file_rows[item_id]
                    def on_file_done(item_id):
                        self.file_rows[item_id].set_done()
                    def on_overall_progress_group(done, total):
                        self.update_overall_progress(overall_offset + done, len(all_items))

                    download_all(
                        doc_formats, attachments_dir, self.token,
                        safe_team, safe_board,
                        is_image=False, strategy=strategy,
                        on_file_start=on_file_start,
                        on_file_done=on_file_done,
                        on_overall_progress=on_overall_progress_group,
                        gui_root=self,
                        id_to_final_path=id_to_final,
                        inline_slot_map=slot_map,                 # <--- главное: маппинг slotId -> локальный путь
                        inline_image_url_map=image_src_map,       # подмена по URL (если встречаются обычные <img>)
                        inline_image_id_map=image_id_map,         # подмена по ID (если в src есть /images/<id>)
                        on_file_fail=on_file_fail, 
                    )

                    overall_offset += len(doc_formats)


                # 8) сохраняем JSON с актуальными local_name
                items_with_links = add_browser_links(board_id, items)
                write_json(real_json_path, items_with_links)

                


                self.after(0, lambda: messagebox.showinfo("Готово", "Скачивание всех файлов завершено."))
            except Exception as e:
                self.after(0, partial(messagebox.showerror, "Ошибка",
                                      f"Ошибка при загрузке: {e}"))


        threading.Thread(target=worker, daemon=True).start()





    def _collect_conflicts(self, future_files: list[Path]) -> list[Path]:
        """
        Возвращает полный список уже существующих на диске файлов,
        которые потенциально конфликтуют с будущими путями:
          - точное совпадение имени;
          - все «индексные» варианты: <stem>*.ext (например, ' (1)', ' (2)' и т.п.);
          - если расширения нет — любые файлы с тем же stem: <stem>.*.
        """
        from glob import escape as glob_escape

        conflicts: list[Path] = []
        seen: set[Path] = set()

        def _add(hit: Path):
            try:
                # Нормализуем путь (на Windows нечувствительность к регистру)
                key = hit.resolve() if hit.exists() else hit
            except Exception:
                key = hit
            if hit.exists() and key not in seen:
                conflicts.append(hit)
                seen.add(key)

        for f in future_files:
            p = Path(f)
            parent = p.parent

            # 1) точное имя
            _add(p)

            # 2) вся «семья» с тем же stem’ом
            if parent.exists():
                if p.suffix:
                    # Всё, что начинается с stem и заканчивается тем же расширением
                    # (подхватит 'name.ext', 'name (1).ext', 'name (2).ext', 'name - копия.ext' и т.п.)
                    pattern = f"{glob_escape(p.stem)}*{p.suffix}"
                    for hit in parent.glob(pattern):
                        # отфильтруем только то, что и правда «начинается с stem» и «тем же .ext»
                        name = hit.name
                        if name.startswith(p.stem) and name.lower().endswith(p.suffix.lower()):
                            _add(hit)
                else:
                    # Нет расширения — покажем все варианты с любым расширением
                    pattern = f"{glob_escape(p.stem)}.*"
                    for hit in parent.glob(pattern):
                        # гарантируем, что stem совпадает
                        if hit.stem.startswith(p.stem):
                            _add(hit)

        return conflicts



   

    def on_close(self):
        self.destroy()
        self.quit()
        os._exit(0)  # гарантированное завершение процесса и потоков


if __name__ == "__main__":
    ctk.set_appearance_mode("System")
    ctk.set_default_color_theme("blue")
    app = MiroDownloaderApp()
    app.mainloop()
