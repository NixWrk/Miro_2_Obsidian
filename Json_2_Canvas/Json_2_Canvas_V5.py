# Jsone_2_Canvas.py
from typing import Dict, Any, Iterable, List

import customtkinter as ctk
import tkinter.filedialog as fd
from tkinter import messagebox

from Converter import convert_miro_to_canvas, find_vault_roots_upwards


# импорт интеллектуального расчёта Scale
from Scale_engine import (
    ViewProfile,
    compute_scale_preview,
    recompute_from_font,
    recompute_from_min_node_width,
    recompute_from_min_node_height,
    preview_values,
)

OBSIDIAN_FONT_SIZE = 14 

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
        self.vault_root: str | None = None

        self.delete_json_var = ctk.BooleanVar(value=False)
        self.delete_src_var  = ctk.BooleanVar(value=False)

        # выбор темы Obsidian
        self.theme_var = ctk.StringVar(value=DEFAULT_THEME_LABEL)

        # Scale / Preview state
        self.profile = ViewProfile()            # 1920x1080, min_zoom=0.12, min_node 60x40, min_font 8px
        self.scale_ctx = None                   # контекст метрик доски
        self.scale_value = 1.0                  # текущий S
        self.min_font_value = self.profile.min_font_px  # floor (минимальный кегль)

        # --- Quantization for Scale ---
        self.S_SHOW_DECIMALS  = 1   # показываем 0.1
        self.S_STORE_DECIMALS = 3   # храним 0.001

        # --- UX flags: commit-only и защита от рекурсий ---
        self._updating = False
        self._editing_scale = False
        self._editing_font  = False
        self._editing_minw  = False

        # "последние зафиксированные" значения (для стабильного сравнения)
        self._last_scale_value = self.scale_value
        self._last_minw_value  = None  # появится после первого расчёта

        # снапшоты значений на FocusIn (чтобы не коммитить без реального ввода)
        self._scale_at_focus: str | None = None
        self._font_at_focus:  str | None = None
        self._minw_at_focus:  str | None = None

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

        # Row 3: Vault root (auto)
        ctk.CTkLabel(self, text="Корень Vault:").grid(row=3, column=0, padx=pad_x, pady=pad_y, sticky="e")
        self.vault_entry = ctk.CTkEntry(self, width=560)
        self.vault_entry.grid(row=3, column=1, padx=pad_x, pady=pad_y, sticky="we")
        ctk.CTkButton(self, text="Определить", width=120, command=self.detect_vault).grid(row=3, column=2, padx=pad_x, pady=pad_y)

        # Row 4: Scale & Preview frame
        self.scale_frame = ctk.CTkFrame(self)
        self.scale_frame.grid(row=4, column=0, columnspan=3, padx=pad_x, pady=(8, 6), sticky="we")

        for c in range(6):
            self.scale_frame.grid_columnconfigure(c, weight=0)
        self.scale_frame.grid_columnconfigure(5, weight=1)  # под будущий превью-виджет

        ctk.CTkLabel(
            self.scale_frame,
            text="— Масштаб и превью —",
            font=ctk.CTkFont(size=16, weight="bold")
        ).grid(row=0, column=0, columnspan=6, padx=8, pady=(6, 6), sticky="w")

        # Row 4.1: Кнопка, Scale, Кегль (целевой)
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

        ctk.CTkLabel(self.scale_frame, text="Кегль (px):").grid(row=1, column=3, padx=(8, 6), pady=4, sticky="e")
        self.minfont_entry = ctk.CTkEntry(self.scale_frame, width=80)
        self.minfont_entry.grid(row=1, column=4, padx=(0, 8), pady=4, sticky="w")
        self.minfont_entry.insert(0, str(self.min_font_value))  # будет заменён расчётным
        self.minfont_entry.bind("<FocusIn>",  lambda e: self._set_editing('font', True))
        self.minfont_entry.bind("<FocusOut>", lambda e: self._commit_font_edit())
        self.minfont_entry.bind("<Return>",   self._enter_font)
        self.minfont_entry.bind("<KP_Enter>", self._enter_font)

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

        # Блокируем Enter на кнопке рекомендаций (чтобы фокус на ней не срабатывал от Enter)
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

    def detect_vault(self):
        if not self.target_dir:
            messagebox.showerror("Ошибка", "Сначала выберите папку для Canvas.")
            return
        candidates = find_vault_roots_upwards(self.target_dir)
        if len(candidates) == 0:
            messagebox.showerror("Vault не найден", "Не удалось автоматически найти .obsidian. Укажите корень Vault вручную.")
            picked = fd.askdirectory(title="Выберите корень Obsidian Vault")
            if not picked: return
            self.vault_root = picked
        elif len(candidates) > 1:
            messagebox.showerror("Несколько Vault", "Обнаружено несколько .obsidian на пути вверх. Выберите корневой Vault вручную.")
            picked = fd.askdirectory(title="Выберите корень Obsidian Vault")
            if not picked: return
            self.vault_root = picked
        else:
            self.vault_root = candidates[0]
        self.vault_entry.delete(0, "end"); self.vault_entry.insert(0, self.vault_root)

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

    def _update_preview_label(self, prev: dict):
        return  # строковое превью отключено

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
            if not self._editing_font:
                self._set_entry_value(self.minfont_entry, str(prev['font_px']))
        finally:
            self._updating = False

    # --- Edit mode helpers (snapshots + user-mode switch) ---

    def _set_editing(self, which: str, val: bool):
        if which == 'scale':
            self._editing_scale = val
            if val: self._scale_at_focus = (self.scale_entry.get() or "").strip()
        elif which == 'font':
            self._editing_font = val
            if val: self._font_at_focus = (self.minfont_entry.get() or "").strip()
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

    def _commit_font_edit(self):
        cur = (self.minfont_entry.get() or "").strip()
        if self._font_at_focus is not None and cur == self._font_at_focus:
            self._editing_font = False; self._font_at_focus = None
            return
        self._user_mode = True
        self._editing_font = False; self._font_at_focus = None
        self.on_min_font_changed()

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

    def _enter_font(self, e):
        self._commit_font_edit()
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
            # floor не трогаем (оставляем profile.min_font_px)
            self.min_font_value = int(self.profile.min_font_px)

            # Превью уже с квантизованным S
            prev = preview_values(self.scale_value, self.scale_ctx, OBSIDIAN_FONT_SIZE, self.min_font_value)
            self._set_entries_from_preview({
                "scale": self.scale_value,
                "Wmin":  prev["Wmin"],
                "Hmin":  prev["Hmin"],
                "font_px": prev["font_px"],
            })

            # синхронизация «последних»
            self._last_scale_value = self.scale_value
            self._last_minw_value  = prev["Wmin"]

            self._update_preview_label({
                "scale": self.scale_value,
                "Wmin":  prev["Wmin"],
                "Hmin":  prev["Hmin"],
                "font_px": prev["font_px"],
            })
            self.status.configure(text="Рекомендованный масштаб рассчитан.")
        except Exception as e:
            messagebox.showerror("Ошибка расчёта масштаба", str(e))

    # --- Font snap helper: подобрать S так, чтобы round(base_px * S) == desired_font_px ---
    def _snap_S_for_font(self, desired_font_px: int, base_px: int = OBSIDIAN_FONT_SIZE) -> float:
        b = max(1, int(base_px))
        d = max(1, int(desired_font_px))
        # интервал S, при котором round(b*S) == d  →  S ∈ [(d-0.5)/b, (d+0.5)/b)
        lo = (d - 0.5) / b
        hi = (d + 0.5) / b
        center = (lo + hi) / 2.0
        return self._qS_store(center)   # квантизуем для внутреннего хранения

    # --- Manual edits (commit-on-change) ---

    def on_scale_changed(self):
        if self._updating: return
        raw = self.scale_entry.get()
        val = self._parse_float(raw, self.scale_value)
        if val is None: return
        if self._sameS_ui(val, self._last_scale_value): return

        self.scale_value       = self._qS_store(val)
        self._last_scale_value = self.scale_value

        if not self.scale_ctx:
            prev = {
                "scale":   self.scale_value,
                "Wmin":    0,
                "Hmin":    0,
                "font_px": max(self.min_font_value, int(round(OBSIDIAN_FONT_SIZE * self.scale_value))),
            }
        else:
            prev = preview_values(self.scale_value, self.scale_ctx, OBSIDIAN_FONT_SIZE, self.min_font_value)

        self._set_entries_from_preview(prev)
        self._update_preview_label(prev)

    def on_min_font_changed(self):
        if self._updating:
            return

        raw = self.minfont_entry.get()
        desired = self._parse_int(raw, None)  # целевой кегль
        if desired is None:
            return
        desired = max(1, int(desired))

        # floor НЕ меняем
        if not self.scale_ctx:
            S = self._snap_S_for_font(desired, OBSIDIAN_FONT_SIZE)
            self.scale_value       = S
            self._last_scale_value = S
            prev = {
                "scale":   S,
                "Wmin":    0,
                "Hmin":    0,
                "font_px": max(self.min_font_value, int(round(OBSIDIAN_FONT_SIZE * S))),
            }
            self._set_entries_from_preview(prev)
            self._update_preview_label(prev)
            self.status.configure(text=f"Кегль → S≈{self._qS_show(S):.1f}")
            return

        # контекст есть → считаем барьер узла
        try:
            mnw = float(self.scale_ctx.get("mnw", 0.0) or 0.0)
            mnh = float(self.scale_ctx.get("mnh", 0.0) or 0.0)
        except Exception:
            mnw = mnh = 0.0

        s_node = max(self.profile.min_node_w / mnw, self.profile.min_node_h / mnh) if (mnw > 0 and mnh > 0) else 0.0
        s_snap = self._snap_S_for_font(desired, OBSIDIAN_FONT_SIZE)

        if self._user_mode:
            S = max(s_snap, s_node)  # без fit
        else:
            s_fit = float(self.scale_ctx.get("scale_fit", 0.0) or 0.0)
            S = max(s_snap, s_node, s_fit)

        self.scale_value       = self._qS_store(S)
        self._last_scale_value = self.scale_value

        prev = preview_values(self.scale_value, self.scale_ctx, OBSIDIAN_FONT_SIZE, self.min_font_value)
        self._set_entries_from_preview(prev)
        self._update_preview_label(prev)

        # Подсказка в статус: показуем причину клампа (если был)
        msg = f"Кегль → S≈{self._qS_show(S):.1f}"
        if S > s_snap + 1e-9:          # подняли масштаб из-за барьера
            if S <= s_node + 1e-3 or self._user_mode:
                msg += f" (ограничение: min node, Snode≈{self._qS_show(s_node):.1f})"
            else:
                msg += f" (fit≈{self._qS_show(self.scale_ctx.get('scale_fit', 0.0) or 0.0):.1f})"
        self.status.configure(text=msg)

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
            S = Wt / mnw                  # БЕЗ fit / БЕЗ кеглевого барьера
        else:
            s_fit  = float(self.scale_ctx.get("scale_fit", 0.0) or 0.0)
            s_node = Wt / mnw
            s_font = self.profile.min_font_px / max(1, OBSIDIAN_FONT_SIZE)
            S = max(s_fit, s_node, s_font)

        self.scale_value       = self._qS_store(S)
        self._last_scale_value = self.scale_value

        prev = preview_values(self.scale_value, self.scale_ctx, OBSIDIAN_FONT_SIZE, self.min_font_value)
        self._set_entries_from_preview(prev)
        self._update_preview_label(prev)

    def on_min_node_h_changed(self):
        # поле H заблокировано; функция оставлена «на будущее»
        if self._updating: return
        if not self.scale_ctx:
            messagebox.showwarning("Нет данных", "Сначала нажмите «Рассчитать масштаб (FHD)».")
            return
        Ht = self._parse_int(self.minh_entry.get(), None)
        if Ht is None: return

        mnh = float(self.scale_ctx.get("mnh", 0.0) or 0.0)
        if mnh <= 0: return

        if self._user_mode:
            S = Ht / mnh
        else:
            s_fit  = float(self.scale_ctx.get("scale_fit", 0.0) or 0.0)
            s_node = Ht / mnh
            s_font = self.profile.min_font_px / max(1, OBSIDIAN_FONT_SIZE)
            S = max(s_fit, s_node, s_font)

        self.scale_value       = self._qS_store(S)
        self._last_scale_value = self.scale_value

        prev = preview_values(self.scale_value, self.scale_ctx, OBSIDIAN_FONT_SIZE, self.min_font_value)
        self._set_entries_from_preview(prev)
        self._update_preview_label(prev)

    def on_convert(self):
        # валидация входа
        if not self.json_file:
            messagebox.showerror("Ошибка", "Не выбран JSON-файл.")
            return
        if not self.target_dir:
            messagebox.showerror("Ошибка", "Не выбрана папка назначения.")
            return
        # vault root
        vault = self.vault_entry.get().strip()
        if not vault:
            self.detect_vault()
            vault = self.vault_entry.get().strip()
            if not vault: return

        theme_value = THEME_LABEL_TO_VALUE.get(self.theme_var.get(), "dark")
        try:
            canvas_path = convert_miro_to_canvas(
                json_path=self.json_file,
                target_dir=self.target_dir,
                vault_root=vault,
                delete_json=self.delete_json_var.get(),
                delete_src_files=self.delete_src_var.get(),
                scale=self.scale_value,
                min_font_px=self.min_font_value,
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
