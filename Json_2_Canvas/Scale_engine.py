# scale_engine.py
# -*- coding: utf-8 -*-
from __future__ import annotations
from dataclasses import dataclass
from math import inf
from typing import Any, Dict, Iterable, Tuple

from Converter import iter_objects, _extract_font_base_px, OBSIDIAN_FONT_SIZE

# Типы элементов, у которых есть шрифт
_FONT_TYPES: frozenset[str] = frozenset({"text", "shape", "sticky_note"})

# ===== Профиль целевого экрана/ограничений =====
@dataclass
class ViewProfile:
    width: int = 1920         # целевой viewport ширина (px)
    height: int = 1080        # целевой viewport высота (px)
    min_zoom: float = 0.12    # минимальный зум Obsidian Canvas (оценочный параметр)
    min_node_w: int = 60      # минимальная ширина узла в Canvas, px
    min_node_h: int = 40      # минимальная высота узла в Canvas, px
    min_font_px: int = 8      # минимальный кегль текста после масштабирования

# Типы, исключаемые из расчёта mnw/mnh (и bbox).
# Категория 1: Read ❌ в Miro REST API — контент недоступен, в canvas не попадают.
# Категория 2: есть в JSON, но не несут смысловой нагрузки в итоговом canvas.
_SCALE_EXCLUDE_TYPES: frozenset[str] = frozenset({
    # Категория 1: Read ❌ в Miro REST API
    "comment",    # только Enterprise Board Export API
    "emoji",      # Read ❌
    "kanban",     # Read ❌
    "mindmap",    # Read ❌
    "stroke",     # Read ❌
    "svg",        # Read ❌
    "grid",       # Read ❌
    "usm",        # Read ❌
    "webscreen",  # Read ❌
    "wireframe",  # Read ❌
    # Категория 2: есть в JSON, не несут смысловой нагрузки в canvas
    "board",           # метаданные доски, не визуальный элемент
    "board_member",    # участник доски, не контент
    "preview",         # превью-иконка доски, Read ❌, в canvas не идёт
    "table_text",      # внутренние ячейки таблицы (beta widget)
    "slide_container", # слайды — нет geometry/ordering в JSON, в canvas не идут
})


def _filter_slide_descendants(items: list[Dict[str, Any]]) -> list[Dict[str, Any]]:
    """Исключает все потомки slide_container (рекурсивно)."""
    deck_ids = {
        str(it.get("id", ""))
        for it in items
        if (it.get("type") or "").lower() == "slide_container"
    }
    if not deck_ids:
        return items

    id_to_parent: Dict[str, str] = {}
    for it in items:
        par = it.get("parent") or {}
        pid = str(par.get("id") or "") if isinstance(par, dict) else ""
        if pid:
            id_to_parent[str(it.get("id", ""))] = pid

    descendants: set = set()
    queue = list(deck_ids)
    while queue:
        pid = queue.pop()
        for iid, par_id in id_to_parent.items():
            if par_id == pid and iid not in descendants:
                descendants.add(iid)
                queue.append(iid)

    return [it for it in items if str(it.get("id", "")) not in descendants]

# ===== Базовая аналитика по доске =====
def analyze_board_from_items(items: Iterable[Dict[str, Any]]) -> Dict[str, float]:
    """
    Аналитика по НОДАМ (без коннекторов и служебных типов):
      - bbox (ширина/высота)
      - минимальный W/H узла

    Из расчёта исключаются:
      - типы из _SCALE_EXCLUDE_TYPES (Read ❌ или не несут нагрузки в canvas)
      - все потомки slide_container (слайды и их содержимое)
    """
    items = _filter_slide_descendants(list(items))
    minx = miny = inf
    maxx = maxy = -inf
    mnw = mnh = inf
    font_min = font_max = None  # реальные кегли из доски (Miro px)

    for it in items:
        itype = (it.get("type") or "").lower()
        if itype == "connector":
            continue
        if itype in _SCALE_EXCLUDE_TYPES:
            continue
        pos, geom = it.get("position", {}) or {}, it.get("geometry", {}) or {}
        try:
            w = float(geom.get("width", 0) or 0)
            h = float(geom.get("height", 0) or 0)
        except Exception:
            w = h = 0.0
        if w <= 0 or h <= 0:
            continue
        try:
            cx, cy = float(pos.get("x", 0)), float(pos.get("y", 0))
        except Exception:
            cx = cy = 0.0
        x0, y0 = cx - w/2, cy - h/2
        x1, y1 = cx + w/2, cy + h/2

        if x0 < minx: minx = x0
        if y0 < miny: miny = y0
        if x1 > maxx: maxx = x1
        if y1 > maxy: maxy = y1

        if w < mnw: mnw = w
        if h < mnh: mnh = h

        # Собираем диапазон кеглей по text/shape/sticky_note
        if itype in _FONT_TYPES:
            fp = _extract_font_base_px(it, fallback=OBSIDIAN_FONT_SIZE)
            if font_min is None or fp < font_min:
                font_min = fp
            if font_max is None or fp > font_max:
                font_max = fp

    if minx is inf:
        return {"bbox_w": 0.0, "bbox_h": 0.0, "mnw": 0.0, "mnh": 0.0,
                "font_min_miro": float(OBSIDIAN_FONT_SIZE), "font_max_miro": float(OBSIDIAN_FONT_SIZE)}

    bbox_w = max(1.0, maxx - minx)
    bbox_h = max(1.0, maxy - miny)
    if mnw is inf: mnw = 0.0
    if mnh is inf: mnh = 0.0
    if font_min is None: font_min = float(OBSIDIAN_FONT_SIZE)
    if font_max is None: font_max = float(OBSIDIAN_FONT_SIZE)

    return {"bbox_w": bbox_w, "bbox_h": bbox_h, "mnw": mnw, "mnh": mnh,
            "font_min_miro": font_min, "font_max_miro": font_max}

def analyze_board(miro_root: Any) -> Dict[str, float]:
    return analyze_board_from_items(iter_objects(miro_root))

# ===== Расчёт масштабов =====
def compute_scale_fit(bbox_w: float, bbox_h: float, profile: ViewProfile) -> float:
    if bbox_w <= 0 or bbox_h <= 0:
        return 1.0
    return min(
        (profile.width  * profile.min_zoom) / bbox_w,
        (profile.height * profile.min_zoom) / bbox_h
    )

def compute_scale_min_node(mnw: float, mnh: float, profile: ViewProfile) -> float:
    if mnw > 0 and mnh > 0:
        return max(profile.min_node_w / mnw, profile.min_node_h / mnh)
    return 0.0

def compute_scale_min_font(base_font_px: int, profile: ViewProfile) -> float:
    return profile.min_font_px / max(1, base_font_px)

def pick_recommended_scale(miro_root: Any, profile: ViewProfile, base_font_px: int) -> Tuple[float, Dict[str, float]]:
    """
    Возвращает (scale, ctx), где ctx — метрики для превью и дальнейших пересчётов.
    """
    a = analyze_board(miro_root)
    s_fit  = compute_scale_fit(a["bbox_w"], a["bbox_h"], profile)
    s_node = compute_scale_min_node(a["mnw"], a["mnh"], profile)
    s_font = compute_scale_min_font(base_font_px, profile)
    S = max(s_fit, s_node, s_font)
    ctx = {**a, "scale_fit": s_fit, "scale_min_node": s_node, "scale_min_font": s_font}
    return S, ctx

# ===== Превью и взаимные пересчёты =====
def preview_values(scale: float, ctx: Dict[str, float], base_font_px: int, min_font_threshold: int) -> Dict[str, Any]:
    mnw = ctx.get("mnw", 0.0)
    mnh = ctx.get("mnh", 0.0)
    font_min_miro = ctx.get("font_min_miro", float(base_font_px))
    font_max_miro = ctx.get("font_max_miro", float(base_font_px))
    Wmin  = int(round(mnw * scale)) if mnw > 0 else 0
    Hmin  = int(round(mnh * scale)) if mnh > 0 else 0
    font_max_px = max(min_font_threshold, int(round(font_max_miro * scale)))
    font_min_px = max(min_font_threshold, int(round(font_min_miro * scale)))
    return {"scale": scale, "Wmin": Wmin, "Hmin": Hmin,
            "font_max_px": font_max_px, "font_min_px": font_min_px}

def recompute_from_font_max(font_target: int, ctx: Dict[str, float], profile: ViewProfile) -> float:
    font_max_miro = max(1.0, ctx.get("font_max_miro", float(OBSIDIAN_FONT_SIZE)))
    s_font = font_target / font_max_miro
    s_node = compute_scale_min_node(ctx["mnw"], ctx["mnh"], profile)
    return max(ctx["scale_fit"], s_node, s_font)

def recompute_from_font_min(font_target: int, ctx: Dict[str, float], profile: ViewProfile) -> float:
    font_min_miro = max(1.0, ctx.get("font_min_miro", float(OBSIDIAN_FONT_SIZE)))
    s_font = font_target / font_min_miro
    s_node = compute_scale_min_node(ctx["mnw"], ctx["mnh"], profile)
    return max(ctx["scale_fit"], s_node, s_font)

def recompute_from_min_node_width(Wtarget: float, ctx: Dict[str, float], profile: ViewProfile) -> float:
    s_node = Wtarget / max(0.0001, ctx["mnw"])
    font_max_miro = max(1.0, ctx.get("font_max_miro", float(OBSIDIAN_FONT_SIZE)))
    s_font = profile.min_font_px / font_max_miro
    return max(ctx["scale_fit"], s_node, s_font)

def recompute_from_min_node_height(Htarget: float, ctx: Dict[str, float], profile: ViewProfile) -> float:
    s_node = Htarget / max(0.0001, ctx["mnh"])
    font_max_miro = max(1.0, ctx.get("font_max_miro", float(OBSIDIAN_FONT_SIZE)))
    s_font = profile.min_font_px / font_max_miro
    return max(ctx["scale_fit"], s_node, s_font)

# ===== Сервис для GUI (чтобы быстро получить превью из JSON-файла) =====
def compute_scale_preview(json_path: str,
                          profile: ViewProfile,
                          base_font_px: int) -> Dict[str, Any]:
    import json
    with open(json_path, "r", encoding="utf-8") as f:
        miro_root = json.load(f)
    scale, ctx = pick_recommended_scale(miro_root, profile, base_font_px)
    prev = preview_values(scale, ctx, base_font_px, profile.min_font_px)
    return {"scale": scale, "context": ctx, "preview": prev}
