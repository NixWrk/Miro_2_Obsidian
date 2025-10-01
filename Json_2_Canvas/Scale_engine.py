# scale_engine.py
# -*- coding: utf-8 -*-
from __future__ import annotations
from dataclasses import dataclass
from math import inf
from typing import Any, Dict, Iterable, Tuple

# iter_objects мы ожидаем получить из converter.py при прямом вызове функций,
# но для compute_scale_preview мы будем читать JSON и сами пройдёмся по структуре.

# ===== Профиль целевого экрана/ограничений =====
@dataclass
class ViewProfile:
    width: int = 1920         # целевой viewport ширина (px)
    height: int = 1080        # целевой viewport высота (px)
    min_zoom: float = 0.12    # минимальный зум Obsidian Canvas (оценочный параметр)
    min_node_w: int = 60      # минимальная ширина узла в Canvas, px
    min_node_h: int = 40      # минимальная высота узла в Canvas, px
    min_font_px: int = 8      # минимальный кегль текста после масштабирования

# ===== Базовая аналитика по доске =====
def _iter_objects_generic(root: Any) -> Iterable[Dict[str, Any]]:
    """
    Универсальный обход объектов без зависимости от converter.iter_objects.
    - список словарей,
    - словарь с типичными коллекциями,
    - словарь с произвольными списками dict'ов.
    """
    KEY_SETS = [
        "items","item",
        "connectors","connector",
        "tags","tag",
        "frames","frame",
        "documents","document",
        "embeds","embed",
        "images","image",
        "texts","text",
        "shapes","shape",
    ]
    if isinstance(root, list):
        for x in root:
            if isinstance(x, dict):
                yield x
    elif isinstance(root, dict):
        picked = False
        for k in KEY_SETS:
            v = root.get(k)
            if isinstance(v, list):
                picked = True
                for x in v:
                    if isinstance(x, dict):
                        yield x
        if not picked:
            for v in root.values():
                if isinstance(v, list):
                    for x in v:
                        if isinstance(x, dict):
                            yield x

def analyze_board_from_items(items: Iterable[Dict[str, Any]]) -> Dict[str, float]:
    """
    Аналитика по НОДАМ (без коннекторов):
      - bbox (ширина/высота)
      - минимальный W/H узла
    """
    minx = miny = inf
    maxx = maxy = -inf
    mnw = mnh = inf

    for it in items:
        if (it.get("type") or "").lower() == "connector":
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

    if minx is inf:
        return {"bbox_w": 0.0, "bbox_h": 0.0, "mnw": 0.0, "mnh": 0.0}

    bbox_w = max(1.0, maxx - minx)
    bbox_h = max(1.0, maxy - miny)
    if mnw is inf: mnw = 0.0
    if mnh is inf: mnh = 0.0

    return {"bbox_w": bbox_w, "bbox_h": bbox_h, "mnw": mnw, "mnh": mnh}

def analyze_board(miro_root: Any) -> Dict[str, float]:
    return analyze_board_from_items(_iter_objects_generic(miro_root))

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
def preview_values(scale: float, ctx: Dict[str, float], base_font_px: int, min_font_threshold: int) -> Dict[str, int]:
    mnw = ctx.get("mnw", 0.0)
    mnh = ctx.get("mnh", 0.0)
    Wmin = int(round(mnw * scale)) if mnw > 0 else 0
    Hmin = int(round(mnh * scale)) if mnh > 0 else 0
    font_px = max(min_font_threshold, int(round(base_font_px * scale)))
    return {"scale": scale, "Wmin": Wmin, "Hmin": Hmin, "font_px": font_px}

def recompute_from_font(font_target: int, ctx: Dict[str, float], base_font_px: int, profile: ViewProfile) -> float:
    s_font = font_target / max(1, base_font_px)
    s_node = compute_scale_min_node(ctx["mnw"], ctx["mnh"], profile)
    return max(ctx["scale_fit"], s_node, s_font)

def recompute_from_min_node_width(Wtarget: float, ctx: Dict[str, float], profile: ViewProfile, base_font_px: int) -> float:
    s_node = Wtarget / max(0.0001, ctx["mnw"])
    s_font = compute_scale_min_font(base_font_px, profile)
    return max(ctx["scale_fit"], s_node, s_font)

def recompute_from_min_node_height(Htarget: float, ctx: Dict[str, float], profile: ViewProfile, base_font_px: int) -> float:
    s_node = Htarget / max(0.0001, ctx["mnh"])
    s_font = compute_scale_min_font(base_font_px, profile)
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
