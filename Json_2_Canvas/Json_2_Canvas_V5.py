# -*- coding: utf-8 -*-
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

        # state
        self.json_file: str | None = None
        self.target_dir: str | None = None
        self.vault_root: str | None = None

        self.delete_json_var = ctk.BooleanVar(value=False)
        self.delete_src_var = ctk.BooleanVar(value=False)

        # выбор темы Obsidian
        self.theme_var = ctk.StringVar(value=DEFAULT_THEME_LABEL)

        # --- Scale/Preview state ---
        self.profile = ViewProfile()  # 1920x1080, min_zoom=0.12, min_node 60x40, min_font 8px
        self.scale_ctx = None          # контекст с метриками доски (из движка)
        self.scale_value = 1.0         # текущий выбранный scale
        self.min_font_value = self.profile.min_font_px  # текущий порог кегля
        self._updating = False         # защита от рекурсивных обновлений GUI


        # --- Layout ---
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

        # Row 4: Scale & Preview (в отдельном фрейме)
        self.scale_frame = ctk.CTkFrame(self)
        self.scale_frame.grid(row=4, column=0, columnspan=3, padx=pad_x, pady=(8, 6), sticky="we")

        # Чёткая сетка: 0..5, тянется только последняя колонка (5) под превью
        for c in range(6):
            self.scale_frame.grid_columnconfigure(c, weight=0)
        self.scale_frame.grid_columnconfigure(5, weight=1)

        # Заголовок
        ctk.CTkLabel(
            self.scale_frame,
            text="— Масштаб и превью —",
            font=ctk.CTkFont(size=16, weight="bold")
        ).grid(row=0, column=0, columnspan=6, padx=8, pady=(6, 6), sticky="w")

        # Ряд 1: кнопка, scale, min font, превью
        self.btn_recommend = ctk.CTkButton(
            self.scale_frame, text="Рассчитать масштаб (FHD)",
            width=180, command=self.on_recommend_scale
        )
        self.btn_recommend.grid(row=1, column=0, padx=(8, 12), pady=4, sticky="w")

        ctk.CTkLabel(self.scale_frame, text="Scale:").grid(row=1, column=1, padx=(8, 6), pady=4, sticky="e")
        self.scale_entry = ctk.CTkEntry(self.scale_frame, width=120)
        self.scale_entry.grid(row=1, column=2, padx=(0, 16), pady=4, sticky="w")
        self.scale_entry.insert(0, f"{self.scale_value:.4f}")
        self.scale_entry.bind("<Return>", lambda e: self.on_scale_changed())
        self.scale_entry.bind("<FocusOut>", lambda e: self.on_scale_changed())
        self.scale_entry.bind("<KeyRelease>", lambda e: self.on_scale_changed())


        ctk.CTkLabel(self.scale_frame, text="Мин. кегль (px):").grid(row=1, column=3, padx=(8, 6), pady=4, sticky="e")
        self.minfont_entry = ctk.CTkEntry(self.scale_frame, width=80)
        self.minfont_entry.grid(row=1, column=4, padx=(0, 8), pady=4, sticky="w")
        self.minfont_entry.insert(0, str(self.min_font_value))
        self.minfont_entry.bind("<Return>", lambda e: self.on_min_font_changed())
        self.minfont_entry.bind("<FocusOut>", lambda e: self.on_min_font_changed())
        self.minfont_entry.bind("<KeyRelease>", lambda e: self.on_min_font_changed())







        # Ряд 2: минимальный объект W × H
        ctk.CTkLabel(self.scale_frame, text="Мин. объект (W×H px):")\
            .grid(row=2, column=1, padx=(8, 6), pady=(0, 6), sticky="e")

        self.minw_entry = ctk.CTkEntry(self.scale_frame, width=84)
        self.minw_entry.grid(row=2, column=2, padx=(0, 4), pady=(0, 6), sticky="w")


        # live-обновление
        self.minw_entry.bind("<KeyRelease>", lambda e: self.on_min_node_w_changed())
        self.minw_entry.bind("<Return>",     lambda e: self.on_min_node_w_changed())


        ctk.CTkLabel(self.scale_frame, text="×")\
            .grid(row=2, column=3, padx=(2, 2), pady=(0, 6))

        self.minh_entry = ctk.CTkEntry(self.scale_frame, width=84)
        self.minh_entry.grid(row=2, column=4, padx=(4, 8), pady=(0, 6), sticky="w")
        # делаем H нередактируемым
        self.minh_entry.configure(state="disabled")



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

    # --- UI actions ---

    def pick_json(self):
        path = fd.askopenfilename(filetypes=[("JSON files", "*.json")])
        if not path:
            return
        self.json_file = path
        self.json_entry.delete(0, "end")
        self.json_entry.insert(0, path)

    def pick_target_dir(self):
        path = fd.askdirectory()
        if not path:
            return
        self.target_dir = path
        self.target_entry.delete(0, "end")
        self.target_entry.insert(0, path)

    def detect_vault(self):
        if not self.target_dir:
            messagebox.showerror("Ошибка", "Сначала выберите папку для Canvas.")
            return
        candidates = find_vault_roots_upwards(self.target_dir)
        if len(candidates) == 0:
            messagebox.showerror("Vault не найден", "Не удалось автоматически найти .obsidian. Укажите корень Vault вручную.")
            picked = fd.askdirectory(title="Выберите корень Obsidian Vault")
            if not picked:
                return
            self.vault_root = picked
        elif len(candidates) > 1:
            messagebox.showerror("Несколько Vault", "Обнаружено несколько .obsidian на пути вверх. Выберите корневой Vault вручную.")
            picked = fd.askdirectory(title="Выберите корень Obsidian Vault")
            if not picked:
                return
            self.vault_root = picked
        else:
            self.vault_root = candidates[0]

        self.vault_entry.delete(0, "end")
        self.vault_entry.insert(0, self.vault_root)

    # --- Helpers for parsing ---
    def _parse_float(self, s: str, default: float) -> float | None:
        s = str(s).strip().replace(",", ".")
        if s == "":
            return None
        try:
            return float(s)
        except Exception:
            return default

    def _parse_int(self, s: str, default: int) -> int | None:
        s = str(s).strip().replace(",", ".")
        if s == "":
            return None
        try:
            return int(float(s))
        except Exception:
            return default


    def _set_entry_value(self, entry, value: str, allow_if_focused=False):
        # не трогаем поле, если пользователь его редактирует
        if not allow_if_focused and entry == self.focus_get():
            return
        entry.delete(0, "end")
        entry.insert(0, value)


    def _update_preview_label(self, prev: dict):
        # превью строкой отключено — ничего не делаем
        return



    def _set_entry_disabled(self, entry, value: str):
    # безопасно записать текст в CTkEntry с state="disabled"
        try:
            entry.configure(state="normal")
            entry.delete(0, "end")
            entry.insert(0, value)
            entry.configure(state="disabled")
        except Exception:
            pass


    def _set_entries_from_preview(self, prev: dict):
        self._updating = True
        try:
            self._set_entry_value(self.scale_entry, f"{prev['scale']:.4f}")
            
            self._set_entry_value(self.minw_entry, str(prev['Wmin']))
            self._set_entry_disabled(self.minh_entry, str(prev['Hmin']))
        finally:
            self._updating = False



    # --- Main: recommend scale from file ---
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
            self.scale_value = float(info["scale"])
            self.min_font_value = int(self.profile.min_font_px)

            prev = info["preview"]
            self._set_entries_from_preview({"scale": self.scale_value,
                                            "Wmin": prev["Wmin"],
                                            "Hmin": prev["Hmin"],
                                            "font_px": prev["font_px"]})
            self._update_preview_label({"scale": self.scale_value,
                                        "Wmin": prev["Wmin"],
                                        "Hmin": prev["Hmin"],
                                        "font_px": prev["font_px"]})
            self.status.configure(text="Рекомендованный масштаб рассчитан.")
        except Exception as e:
            messagebox.showerror("Ошибка расчёта масштаба", str(e))

    # --- React to manual edits ---
    def on_scale_changed(self):
        if self._updating:
            return
        raw = self.scale_entry.get()
        val = self._parse_float(raw, self.scale_value)
        if val is None:
            # пользователь стирает — ничего не пересчитываем и не заливаем обратно
            return
        self.scale_value = val
        if not self.scale_ctx:
            prev = {"scale": self.scale_value, "Wmin": 0, "Hmin": 0,
                    "font_px": max(self.profile.min_font_px, int(round(OBSIDIAN_FONT_SIZE * self.scale_value)))}
            self._update_preview_label(prev)
            return
        prev = preview_values(self.scale_value, self.scale_ctx, OBSIDIAN_FONT_SIZE, self.min_font_value)
        self._set_entries_from_preview(prev)
        self._update_preview_label(prev)


    def on_min_font_changed(self):
        if self._updating:
            return
        raw = self.minfont_entry.get()
        val = self._parse_int(raw, self.min_font_value)
        if val is None:
            return
        self.min_font_value = val
        if not self.scale_ctx:
            s_font = self.min_font_value / max(1, OBSIDIAN_FONT_SIZE)
            self.scale_value = max(self.scale_value, s_font)
            prev = {"scale": self.scale_value, "Wmin": 0, "Hmin": 0,
                    "font_px": max(self.min_font_value, int(round(OBSIDIAN_FONT_SIZE * self.scale_value)))}
            self._update_preview_label(prev)
            return
        S = recompute_from_font(self.min_font_value, self.scale_ctx, OBSIDIAN_FONT_SIZE, self.profile)
        self.scale_value = S
        prev = preview_values(S, self.scale_ctx, OBSIDIAN_FONT_SIZE, self.min_font_value)
        self._set_entries_from_preview(prev)
        self._update_preview_label(prev)


    def on_min_node_w_changed(self):
        if self._updating:
            return
        if not self.scale_ctx:
            messagebox.showwarning("Нет данных", "Сначала нажмите «Рассчитать масштаб (FHD)».")
            return
        raw = self.minw_entry.get()
        Wt = self._parse_int(raw, 0)
        if Wt is None:
            return
        S = recompute_from_min_node_width(Wt, self.scale_ctx, self.profile, OBSIDIAN_FONT_SIZE)
        self.scale_value = S
        prev = preview_values(S, self.scale_ctx, OBSIDIAN_FONT_SIZE, self.min_font_value)
        self._set_entries_from_preview(prev)
        self._update_preview_label(prev)


    def on_min_node_h_changed(self):
        if self._updating:
            return
        if not self.scale_ctx:
            messagebox.showwarning("Нет данных", "Сначала нажмите «Рассчитать масштаб (FHD)».")
            return
        Ht = self._parse_int(self.minh_entry.get(), 0)
        S = recompute_from_min_node_height(Ht, self.scale_ctx, self.profile, OBSIDIAN_FONT_SIZE)
        self.scale_value = S
        prev = preview_values(S, self.scale_ctx, OBSIDIAN_FONT_SIZE, self.min_font_value)
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
            # попробовать авто
            self.detect_vault()
            vault = self.vault_entry.get().strip()
            if not vault:
                return
        
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
                theme=theme_value,          # "dark" или "light" из выпадашки
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
