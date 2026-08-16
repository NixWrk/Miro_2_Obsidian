# scale_engine.py
# -*- coding: utf-8 -*-
from __future__ import annotations
from dataclasses import dataclass
from math import inf, isfinite
from typing import Any, Dict, Iterable, Optional, Tuple

from Converter import (
    COMMENT_NODE_MIN_HEIGHT,
    COMMENT_NODE_WIDTH,
    OBSIDIAN_FONT_SIZE,
    SOURCE_LIMITED_DROP_TYPES,
    _estimate_render_height,
    _extract_font_base_px,
    _format_comment_html,
    _link_card_16x9_size,
    _position_only_placeholder_size,
    has_recoverable_item_content,
    iter_objects,
)

# Types whose source font is scaled by the converter.
_FONT_TYPES: frozenset[str] = frozenset(
    {
        "text",
        "shape",
        "sticky_note",
        "mindmap_node",
        "card",
        "preview",
        "app_card",
        "code",
        "table_text",
        "tag",
        "comment",
    }
)
_META_TYPES: frozenset[str] = frozenset({"board", "board_member"})
SCALE_MODES: frozenset[str] = frozenset({"overview", "readable", "balanced"})


# ===== Профиль целевого экрана/ограничений =====
@dataclass
class ViewProfile:
    width: int = 1920  # целевой viewport ширина (px)
    height: int = 1080  # целевой viewport высота (px)
    min_zoom: float = 0.12  # минимальный зум Obsidian Canvas (оценочный параметр)
    fit_margin: float = 0.95  # запас под post-conversion рост nodes и UI-рамки
    min_node_w: int = 60  # минимальная ширина узла в Canvas, px
    min_node_h: int = 40  # минимальная высота узла в Canvas, px
    min_font_px: int = 8  # минимальный кегль текста после масштабирования
    scale_mode: str = "balanced"  # overview | readable | balanced


def _validate_profile(profile: ViewProfile) -> None:
    for field in (
        "width",
        "height",
        "min_zoom",
        "fit_margin",
        "min_node_w",
        "min_node_h",
        "min_font_px",
    ):
        value = getattr(profile, field)
        if isinstance(value, bool):
            raise ValueError(f"ViewProfile.{field} must be a positive finite number")
        try:
            numeric = float(value)
        except (TypeError, ValueError) as exc:
            raise ValueError(
                f"ViewProfile.{field} must be a positive finite number"
            ) from exc
        if not isfinite(numeric) or numeric <= 0:
            raise ValueError(f"ViewProfile.{field} must be a positive finite number")


def _has_position(item: Dict[str, Any]) -> bool:
    pos = item.get("position") if isinstance(item.get("position"), dict) else {}
    return pos.get("x") is not None and pos.get("y") is not None


def _is_scale_relevant(item: Dict[str, Any]) -> bool:
    item_type = str(item.get("type") or "").lower()
    if item_type == "connector" or item_type in _META_TYPES:
        return False
    if item_type in SOURCE_LIMITED_DROP_TYPES and not has_recoverable_item_content(
        item
    ):
        return False
    if item_type in {
        "mindmap_node",
        "card",
        "preview",
        "app_card",
        "code",
        "table_text",
        "comment",
    }:
        if not has_recoverable_item_content(item) and item_type != "comment":
            return False
        if item_type == "comment" and not _format_comment_html(item):
            return False
    if item_type == "embed" and not (
        has_recoverable_item_content(item) or item.get("local_name")
    ):
        return False
    if item_type == "tag" and (
        not _has_position(item) or not isinstance(item.get("geometry"), dict)
    ):
        return False
    if item_type == "slide_container" and not isinstance(item.get("geometry"), dict):
        return False
    return (
        isinstance(item.get("geometry"), dict)
        or _has_position(item)
        or item_type == "comment"
    )


def _item_geometry(item: Dict[str, Any]) -> tuple[float, float]:
    item_type = str(item.get("type") or "").lower()
    geom = item.get("geometry") if isinstance(item.get("geometry"), dict) else {}
    try:
        width = float(geom.get("width") or 0.0)
        height = float(geom.get("height") or 0.0)
    except (TypeError, ValueError):
        width = height = 0.0
    if not isfinite(width) or not isfinite(height):
        width = height = 0.0

    supported_types = {
        "doc_format",
        "mindmap_node",
        "text",
        "shape",
        "sticky_note",
        "card",
        "preview",
        "app_card",
        "code",
        "image",
        "document",
        "embed",
        "table_text",
    }
    if item_type == "comment":
        width = max(width, float(COMMENT_NODE_WIDTH))
        html = _format_comment_html(item)
        height = max(
            height,
            float(COMMENT_NODE_MIN_HEIGHT),
            _estimate_render_height(
                html, width_px=width, font_px=14, line_height=1.35, padding=48
            ),
        )
    elif item_type in supported_types:
        width = width if width > 0 else 250.0
        if height <= 0 and item_type == "text":
            data = item.get("data") if isinstance(item.get("data"), dict) else {}
            content = str(data.get("content") or item.get("plain_text") or "")
            font_px = _extract_font_base_px(item, fallback=OBSIDIAN_FONT_SIZE)
            height = _estimate_render_height(
                content, width_px=width, font_px=int(font_px), line_height=1.35
            )
        height = height if height > 0 else 60.0
    if item_type == "embed" and width > 0:
        width, height = _link_card_16x9_size(width)
    elif width <= 0 or height <= 0:
        if _has_position(item) and item_type not in {
            "data_table_format",
            "table_text",
            "tag",
        }:
            width, height = _position_only_placeholder_size(item_type)
    return width, height


def _absolute_center(
    item: Dict[str, Any],
    by_id: Dict[str, Dict[str, Any]],
    stack: frozenset[str] = frozenset(),
) -> Optional[tuple[float, float]]:
    item_id = str(item.get("id") or "")
    if item_id and item_id in stack:
        return None
    pos = item.get("position") if isinstance(item.get("position"), dict) else {}
    try:
        x = float(pos.get("x") or 0.0)
        y = float(pos.get("y") or 0.0)
    except (TypeError, ValueError):
        return None
    if not isfinite(x) or not isfinite(y):
        return None

    width, height = _item_geometry(item)
    origin = str(pos.get("origin") or "center").lower()
    rel = str(pos.get("relativeTo") or "canvas_center").lower()
    parent = item.get("parent") if isinstance(item.get("parent"), dict) else {}
    parent_id = str(parent.get("id") or "")
    if rel == "canvas_center" or not parent_id:
        return (x, y) if origin == "center" else (x + width / 2.0, y + height / 2.0)

    parent_item = by_id.get(parent_id)
    if not parent_item or rel not in {"parent_top_left", "parent_center"}:
        return None
    parent_center = _absolute_center(parent_item, by_id, stack | {item_id})
    if parent_center is None:
        return None
    parent_width, parent_height = _item_geometry(parent_item)
    base_x, base_y = parent_center
    if rel == "parent_top_left":
        base_x -= parent_width / 2.0
        base_y -= parent_height / 2.0
    if origin == "center":
        return base_x + x, base_y + y
    return base_x + x + width / 2.0, base_y + y + height / 2.0


# ===== Базовая аналитика по доске =====
def analyze_board_from_items(items: Iterable[Dict[str, Any]]) -> Dict[str, float]:
    """
    Analyze only items that the converter can represent, in absolute coordinates.
    """
    items = list(items)
    by_id = {
        str(item.get("id")): item
        for item in items
        if isinstance(item, dict) and item.get("id") is not None
    }
    minx = miny = inf
    maxx = maxy = -inf
    mnw = mnh = inf
    font_min = font_max = None  # реальные кегли из доски (Miro px)

    for it in items:
        itype = (it.get("type") or "").lower()
        if not _is_scale_relevant(it):
            continue
        w, h = _item_geometry(it)
        if w <= 0 or h <= 0:
            continue
        center = _absolute_center(it, by_id)
        if center is None:
            continue
        cx, cy = center
        x0, y0 = cx - w / 2, cy - h / 2
        x1, y1 = cx + w / 2, cy + h / 2

        if x0 < minx:
            minx = x0
        if y0 < miny:
            miny = y0
        if x1 > maxx:
            maxx = x1
        if y1 > maxy:
            maxy = y1

        if w < mnw:
            mnw = w
        if h < mnh:
            mnh = h

        # Собираем диапазон кеглей по text/shape/sticky_note
        if itype in _FONT_TYPES:
            fp = (
                14.0
                if itype == "comment"
                else _extract_font_base_px(it, fallback=OBSIDIAN_FONT_SIZE)
            )
            if font_min is None or fp < font_min:
                font_min = fp
            if font_max is None or fp > font_max:
                font_max = fp

    if minx is inf:
        return {
            "bbox_w": 0.0,
            "bbox_h": 0.0,
            "mnw": 0.0,
            "mnh": 0.0,
            "font_min_miro": float(OBSIDIAN_FONT_SIZE),
            "font_max_miro": float(OBSIDIAN_FONT_SIZE),
        }

    bbox_w = max(1.0, maxx - minx)
    bbox_h = max(1.0, maxy - miny)
    if mnw is inf:
        mnw = 0.0
    if mnh is inf:
        mnh = 0.0
    if font_min is None:
        font_min = float(OBSIDIAN_FONT_SIZE)
    if font_max is None:
        font_max = float(OBSIDIAN_FONT_SIZE)

    return {
        "bbox_w": bbox_w,
        "bbox_h": bbox_h,
        "mnw": mnw,
        "mnh": mnh,
        "font_min_miro": font_min,
        "font_max_miro": font_max,
    }


def analyze_board(miro_root: Any) -> Dict[str, float]:
    return analyze_board_from_items(iter_objects(miro_root))


# ===== Расчёт масштабов =====
def compute_scale_fit(bbox_w: float, bbox_h: float, profile: ViewProfile) -> float:
    """
    Верхний предел масштаба, при котором bbox помещается в viewport на min_zoom.

    Для Obsidian zoom screen_px = canvas_px * min_zoom, поэтому:
    bbox * scale * min_zoom <= viewport.
    """
    if bbox_w <= 0 or bbox_h <= 0:
        return 1.0
    target_w = max(1.0, profile.width * profile.fit_margin)
    target_h = max(1.0, profile.height * profile.fit_margin)
    zoom = max(0.0001, profile.min_zoom)
    return min(target_w / (bbox_w * zoom), target_h / (bbox_h * zoom))


def _cap_to_fit(scale: float, fit_cap: float) -> float:
    if fit_cap <= 0:
        return scale
    return min(scale, fit_cap)


def normalize_scale_mode(mode: str | None) -> str:
    mode_value = (mode or "balanced").strip().lower()
    if mode_value not in SCALE_MODES:
        raise ValueError(
            f"Unknown scale mode: {mode!r}. Expected one of: {', '.join(sorted(SCALE_MODES))}"
        )
    return mode_value


def _select_scale_for_mode(
    readability_scale: float, fit_cap: float, profile: ViewProfile
) -> float:
    mode = normalize_scale_mode(profile.scale_mode)
    if mode == "overview":
        return fit_cap
    if mode == "readable":
        return readability_scale
    return _cap_to_fit(readability_scale, fit_cap)


def compute_scale_min_node(mnw: float, mnh: float, profile: ViewProfile) -> float:
    if mnw > 0 and mnh > 0:
        return max(profile.min_node_w / mnw, profile.min_node_h / mnh)
    return 0.0


def compute_scale_min_font(base_font_px: float, profile: ViewProfile) -> float:
    return profile.min_font_px / max(1, base_font_px)


def pick_recommended_scale(
    miro_root: Any, profile: ViewProfile, base_font_px: int
) -> Tuple[float, Dict[str, Any]]:
    """
    Возвращает (scale, ctx), где ctx — метрики для превью и дальнейших пересчётов.
    """
    _validate_profile(profile)
    a = analyze_board(miro_root)
    s_fit = compute_scale_fit(a["bbox_w"], a["bbox_h"], profile)
    s_node = compute_scale_min_node(a["mnw"], a["mnh"], profile)
    s_font = compute_scale_min_font(a["font_min_miro"], profile)
    s_readability = max(s_node, s_font)
    mode = normalize_scale_mode(profile.scale_mode)
    S = _select_scale_for_mode(s_readability, s_fit, profile)
    conflict = s_readability > s_fit
    ctx = {
        **a,
        "scale_mode": mode,
        "scale_fit": s_fit,
        "scale_min_node": s_node,
        "scale_min_font": s_font,
        "scale_readability": s_readability,
        "scale_conflict_fit_vs_readability": 1.0 if conflict else 0.0,
        "scale_limited_by_fit": 1.0 if S < s_readability else 0.0,
        "scale_exceeds_fit": 1.0 if S > s_fit else 0.0,
    }
    return S, ctx


# ===== Превью и взаимные пересчёты =====
def preview_values(
    scale: float, ctx: Dict[str, Any], base_font_px: int, min_font_threshold: int
) -> Dict[str, Any]:
    mnw = ctx.get("mnw", 0.0)
    mnh = ctx.get("mnh", 0.0)
    font_min_miro = ctx.get("font_min_miro", float(base_font_px))
    font_max_miro = ctx.get("font_max_miro", float(base_font_px))
    Wmin = int(round(mnw * scale)) if mnw > 0 else 0
    Hmin = int(round(mnh * scale)) if mnh > 0 else 0
    font_max_px = max(min_font_threshold, int(round(font_max_miro * scale)))
    font_min_px = max(min_font_threshold, int(round(font_min_miro * scale)))
    return {
        "scale": scale,
        "Wmin": Wmin,
        "Hmin": Hmin,
        "font_max_px": font_max_px,
        "font_min_px": font_min_px,
    }


def recompute_from_font_max(
    font_target: int, ctx: Dict[str, Any], profile: ViewProfile
) -> float:
    font_max_miro = max(1.0, ctx.get("font_max_miro", float(OBSIDIAN_FONT_SIZE)))
    s_font = font_target / font_max_miro
    s_node = compute_scale_min_node(ctx["mnw"], ctx["mnh"], profile)
    return _select_scale_for_mode(max(s_node, s_font), ctx["scale_fit"], profile)


def recompute_from_font_min(
    font_target: int, ctx: Dict[str, Any], profile: ViewProfile
) -> float:
    font_min_miro = max(1.0, ctx.get("font_min_miro", float(OBSIDIAN_FONT_SIZE)))
    s_font = font_target / font_min_miro
    s_node = compute_scale_min_node(ctx["mnw"], ctx["mnh"], profile)
    return _select_scale_for_mode(max(s_node, s_font), ctx["scale_fit"], profile)


def recompute_from_min_node_width(
    Wtarget: float, ctx: Dict[str, Any], profile: ViewProfile
) -> float:
    s_node = Wtarget / max(0.0001, ctx["mnw"])
    font_min_miro = max(1.0, ctx.get("font_min_miro", float(OBSIDIAN_FONT_SIZE)))
    s_font = profile.min_font_px / font_min_miro
    return _select_scale_for_mode(max(s_node, s_font), ctx["scale_fit"], profile)


def recompute_from_min_node_height(
    Htarget: float, ctx: Dict[str, Any], profile: ViewProfile
) -> float:
    s_node = Htarget / max(0.0001, ctx["mnh"])
    font_min_miro = max(1.0, ctx.get("font_min_miro", float(OBSIDIAN_FONT_SIZE)))
    s_font = profile.min_font_px / font_min_miro
    return _select_scale_for_mode(max(s_node, s_font), ctx["scale_fit"], profile)


# ===== Сервис для GUI (чтобы быстро получить превью из JSON-файла) =====
def compute_scale_preview(
    json_path: str, profile: ViewProfile, base_font_px: int
) -> Dict[str, Any]:
    import json

    def reject_constant(value: str) -> None:
        raise ValueError(f"Miro source contains non-JSON numeric constant: {value}")

    with open(json_path, "r", encoding="utf-8") as f:
        miro_root = json.load(f, parse_constant=reject_constant)
    scale, ctx = pick_recommended_scale(miro_root, profile, base_font_px)
    prev = preview_values(scale, ctx, base_font_px, profile.min_font_px)
    return {"scale": scale, "context": ctx, "preview": prev}
