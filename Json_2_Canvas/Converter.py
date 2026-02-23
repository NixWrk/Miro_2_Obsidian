# converter.py
# -*- coding: utf-8 -*-
from __future__ import annotations

import json
import os
import re
import shutil
from html import escape as _html_escape
from typing import Any, Dict, Iterable, List, Optional


# =========================
# Constants
# =========================

DECK_TYPES = {"slide_container"}
CONTAINER_TYPES = {"group", "frame", "diagram", "slide_container"} 
FRAME_LIKE_TYPES = {"frame", "diagram"}  # строим как рамку


OBSIDIAN_FONT_SIZE = 18  # px
FLOW_PREFIX = "flow_chart_"

# Цвета стикеров Miro
MIRO_STICKY_HEX: Dict[str, str] = {
    "light_yellow": "#FFF59D", "yellow": "#FFD54F", "orange": "#FF8A65",
    "red": "#FF0000", "light_pink": "#F48FB1", "pink": "#F06292",
    "light_blue": "#7986CB", "violet": "#9FA8DA", "blue": "#4FC3F7",
    "dark_blue": "#42A5F5", "cyan": "#26A69A", "dark_green": "#66BB6A",
    "light_green": "#C5E1A5", "green": "#AED581", "white": "#FFFFFF", "black": "#000000",
}

ARROW_SYMBOLS = {"right_arrow": "→", "left_arrow": "←", "left_right_arrow": "↔"}
BRACE_SYMBOLS = {"left_brace": "{", "right_brace": "}"}

MIRO_TO_CANVAS_SHAPE = {
    # Basic
    "rectangle": "round-rectangle", "round_rectangle": "round-rectangle",
    "circle": "circle", "triangle": "diamond", "rhombus": "diamond",
    "parallelogram": "parallelogram", "trapezoid": "parallelogram",
    "pentagon": "round-rectangle", "hexagon": "round-rectangle", "octagon": "round-rectangle",
    "wedge_round_rectangle_callout": "round-rectangle", "star": "round-rectangle",
    "flow_chart_predefined_process": "predefined-process", "cloud": "round-rectangle",
    "cross": "round-rectangle", "can": "database",
    "right_arrow": "pill", "left_arrow": "pill", "left_right_arrow": "pill",
    "left_brace": "round-rectangle", "right_brace": "round-rectangle",
    # Flowchart
    "flow_chart_connector": "circle", "flow_chart_magnetic_disk": "database",
    "flow_chart_input_output": "parallelogram", "flow_chart_decision": "diamond",
    "flow_chart_delay": "pill", "flow_chart_display": "round-rectangle",
    "flow_chart_document": "document", "flow_chart_magnetic_drum": "database",
    "flow_chart_internal_storage": "round-rectangle", "flow_chart_manual_input": "parallelogram",
    "flow_chart_manual_operation": "round-rectangle", "flow_chart_merge": "diamond",
    "flow_chart_multidocuments": "document", "flow_chart_note_curly_left": "document",
    "flow_chart_note_curly_right": "document", "flow_chart_note_square": "document",
    "flow_chart_offpage_connector": "pill", "flow_chart_or": "diamond",
    "flow_chart_predefined_process_2": "predefined-process",
    "flow_chart_preparation": "round-rectangle", "flow_chart_process": "round-rectangle",
    "flow_chart_online_storage": "database", "flow_chart_summing_junction": "circle",
    "flow_chart_terminator": "pill",
}

NOTE_SUBTYPES = {
    "flow_chart_note_curly_right",
    "flow_chart_note_curly_left",
    "flow_chart_note_square",
}

FLOWCHART_LABEL = {
    "flow_chart_terminator": "terminal",
    "flow_chart_process": "process",
    "flow_chart_decision": "decision",
    "flow_chart_input_output": "input/output",
    "flow_chart_predefined_process": "predefined process",
    "flow_chart_document": "document",
    "flow_chart_magnetic_disk": "database",
    "flow_chart_online_storage": "database",
    "flow_chart_or": "or",
    "flow_chart_summing_junction": "summing junction",
}

EXACT_BASE_SHAPES = {"round_rectangle", "rectangle", "circle", "rhombus", "parallelogram"}

KEY_SETS = [
    "items", "item",
    "connectors", "connector",
    "tags", "tag",
    "frames", "frame",
    "documents", "document",
    "embeds", "embed",
    "images", "image",
    "texts", "text",
    "shapes", "shape",
]

VALID_SIDES = {"left", "right", "top", "bottom"}

# =========================
# Compiled regexes (module-level; reuse everywhere)
# =========================

HTML_TAG_RE = re.compile(r"<[^>]+>")
HAS_TAG_RE = re.compile(r"<[a-zA-Z/][^>]*>")
P_CLOSE_RE = re.compile(r"</p\s*>", re.I)
BR_RE = re.compile(r"<br\s*/?>", re.I)
LI_RE = re.compile(r"<li\b", re.I)
PCT_RE = re.compile(r"^\s*([+-]?\d+(?:\.\d+)?)\s*%\s*$")
COLOR_PROP_RE = re.compile(r"(color\s*:\s*)(#[0-9a-fA-F]{3,8}|rgb\s*\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*\))", re.I)

# =========================
# Small utilities
# =========================

def _bbox_of_real_nodes(nodes: List[Dict[str, Any]], include_groups: bool = False) -> Optional[Dict[str, float]]:
    xs, ys, xe, ye = [], [], [], []
    for n in nodes:
        if not include_groups and n.get("type") == "group":
            continue
        try:
            x = float(n["x"]); y = float(n["y"])
            w = float(n["width"]); h = float(n["height"])
        except Exception:
            continue
        xs.append(x); ys.append(y); xe.append(x + w); ye.append(y + h)
    if not xs:
        return None
    x0, y0 = min(xs), min(ys)
    x1, y1 = max(xe), max(ye)
    return {"x": x0, "y": y0, "width": x1 - x0, "height": y1 - y0}


def _norm_hex(s: str) -> str:
    s = s.strip().lower()
    if s.startswith("#") and len(s) in (4, 7):
        # #abc -> #aabbcc
        if len(s) == 4:
            s = "#" + "".join(ch*2 for ch in s[1:])
        return s
    return s

def _is_miro_black_color(s: Optional[str]) -> bool:
    if not s or not isinstance(s, str):
        return False
    t = s.strip().lower()
    if t.startswith("#"):
        return _norm_hex(t) == "#1a1a1a"
    if t.startswith("rgb"):
        # допускаем произвольные пробелы: rgb(26, 26, 26)
        nums = re.findall(r"\d+", t)
        return len(nums) == 3 and all(n.isdigit() for n in nums) and tuple(map(int, nums)) == (26, 26, 26)
    return False

def _extract_inline_color(html: str) -> Optional[str]:
    m = COLOR_PROP_RE.search(html or "")
    return m.group(2) if m else None

def _strip_inline_black_color(html: str) -> str:
    # удаляем только color: #1a1a1a или rgb(26,26,26) — остальные цвета не трогаем
    def _repl(m: re.Match) -> str:
        prefix, val = m.group(1), m.group(2)
        return "" if _is_miro_black_color(val) else m.group(0)
    return COLOR_PROP_RE.sub(_repl, html or "")

def posix_path(p: str) -> str:
    return p.replace("\\", "/")

def find_vault_roots_upwards(start_dir: str) -> List[str]:
    """
    Ищет все кандидаты Vault, поднимаясь от start_dir к корню диска (папки с `.obsidian/`).
    """
    candidates: List[str] = []
    current = os.path.abspath(start_dir)
    while True:
        if os.path.isdir(os.path.join(current, ".obsidian")):
            candidates.append(current)
        parent = os.path.dirname(current)
        if parent == current:
            break
        current = parent
    return candidates

def relpath_from_vault(abs_path: str, vault_root: str) -> str:
    return posix_path(os.path.relpath(abs_path, vault_root))

def _parse_px(v: Any) -> Optional[float]:
    if isinstance(v, (int, float)):
        return float(v)
    if isinstance(v, str):
        s = v.strip().lower()
        if s.endswith("px"):
            s = s[:-2].strip()
        try:
            return float(s)
        except Exception:
            return None
    return None

def _pct_to_float(v: Any) -> Optional[float]:
    """'12%' -> 12.0; '50' -> 50.0; иначе None"""
    if isinstance(v, (int, float)):
        return float(v)
    if isinstance(v, str):
        m = PCT_RE.match(v)
        if m:
            return float(m.group(1))
        try:
            return float(v)
        except ValueError:
            return None
    return None

def strip_html(text: str) -> str:
    return HTML_TAG_RE.sub("", text or "").strip()

def _is_html(s: str) -> bool:
    return bool(s) and bool(HAS_TAG_RE.search(s))



def _extract_line_height(style: Dict[str, Any], default: float = 1.35) -> float:
    v = (style or {}).get("lineHeight") or (style or {}).get("line_height")
    if v is None:
        return default
    if isinstance(v, (int, float)):
        return float(v) if float(v) > 0 else default
    s = str(v).strip().lower()
    if s.endswith("%"):
        try:
            return max(default, float(s[:-1]) / 100.0)
        except Exception:
            return default
    try:
        x = float(s)
        return x if x > 0 else default
    except Exception:
        return default

def _extract_font_base_px(it: Dict[str, Any], fallback: float = OBSIDIAN_FONT_SIZE) -> float:
    style = (it.get("style") or {})
    data = (it.get("data") or {})
    # 1) явные px-ключи
    for src in (style, data):
        for k in ("fontSize", "font_size", "fontSizePx", "textSizePx", "text_size_px", "font-size", "text-size"):
            px = _parse_px(src.get(k))
            if px is not None:
                return px
    # 2) категориальные размеры
    size_key: Optional[str] = None
    for k in ("textSize", "text_size", "fontSizeName", "font_size_name"):
        v = style.get(k)
        if isinstance(v, str):
            size_key = v
            break
        v = data.get(k)
        if isinstance(v, str):
            size_key = v
            break
    if isinstance(size_key, str):
        s = size_key.strip().lower()
        size_map = {
            "xs": 10, "extra_small": 10, "extra-small": 10,
            "s": 12, "small": 12, "m": 16, "medium": 16,
            "l": 20, "large": 20, "xl": 28, "x-large": 28,
            "extra_large": 28, "extra-large": 28,
        }
        if s in size_map:
            return float(size_map[s])
    # 3) масштабные коэффициенты
    for k in ("fontScale", "textScale"):
        sc = _parse_px(style.get(k))
        if sc and sc > 0:
            return float(fallback) * sc
    return float(fallback)

def compute_font_px(scale: float, base_font_px: int = OBSIDIAN_FONT_SIZE, min_font_px: int = 8) -> int:
    """Кегль = round(base*scale), но не меньше min_font_px."""
    return max(min_font_px, int(round(base_font_px * scale)))

def resolve_local_file_name(item: Dict[str, Any], fallback_id: str) -> str:
    data = item.get("data", {}) or {}
    name = item.get("local_name") or os.path.basename(data.get("title") or "")
    return name or f"file_{fallback_id}.bin"

def extract_bg_color(item: Dict[str, Any]) -> Optional[str]:
    """
    Возвращает цвет фона (background/fill) или None.
    Игнорирует fillColor, если fillOpacity == 0 (прозрачная заливка).
    """
    style = item.get("style") or {}
    bg = style.get("backgroundColor")
    if isinstance(bg, str) and bg.strip():
        return bg
    fill = style.get("fillColor")
    try:
        fill_opacity = float(style.get("fillOpacity") or 1.0)
    except Exception:
        fill_opacity = 1.0
    return fill if (fill and fill_opacity > 0.0) else None

# =========================
# Vault / Files
# =========================

def ensure_move_attachments(json_file: str, target_dir: str) -> str:
    """
    Гарантирует, что рядом с целевым .canvas будет <base>_files с вложениями.
    """
    base_name = os.path.splitext(os.path.basename(json_file))[0]
    src_files = os.path.join(os.path.dirname(json_file), base_name + "_files")
    dst_files = os.path.join(target_dir, base_name + "_files")

    if os.path.abspath(src_files) == os.path.abspath(dst_files):
        return dst_files

    if os.path.exists(src_files):
        if os.path.exists(dst_files):
            shutil.rmtree(dst_files)
        shutil.move(src_files, dst_files)
    return dst_files

def cleanup_sources(json_file: str, src_files_folder: str, delete_json: bool, delete_src_files: bool) -> None:
    """Удаляет исходный JSON и/или исходную папку _files (если ещё существует)."""
    try:
        if delete_json and os.path.exists(json_file):
            os.remove(json_file)
    except Exception as e:
        print(f"⚠ Не удалось удалить JSON: {e}")

    try:
        if delete_src_files and os.path.exists(src_files_folder):
            shutil.rmtree(src_files_folder)
    except Exception as e:
        print(f"⚠ Не удалось удалить исходную папку _files: {e}")

# =========================
# JSON iter helpers
# =========================

def iter_objects(miro_root: Any) -> Iterable[Dict[str, Any]]:
    """
    Обходит разные формы JSON:
    - список объектов
    - словарь со списками по «известным» ключам
    - словарь с произвольными списками dict'ов
    """
    if isinstance(miro_root, list):
        for x in miro_root:
            if isinstance(x, dict):
                yield x
        return

    if isinstance(miro_root, dict):
        picked = False
        for k in KEY_SETS:
            if k in miro_root and isinstance(miro_root[k], list):
                picked = True
                for x in miro_root[k]:
                    if isinstance(x, dict):
                        yield x
        if not picked:
            for v in miro_root.values():
                if isinstance(v, list):
                    for x in v:
                        if isinstance(x, dict):
                            yield x

# =========================
# Shape/text helpers
# =========================

def convert_sticky_color(name: str) -> str:
    return MIRO_STICKY_HEX.get((name or "").lower(), name)

def apply_note_brackets(subtype: str, inner_text: str) -> str:
    t = (inner_text or "").strip()
    if subtype == "flow_chart_note_curly_right":
        return f"{t} }}" if t else "}"
    if subtype == "flow_chart_note_curly_left":
        return f"{{ {t}" if t else "{"
    if subtype == "flow_chart_note_square":
        return f"[ {t} ]" if t else "[ ]"
    return inner_text

def pick_canvas_shape(subtype: str) -> str:
    return MIRO_TO_CANVAS_SHAPE.get(subtype, "round-rectangle")

def default_flow_label(subtype: str) -> str:
    if subtype in FLOWCHART_LABEL:
        return FLOWCHART_LABEL[subtype]
    if subtype.startswith(FLOW_PREFIX):
        return subtype[len(FLOW_PREFIX):].replace("_", " ")
    return subtype.replace("_", " ")

def get_miro_subtype(d: Dict[str, Any]) -> str:
    for v in (d.get("subtype"),
              (d.get("shape") or {}).get("shape"),
              (d.get("data") or {}).get("shape"),
              (d.get("data") or {}).get("subtype"),
              (d.get("data") or {}).get("type")):
        if isinstance(v, str) and v:
            return v.lower()
    return ""

def get_text_align(item: Dict[str, Any]) -> str:
    ta = (item.get("style") or {}).get("textAlign")
    return ta if ta in ("left", "center", "right") else "center"

def map_node_border(style: Dict[str, Any]) -> Optional[str]:
    """
    Возвращает одно из: 'dashed' | 'dotted' | 'invisible' | None (сплошная).
    """
    if not style:
        return None
    try:
        bw  = float(style.get("borderWidth") or 0)
        bop = float(style.get("borderOpacity") or 1)
    except Exception:
        bw, bop = 0.0, 1.0
    if bw <= 0 or bop <= 0:
        return "invisible"
    st = str(style.get("borderStyle") or "normal").lower()
    return st if st in ("dashed", "dotted") else None

def map_edge_path(style: Dict[str, Any]) -> Optional[str]:
    """
    Переводит strokeStyle/Width в path:
      dotted -> 'dotted'
      dashed -> 'short-dashed' / 'long-dashed' (эвристика по ширине)
      solid/none -> None
    """
    if not style:
        return None
    st = str(style.get("strokeStyle") or "normal").lower()
    try:
        sw  = float(style.get("strokeWidth") or 0)
        sop = float(style.get("strokeOpacity") or 1)
    except Exception:
        sw, sop = 0.0, 1.0
    if sop <= 0 or sw <= 0:
        return None
    if st == "dotted":
        return "dotted"
    if st == "dashed":
        return "long-dashed" if sw >= 3 else "short-dashed"
    return None

def _extract_side(anchor: Dict[str, Any]) -> Optional[str]:
    """
    Возвращает 'left'|'right'|'top'|'bottom' из anchor['position'].
    Поддерживает:
      - строку ('left'/'right'/...),
      - dict {'side'|'position'|'edge'|'orientation': 'left'...},
      - dict {'x':'0%','y':'50%'} — проценты по периметру.
    """
    if not anchor:
        return None
    v = anchor.get("position")
    # 1) строка со стороной
    if isinstance(v, str):
        s = v.strip().lower()
        return s if s in VALID_SIDES else None
    # 2) словарь с явной стороной
    if isinstance(v, dict):
        for k in ("side", "position", "edge", "orientation"):
            s = v.get(k)
            if isinstance(s, str):
                s = s.strip().lower()
                if s in VALID_SIDES:
                    return s
        # 3) проценты x/y
        x = _pct_to_float(v.get("x"))
        y = _pct_to_float(v.get("y"))
        if x is not None or y is not None:
            if x is not None:
                if x <= 25:
                    return "left"
                if x >= 75:
                    return "right"
            if y is not None:
                if y <= 25:
                    return "top"
                if y >= 75:
                    return "bottom"
            if x is not None:
                return "left" if x < 50 else "right"
            if y is not None:
                return "top" if y < 50 else "bottom"
    return None

def _extract_conn_shape(item: Dict[str, Any]) -> str:
    """Возвращает 'straight'|'elbowed'|'curved' из item['shape'] (строка или dict)."""
    s = item.get("shape")
    if isinstance(s, str):
        return s.lower()
    if isinstance(s, dict):
        for k in ("shape", "type", "path"):
            v = s.get(k)
            if isinstance(v, str):
                return v.lower()
    return ""

def map_edge_pathfinding(mi_shape: str) -> Optional[str]:
    """
    Miro connector shape -> pathfindingMethod:
      straight -> 'direct'
      elbowed  -> 'square'
      curved   -> 'bezier'
    """
    s = (mi_shape or "").lower()
    if s == "straight":
        return "direct"
    if s == "elbowed":
        return "square"
    if s == "curved":
        return "bezier"
    return None

def _extract_edge_label(item: Dict[str, Any]) -> str:
    """
    Возвращает текст метки для коннектора (строка без HTML) или "".
    Приоритет: captions[0].content > label > data.{label|text|content}
    """
    caps = item.get("captions")
    if isinstance(caps, list) and caps:
        c0 = caps[0]
        if isinstance(c0, dict):
            txt = c0.get("content")
            if isinstance(txt, str) and txt.strip():
                return strip_html(txt).strip()
    v = item.get("label")
    if isinstance(v, str):
        return strip_html(v).strip()
    if isinstance(v, dict):
        for k in ("text", "content", "label"):
            t = v.get(k)
            if isinstance(t, str) and t.strip():
                return strip_html(t).strip()
    data = item.get("data") or {}
    for k in ("label", "text", "content"):
        t = data.get(k)
        if isinstance(t, str) and t.strip():
            return strip_html(t).strip()
    return ""

def _estimate_render_height(html_or_text: str, *, width_px: float, font_px: float, line_height: float = 2.35, padding: int = 16) -> int:
    if width_px <= 0 or font_px <= 0:
        return int(padding)
    plain = strip_html(html_or_text or "")
    avg_ch_w = 0.55 * font_px
    usable_w = max(1, width_px - 12)
    max_cols = max(1, int(usable_w / avg_ch_w))

    brs   = len(BR_RE.findall(html_or_text or ""))
    paras = len(P_CLOSE_RE.findall(html_or_text or ""))
    lis   = len(LI_RE.findall(html_or_text or ""))
    nls   = plain.count("\n")

    base_lines  = max(1, paras + lis + brs + nls + 1)
    wrap_extra  = max(0, int(len(plain) / max(1, max_cols)) - 1)
    total_lines = base_lines + wrap_extra
    return int(total_lines * line_height * font_px + padding)

# --- Sticky helpers ---

STICKY_TEXT_PADDING = 30  # внутренние отступы в пикселях для оценки вписывания

def _autofit_font_px_for_box(
    html_or_text: str,
    box_w: float,
    box_h: float,
    *,
    line_height: float,
    min_px: int,
    max_px: int,
) -> int:
    """
    Подбирает максимально возможный кегль так, чтобы предполагаемая высота
    рендеринга текста не превышала box_h (с учётом переноса по box_w).
    Бинарный поиск по интервалу [min_px, max_px].
    """
    lo, hi = max(1, int(min_px)), max(min_px, int(max_px))
    best = lo
    while lo <= hi:
        mid = (lo + hi) // 2
        need_h = _estimate_render_height(
            html_or_text,
            width_px=max(1.0, box_w),
            font_px=mid,
            line_height=line_height
        )
        if need_h <= box_h:
            best = mid
            lo = mid + 1  # пробуем больше
        else:
            hi = mid - 1  # слишком крупно, уменьшаем
    return max(min_px, best)


# === GROUPS / FRAMES helpers ===

def _val_px_or_pct(v: Any, total: float) -> Optional[float]:
    """
    Число в пикселях или строка вида 'NN%'. Возвращает пиксели.
    """
    if v is None:
        return None
    if isinstance(v, (int, float)):
        return float(v)
    s = str(v).strip().lower()
    if s.endswith("%"):
        try:
            return float(s[:-1]) * 0.01 * float(total)
        except Exception:
            return None
    # допускаем '123px'
    try:
        if s.endswith("px"):
            s = s[:-2].strip()
        return float(s)
    except Exception:
        return None

def _rebase_from_diagram_local(item: Dict[str, Any], diag_rect_unscaled: Dict[str, float]) -> Optional[Dict[str, Any]]:
    """
    Трактуем position.x/y ребёнка как ЛОКАЛЬНЫЕ координаты ЦЕНТРА
    от левого-верхнего угла диаграммы. Возвращаем обновлённый item
    с глобальными центровыми координатами (canvas_center).
    Проверяем, что бокс ребёнка попадает в диаграмму (с небольшим допуском).
    """
    pos = item.get("position") or {}
    geom = item.get("geometry") or {}
    try:
        w = float(geom.get("width") or 0.0)
        h = float(geom.get("height") or 0.0)
    except Exception:
        return None
    if w <= 0 or h <= 0:
        return None

    DTLx = float(diag_rect_unscaled["x"])
    DTLy = float(diag_rect_unscaled["y"])
    Dw   = float(diag_rect_unscaled["width"])
    Dh   = float(diag_rect_unscaled["height"])

    dx = _val_px_or_pct(pos.get("x"), Dw)
    dy = _val_px_or_pct(pos.get("y"), Dh)
    if dx is None or dy is None:
        return None

    # глобальный центр ребёнка
    cx = DTLx + dx
    cy = DTLy + dy

    # проверка: бокс ребёнка в диаграмме (с допуском)
    cand = {"x": cx - w/2.0, "y": cy - h/2.0, "width": w, "height": h}
    if not _rect_contains(diag_rect_unscaled, cand, eps=4.0):
        # Слишком далеко — вероятно, это не «дитя» диаграммы
        return None

    new_item = dict(item)
    new_pos = dict(pos)
    new_pos.update({"x": cx, "y": cy, "relativeTo": "canvas_center", "origin": "center"})
    new_item["position"] = new_pos
    return new_item



def _node_center_inside_rect(node: Dict[str, float], rect: Dict[str, float], tol: float = 0.0) -> bool:
    """
    Проверяет, лежит ли центр ноды внутри rect (оба в координатах Canvas).
    tol — допуск (в пикселях Canvas).
    """
    cx = float(node["x"]) + float(node["width"]) / 2.0
    cy = float(node["y"]) + float(node["height"]) / 2.0
    return (
        (rect["x"] - tol) <= cx <= (rect["x"] + rect["width"] + tol) and
        (rect["y"] - tol) <= cy <= (rect["y"] + rect["height"] + tol)
    )


def _frame_rect_unscaled(mi_frame: Dict[str, Any]) -> Optional[Dict[str, float]]:
    geom = (mi_frame.get("geometry") or {})
    pos  = (mi_frame.get("position") or {})
    try:
        w = float(geom.get("width") or 0.0)
        h = float(geom.get("height") or 0.0)
        xc = float(pos.get("x") or 0.0)
        yc = float(pos.get("y") or 0.0)
    except Exception:
        return None
    if w <= 0 or h <= 0:
        return None
    return {"x": xc - w/2.0, "y": yc - h/2.0, "width": w, "height": h}

def _normalize_child_pos_to_canvas(item, parent_rect, *, margin_ratio: float = 0.05):
    pos = (item.get("position") or {})
    rel = str(pos.get("relativeTo") or "canvas_center").lower()
    if rel not in ("parent_top_left", "parent_center"):
        return item

    origin = str(pos.get("origin") or "center").lower()
    try:
        lx = float(pos.get("x") or 0.0)
        ly = float(pos.get("y") or 0.0)
    except Exception:
        return item

    geom = (item.get("geometry") or {})
    w = float(geom.get("width") or 0.0)
    h = float(geom.get("height") or 0.0)

    # базовая точка родителя (левый-верх или центр фрейма)
    p_tl_x, p_tl_y = parent_rect["x"], parent_rect["y"]
    p_w, p_h = parent_rect["width"], parent_rect["height"]
    p_cx = p_tl_x + p_w / 2.0
    p_cy = p_tl_y + p_h / 2.0
    base_x, base_y = (p_tl_x, p_tl_y) if rel == "parent_top_left" else (p_cx, p_cy)

    # центр ребёнка в глобальных координатах (ВСЕГДА пересчитываем)
    if origin == "center":
        cx, cy = base_x + lx, base_y + ly
    else:  # origin == 'top_left'
        cx = base_x + lx + (w / 2.0 if w else 0.0)
        cy = base_y + ly + (h / 2.0 if h else 0.0)

    new_item = dict(item)
    new_pos = dict(pos)
    new_pos.update({"x": cx, "y": cy, "relativeTo": "canvas_center", "origin": "center"})
    new_item["position"] = new_pos
    return new_item





def _frame_rect(mi_frame: Dict[str, Any], scale: float = 1.0) -> Optional[Dict[str, float]]:
    geom = (mi_frame.get("geometry") or {})
    pos  = (mi_frame.get("position") or {})
    try:
        w = float(geom.get("width") or 0.0)
        h = float(geom.get("height") or 0.0)
        xc = float(pos.get("x") or 0.0)
        yc = float(pos.get("y") or 0.0)
    except Exception:
        return None
    if w <= 0 or h <= 0:
        return None
    return {"x": (xc - w/2)*scale, "y": (yc - h/2)*scale, "width": w*scale, "height": h*scale}

def _rect_union(a: Dict[str, float], b: Dict[str, float]) -> Dict[str, float]:
    """Объединение двух прямоугольников в координатах Canvas (левый-верх)."""
    x0 = min(a["x"], b["x"])
    y0 = min(a["y"], b["y"])
    x1 = max(a["x"] + a["width"],  b["x"] + b["width"])
    y1 = max(a["y"] + a["height"], b["y"] + b["height"])
    return {"x": x0, "y": y0, "width": x1 - x0, "height": y1 - y0}

def _rect_contains(a: Dict[str, float], b: Dict[str, float], eps: float = 0.5) -> bool:
    """True, если прямоугольник b полностью внутри a (с допуском eps)."""
    return (
        b["x"]                 >= a["x"] - eps and
        b["y"]                 >= a["y"] - eps and
        b["x"] + b["width"]    <= a["x"] + a["width"]  + eps and
        b["y"] + b["height"]   <= a["y"] + a["height"] + eps
    )



def _is_white_like(hex_or_name: Optional[str]) -> bool:
    if not hex_or_name:
        return True
    s = str(hex_or_name).strip().lower()
    return s in {"#fff", "#ffffff", "white"}

def _is_black_like(hex_or_name: Optional[str]) -> bool:
    if not hex_or_name:
        return False
    s = str(hex_or_name).strip().lower()
    if s in {"#000", "#000000", "black"}:
        return True
    # считаем «почти чёрный» (#1a1a1a) тоже чёрным для наших задач
    if s in {"#1a1a1a"}:
        return True
    if s.startswith("rgb"):
        nums = re.findall(r"\d+", s)
        if len(nums) == 3:
            r, g, b = (int(nums[0]), int(nums[1]), int(nums[2]))
            return (r, g, b) in {(0, 0, 0), (26, 26, 26)}
    return False

def _is_default_miro_stroke(color: Optional[str]) -> bool:
    """
    Цвет линии «по умолчанию» для Miro-коннекторов:
      - пусто/None
      - #333333
      - rgb(51, 51, 51)
    """
    if not color:
        return True
    s = str(color).strip().lower()
    if s == "#333333":
        return True
    if s.startswith("rgb"):
        nums = re.findall(r"\d+", s)
        if len(nums) == 3 and tuple(map(int, nums)) == (51, 51, 51):
            return True
    return False


def _group_label(item: Dict[str, Any]) -> str:
    return (
        item.get("title")
        or (item.get("data") or {}).get("title")
        or item.get("name")
        or ""
    )

# === COLORS helpers ===

def _extract_frame_color(item: Dict[str, Any]) -> str:
    """
    Цвет для FRAME:
      - если в Miro задан заливочный цвет (fillColor/fillOpacity) и он НЕ белый → используем его;
      - иначе всегда белый (#FFFFFF), независимо от темы.
    """
    style = item.get("style") or {}
    try:
        fill_opacity = float(str(style.get("fillOpacity", "") or 1.0))
    except ValueError:
        fill_opacity = 1.0

    bg = extract_bg_color(item)
    if bg and fill_opacity > 0 and not _is_white_like(bg):
        return bg
    return "#FFFFFF"


def _extract_group_color(item: Dict[str, Any]) -> str:
    """
    Цвет для обычной GROUP:
      - если в Miro задан заливочный цвет (fillColor/fillOpacity) и он НЕ белый → используем его;
      - иначе чёрный (#000000) по умолчанию (зависимость от темы НЕ учитываем).
    """
    style = item.get("style") or {}
    try:
        fill_opacity = float(str(style.get("fillOpacity", "") or 1.0))
    except ValueError:
        fill_opacity = 1.0

    bg = extract_bg_color(item)
    if bg and fill_opacity > 0 and not _is_white_like(bg):
        return bg
    return "#000000"


def _parent_id(item: Dict[str, Any]) -> Optional[str]:
    """
    Возвращает id контейнера родителя (group/frame) для обычного элемента.
    В Miro это чаще всего item['group']['id'].
    """
    g = item.get("group")
    if isinstance(g, dict):
        gid = g.get("id")
        if isinstance(gid, (str, int)):
            return str(gid)
    # опционально, если встречаются альтернативные поля:
    par = item.get("parent")
    if isinstance(par, dict):
        pid = par.get("id")
        if isinstance(pid, (str, int)):
            return str(pid)
    return None

def _collect_explicit_group_items(mi_group: Dict[str, Any]) -> List[str]:
    arr = ((mi_group.get("data") or {}).get("items")) or []
    out: List[str] = []
    if isinstance(arr, list):
        for v in arr:
            if isinstance(v, (str, int)):
                out.append(str(v))
    return out

def _bbox_of_nodes(node_map: Dict[str, Dict[str, Any]], child_ids: List[str], padding: int = 12) -> Optional[Dict[str, float]]:
    xs, ys, xe, ye = [], [], [], []
    for cid in child_ids:
        n = node_map.get(cid)
        if not n:
            continue
        try:
            nx, ny = float(n["x"]), float(n["y"])
            nw, nh = float(n["width"]), float(n["height"])
        except Exception:
            continue  # пропускаем «битые» ноды
        xs.append(nx)
        ys.append(ny)
        xe.append(nx + nw)
        ye.append(ny + nh)
    if not xs:
        return None
    x0, y0 = min(xs), min(ys)
    x1, y1 = max(xe), max(ye)
    return {
        "x": x0 - padding,
        "y": y0 - padding,
        "width": (x1 - x0) + 2 * padding,
        "height": (y1 - y0) + 2 * padding,
    }





# =========================
# Converters
# =========================

def convert_item_to_canvas_node(
    item: Dict[str, Any],
    new_files_folder: str,
    vault_root: str,
    scale: float = 1.0,
    min_font_px: int = 8,
    theme: str = "light"
) -> Optional[Dict[str, Any]]:
    """
    Размеры и позиция = геометрия Miro * scale.
    Шрифт = (font из Miro) * scale, но не ниже min_font_px.
    Текст сохраняется как HTML (при наличии).
    Для document: ограничение 500x700 (уменьшаем с сохранением пропорций).
    Если высоты узла не хватает, увеличиваем node["height"].
    """
    item_type = (item.get("type") or "").lower()
    pos = (item.get("position") or {}) if isinstance(item.get("position"), dict) else {}
    geom = (item.get("geometry") or {}) if isinstance(item.get("geometry"), dict) else {}

    width = float(geom.get("width", 250) or 250)

    # высота: если у TEXT отсутствует geometry.height — оценим по контенту
    raw_h = geom.get("height")
    if raw_h is None and item_type == "text":
        base_font_px0 = _extract_font_base_px(item, fallback=OBSIDIAN_FONT_SIZE)
        lh0 = _extract_line_height(item.get("style") or {}, default=1.35)
        content_html = ((item.get("data") or {}).get("content")) or (item.get("plain_text") or "")

        height = _estimate_render_height(content_html, width_px=width, font_px=base_font_px0, line_height=lh0)
    else:
        height = float(raw_h or 60)

    # перевод из центра (Miro) в левый-верх (Canvas) + масштаб
    x, y = pos.get("x", 0) - width / 2, pos.get("y", 0) - height / 2
    base_w, base_h = width * scale, height * scale

    base = {
        "id": str(item.get("id", "")),
        "x": x * scale,
        "y": y * scale,
        "width": base_w,
        "height": base_h,
    }

    # ---------- DOC_FORMAT → FILE (PDF) ----------
    if item_type == "doc_format":
        local_name = item.get("local_name") or f"doc_{str(item.get('id', ''))}.pdf"
        if not str(local_name).lower().endswith(".pdf"):
            local_name = f"{local_name}.pdf"
        abs_path = os.path.join(new_files_folder, local_name)
        rel = relpath_from_vault(abs_path, vault_root)
        node: Dict[str, Any] = {**base, "type": "file", "file": rel}
        max_w, max_h = 500.0, 700.0
        w, h = float(node["width"]), float(node["height"])
        if w > max_w or h > max_h:
            k = min(max_w / max(w, 1e-6), max_h / max(h, 1e-6))
            node["width"], node["height"] = w * k, h * k
        return node


    # ---------- TEXT / SHAPE / STICKY ----------
    if item_type in ("text", "shape", "sticky_note"):
        raw_content = ((item.get("data") or {}).get("content")
                       or item.get("plain_text")
                       or "")
        subtype = get_miro_subtype(item)

        node: Dict[str, Any] = {**base, "type": "text", "text": ""}
        sa = node.setdefault("styleAttributes", {})
        sa["shape"] = pick_canvas_shape(subtype)
        sa["textAlign"] = get_text_align(item)
        sa["border"] = map_node_border(item.get("style") or {})

        is_sticky = (item_type == "sticky_note")

        if item_type == "sticky_note":
            fill = (item.get("style") or {}).get("fillColor")
            if fill:
                node["color"] = convert_sticky_color(str(fill))
        else:
            bg = extract_bg_color(item)
            if bg:
                node["color"] = bg

        plain = strip_html(raw_content).strip()
        if subtype in NOTE_SUBTYPES:
            if _is_html(raw_content):
                plain = apply_note_brackets(subtype, plain)
                raw_content = f"<p>{_html_escape(plain, quote=False)}</p>"
            else:
                raw_content = apply_note_brackets(subtype, plain)
        elif not plain:
            if subtype in ARROW_SYMBOLS:
                raw_content = ARROW_SYMBOLS[subtype]
            elif subtype in BRACE_SYMBOLS:
                raw_content = BRACE_SYMBOLS[subtype]
            elif subtype.startswith(FLOW_PREFIX):
                raw_content = default_flow_label(subtype)
                if "color" not in node:
                    node["color"] = "#FFFFFF"
            elif subtype and subtype not in EXACT_BASE_SHAPES:
                raw_content = subtype.replace("_", " ")

      
        # Базовый кегль из Miro (на самом элементе) + пересчёт в Canvas по масштабу
        base_font_px = _extract_font_base_px(item, fallback=OBSIDIAN_FONT_SIZE)
        lh = _extract_line_height(item.get("style") or {}, default=1.35)

        # "расчётный" минимум для узла (floor)
        raw_node_px = int(base_font_px * scale)
        start_px = max(min_font_px, raw_node_px)

        if is_sticky:
            # Вписываем текст внутрь бокса: полезная область
            avail_w = max(1.0, base_w - 2 * STICKY_TEXT_PADDING)
            avail_h = max(1.0, base_h - 2 * STICKY_TEXT_PADDING)

            # Нижняя/верхняя границы подбора
            lo = max(1, min(raw_node_px, min_font_px))              # можно опуститься ниже глобального min
            hard_cap = int(max(8, min(base_h, base_w)))
            hi = max(start_px, int(start_px * 1.25), hard_cap)

            font_px = _autofit_font_px_for_box(
                raw_content,
                avail_w,
                avail_h,
                line_height=lh,
                min_px=lo,
                max_px=hi,
            )
        else:
            # Обычный TEXT без автофита
            font_px = compute_font_px(scale, int(base_font_px), min_font_px)

        # применяем выбранный кегль (для всех типов)
        sa["fontSize"] = font_px

        style_color = ((item.get("style") or {}).get("color") or "").strip()
        inline_color = _extract_inline_color(raw_content) if _is_html(raw_content) else None

        # Решаем итоговую стратегию:
        #  - если есть inline color → он главный
        #  - иначе берём style.color (кроме особого «микро-чёрного» в тёмной теме)
        #  - иначе без цвета (наследуем тему)
        wrapper_extra_color: Optional[str] = None
        content_html = raw_content

        if _is_html(raw_content):
            if inline_color and theme.lower() == "dark" and _is_miro_black_color(inline_color):
                # В тёмной теме чёрный → наследовать (убираем color: из инлайна)
                content_html = _strip_inline_black_color(raw_content)
                # Если хочешь вместо наследования всегда ставить белый:
                # wrapper_extra_color = "#FFFFFF"
            elif not inline_color and style_color:
                # инлайна нет — прокинем style.color в обёртку,
                # но в тёмной теме НЕ прокидываем «микро-чёрный»
                if not (theme.lower() == "dark" and _is_miro_black_color(style_color)):
                    wrapper_extra_color = style_color
        else:
            # plain text: применяем style.color, но уважая тёмную тему + «микро-чёрный»
            if style_color and not (theme.lower() == "dark" and _is_miro_black_color(style_color)):
                wrapper_extra_color = style_color
            # если тёмная тема и style.color — «микро-чёрный», ничего не ставим → наследуем светлый по теме

        # Собираем HTML-обёртку
        if _is_html(content_html):
            style_bits = [f"font-size:{font_px}px", f"line-height:{lh}"]
            if wrapper_extra_color:
                style_bits.append(f"color:{wrapper_extra_color}")
            node["text"] = f'<div style="{"; ".join(style_bits)}">{content_html}</div>'
        else:
            safe = _html_escape(content_html or "", quote=False).replace("\n", "<br>")
            style_bits = [f"font-size:{font_px}px", f"line-height:{lh}"]
            if wrapper_extra_color:
                style_bits.append(f"color:{wrapper_extra_color}")
            node["text"] = f'<span style="{"; ".join(style_bits)}">{safe}</span>'

        # оценка высоты для контроля
        need_h = _estimate_render_height(raw_content, width_px=base_w, font_px=font_px, line_height=lh)

        if (not is_sticky and not is_shape) and need_h > node["height"]:
            # только «чистые» TEXT можно растягивать по высоте
            node["height"] = need_h
        # для фигуры/стикера высоту не увеличиваем — кегль уже подогнан под бокс

        return node



    # ---------- EMBED → LINK ----------
    if item_type == "embed":
        url = (item.get("data") or {}).get("url") or (item.get("links") or {}).get("web", "")
        return {**base, "type": "link", "url": url}

    # ---------- CARD / PREVIEW / APP_CARD → TEXT ----------
    if item_type in ("card", "preview", "app_card"):
        data = item.get("data") or {}
        parts = []
        if data.get("title"):
            parts.append(f"<p>{_html_escape(str(data.get('title')), False)}</p>")
        if data.get("description"):
            parts.append(f"<p>{_html_escape(str(data.get('description')), False)}</p>")
        if data.get("url"):
            parts.append(f"<p>{_html_escape(str(data.get('url')), False)}</p>")
        html = "".join(parts) if parts else ""

        node = {**base, "type": "text", "text": ""}
        base_font_px = _extract_font_base_px(item, fallback=OBSIDIAN_FONT_SIZE)
        lh = _extract_line_height(item.get("style") or {}, default=1.35)
        font_px = compute_font_px(scale, int(base_font_px), min_font_px)
        node.setdefault("styleAttributes", {})["fontSize"] = font_px
        node["text"] = f'<div style="font-size:{font_px}px; line-height:{lh}">{html}</div>'

        # грубая оценка высоты
        need_h = _estimate_render_height(html or "", width_px=base_w, font_px=font_px, line_height=lh)
        if need_h > node["height"]:
            node["height"] = need_h
        return node

    # ---------- IMAGE / DOCUMENT → FILE ----------
    if item_type in ("image", "document"):
        # пропускаем слоты в doc_format
        pos_obj = item.get("position") or {}
        par_obj = item.get("parent") or {}
        is_slot = isinstance(pos_obj, dict) and bool(pos_obj.get("slotId"))
        is_doc_parent = False
        if isinstance(par_obj, dict):
            links = par_obj.get("links") or {}
            self_url = links.get("self") or ""
            is_doc_parent = "/doc_formats/" in str(self_url)
        if is_slot or is_doc_parent:
            return None

        local_name = resolve_local_file_name(item, base["id"])
        abs_path = os.path.join(new_files_folder, local_name)
        rel = relpath_from_vault(abs_path, vault_root)
        node = {**base, "type": "file", "file": rel}

        if item_type == "document":
            max_w, max_h = 500.0, 700.0
            w, h = float(node["width"]), float(node["height"])
            if w > max_w or h > max_h:
                k = min(max_w / max(w, 1e-6), max_h / max(h, 1e-6))
                node["width"], node["height"] = w * k, h * k
        return node

    # ----------  TAG → TEXT-МЕТКА ----------


    if item_type == "tag":
        title = item.get("title") or (item.get("data") or {}).get("title", "") or ""
        html = f"<p>[Tag] {_html_escape(title, False)}</p>"
        node = {**base, "type": "text", "text": ""}
        base_font_px = _extract_font_base_px(item, fallback=OBSIDIAN_FONT_SIZE)
        lh = _extract_line_height(item.get("style") or {}, default=1.35)
        font_px = compute_font_px(scale, int(base_font_px), min_font_px)
        node.setdefault("styleAttributes", {})["fontSize"] = font_px
        node["text"] = f'<div style="font-size:{font_px}px; line-height:{lh}">{html}</div>'
        need_h = _estimate_render_height(html, width_px=base_w, font_px=font_px, line_height=lh)
        if need_h > node["height"]:
            node["height"] = need_h
        return node

    # прочие типы пропускаем
    return None

def convert_item_to_edge(item: Dict[str, Any], theme: str = "light") -> Optional[Dict[str, Any]]:
    if (item.get("type") or "").lower() != "connector":
        return None

    start = (item.get("startItem") or {}).get("id")
    end = (item.get("endItem") or {}).get("id")
    if not (start and end):
        return None

    edge: Dict[str, Any] = {
        "id": str(item.get("id", "")),
        "fromNode": str(start),
        "toNode": str(end),
    }

    # стороны подключения
    fs = _extract_side(item.get("startItem") or {})
    ts = _extract_side(item.get("endItem") or {})
    if fs:
        edge["fromSide"] = fs
    if ts:
        edge["toSide"] = ts

    style = item.get("style") or {}

    # если линия невидима — не красим
    try:
        sw  = float(style.get("strokeWidth") or 0)
        sop = float(style.get("strokeOpacity") or 1)
    except Exception:
        sw, sop = 0.0, 1.0
    invisible = (sw <= 0) or (sop <= 0)

    col_raw = (style.get("strokeColor") or "").strip()
    is_default = _is_default_miro_stroke(col_raw)
    is_black   = _is_black_like(col_raw)
    is_white   = _is_white_like(col_raw)

    chosen_color: Optional[str] = None
    if not invisible:
        t = (theme or "light").lower()
        if t == "dark":
            # НОВОЕ: в тёмной теме «по умолчанию» ИЛИ «чёрные» → без цвета (пусть будет дефолт канваса)
            if is_default or is_black:
                chosen_color = None
            elif col_raw and not is_default:
                chosen_color = col_raw  # кастомный цвет уважаем
        else:  # light
            # как и раньше: «по умолчанию» ИЛИ «белые» → чёрные
            if is_default or is_white:
                chosen_color = "#000000"
            elif col_raw and not is_default:
                chosen_color = col_raw

    # записываем только если есть, иначе оставляем без 'color'
    if chosen_color:
        edge["color"] = chosen_color
    elif "color" in edge:
        del edge["color"]

    # наконечники
    start_cap = str(style.get("startStrokeCap", "none")).lower()
    end_cap = str(style.get("endStrokeCap", "none")).lower()

    def _has_arrow(c: str) -> bool:
        return any(tok in c for tok in ("arrow", "stealth", "triangle", "diamond"))

    edge["fromEnd"] = "arrow" if _has_arrow(start_cap) else "none"
    edge["toEnd"] = "arrow" if _has_arrow(end_cap) else "none"

    # стиль линии и маршрут
    sa = edge.setdefault("styleAttributes", {})
    path = map_edge_path(style)  # dotted / short-dashed / long-dashed / None
    if path is not None:
        sa["path"] = path

    pf = map_edge_pathfinding(_extract_conn_shape(item))  # direct / square / bezier / None
    if pf is not None:
        sa["pathfindingMethod"] = pf

    # подпись
    lbl = _extract_edge_label(item)
    if lbl:
        edge["label"] = lbl

    return edge


# =========================
# Top-level pipeline
# =========================

def _is_deck(it: Dict[str, Any]) -> bool:
    return (it.get("type") or "").lower() in DECK_TYPES


def _is_slide_frame(
    mi_frame: Dict[str, Any],
    deck_ids: set,
    children: Dict[str, List[str]],
) -> bool:
    """True, если фрейм относится к slide_container (деке)."""
    if (mi_frame.get("type") or "").lower() != "frame":
        return False
    if not deck_ids:
        return False

    # 1) Явный parent → deck
    par = mi_frame.get("parent")
    if isinstance(par, dict) and par.get("id") is not None and str(par.get("id")) in deck_ids:
        return True

    # 2) Через собранные связи children[deck_id] (если API их положил)
    fid = str(mi_frame.get("id", "") or "")
    for did in deck_ids:
        if fid in (children.get(did) or []):
            return True

    return False


def convert_miro_to_canvas(
    json_path: str,
    target_dir: str,
    vault_root: str,
    delete_json: bool = False,
    delete_src_files: bool = False,
    scale: float = 1.0,
    min_font_px: int = 8,
    theme: str = "light"
) -> str:
    """
    Основной конвейер конвертации Miro JSON → Obsidian Canvas.
    Возвращает путь к созданному .canvas.
    """
    base_name = os.path.splitext(os.path.basename(json_path))[0]
    canvas_path = os.path.join(target_dir, base_name + ".canvas")

    src_files_folder = os.path.join(os.path.dirname(json_path), base_name + "_files")
    new_files_folder = ensure_move_attachments(json_file=json_path, target_dir=target_dir)

    with open(json_path, "r", encoding="utf-8") as f:
        miro_root = json.load(f)

    nodes: List[Dict[str, Any]] = []
    edges: List[Dict[str, Any]] = []

    # --- первый проход: собираем все элементы и отношения родитель → дети
    
    all_items: List[Dict[str, Any]] = list(iter_objects(miro_root))

    by_id: Dict[str, Dict[str, Any]] = {}
    children: Dict[str, List[str]] = {}
    containers: List[Dict[str, Any]] = []
    container_rects_unscaled: Dict[str, Dict[str, float]] = {}  # frame + diagram
    diagram_rects_unscaled: Dict[str, Dict[str, float]] = {}    # только diagram

    for it in all_items:
        iid = str(it.get("id", "") or "")
        if iid:
            by_id[iid] = it

        t = (it.get("type") or "").lower()
        if t in CONTAINER_TYPES:
            containers.append(it)
            if t in FRAME_LIKE_TYPES:
                fr0 = _frame_rect_unscaled(it)
                if fr0:
                    container_rects_unscaled[iid] = fr0
                    if t == "diagram":
                        diagram_rects_unscaled[iid] = fr0

        # 1) привязка к группе (если есть)
        g = it.get("group")
        if isinstance(g, dict) and g.get("id") is not None:
            gid = str(g.get("id"))
            children.setdefault(gid, []).append(iid)

        # 2) привязка к фрейму через parent.id (если есть)
        par = it.get("parent")
        if isinstance(par, dict) and par.get("id") is not None:
            pid = str(par.get("id"))
            children.setdefault(pid, []).append(iid)


    # --- нормализация rect вложенных фреймов (relativeTo: parent_top_left/parent_center)
    # Фреймы-слайды внутри slide_container имеют position.relativeTo="parent_top_left",
    # поэтому _frame_rect_unscaled вернул локальные координаты как глобальные.
    # Пересчитываем их через rect родителя (если он уже известен).
    for it in containers:
        iid = str(it.get("id", "") or "")
        if iid not in container_rects_unscaled:
            continue
        pos = it.get("position") or {}
        rel = str(pos.get("relativeTo") or "").lower()
        if rel not in ("parent_top_left", "parent_center"):
            continue
        par = it.get("parent")
        if not isinstance(par, dict) or par.get("id") is None:
            continue
        pid = str(par.get("id"))
        parent_rect = container_rects_unscaled.get(pid)
        if not parent_rect:
            # slide_container не имеет геометрии — строим rect из его позиции
            par_item = by_id.get(pid)
            if not par_item:
                continue
            par_pos = par_item.get("position") or {}
            try:
                par_cx = float(par_pos.get("x") or 0.0)
                par_cy = float(par_pos.get("y") or 0.0)
            except Exception:
                continue
            # point-rect: top_left = center (w=0, h=0), нормализация сработает корректно
            parent_rect = {"x": par_cx, "y": par_cy, "width": 0.0, "height": 0.0}
        # нормализуем сам фрейм как обычный дочерний элемент
        normalized = _normalize_child_pos_to_canvas(it, parent_rect)
        npos = normalized.get("position") or {}
        geom = it.get("geometry") or {}
        try:
            cx = float(npos.get("x") or 0.0)
            cy = float(npos.get("y") or 0.0)
            w  = float(geom.get("width") or 0.0)
            h  = float(geom.get("height") or 0.0)
        except Exception:
            continue
        if w > 0 and h > 0:
            container_rects_unscaled[iid] = {"x": cx - w/2.0, "y": cy - h/2.0, "width": w, "height": h}

    # учесть явные списки детей в самих группах (data.items)
    for cont in containers:
        cid = str(cont.get("id", "") or "")
        if not cid:
            continue
        explicit_ids = _collect_explicit_group_items(cont)
        if explicit_ids:
            lst = children.setdefault(cid, [])
            seen = set(lst)
            for ch in explicit_ids:
                if ch and ch not in seen:
                    lst.append(ch)
                    seen.add(ch)

     # --- Slides: deck и принадлежность фреймов к деке ---

    # Найдём все slide_container'ы
    deck_ids = {
        str(it.get("id"))
        for it in all_items
        if isinstance(it, dict) and (it.get("type") or "").lower() in DECK_TYPES
    }

    # Гарантируем, что у каждой деки в children будут её фреймы-слайды
    slide_frame_ids = [
        str(it.get("id"))
        for it in containers
        if (it.get("type") or "").lower() == "frame" and _is_slide_frame(it, deck_ids, children)
    ]
    for did in deck_ids:
        lst = children.setdefault(did, [])
        seen = set(lst)
        for fid in slide_frame_ids:
            if fid and fid not in seen:
                lst.append(fid)
                seen.add(fid)


    # --- второй проход: сначала обычные узлы/рёбра (кроме контейнеров)
    node_map: Dict[str, Dict[str, Any]] = {}
    for item in all_items:
        t = (item.get("type") or "").lower()
        if t in CONTAINER_TYPES:  # {"group", "frame", "diagram"}
            continue

        # 1) Нормализация по реальному родителю-контейнеру (frame/diagram)
        par = item.get("parent") or {}
        parent_pid = None
        if isinstance(par, dict) and par.get("id") is not None:
            cand = str(par.get("id"))
            if cand in container_rects_unscaled:  # есть rect у родителя
                parent_pid = cand

        if parent_pid:
            pos = (item.get("position") or {})
            rel_to = str(pos.get("relativeTo") or "").lower()
            if rel_to in ("parent_top_left", "parent_center"):
                item = _normalize_child_pos_to_canvas(item, container_rects_unscaled[parent_pid])
        else:
            # 2) Эвристика для диаграмм: координаты детей, по факту, локальные от TL диаграммы.
            # Пересчитываем в глобальные, подбирая диаграмму с минимальным «переливом» за рамки.
            pos = (item.get("position") or {})
            rel_to = str(pos.get("relativeTo") or "").lower()
            if rel_to == "canvas_center" and diagram_rects_unscaled:
                rebased = None
                best_overflow = None
                for did, drect in diagram_rects_unscaled.items():
                    cand_item = _rebase_from_diagram_local(item, drect)
                    if not cand_item:
                        continue

                    # Оценим, насколько бокс ребёнка вылезает за диаграмму (0 — идеально внутри)
                    g = (cand_item.get("geometry") or {})
                    try:
                        w  = float(g.get("width") or 0.0)
                        h  = float(g.get("height") or 0.0)
                        cx = float((cand_item.get("position") or {}).get("x") or 0.0)
                        cy = float((cand_item.get("position") or {}).get("y") or 0.0)
                    except Exception:
                        continue
                    bx = cx - w / 2.0
                    by = cy - h / 2.0

                    ox = 0.0
                    if bx < drect["x"]:
                        ox += drect["x"] - bx
                    if bx + w > drect["x"] + drect["width"]:
                        ox += (bx + w) - (drect["x"] + drect["width"])

                    oy = 0.0
                    if by < drect["y"]:
                        oy += drect["y"] - by
                    if by + h > drect["y"] + drect["height"]:
                        oy += (by + h) - (drect["y"] + drect["height"])

                    overflow = ox + oy
                    if (best_overflow is None) or (overflow < best_overflow):
                        best_overflow = overflow
                        rebased = cand_item

                if rebased is not None:
                    item = rebased

        # 3) Конвертация коннекторов в рёбра
        edge = convert_item_to_edge(item, theme=theme)
        if edge:
            edges.append(edge)
            continue

        # 4) Конвертация остальных элементов в ноды
        node = convert_item_to_canvas_node(
            item, new_files_folder, vault_root,
            scale=scale, min_font_px=min_font_px, theme=theme
        )
        if node:
            nodes.append(node)
            nid = str(node.get("id", "") or "")
            if nid:
                node_map[nid] = node



    # --- третий проход: строим контейнеры (Miro group / frame / diagram) как Canvas group

    def _container_depth(it: Dict[str, Any]) -> int:
        """
        Глубина вложенности контейнера по цепочке parent.id -> by_id.
        Нужна, чтобы сначала собрать внутренние контейнеры, затем внешние.
        """
        d, cur, seen = 0, it, set()
        while isinstance(cur, dict):
            par = cur.get("parent")
            pid = str(par.get("id")) if isinstance(par, dict) and par.get("id") is not None else None
            if not pid or pid in seen:
                break
            seen.add(pid)
            cur = by_id.get(pid)
            d += 1
        return d

    # 3.1. Сначала обычные контейнеры (frame/diagram/group)
    normal_containers = [c for c in containers if not _is_deck(c)]
    normal_containers.sort(key=_container_depth, reverse=True)

    # Набор id фреймов-слайдов — нужен чтобы добавить ratio при создании группы
    slide_frame_id_set = set(slide_frame_ids)
    # Первый слайд каждой деки (для metadata.startNode)
    first_slide_per_deck: Dict[str, str] = {}
    for did in deck_ids:
        for fid in (children.get(did) or []):
            if fid in slide_frame_id_set:
                first_slide_per_deck[did] = fid
                break

    for cont in normal_containers:
        cid = str(cont.get("id", "") or "")
        if not cid:
            continue

        ctype = str(cont.get("type") or "").lower()
        is_frame_like = (ctype in FRAME_LIKE_TYPES)  # frame и diagram

        # кандидаты-дети по id (берём только те, что реально сконвертированы в node_map)
        raw_child_ids = [ch for ch in (children.get(cid) or []) if ch in node_map]

        # геометрия «фреймоподобных» контейнеров в координатах Canvas (левый-верх)
        # Используем нормализованный rect из container_rects_unscaled (уже пересчитан
        # для вложенных фреймов с relativeTo=parent_top_left), применяем масштаб вручную.
        if is_frame_like:
            _r0 = container_rects_unscaled.get(cid)
            frect = (
                {"x": _r0["x"] * scale, "y": _r0["y"] * scale,
                 "width": _r0["width"] * scale, "height": _r0["height"] * scale}
                if _r0 else _frame_rect(cont, scale=scale)
            )
        else:
            frect = None

        # фильтр по центру (для frame/diagram)
        if is_frame_like and frect:
            child_ids = [ch for ch in raw_child_ids if _node_center_inside_rect(node_map[ch], frect, tol=1.0)]
        else:
            child_ids = raw_child_ids

        # bbox детей: 0 padding для frame/diagram, 12 px для обычной группы
        bbox = (
            _bbox_of_nodes(node_map, child_ids, padding=0) if (child_ids and is_frame_like)
            else _bbox_of_nodes(node_map, child_ids, padding=12) if child_ids
            else None
        )

        # финальный прямоугольник контейнера
        if is_frame_like:
            if frect and bbox:
                rect = frect if _rect_contains(frect, bbox, eps=0.5) else _rect_union(frect, bbox)
            else:
                rect = frect or bbox  # пустая рамка тоже допустима
        else:
            rect = bbox

        if not rect:
            # для групп без детей прямоугольник не получился — пропускаем
            continue

        # подпись контейнера
        label = _group_label(cont)

        # цвет: у frame/diagram — явная заливка или белый; у групп — с учётом темы
        if is_frame_like:
            color = _extract_frame_color(cont)
        else:
            color = _extract_group_color(cont)
            t = (theme or "light").lower()
            if t == "dark":
                if (not color) or _is_white_like(color):
                    color = "#000000"
            else:  # light
                if (not color) or _is_black_like(color):
                    color = "#FFFFFF"

        # формируем Canvas-ноду контейнера
        group_node = {
            "id": cid,
            "type": "group",
            "x": rect["x"],
            "y": rect["y"],
            "width": rect["width"],
            "height": rect["height"],
            "label": label,
            "nodes": child_ids,
            "color": color,
        }
        # Advanced Canvas: слайды требуют поля ratio (ширина/высота)
        if cid in slide_frame_id_set and rect["height"] > 0:
            group_node["ratio"] = rect["width"] / rect["height"]
        nodes.append(group_node)
        node_map[cid] = group_node

    # 3.2. Теперь собираем deck как группы, содержащие фреймы-слайды (уже созданные выше)
    deck_containers = [c for c in containers if _is_deck(c)]

    for cont in deck_containers:
        cid = str(cont.get("id", "") or "")
        if not cid:
            continue

        # Берём детей деки, которые уже есть как ноды (frame-группы)
        child_ids = [ch for ch in (children.get(cid) or []) if ch in node_map]
        if not child_ids:
            continue

        # bbox по frame-группам (deck своей геометрии не имеет)
        rect = _bbox_of_nodes(node_map, child_ids, padding=12)
        if not rect:
            continue

        label = _group_label(cont)
        color = _extract_group_color(cont)
        t = (theme or "light").lower()
        if t == "dark":
            if (not color) or _is_white_like(color):
                color = "#000000"
        else:
            if (not color) or _is_black_like(color):
                color = "#FFFFFF"

        group_node = {
            "id": cid,
            "type": "group",
            "x": rect["x"],
            "y": rect["y"],
            "width": rect["width"],
            "height": rect["height"],
            "label": label,
            "nodes": child_ids,   # ВАЖНО: deck содержит frame-группы
            "color": color,
        }
        nodes.append(group_node)
        node_map[cid] = group_node




    # --- НОРМАЛИЗАЦИЯ: центрируем «вещественные» элементы в (0, 0)
    bb = _bbox_of_real_nodes(nodes, include_groups=False)  # считаем только по non-group
    if bb:
        cx = bb["x"] + bb["width"] / 2.0
        cy = bb["y"] + bb["height"] / 2.0
        dx, dy = -cx, -cy
        if abs(dx) > 1e-9 or abs(dy) > 1e-9:
            for n in nodes:
                try:
                    n["x"] = float(n["x"]) + dx
                    n["y"] = float(n["y"]) + dy
                except Exception:
                    # пропускаем элементы без координат (на всякий случай)
                    pass




    canvas_obj: Dict[str, Any] = {"nodes": nodes, "edges": edges}

    # Advanced Canvas metadata: startNode = первый слайд первой деки (если есть)
    all_first_slides = list(first_slide_per_deck.values())
    if all_first_slides:
        canvas_obj["metadata"] = {
            "version": "1.0-1.0",
            "frontmatter": {},
            "startNode": all_first_slides[0],
        }

    os.makedirs(target_dir, exist_ok=True)
    with open(canvas_path, "w", encoding="utf-8") as f:
        json.dump(canvas_obj, f, ensure_ascii=False, indent=2)

    cleanup_sources(
        json_file=json_path,
        src_files_folder=src_files_folder,
        delete_json=delete_json,
        delete_src_files=delete_src_files,
    )



    return canvas_path
