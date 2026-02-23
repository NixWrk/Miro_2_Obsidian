# Jsone_2_Canvas.py
from typing import Dict, Any, Iterable, List

import customtkinter as ctk
import tkinter.filedialog as fd
from tkinter import messagebox

from Converter import convert_miro_to_canvas, find_vault_roots_upwards, OBSIDIAN_FONT_SIZE


# импорт интеллектуального расчёта Scale
from Scale_engine import (
    ViewProfile,
    compute_scale_preview,
    recompute_from_font_max,
    recompute_from_font_min,
    recompute_from_min_node_width,
    preview_values,
)

# тема Obsidian (UI label -> значение для конвертера)
THEME_LABEL_TO_VALUE = {"Тёмная": "dark", "Светлая": "light"}
DEFAULT_THEME_LABEL = "Тёмная"


# =========================
# GUI (customtkinter)
# =========================

class App(ctk.CTk):
    def __init__(self):
        super().__init__()
        ctk.set_appearance_mode("System")
        ctk.set_default_color_theme("blue")

        self.title("Miro → Obsidian Canvas Converter")
        self.geometry("900x500")
        self.resizable(False, False)

        # ---- state ----
        self.json_file: str | None = None
        self.target_dir: str | None = None

        self.delete_json_var = ctk.BooleanVar(value=False)
        self.delete_src_var  = ctk.BooleanVar(value=False)

        # выбор темы Obsidian
        self.theme_var = ctk.StringVar(value=DEFAULT_THEME_LABEL)

        # Scale / Preview state
        self.profile = ViewProfile()            # 1920x1080, min_zoom=0.12, min_node 60x40, min_font 8px
        self.scale_ctx = None                   # контекст метрик доски
        self.scale_value = 1.0                  # текущий S
        # диапазон кеглей (показывается пользователю, пересчитываются из ctx × S)
        self.font_max_value = self.profile.min_font_px
        self.font_min_value = self.profile.min_font_px

        # --- Quantization for Scale ---
        self.S_SHOW_DECIMALS  = 1   # показываем 0.1
        self.S_STORE_DECIMALS = 3   # храним 0.001

        # --- UX flags: commit-only и защита от рекурсий ---
        self._updating = False
        self._editing_scale     = False
        self._editing_font_max  = False
        self._editing_font_min  = False
        self._editing_minw      = False

        # "последние зафиксированные" значения (для стабильного сравнения)
        self._last_scale_value = self.scale_value
        self._last_minw_value  = None  # появится после первого расчёта

        # снапшоты значений на FocusIn (чтобы не коммитить без реального ввода)
        self._scale_at_focus:     str | None = None
        self._font_max_at_focus:  str | None = None
        self._font_min_at_focus:  str | None = None
        self._minw_at_focus:      str | None = None

        # Режим вычислений: False = оптимум по кнопке; True = ручной режим без fit
        self._user_mode = False

        # ---- Layout ----
        pad_y = 10
        pad_x = 12

        title = ctk.CTkLabel(self, text="Miro → Obsidian Canvas", font=ctk.CTkFont(size=20, weight="bold"))
        title.grid(row=0, column=0, columnspan=3, padx=pad_x, pady=(16, 12), sticky="w")

        # Row 1: JSON file
        ctk.CTkLabel(self, text="JSON от Miro:").grid(row=1, column=0, padx=pad_x, pady=pad_y, sticky="e")
        self.json_entry = ctk.CTkEntry(self, width=560)
        self.json_entry.grid(row=1, column=1, padx=pad_x, pady=pad_y, sticky="we")
        ctk.CTkButton(self, text="Обзор…", width=120, command=self.pick_json).grid(row=1, column=2, padx=pad_x, pady=pad_y)

        # Row 2: Target dir
        ctk.CTkLabel(self, text="Папка для Canvas (внутри Vault):").grid(row=2, column=0, padx=pad_x, pady=pad_y, sticky="e")
        self.target_entry = ctk.CTkEntry(self, width=560)
        self.target_entry.grid(row=2, column=1, padx=pad_x, pady=pad_y, sticky="we")
        ctk.CTkButton(self, text="Обзор…", width=120, command=self.pick_target_dir).grid(row=2, column=2, padx=pad_x, pady=pad_y)

        # Row 4: Scale & Preview frame
        self.scale_frame = ctk.CTkFrame(self)
        self.scale_frame.grid(row=4, column=0, columnspan=3, padx=pad_x, pady=(8, 6), sticky="we")

        for c in range(8):
            self.scale_frame.grid_columnconfigure(c, weight=0)
        self.scale_frame.grid_columnconfigure(7, weight=1)

        ctk.CTkLabel(
            self.scale_frame,
            text="— Масштаб и превью —",
            font=ctk.CTkFont(size=16, weight="bold")
        ).grid(row=0, column=0, columnspan=8, padx=8, pady=(6, 6), sticky="w")

        # Row 4.1: Кнопка, Scale, Кегль max, Кегль min
        self.btn_recommend = ctk.CTkButton(
            self.scale_frame, text="Рассчитать масштаб (FHD)",
            width=180, command=self.on_recommend_scale
        )
        self.btn_recommend.grid(row=1, column=0, padx=(8, 12), pady=4, sticky="w")

        ctk.CTkLabel(self.scale_frame, text="Scale:").grid(row=1, column=1, padx=(8, 6), pady=4, sticky="e")
        self.scale_entry = ctk.CTkEntry(self.scale_frame, width=120)
        self.scale_entry.grid(row=1, column=2, padx=(0, 16), pady=4, sticky="w")
        self.scale_entry.insert(0, f"{self._qS_show(self.scale_value):.{self.S_SHOW_DECIMALS}f}")
        self.scale_entry.bind("<FocusIn>",  lambda e: self._set_editing('scale', True))
        self.scale_entry.bind("<FocusOut>", lambda e: self._commit_scale_edit())
        self.scale_entry.bind("<Return>",   self._enter_scale)
        self.scale_entry.bind("<KP_Enter>", self._enter_scale)

        ctk.CTkLabel(self.scale_frame, text="Кегль max:").grid(row=1, column=3, padx=(8, 6), pady=4, sticky="e")
        self.font_max_entry = ctk.CTkEntry(self.scale_frame, width=70)
        self.font_max_entry.grid(row=1, column=4, padx=(0, 8), pady=4, sticky="w")
        self.font_max_entry.insert(0, str(self.font_max_value))
        self.font_max_entry.bind("<FocusIn>",  lambda e: self._set_editing('font_max', True))
        self.font_max_entry.bind("<FocusOut>", lambda e: self._commit_font_max_edit())
        self.font_max_entry.bind("<Return>",   self._enter_font_max)
        self.font_max_entry.bind("<KP_Enter>", self._enter_font_max)

        ctk.CTkLabel(self.scale_frame, text="min:").grid(row=1, column=5, padx=(4, 6), pady=4, sticky="e")
        self.font_min_entry = ctk.CTkEntry(self.scale_frame, width=70)
        self.font_min_entry.grid(row=1, column=6, padx=(0, 8), pady=4, sticky="w")
        self.font_min_entry.insert(0, str(self.font_min_value))
        self.font_min_entry.bind("<FocusIn>",  lambda e: self._set_editing('font_min', True))
        self.font_min_entry.bind("<FocusOut>", lambda e: self._commit_font_min_edit())
        self.font_min_entry.bind("<Return>",   self._enter_font_min)
        self.font_min_entry.bind("<KP_Enter>", self._enter_font_min)

        # Row 4.2: Минимальный объект W×H
        ctk.CTkLabel(self.scale_frame, text="Мин. объект (W×H px):")\
            .grid(row=2, column=1, padx=(8, 6), pady=(0, 6), sticky="e")

        self.minw_entry = ctk.CTkEntry(self.scale_frame, width=84)
        self.minw_entry.grid(row=2, column=2, padx=(0, 4), pady=(0, 6), sticky="w")
        self.minw_entry.bind("<FocusIn>",  lambda e: self._set_editing('minw', True))
        self.minw_entry.bind("<FocusOut>", lambda e: self._commit_minw_edit())
        self.minw_entry.bind("<Return>",   self._enter_minw)
        self.minw_entry.bind("<KP_Enter>", self._enter_minw)

        ctk.CTkLabel(self.scale_frame, text="×")\
            .grid(row=2, column=3, padx=(2, 2), pady=(0, 6))

        self.minh_entry = ctk.CTkEntry(self.scale_frame, width=84)
        self.minh_entry.grid(row=2, column=4, padx=(4, 8), pady=(0, 6), sticky="w")
        self.minh_entry.configure(state="disabled")  # H нередактируемое

        # Блокируем Enter на кнопке рекомендаций
        self.btn_recommend.bind("<Return>",   lambda e: "break")
        self.btn_recommend.bind("<KP_Enter>", lambda e: "break")

        # Row 5: Theme selection
        ctk.CTkLabel(self, text="Тема Obsidian:").grid(row=5, column=0, padx=pad_x, pady=pad_y, sticky="e")
        self.theme_menu = ctk.CTkOptionMenu(
            self,
            variable=self.theme_var,
            values=list(THEME_LABEL_TO_VALUE.keys()),
            width=160
        )
        self.theme_menu.grid(row=5, column=1, padx=pad_x, pady=pad_y, sticky="w")

        # Row 6-7: Checkboxes
        self.cb_del_json = ctk.CTkCheckBox(self, text="Удалить исходный JSON после конвертации", variable=self.delete_json_var)
        self.cb_del_json.grid(row=6, column=1, padx=pad_x, pady=(6, 0), sticky="w")

        self.cb_del_src = ctk.CTkCheckBox(self, text="Удалить исходную папку _files (источник)", variable=self.delete_src_var)
        self.cb_del_src.grid(row=7, column=1, padx=pad_x, pady=(6, 6), sticky="w")

        # Row 8: Convert button
        self.convert_btn = ctk.CTkButton(self, text="Конвертировать → .canvas", height=40, command=self.on_convert)
        self.convert_btn.grid(row=8, column=2, padx=pad_x, pady=(16, 8), sticky="e")

        # Row 9: Status
        self.status = ctk.CTkLabel(self, text="Готов к работе.")
        self.status.grid(row=9, column=0, columnspan=3, padx=pad_x, pady=(8, 12), sticky="w")

        # grid weights
        self.grid_columnconfigure(1, weight=1)

    # --- Quantization helpers ---

    def _qS_show(self, x: float) -> float:
        try:    return round(float(x), self.S_SHOW_DECIMALS)
        except: return round(float(self.scale_value), self.S_SHOW_DECIMALS)

    def _qS_store(self, x: float) -> float:
        try:    return round(float(x), self.S_STORE_DECIMALS)
        except: return round(float(self.scale_value), self.S_STORE_DECIMALS)

    def _sameS_ui(self, a: float, b: float) -> bool:
        return self._qS_show(a) == self._qS_show(b)

    # --- UI actions ---

    def pick_json(self):
        path = fd.askopenfilename(filetypes=[("JSON files", "*.json")])
        if not path: return
        self.json_file = path
        self.json_entry.delete(0, "end"); self.json_entry.insert(0, path)

    def pick_target_dir(self):
        path = fd.askdirectory()
        if not path: return
        self.target_dir = path
        self.target_entry.delete(0, "end"); self.target_entry.insert(0, path)

    # --- Parsing helpers ---

    def _parse_float(self, s: str, default: float) -> float | None:
        s = str(s).strip().replace(",", ".")
        if s == "": return None
        try: return float(s)
        except: return default

    def _parse_int(self, s: str, default: int | None) -> int | None:
        s = str(s).strip().replace(",", ".")
        if s == "": return None
        try: return int(float(s))
        except: return default

    def _set_entry_value(self, entry, value: str, allow_if_focused=False):
        if not allow_if_focused and entry == self.focus_get():
            return
        entry.delete(0, "end"); entry.insert(0, value)

    def _set_entry_disabled(self, entry, value: str):
        try:
            entry.configure(state="normal")
            entry.delete(0, "end"); entry.insert(0, value)
            entry.configure(state="disabled")
        except: pass

    def _set_entries_from_preview(self, prev: dict):
        """Заливаем превью, не перезатирая редактируемые поля."""
        self._updating = True
        try:
            if not self._editing_scale:
                self._set_entry_value(self.scale_entry, f"{self._qS_show(prev['scale']):.{self.S_SHOW_DECIMALS}f}")
            if not self._editing_minw:
                self._set_entry_value(self.minw_entry, str(prev['Wmin']))
            self._set_entry_disabled(self.minh_entry, str(prev['Hmin']))
            if not self._editing_font_max:
                self._set_entry_value(self.font_max_entry, str(prev['font_max_px']))
            if not self._editing_font_min:
                self._set_entry_value(self.font_min_entry, str(prev['font_min_px']))
        finally:
            self._updating = False

    # --- Edit mode helpers (snapshots + user-mode switch) ---

    def _set_editing(self, which: str, val: bool):
        if which == 'scale':
            self._editing_scale = val
            if val: self._scale_at_focus = (self.scale_entry.get() or "").strip()
        elif which == 'font_max':
            self._editing_font_max = val
            if val: self._font_max_at_focus = (self.font_max_entry.get() or "").strip()
        elif which == 'font_min':
            self._editing_font_min = val
            if val: self._font_min_at_focus = (self.font_min_entry.get() or "").strip()
        elif which == 'minw':
            self._editing_minw = val
            if val: self._minw_at_focus = (self.minw_entry.get() or "").strip()

    def _commit_scale_edit(self):
        cur = (self.scale_entry.get() or "").strip()
        if self._scale_at_focus is not None and cur == self._scale_at_focus:
            self._editing_scale = False; self._scale_at_focus = None
            return
        self._user_mode = True
        self._editing_scale = False; self._scale_at_focus = None
        self.on_scale_changed()

    def _commit_font_max_edit(self):
        cur = (self.font_max_entry.get() or "").strip()
        if self._font_max_at_focus is not None and cur == self._font_max_at_focus:
            self._editing_font_max = False; self._font_max_at_focus = None
            return
        self._user_mode = True
        self._editing_font_max = False; self._font_max_at_focus = None
        self.on_font_max_changed()

    def _commit_font_min_edit(self):
        cur = (self.font_min_entry.get() or "").strip()
        if self._font_min_at_focus is not None and cur == self._font_min_at_focus:
            self._editing_font_min = False; self._font_min_at_focus = None
            return
        self._user_mode = True
        self._editing_font_min = False; self._font_min_at_focus = None
        self.on_font_min_changed()

    def _commit_minw_edit(self):
        cur = (self.minw_entry.get() or "").strip()
        if self._minw_at_focus is not None and cur == self._minw_at_focus:
            self._editing_minw = False; self._minw_at_focus = None
            return
        self._user_mode = True
        self._editing_minw = False; self._minw_at_focus = None
        self.on_min_node_w_changed()

    # --- handlers that swallow Enter (prevent button invoke) ---
    def _enter_scale(self, e):
        self._commit_scale_edit()
        return "break"

    def _enter_font_max(self, e):
        self._commit_font_max_edit()
        return "break"

    def _enter_font_min(self, e):
        self._commit_font_min_edit()
        return "break"

    def _enter_minw(self, e):
        self._commit_minw_edit()
        return "break"

    # --- Recommend (optimal) scale from file ---

    def on_recommend_scale(self):
        if not self.json_entry.get().strip():
            messagebox.showerror("Ошибка", "Сначала выберите JSON от Miro.")
            return
        try:
            info = compute_scale_preview(
                json_path=self.json_entry.get().strip(),
                profile=self.profile,
                base_font_px=OBSIDIAN_FONT_SIZE
            )
            self.scale_ctx = info["context"]

            # Оптимум по кнопке: включаем fit, выходим из user-режима
            self._user_mode = False

            # Квантизуем и применяем S
            self.scale_value = self._qS_store(float(info["scale"]))

            # Превью с квантизованным S
            prev = preview_values(self.scale_value, self.scale_ctx, OBSIDIAN_FONT_SIZE, self.profile.min_font_px)
            self.font_max_value = prev["font_max_px"]
            self.font_min_value = prev["font_min_px"]

            self._set_entries_from_preview({
                "scale":       self.scale_value,
                "Wmin":        prev["Wmin"],
                "Hmin":        prev["Hmin"],
                "font_max_px": prev["font_max_px"],
                "font_min_px": prev["font_min_px"],
            })

            # синхронизация «последних»
            self._last_scale_value = self.scale_value
            self._last_minw_value  = prev["Wmin"]

            self.status.configure(text="Рекомендованный масштаб рассчитан.")
        except Exception as e:
            messagebox.showerror("Ошибка расчёта масштаба", str(e))

    # --- Manual edits (commit-on-change) ---

    def _apply_scale(self, S: float, status_msg: str = ""):
        """Применяет новый S: сохраняет, пересчитывает превью, обновляет UI."""
        self.scale_value       = self._qS_store(S)
        self._last_scale_value = self.scale_value
        if self.scale_ctx:
            prev = preview_values(self.scale_value, self.scale_ctx, OBSIDIAN_FONT_SIZE, self.profile.min_font_px)
        else:
            font_max_miro = float(self.scale_ctx.get("font_max_miro", OBSIDIAN_FONT_SIZE)) if self.scale_ctx else OBSIDIAN_FONT_SIZE
            font_min_miro = float(self.scale_ctx.get("font_min_miro", OBSIDIAN_FONT_SIZE)) if self.scale_ctx else OBSIDIAN_FONT_SIZE
            prev = {
                "scale":       self.scale_value,
                "Wmin":        0,
                "Hmin":        0,
                "font_max_px": max(self.profile.min_font_px, int(round(font_max_miro * S))),
                "font_min_px": max(self.profile.min_font_px, int(round(font_min_miro * S))),
            }
        self._set_entries_from_preview(prev)
        if status_msg:
            self.status.configure(text=status_msg)

    def on_scale_changed(self):
        if self._updating: return
        raw = self.scale_entry.get()
        val = self._parse_float(raw, self.scale_value)
        if val is None: return
        if self._sameS_ui(val, self._last_scale_value): return
        self._apply_scale(val)

    def on_font_max_changed(self):
        if self._updating: return
        desired = self._parse_int(self.font_max_entry.get(), None)
        if desired is None: return
        desired = max(1, desired)

        if not self.scale_ctx:
            # нет контекста — простой snap
            font_max_miro = float(OBSIDIAN_FONT_SIZE)
            S = self._qS_store(desired / font_max_miro)
            self._apply_scale(S, f"Кегль max → S≈{self._qS_show(S):.1f}")
            return

        S_raw = recompute_from_font_max(desired, self.scale_ctx, self.profile)
        if self._user_mode:
            # без fit-барьера
            from Scale_engine import compute_scale_min_node, OBSIDIAN_FONT_SIZE as _BFP
            font_max_miro = max(1.0, self.scale_ctx.get("font_max_miro", float(_BFP)))
            s_font = desired / font_max_miro
            s_node = compute_scale_min_node(self.scale_ctx["mnw"], self.scale_ctx["mnh"], self.profile)
            S_raw = max(s_font, s_node)

        S = self._qS_store(S_raw)
        msg = f"Кегль max → S≈{self._qS_show(S):.1f}"
        self._apply_scale(S, msg)

    def on_font_min_changed(self):
        if self._updating: return
        desired = self._parse_int(self.font_min_entry.get(), None)
        if desired is None: return
        desired = max(1, desired)

        if not self.scale_ctx:
            font_min_miro = float(OBSIDIAN_FONT_SIZE)
            S = self._qS_store(desired / font_min_miro)
            self._apply_scale(S, f"Кегль min → S≈{self._qS_show(S):.1f}")
            return

        S_raw = recompute_from_font_min(desired, self.scale_ctx, self.profile)
        if self._user_mode:
            from Scale_engine import compute_scale_min_node, OBSIDIAN_FONT_SIZE as _BFP
            font_min_miro = max(1.0, self.scale_ctx.get("font_min_miro", float(_BFP)))
            s_font = desired / font_min_miro
            s_node = compute_scale_min_node(self.scale_ctx["mnw"], self.scale_ctx["mnh"], self.profile)
            S_raw = max(s_font, s_node)

        S = self._qS_store(S_raw)
        msg = f"Кегль min → S≈{self._qS_show(S):.1f}"
        self._apply_scale(S, msg)

    def on_min_node_w_changed(self):
        if self._updating: return
        if not self.scale_ctx:
            messagebox.showwarning("Нет данных", "Сначала нажмите «Рассчитать масштаб (FHD)».")
            return

        raw = self.minw_entry.get()
        Wt = self._parse_int(raw, None)
        if Wt is None: return

        if (self._last_minw_value is not None) and (int(Wt) == int(self._last_minw_value)):
            return
        self._last_minw_value = int(Wt)

        mnw = float(self.scale_ctx.get("mnw", 0.0) or 0.0)
        if mnw <= 0: return

        if self._user_mode:
            S = Wt / mnw
        else:
            S = recompute_from_min_node_width(float(Wt), self.scale_ctx, self.profile)

        self._apply_scale(S)

    def on_convert(self):
        # валидация входа
        if not self.json_file:
            messagebox.showerror("Ошибка", "Не выбран JSON-файл.")
            return
        if not self.target_dir:
            messagebox.showerror("Ошибка", "Не выбрана папка назначения.")
            return
        # vault root — определяем автоматически по target_dir
        candidates = find_vault_roots_upwards(self.target_dir)
        if len(candidates) == 1:
            vault = candidates[0]
        elif len(candidates) > 1:
            messagebox.showwarning("Несколько Vault", "Обнаружено несколько .obsidian на пути вверх. Выберите корневой Vault вручную.")
            vault = fd.askdirectory(title="Выберите корень Obsidian Vault")
            if not vault: return
        else:
            messagebox.showwarning("Vault не найден", "Не удалось найти .obsidian автоматически. Выберите корень Vault вручную.")
            vault = fd.askdirectory(title="Выберите корень Obsidian Vault")
            if not vault: return

        theme_value = THEME_LABEL_TO_VALUE.get(self.theme_var.get(), THEME_LABEL_TO_VALUE[DEFAULT_THEME_LABEL])
        try:
            canvas_path = convert_miro_to_canvas(
                json_path=self.json_file,
                target_dir=self.target_dir,
                vault_root=vault,
                delete_json=self.delete_json_var.get(),
                delete_src_files=self.delete_src_var.get(),
                scale=self.scale_value,
                min_font_px=self.profile.min_font_px,
                theme=theme_value,
            )
            self.status.configure(text=f"Готово: {canvas_path}")
            messagebox.showinfo("Успех", f"Canvas создан:\n{canvas_path}")
        except Exception as e:
            messagebox.showerror("Ошибка конвертации", str(e))
            self.status.configure(text=f"Ошибка: {e}")




# =========================
# Entry point
# =========================

if __name__ == "__main__":
    app = App()
    app.mainloop()
