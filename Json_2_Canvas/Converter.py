# converter.py
# -*- coding: utf-8 -*-
from __future__ import annotations

import json
import os
import re
import shutil
from html import escape as _html_escape, unescape as _html_unescape
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional
from urllib.parse import parse_qs, unquote, urlparse


# =========================
# Constants
# =========================

DECK_TYPES = {"slide_container"}
CONTAINER_TYPES = {"group", "frame", "diagram", "slide_container"}
FRAME_LIKE_TYPES = {"frame", "diagram"}  # строим как рамку
TEXT_STYLE_MODES = frozenset({"miro", "obsidian"})


OBSIDIAN_FONT_SIZE = 18  # px
FLOW_PREFIX = "flow_chart_"
SHORT_LABEL_RENDER_PADDING = 24
TEXT_VISUAL_CLEARANCE_PX = 16
MIN_TEXT_WIDTH_AFTER_CLEARANCE = 64
TEXT_TEXT_VERTICAL_OVERLAP_MIN_RATIO = 0.45
TEXT_TEXT_VERTICAL_MAX_PASSES = 8
TEXT_TEXT_HORIZONTAL_EDGE_MAX_RATIO = 0.15
TEXT_TEXT_HORIZONTAL_EDGE_MAX_PASSES = 16
TINY_TEXT_TEXT_VERTICAL_EDGE_MAX_OVERLAP_PX = 4
TINY_TEXT_TEXT_VERTICAL_EDGE_CLEARANCE_PX = 1
TINY_TEXT_TEXT_VERTICAL_EDGE_MAX_HEIGHT_PX = 48
TINY_TEXT_TEXT_VERTICAL_EDGE_MIN_HORIZONTAL_RATIO = 0.80
TINY_TEXT_TEXT_VERTICAL_EDGE_MAX_PASSES = 16
TINY_SLIDE_TEXT_MAX_FONT_PX = 7
TINY_SLIDE_TEXT_MAX_HEIGHT_PX = 48
TINY_SLIDE_TEXT_COMPACT_PADDING = 2
TINY_SLIDE_MARKER_TEXT_CLEARANCE_PX = 1
LINK_VISUAL_MAX_PASSES = 8
LINK_TEXT_EDGE_MAX_PASSES = 8
LINK_TEXT_EDGE_MAX_OVERLAP_PX = 8
SHORT_LABEL_VISUAL_MAX_PASSES = 32
TEXT_VISUAL_VERTICAL_MAX_PASSES = 32
TEXT_VISUAL_VERTICAL_MIN_RATIO = 0.25
TEXT_VISUAL_CASCADE_MAX_PASSES = 64
SLIDE_THUMBNAIL_MIN_FONT_PX = 1
SYNTHETIC_SLIDE_MANUAL_DEFAULT_MAX_SIDE = 1200.0
SYNTHETIC_SLIDE_DECK_TOP_ROW_COUNT = 4
SYNTHETIC_SLIDE_DECK_OVERLAP_CLEARANCE_PX = 24.0
SYNTHETIC_SLIDE_DECK_OVERLAP_TOLERANCE_PX = 1.0
SYNTHETIC_SLIDE_DECK_OVERLAP_MAX_PASSES = 16
SLIDE_THUMBNAIL_CONTENT_BOOST_EXPONENT = 0.75
SLIDE_THUMBNAIL_CONTENT_BOOST_MAX = 5.0
SLIDE_THUMBNAIL_CONTENT_BOOST_MAX_FIT = 0.25
SLIDE_THUMBNAIL_TEXT_BOOST_MAX = 4.0
SLIDE_THUMBNAIL_TEXT_BOOST_FONT_DIVISOR = 4.0
SLIDE_THUMBNAIL_MEDIUM_TEXT_BOOST = 1.5
SLIDE_THUMBNAIL_MEDIUM_TEXT_MIN_FONT_PX = 5.0
SLIDE_THUMBNAIL_LARGE_TEXT_MIN_FONT_PX = 8.0
SLIDE_CHILD_FIT_OVERFLOW_RATIO = 0.15
SLIDE_CHILD_FIT_OVERFLOW_MIN_PX = 24.0
SLIDE_CHILD_FIT_BBOX_RATIO = 1.5
SLIDE_CHILD_FIT_DENSE_MIN_CHILDREN = 3
SLIDE_CHILD_FIT_DENSE_BBOX_RATIO = 1.10
SHORT_LABEL_COMPACT_PADDING = 16
ULTRA_NARROW_LABEL_WIDTH_PX = 16
ULTRA_NARROW_LABEL_FALLBACK_WIDTHS = (176, 128, 96, 64, 32)
SOURCE_LIMITED_DROP_TYPES = {
    "dynamic_poll",
    "flip_card",
    "people",
    "prototyping_screen",
    "table",
    "widgets_stack",
}
SHORT_LABEL_SINGLE_LINE_PADDING = 64
SHORT_LABEL_SINGLE_LINE_AVG_CHAR_WIDTH = 0.50
SHORT_LABEL_WIDTH_MIN_GROW = 32
SHORT_LABEL_WIDTH_OVERLAP_TOLERANCE = 8
EMBED_LINK_MIN_WIDTH = 320
COMMENT_NODE_WIDTH = 300
COMMENT_NODE_MIN_HEIGHT = 96
COMMENT_NODE_OFFSET_X = 64

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
    "comments", "comment",
]

VALID_SIDES = {"left", "right", "top", "bottom"}

# =========================
# Compiled regexes (module-level; reuse everywhere)
# =========================

HTML_TAG_RE = re.compile(r"<[^>]+>")
HAS_TAG_RE = re.compile(r"<[a-zA-Z/][^>]*>")
P_CLOSE_RE = re.compile(r"</p\s*>", re.I)
P_BLOCK_RE = re.compile(r"<p\b[^>]*>(.*?)</p\s*>", re.I | re.S)
EDGE_EMPTY_P_RE = re.compile(r"^\s*(?:<p\b[^>]*>\s*(?:<br\s*/?>|&nbsp;|\s)*</p\s*>\s*)+", re.I)
TRAILING_EMPTY_P_RE = re.compile(r"(?:\s*<p\b[^>]*>\s*(?:<br\s*/?>|&nbsp;|\s)*</p\s*>\s*)+\s*$", re.I)
BR_RE = re.compile(r"<br\s*/?>", re.I)
LI_RE = re.compile(r"<li\b", re.I)
LI_BLOCK_RE = re.compile(r"<li\b[^>]*>(.*?)</li\s*>", re.I | re.S)
A_HREF_RE = re.compile(r"<a\b[^>]*\bhref\s*=\s*[\"']([^\"']+)[\"'][^>]*>(.*?)</a\s*>", re.I | re.S)
STRONG_RE = re.compile(r"<(?:strong|b)\b[^>]*>(.*?)</(?:strong|b)\s*>", re.I | re.S)
EM_RE = re.compile(r"<(?:em|i)\b[^>]*>(.*?)</(?:em|i)\s*>", re.I | re.S)
OPEN_P_RE = re.compile(r"<p\b[^>]*>", re.I)
P_TAG_RE = re.compile(r"</?p\b[^>]*>", re.I)
SIMPLE_HTML_TAG_RE = re.compile(r"</?\s*([a-zA-Z0-9:-]+)\b[^>]*>")
RICH_HTML_TAG_RE = re.compile(r"<(?:table|thead|tbody|tr|td|th|iframe|img|svg|canvas|video|pre|code)\b", re.I)
VISUAL_STYLE_RE = re.compile(r"\bstyle\s*=\s*[\"'][^\"']*(?:background|color|font-size)[^\"']*[\"']", re.I)
PCT_RE = re.compile(r"^\s*([+-]?\d+(?:\.\d+)?)\s*%\s*$")
COLOR_PROP_RE   = re.compile(r"(color\s*:\s*)(#[0-9a-fA-F]{3,8}|rgb\s*\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*\))", re.I)
SPAN_BGCOLOR_RE = re.compile(r"<span\b[^>]*background-color\s*:", re.I)  # span с background-color
FONT_SIZE_STYLE_RE = re.compile(r"(font-size\s*:\s*)\d+(?:\.\d+)?px", re.I)
LINE_HEIGHT_STYLE_RE = re.compile(r"line-height\s*:\s*([0-9]+(?:\.[0-9]+)?)", re.I)
# Матчит открывающий тег span или strong с атрибутом style
_HIGHLIGHT_TAG_RE = re.compile(
    r'(<(?:span|strong)\b[^>]*\bstyle\s*=\s*"([^"]*)"[^>]*>)',
    re.I,
)

# Детектор: текстовый блок содержит ТОЛЬКО одну URL-ссылку, без другого текста.
# Матчит href из <a href="..."> или голую http(s)/ftp URL.
_SOLO_LINK_RE = re.compile(
    r'^https?://\S+$|^ftp://\S+$',
    re.I,
)
_SOLO_A_HREF_RE = re.compile(
    r'^\s*(?:<p[^>]*>\s*)?<a\b[^>]*\bhref\s*=\s*["\']([^"\']+)["\'][^>]*>.*?</a>\s*(?:</p>\s*)?$',
    re.I | re.S,
)


def _extract_iframe_size(html: str) -> tuple[int, int] | None:
    """
    Парсит первый <iframe> в HTML и возвращает (width, height) в пикселях.
    Возвращает None если iframe не найден или размеры не читаются.
    """
    if not html:
        return None
    w_m = re.search(r'<iframe\b[^>]*\bwidth=["\']?(\d+)', html, re.I)
    h_m = re.search(r'<iframe\b[^>]*\bheight=["\']?(\d+)', html, re.I)
    if w_m and h_m:
        return int(w_m.group(1)), int(h_m.group(1))
    return None


def _normalize_external_url(value: str) -> str | None:
    url = _html_unescape(str(value or "")).strip()
    if not url:
        return None
    url = unquote(url)
    if url.startswith("//"):
        url = "https:" + url
    if url.startswith(("http://", "https://")):
        return url
    return None


def _recover_embed_url(data: Dict[str, Any]) -> str | None:
    direct_url = _normalize_external_url(str((data or {}).get("url") or ""))
    if direct_url:
        return direct_url

    html_value = _html_unescape(str((data or {}).get("html") or ""))
    if not html_value:
        return None

    candidates = [
        match.group(1)
        for match in re.finditer(r'\b(?:src|href)\s*=\s*["\']([^"\']+)["\']', html_value, re.I)
    ]
    candidates.extend(
        match.group(0)
        for match in re.finditer(r"https?://[^\s\"'<>]+|//[^\s\"'<>]+", html_value, re.I)
    )

    for candidate in candidates:
        url = _normalize_external_url(candidate)
        if not url:
            continue
        parsed = urlparse(url)
        query = parse_qs(parsed.query)
        for key in ("url", "href", "u"):
            for value in query.get(key, []):
                recovered = _normalize_external_url(value)
                if recovered:
                    return recovered
        if "embedly.com" not in parsed.netloc.lower():
            return url

    return None


def _extract_solo_url(html_or_plain: str) -> str | None:
    """
    Если блок содержит ровно одну ссылку и ничего кроме неё — возвращает URL.
    Иначе None.
    Принимает как HTML (<p><a href="...">...</a></p>), так и plain text.
    """
    text = html_or_plain.strip()
    if not text:
        return None
    # Голая URL-строка (plain text)
    if _SOLO_LINK_RE.match(text):
        return text
    # HTML: считаем число тегов <a ...>
    a_tags = re.findall(r'<a\b', text, re.I)
    if len(a_tags) != 1:
        return None
    # HTML с единственным <a href>: точный матч — только тег внутри <p>
    m = _SOLO_A_HREF_RE.match(text)
    if m:
        return m.group(1).strip()
    # Нестандартное обрамление: проверяем, что после удаления тегов
    # не осталось постороннего текста
    href_m = re.search(r'<a\b[^>]*\bhref\s*=\s*["\']([^"\']+)["\']', text, re.I)
    if not href_m:
        return None
    stripped = re.sub(r'<[^>]+>', '', text).strip()
    if not stripped or stripped == href_m.group(1).strip():
        return href_m.group(1).strip()
    return None


def _plain_field_text(value: Any) -> str:
    """Best-effort compact text rendering for app_card field values."""
    if value is None:
        return ""
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return str(value)
    if isinstance(value, str):
        return _html_unescape(HTML_TAG_RE.sub("", value)).strip()
    if isinstance(value, list):
        parts = [_plain_field_text(v) for v in value]
        return ", ".join(p for p in parts if p)
    if isinstance(value, dict):
        for key in ("displayValue", "display_value", "text", "title", "name", "value", "url"):
            if key in value:
                text = _plain_field_text(value.get(key))
                if text:
                    return text

        parts = []
        for key, sub_value in value.items():
            text = _plain_field_text(sub_value)
            if text:
                parts.append(f"{key}: {text}")
        return "; ".join(parts)
    return str(value).strip()


def _format_app_card_fields(fields: Any) -> List[str]:
    """Returns HTML paragraphs for meaningful Miro app_card data.fields entries."""
    if not isinstance(fields, list):
        return []

    rendered: List[str] = []
    label_keys = ("label", "name", "title", "key", "type")
    value_keys = ("value", "displayValue", "display_value", "text", "content")

    for field in fields:
        if isinstance(field, dict):
            label = ""
            for key in label_keys:
                candidate = _plain_field_text(field.get(key))
                if candidate:
                    label = candidate
                    break

            value = ""
            for key in value_keys:
                if key in field:
                    candidate = _plain_field_text(field.get(key))
                    if candidate:
                        value = candidate
                        break

            if not value:
                rest = {
                    k: v for k, v in field.items()
                    if k not in set(label_keys) and k not in set(value_keys)
                }
                value = _plain_field_text(rest)

            if label and value:
                rendered.append(
                    f"<p><strong>{_html_escape(label, False)}:</strong> "
                    f"{_html_escape(value, False)}</p>"
                )
            elif value:
                rendered.append(f"<p>{_html_escape(value, False)}</p>")
        else:
            value = _plain_field_text(field)
            if value:
                rendered.append(f"<p>{_html_escape(value, False)}</p>")

    return rendered


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

def _contrast_color(r: int, g: int, b: int) -> str:
    """Возвращает '#000000' или '#ffffff' — контрастный цвет по W3C relative luminance."""
    def _lin(c: int) -> float:
        s = c / 255.0
        return s / 12.92 if s <= 0.04045 else ((s + 0.055) / 1.055) ** 2.4
    lum = 0.2126 * _lin(r) + 0.7152 * _lin(g) + 0.0722 * _lin(b)
    return "#000000" if lum > 0.179 else "#ffffff"


def _inject_contrast_color_on_bgcolor_spans(html: str) -> str:
    """
    Для каждого <span> и <strong> с background-color в style, но без color —
    дописывает контрастный color в атрибут style.
    Срабатывает только при наличии background-color (highlight/маркер).
    """
    _RGB_RE = re.compile(r"background-color\s*:\s*rgb\s*\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)", re.I)
    _HEX_RE = re.compile(r"background-color\s*:\s*(#[0-9a-fA-F]{3,8})", re.I)
    _HAS_COLOR_RE = re.compile(r"(?<![a-z-])color\s*:", re.I)  # есть color (не background-color)

    def _repl(m: re.Match) -> str:
        full_tag, style_val = m.group(1), m.group(2)
        # Только если есть background-color
        has_bg = bool(_RGB_RE.search(style_val) or _HEX_RE.search(style_val))
        if not has_bg:
            return full_tag
        # Уже есть color — не трогаем
        if _HAS_COLOR_RE.search(style_val):
            return full_tag
        # Определяем контрастный цвет
        rgb_m = _RGB_RE.search(style_val)
        if rgb_m:
            r, g, b = int(rgb_m.group(1)), int(rgb_m.group(2)), int(rgb_m.group(3))
        else:
            hex_m = _HEX_RE.search(style_val)
            if not hex_m:
                return full_tag
            h = _norm_hex(hex_m.group(1))
            try:
                r = int(h[1:3], 16); g = int(h[3:5], 16); b = int(h[5:7], 16)
            except Exception:
                return full_tag
        contrast = _contrast_color(r, g, b)
        # Вставляем color в конец style="..."
        new_style = style_val.rstrip(";") + f"; color:{contrast}"
        return full_tag.replace(f'style="{style_val}"', f'style="{new_style}"', 1)

    return _HIGHLIGHT_TAG_RE.sub(_repl, html)


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


def normalize_text_style_mode(mode: str | None) -> str:
    mode_value = (mode or "miro").strip().lower()
    if mode_value not in TEXT_STYLE_MODES:
        raise ValueError(
            f"Unknown text style mode: {mode!r}. Expected one of: {', '.join(sorted(TEXT_STYLE_MODES))}"
        )
    return mode_value


def _html_to_markdown_fragment(html: str) -> str:
    text = _strip_edge_empty_paragraphs(html or "")

    def clean_inline(value: str) -> str:
        value = BR_RE.sub("\n", value or "")
        value = HTML_TAG_RE.sub("", value)
        return _html_unescape(value).replace("\xa0", " ").strip()

    text = A_HREF_RE.sub(
        lambda m: f"[{clean_inline(m.group(2))}]({_html_unescape(m.group(1)).strip()})",
        text,
    )
    text = STRONG_RE.sub(lambda m: f"**{clean_inline(m.group(1))}**", text)
    text = EM_RE.sub(lambda m: f"*{clean_inline(m.group(1))}*", text)
    text = LI_BLOCK_RE.sub(lambda m: "\n- " + clean_inline(m.group(1)), text)
    text = BR_RE.sub("\n", text)
    text = OPEN_P_RE.sub("", text)
    text = P_CLOSE_RE.sub("\n\n", text)
    text = re.sub(r"</?(?:ul|ol)\b[^>]*>", "\n", text, flags=re.I)
    text = HTML_TAG_RE.sub("", text)
    text = _html_unescape(text).replace("\xa0", " ")
    text = re.sub(r"[ \t]+\n", "\n", text)
    text = re.sub(r"\n[ \t]+", "\n", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def _should_keep_html_for_obsidian_style(html: str, wrapper_extra_color: Optional[str] = None) -> bool:
    if wrapper_extra_color:
        return True
    if RICH_HTML_TAG_RE.search(html or ""):
        return True
    if VISUAL_STYLE_RE.search(html or "") or SPAN_BGCOLOR_RE.search(html or ""):
        return True

    allowed = {"p", "br", "strong", "b", "em", "i", "ul", "ol", "li", "a"}
    for match in SIMPLE_HTML_TAG_RE.finditer(html or ""):
        if match.group(1).lower() not in allowed:
            return True
    return False


def _render_canvas_text(
    content: Any,
    *,
    font_px: int,
    line_height: float = 1.35,
    text_style_mode: str = "miro",
    wrapper_extra_color: Optional[str] = None,
) -> str:
    text = str(content or "")
    mode = normalize_text_style_mode(text_style_mode)
    is_html = _is_html(text)

    if mode == "obsidian":
        if is_html:
            if _should_keep_html_for_obsidian_style(text, wrapper_extra_color):
                if wrapper_extra_color:
                    return f'<div style="color:{wrapper_extra_color}">{text}</div>'
                return text
            return _html_to_markdown_fragment(text)

        if wrapper_extra_color:
            safe = _html_escape(text, quote=False).replace("\n", "<br>")
            return f'<span style="color:{wrapper_extra_color}">{safe}</span>'
        return text

    style_bits = [f"font-size:{font_px}px", f"line-height:{line_height}"]
    if wrapper_extra_color:
        style_bits.append(f"color:{wrapper_extra_color}")
    style_attr = "; ".join(style_bits)
    if is_html:
        return f'<div style="{style_attr}">{text}</div>'

    safe = _html_escape(text, quote=False).replace("\n", "<br>")
    return f'<span style="{style_attr}">{safe}</span>'


def _strip_edge_empty_paragraphs(html_or_text: str) -> str:
    if not _is_html(html_or_text):
        return html_or_text or ""
    stripped = EDGE_EMPTY_P_RE.sub("", html_or_text or "")
    stripped = TRAILING_EMPTY_P_RE.sub("", stripped)
    return stripped or html_or_text or ""


def _empty_html_fragment(fragment: str) -> bool:
    without_breaks = BR_RE.sub("", fragment or "")
    plain = _html_unescape(HTML_TAG_RE.sub("", without_breaks)).replace("\xa0", " ").strip()
    return not plain


def _non_empty_paragraph_count(html_or_text: str) -> int:
    if not _is_html(html_or_text):
        return 1 if strip_html(html_or_text).strip() else 0
    paragraphs = P_BLOCK_RE.findall(html_or_text or "")
    if not paragraphs:
        return 1 if strip_html(html_or_text).strip() else 0
    return sum(1 for paragraph in paragraphs if not _empty_html_fragment(paragraph))


def _is_short_text_label(html_or_text: str) -> bool:
    if not html_or_text:
        return False
    if LI_RE.search(html_or_text) or re.search(r"<(?:ol|ul|table)\b", html_or_text, re.I):
        return False
    plain = _html_unescape(strip_html(html_or_text)).replace("\xa0", " ").strip()
    if not plain or len(plain) > 120:
        return False
    return _non_empty_paragraph_count(html_or_text) <= 2


def _compact_short_label_html(html_or_text: str) -> str:
    if not _is_html(html_or_text):
        return html_or_text or ""
    paragraphs = P_BLOCK_RE.findall(html_or_text or "")
    if not paragraphs:
        return html_or_text or ""
    visible = [fragment.strip() for fragment in paragraphs if not _empty_html_fragment(fragment)]
    if not visible:
        return html_or_text or ""
    return "<br>".join(visible)


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


def resolve_image_file_name(item: Dict[str, Any], fallback_id: str) -> str:
    data = item.get("data", {}) or {}
    name = item.get("local_name") or os.path.basename(data.get("title") or "")
    if not name:
        name = f"file_{fallback_id}.png"
    if not Path(name).suffix:
        name = f"{name}.png"
    return name


def compact_attachment_name(local_name: str, fallback_id: str, prefix: str) -> str:
    suffix = Path(local_name or "").suffix or ".bin"
    clean_id = re.sub(r"[^0-9A-Za-z_-]+", "", str(fallback_id)) or "file"
    short_id = clean_id[-10:]
    return f"{prefix}_{short_id}{suffix.lower()}"


def prepare_compact_attachment_reference(
    files_folder: str,
    local_name: str,
    fallback_id: str,
    prefix: str,
) -> str:
    compact_name = compact_attachment_name(local_name, fallback_id, prefix)
    if not local_name or local_name == compact_name:
        return compact_name

    src = os.path.join(files_folder, local_name)
    dst = os.path.join(files_folder, compact_name)
    if os.path.exists(src) and not os.path.exists(dst):
        shutil.copy2(src, dst)
    return compact_name


def _attachment_file_exists(files_folder: str, local_name: str) -> bool:
    if not local_name:
        return False
    return os.path.isfile(os.path.join(files_folder, local_name))


def _recover_attachment_url(item: Dict[str, Any], *data_keys: str) -> str | None:
    data = item.get("data") if isinstance(item.get("data"), dict) else {}
    for key in data_keys:
        url = _normalize_external_url(str(data.get(key) or ""))
        if url:
            return url

    links = item.get("links") if isinstance(item.get("links"), dict) else {}
    for key in ("web", "self"):
        url = _normalize_external_url(str(links.get(key) or ""))
        if url:
            return url
    return None

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

def _mindmap_node_view(item: Dict[str, Any]) -> Dict[str, Any]:
    data = item.get("data") if isinstance(item.get("data"), dict) else {}
    for value in (data.get("nodeView"), item.get("nodeView")):
        if isinstance(value, dict):
            return value
    return {}

def _extract_mindmap_node_content(item: Dict[str, Any]) -> str:
    data = item.get("data") if isinstance(item.get("data"), dict) else {}
    node_view = _mindmap_node_view(item)
    node_view_data = node_view.get("data") if isinstance(node_view.get("data"), dict) else {}

    for value in (
        node_view_data.get("content"),
        node_view.get("content"),
        data.get("content"),
        data.get("title"),
        item.get("plain_text"),
        item.get("title"),
    ):
        if value:
            return _strip_edge_empty_paragraphs(str(value))
    return ""

def _extract_mindmap_node_style(item: Dict[str, Any]) -> Dict[str, Any]:
    data = item.get("data") if isinstance(item.get("data"), dict) else {}
    style: Dict[str, Any] = {}
    for source in (item.get("style"), data.get("style"), _mindmap_node_view(item).get("style")):
        if isinstance(source, dict):
            style.update(source)
    return style

def _extract_mindmap_node_shape(style: Dict[str, Any]) -> Optional[str]:
    shape = str(style.get("shape") or "").strip().lower()
    if not shape or shape == "none":
        return None
    return pick_canvas_shape(shape)

def _extract_mindmap_node_bg(style: Dict[str, Any]) -> Optional[str]:
    fill = style.get("fillColor") or style.get("backgroundColor")
    if not fill and str(style.get("shape") or "").strip().lower() not in {"", "none"}:
        fill = style.get("nodeColor")
    try:
        fill_opacity = float(style.get("fillOpacity") if style.get("fillOpacity") is not None else 1.0)
    except Exception:
        fill_opacity = 1.0
    return str(fill) if fill and fill_opacity > 0.0 else None

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

    base_lines = max(1, paras, lis) + brs + nls
    wrap_extra = max(0, (len(plain) - 1) // max(1, max_cols))
    total_lines = base_lines + wrap_extra
    return int(total_lines * line_height * font_px + padding)

# --- Sticky helpers ---

STICKY_TEXT_PADDING = 30      # максимальные внутренние отступы sticky-ноды (px)
STICKY_PAD_MAX_RATIO = 0.15  # отступ не более 15% от стороны бокса

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


def _fit_font_px(
    html_or_text: str,
    box_w: float,
    box_h: float,
    *,
    target_px: int,
    min_font_px: int,
    line_height: float,
) -> tuple[int, bool]:
    """
    Подбирает кегль для ноды по правилу «из Miro, только уменьшаем»:

      1. Пробуем target_px — если текст вписывается, возвращаем его.
      2. Не вписывается → уменьшаем до min_font_px (бинарный поиск вниз).
      3. Даже при min_font_px не вписывается → возвращаем min_font_px
         и флаг needs_grow=True (нода должна быть увеличена).

    box_w/box_h — доступная область (avail) уже с учётом padding снаружи.
    Возвращает (font_px, needs_grow).
    """
    def fits(px: int) -> bool:
        need = _estimate_render_height(html_or_text, width_px=max(1.0, box_w),
                                       font_px=px, line_height=line_height)
        return need <= box_h

    # Шаг 1: target вписывается?
    if fits(target_px):
        return target_px, False

    # Шаг 2: бинарный поиск в [min_font_px, target_px - 1]
    if target_px > min_font_px:
        lo, hi = min_font_px, target_px - 1
        best = min_font_px
        while lo <= hi:
            mid = (lo + hi) // 2
            if fits(mid):
                best = mid
                lo = mid + 1
            else:
                hi = mid - 1
        if best >= min_font_px and fits(best):
            return best, False

    # Шаг 3: даже min_font_px не влезает
    return min_font_px, True


def _node_rect(node: Dict[str, Any]) -> Optional[tuple[float, float, float, float]]:
    try:
        x = float(node["x"])
        y = float(node["y"])
        w = float(node["width"])
        h = float(node["height"])
    except Exception:
        return None
    if w <= 0 or h <= 0:
        return None
    return x, y, x + w, y + h


def _rect_overlap(a: tuple[float, float, float, float], b: tuple[float, float, float, float]) -> tuple[float, float]:
    overlap_w = min(a[2], b[2]) - max(a[0], b[0])
    overlap_h = min(a[3], b[3]) - max(a[1], b[1])
    return overlap_w, overlap_h


def _is_clearance_text_node(node: Dict[str, Any]) -> bool:
    if node.get("type") != "text":
        return False
    if not isinstance(node.get("text"), str) or not node.get("text"):
        return False
    if node.get("color"):
        return False
    sa = node.get("styleAttributes") or {}
    return sa.get("border") in (None, "invisible")


def _is_visual_neighbor_node(node: Dict[str, Any]) -> bool:
    return node.get("type") in ("file", "link")


def _is_short_clearance_label_node(node: Dict[str, Any]) -> bool:
    if not _is_clearance_text_node(node):
        return False
    text = node.get("text")
    if not isinstance(text, str):
        return False
    if re.search(r"<(?:ol|ul|table|li)\b", text, re.I):
        return False
    plain = _html_unescape(strip_html(text)).replace("\xa0", " ").strip()
    return bool(plain) and len(plain) <= 80 and "\n" not in plain


def _line_height_from_canvas_text(text: str, default: float = 1.35) -> float:
    m = LINE_HEIGHT_STYLE_RE.search(text or "")
    if not m:
        return default
    try:
        value = float(m.group(1))
    except Exception:
        return default
    return value if value > 0 else default


def _set_canvas_text_font_px(node: Dict[str, Any], font_px: int) -> None:
    node.setdefault("styleAttributes", {})["fontSize"] = font_px
    text = node.get("text")
    if isinstance(text, str):
        updated = FONT_SIZE_STYLE_RE.sub(
            lambda m: f"{m.group(1)}{font_px}px",
            text,
            count=1,
        )
        node["text"] = updated


def _refit_text_node_after_width_change(node: Dict[str, Any], *, min_font_px: int) -> None:
    text = node.get("text")
    if not isinstance(text, str) or not text:
        return

    sa = node.get("styleAttributes") or {}
    try:
        target_px = int(round(float(sa.get("fontSize") or min_font_px)))
        width = float(node["width"])
        height = float(node["height"])
    except Exception:
        return

    line_height = _line_height_from_canvas_text(text)
    font_px, _needs_grow = _fit_font_px(
        text,
        width,
        height,
        target_px=target_px,
        min_font_px=min_font_px,
        line_height=line_height,
    )
    if font_px != target_px:
        _set_canvas_text_font_px(node, font_px)


def _estimate_short_label_single_line_width(html_or_text: str, font_px: int) -> int:
    plain = _html_unescape(strip_html(html_or_text or "")).replace("\xa0", " ")
    plain = re.sub(r"\s+", " ", plain).strip()
    if not plain:
        return SHORT_LABEL_SINGLE_LINE_PADDING
    return int(round(len(plain) * font_px * SHORT_LABEL_SINGLE_LINE_AVG_CHAR_WIDTH + SHORT_LABEL_SINGLE_LINE_PADDING))


def _link_card_16x9_size(width_px: float) -> tuple[float, int]:
    width = max(float(width_px), float(EMBED_LINK_MIN_WIDTH))
    return width, round(width * 9 / 16)


def _candidate_rect_overlaps_any_node(
    nodes: List[Dict[str, Any]],
    candidate_rect: tuple[float, float, float, float],
    *,
    skip_id: str,
    overlap_tolerance_px: float = SHORT_LABEL_WIDTH_OVERLAP_TOLERANCE,
) -> bool:
    for node in nodes:
        if str(node.get("id", "")) == skip_id:
            continue
        if node.get("type") not in ("text", "file", "link"):
            continue
        rect = _node_rect(node)
        if not rect:
            continue
        overlap_w, overlap_h = _rect_overlap(candidate_rect, rect)
        if overlap_w > overlap_tolerance_px and overlap_h > overlap_tolerance_px:
            return True
    return False


def _move_node_down_with_cascade(
    nodes: List[Dict[str, Any]],
    moved_node: Dict[str, Any],
    new_y: float,
    *,
    clearance_px: int = TEXT_VISUAL_CLEARANCE_PX,
    max_passes: int = TEXT_VISUAL_CASCADE_MAX_PASSES,
) -> bool:
    try:
        current_y = float(moved_node.get("y", 0) or 0)
    except Exception:
        return False
    if new_y <= current_y:
        return False

    moved_node["y"] = new_y
    moved_ids = {str(moved_node.get("id", ""))}

    for _ in range(max_passes):
        changed = False
        moved_rects = [
            (str(node.get("id", "")), _node_rect(node))
            for node in nodes
            if str(node.get("id", "")) in moved_ids
        ]

        for node in nodes:
            node_id = str(node.get("id", ""))
            if node_id in moved_ids:
                continue
            if node.get("type") not in ("text", "file", "link"):
                continue
            rect = _node_rect(node)
            if not rect:
                continue

            required_y: float | None = None
            for _moved_id, moved_rect in moved_rects:
                if not moved_rect:
                    continue
                overlap_w, overlap_h = _rect_overlap(rect, moved_rect)
                if overlap_w <= 1.0 or overlap_h <= 1.0:
                    continue
                candidate_y = moved_rect[3] + clearance_px
                if required_y is None or candidate_y > required_y:
                    required_y = candidate_y

            if required_y is None or rect[1] >= required_y:
                continue
            node["y"] = required_y
            moved_ids.add(node_id)
            changed = True

        if not changed:
            return True

    return True


def _expand_short_inline_label_widths(
    nodes: List[Dict[str, Any]],
) -> None:
    for label_node in nodes:
        if not _is_short_clearance_label_node(label_node):
            continue

        text = str(label_node.get("text") or "")
        plain = _html_unescape(strip_html(text)).replace("\xa0", " ")
        plain = re.sub(r"\s+", " ", plain).strip()
        if not plain:
            continue

        sa = label_node.get("styleAttributes") or {}
        font_px = int(round(float(sa.get("fontSize") or OBSIDIAN_FONT_SIZE)))
        need_w = _estimate_short_label_single_line_width(text, font_px)
        label_rect = _node_rect(label_node)
        if not label_rect:
            continue

        lx0, ly0, lx1, ly1 = label_rect
        current_w = lx1 - lx0
        if need_w <= current_w:
            continue
        need_w = max(need_w, int(round(current_w + SHORT_LABEL_WIDTH_MIN_GROW)))

        text_align = str(sa.get("textAlign") or "center").lower()
        if text_align == "left":
            new_x = lx0
        elif text_align == "right":
            new_x = lx1 - need_w
        else:
            new_x = ((lx0 + lx1) / 2.0) - need_w / 2.0

        candidate_rect = (new_x, ly0, new_x + need_w, ly1)
        if _candidate_rect_overlaps_any_node(nodes, candidate_rect, skip_id=str(label_node.get("id", ""))):
            continue

        label_node["x"] = new_x
        label_node["width"] = need_w


def _compact_short_inline_label_heights(
    nodes: List[Dict[str, Any]],
) -> None:
    visuals = [n for n in nodes if _is_visual_neighbor_node(n)]
    if not visuals:
        return

    for label_node in nodes:
        if not _is_short_clearance_label_node(label_node):
            continue

        text = str(label_node.get("text") or "")
        if not text:
            continue

        sa = label_node.get("styleAttributes") or {}
        try:
            font_px = int(round(float(sa.get("fontSize") or OBSIDIAN_FONT_SIZE)))
            width = float(label_node["width"])
            current_h = float(label_node["height"])
        except Exception:
            continue

        label_rect = _node_rect(label_node)
        if not label_rect:
            continue
        if not any(
            _rect_overlap(label_rect, visual_rect)[0] > 0 and _rect_overlap(label_rect, visual_rect)[1] > 0
            for visual in visuals
            for visual_rect in [_node_rect(visual)]
            if visual_rect
        ):
            continue

        line_height = _line_height_from_canvas_text(text)
        need_h = _estimate_render_height(
            text,
            width_px=width,
            font_px=font_px,
            line_height=line_height,
            padding=SHORT_LABEL_COMPACT_PADDING,
        )
        if 0 < need_h < current_h:
            label_node["height"] = need_h


def _resolve_ultra_narrow_label_visual_overlaps(
    nodes: List[Dict[str, Any]],
    *,
    clearance_px: int = TEXT_VISUAL_CLEARANCE_PX,
) -> None:
    visuals = [n for n in nodes if _is_visual_neighbor_node(n)]
    if not visuals:
        return

    for label_node in nodes:
        if not _is_short_clearance_label_node(label_node):
            continue

        label_rect = _node_rect(label_node)
        if not label_rect:
            continue
        lx0, ly0, lx1, ly1 = label_rect
        current_w = lx1 - lx0
        current_h = ly1 - ly0
        if current_w > ULTRA_NARROW_LABEL_WIDTH_PX:
            continue

        text = str(label_node.get("text") or "")
        sa = label_node.get("styleAttributes") or {}
        try:
            font_px = int(round(float(sa.get("fontSize") or OBSIDIAN_FONT_SIZE)))
        except Exception:
            font_px = OBSIDIAN_FONT_SIZE
        line_height = _line_height_from_canvas_text(text)
        need_w = _estimate_short_label_single_line_width(text, font_px)
        widths = sorted(
            {
                float(max(current_w, min(need_w, width)))
                for width in (need_w, *ULTRA_NARROW_LABEL_FALLBACK_WIDTHS, current_w)
            },
            reverse=True,
        )

        for visual_node in visuals:
            visual_rect = _node_rect(visual_node)
            if not visual_rect:
                continue
            overlap_w, overlap_h = _rect_overlap(label_rect, visual_rect)
            if overlap_w <= 0 or overlap_h <= 0:
                continue

            vx0, vy0, vx1, vy1 = visual_rect
            candidates: list[tuple[float, float, float, float, float]] = []
            for width in widths:
                height = min(
                    current_h,
                    float(
                        _estimate_render_height(
                            text,
                            width_px=width,
                            font_px=font_px,
                            line_height=line_height,
                            padding=SHORT_LABEL_COMPACT_PADDING,
                        )
                    ),
                )
                positions = [
                    (vx0, vy1 + clearance_px),
                    (lx0, vy1 + clearance_px),
                    ((vx0 + vx1) / 2.0 - width / 2.0, vy1 + clearance_px),
                    (vx0, vy0 - clearance_px - height),
                    (lx0, vy0 - clearance_px - height),
                    ((vx0 + vx1) / 2.0 - width / 2.0, vy0 - clearance_px - height),
                    (vx1 + clearance_px, ly0),
                    (vx0 - clearance_px - width, ly0),
                ]
                for new_x, new_y in positions:
                    distance = abs(new_x - lx0) + abs(new_y - ly0)
                    candidates.append((width, distance, new_x, new_y, height))

            for width, _distance, new_x, new_y, height in sorted(candidates, key=lambda c: (-c[0], c[1])):
                candidate_rect = (new_x, new_y, new_x + width, new_y + height)
                if _candidate_rect_overlaps_any_node(
                    nodes,
                    candidate_rect,
                    skip_id=str(label_node.get("id", "")),
                    overlap_tolerance_px=1.0,
                ):
                    continue
                label_node["x"] = new_x
                label_node["y"] = new_y
                label_node["width"] = width
                label_node["height"] = height
                break

            label_rect = _node_rect(label_node)
            if not label_rect:
                break


def _resolve_text_visual_horizontal_overlaps(
    nodes: List[Dict[str, Any]],
    *,
    min_font_px: int,
    clearance_px: int = TEXT_VISUAL_CLEARANCE_PX,
) -> None:
    visuals = [n for n in nodes if _is_visual_neighbor_node(n)]
    if not visuals:
        return

    for text_node in nodes:
        if not _is_clearance_text_node(text_node):
            continue

        changed = False
        for visual_node in visuals:
            text_rect = _node_rect(text_node)
            visual_rect = _node_rect(visual_node)
            if not text_rect or not visual_rect:
                continue

            overlap_w, overlap_h = _rect_overlap(text_rect, visual_rect)
            if overlap_w <= 0 or overlap_h <= 0:
                continue

            tx0, _ty0, tx1, _ty1 = text_rect
            vx0, _vy0, vx1, _vy1 = visual_rect
            text_center_x = (tx0 + tx1) / 2.0
            visual_center_x = (vx0 + vx1) / 2.0

            if text_center_x <= visual_center_x and tx0 < vx0:
                new_width = (vx0 - clearance_px) - tx0
                if MIN_TEXT_WIDTH_AFTER_CLEARANCE <= new_width < (tx1 - tx0):
                    text_node["width"] = new_width
                    changed = True
            elif text_center_x > visual_center_x and tx1 > vx1:
                new_left = vx1 + clearance_px
                new_width = tx1 - new_left
                if MIN_TEXT_WIDTH_AFTER_CLEARANCE <= new_width < (tx1 - tx0):
                    text_node["x"] = new_left
                    text_node["width"] = new_width
                    changed = True

        if changed:
            _refit_text_node_after_width_change(text_node, min_font_px=min_font_px)


def _resolve_short_label_visual_vertical_overlaps(
    nodes: List[Dict[str, Any]],
    *,
    clearance_px: int = TEXT_VISUAL_CLEARANCE_PX,
    max_passes: int = SHORT_LABEL_VISUAL_MAX_PASSES,
) -> None:
    for _ in range(max_passes):
        changed = False
        visuals = [n for n in nodes if _is_visual_neighbor_node(n)]
        if not visuals:
            return

        for label_node in nodes:
            if not _is_short_clearance_label_node(label_node):
                continue

            for visual_node in visuals:
                label_rect = _node_rect(label_node)
                visual_rect = _node_rect(visual_node)
                if not label_rect or not visual_rect:
                    continue

                overlap_w, overlap_h = _rect_overlap(label_rect, visual_rect)
                if overlap_w <= 0 or overlap_h <= 0:
                    continue

                lx0, ly0, lx1, ly1 = label_rect
                _vx0, vy0, _vx1, vy1 = visual_rect
                label_center_y = (ly0 + ly1) / 2.0
                visual_center_y = (vy0 + vy1) / 2.0
                label_h = ly1 - ly0
                label_w = lx1 - lx0

                above_y = vy0 - clearance_px - label_h
                below_y = vy1 + clearance_px
                candidates = [(abs(above_y - ly0), above_y), (abs(below_y - ly0), below_y)]
                if label_center_y > visual_center_y:
                    candidates.reverse()

                for _distance, new_y in candidates:
                    candidate_rect = (lx0, new_y, lx0 + label_w, new_y + label_h)
                    if _candidate_rect_overlaps_any_node(
                        nodes,
                        candidate_rect,
                        skip_id=str(label_node.get("id", "")),
                        overlap_tolerance_px=1.0,
                    ):
                        continue
                    if abs(new_y - ly0) <= 1e-9:
                        continue
                    label_node["y"] = new_y
                    changed = True
                    break

                if not changed and label_center_y <= visual_center_y:
                    new_visual_y = ly1 + clearance_px
                    if _move_node_down_with_cascade(nodes, visual_node, new_visual_y, clearance_px=clearance_px):
                        changed = True

                if changed:
                    break

        if not changed:
            return


def _resolve_text_visual_vertical_stack_overlaps(
    nodes: List[Dict[str, Any]],
    *,
    clearance_px: int = TEXT_VISUAL_CLEARANCE_PX,
    min_horizontal_overlap_ratio: float = TEXT_VISUAL_VERTICAL_MIN_RATIO,
    max_passes: int = TEXT_VISUAL_VERTICAL_MAX_PASSES,
) -> None:
    for _ in range(max_passes):
        changed = False
        texts = [
            n for n in nodes
            if _is_clearance_text_node(n) and not _is_short_clearance_label_node(n)
        ]
        visuals = [n for n in nodes if _is_visual_neighbor_node(n)]
        if not texts or not visuals:
            return

        for text_node in texts:
            text_rect = _node_rect(text_node)
            if not text_rect:
                continue
            tx0, ty0, tx1, ty1 = text_rect
            text_w = tx1 - tx0
            text_center_y = (ty0 + ty1) / 2.0

            for visual_node in visuals:
                visual_rect = _node_rect(visual_node)
                if not visual_rect:
                    continue
                vx0, vy0, vx1, vy1 = visual_rect
                visual_w = vx1 - vx0
                visual_h = vy1 - vy0
                overlap_w, overlap_h = _rect_overlap(text_rect, visual_rect)
                if overlap_w <= 0 or overlap_h <= 0:
                    continue

                min_w = min(text_w, visual_w)
                if min_w <= 0 or overlap_w < min_w * min_horizontal_overlap_ratio:
                    continue

                visual_center_y = (vy0 + vy1) / 2.0
                text_h = ty1 - ty0
                candidates: list[tuple[float, Dict[str, Any], float, float, float, float]] = []
                if text_center_y <= visual_center_y:
                    candidates.extend(
                        [
                            (abs((ty1 + clearance_px) - vy0), visual_node, vx0, ty1 + clearance_px, visual_w, visual_h),
                            (abs((vy0 - clearance_px - text_h) - ty0), text_node, tx0, vy0 - clearance_px - text_h, text_w, text_h),
                        ]
                    )
                else:
                    candidates.extend(
                        [
                            (abs((vy1 + clearance_px) - ty0), text_node, tx0, vy1 + clearance_px, text_w, text_h),
                            (abs((ty0 - clearance_px - visual_h) - vy0), visual_node, vx0, ty0 - clearance_px - visual_h, visual_w, visual_h),
                        ]
                    )

                candidates.extend(
                    [
                        (
                            abs((vx0 - clearance_px - text_w) - tx0),
                            text_node,
                            vx0 - clearance_px - text_w,
                            ty0,
                            text_w,
                            text_h,
                        ),
                        (
                            abs((vx1 + clearance_px) - tx0),
                            text_node,
                            vx1 + clearance_px,
                            ty0,
                            text_w,
                            text_h,
                        ),
                        (
                            abs((tx0 - clearance_px - visual_w) - vx0),
                            visual_node,
                            tx0 - clearance_px - visual_w,
                            vy0,
                            visual_w,
                            visual_h,
                        ),
                        (
                            abs((tx1 + clearance_px) - vx0),
                            visual_node,
                            tx1 + clearance_px,
                            vy0,
                            visual_w,
                            visual_h,
                        ),
                    ]
                )

                for _distance, moved_node, new_x, new_y, moved_w, moved_h in sorted(candidates, key=lambda c: c[0]):
                    candidate_rect = (new_x, new_y, new_x + moved_w, new_y + moved_h)
                    if _candidate_rect_overlaps_any_node(
                        nodes,
                        candidate_rect,
                        skip_id=str(moved_node.get("id", "")),
                        overlap_tolerance_px=1.0,
                    ):
                        try:
                            current_y = float(moved_node.get("y", 0) or 0)
                        except Exception:
                            current_y = new_y
                        if (
                            abs(float(moved_node.get("x", 0) or 0) - new_x) <= 1e-9
                            and new_y > current_y
                            and _move_node_down_with_cascade(nodes, moved_node, new_y, clearance_px=clearance_px)
                        ):
                            changed = True
                            break
                        continue

                    if (
                        abs(float(moved_node.get("x", 0) or 0) - new_x) <= 1e-9
                        and abs(float(moved_node.get("y", 0) or 0) - new_y) <= 1e-9
                    ):
                        continue
                    moved_node["x"] = new_x
                    moved_node["y"] = new_y
                    changed = True
                    break

                if not changed:
                    continue
                break

            if changed:
                break

        if not changed:
            return


def _resolve_text_text_vertical_overlaps(
    nodes: List[Dict[str, Any]],
    *,
    clearance_px: int = TEXT_VISUAL_CLEARANCE_PX,
    min_horizontal_overlap_ratio: float = TEXT_TEXT_VERTICAL_OVERLAP_MIN_RATIO,
    max_passes: int = TEXT_TEXT_VERTICAL_MAX_PASSES,
) -> None:
    text_nodes = [n for n in nodes if _is_clearance_text_node(n)]
    if len(text_nodes) < 2:
        return

    for _ in range(max_passes):
        changed = False
        text_nodes.sort(key=lambda n: (float(n.get("y", 0) or 0), float(n.get("x", 0) or 0)))

        for i, upper_node in enumerate(text_nodes):
            upper_rect = _node_rect(upper_node)
            if not upper_rect:
                continue
            ux0, uy0, ux1, uy1 = upper_rect
            upper_center_y = (uy0 + uy1) / 2.0
            upper_w = ux1 - ux0

            for lower_node in text_nodes[i + 1:]:
                lower_rect = _node_rect(lower_node)
                if not lower_rect:
                    continue
                lx0, ly0, lx1, ly1 = lower_rect
                lower_center_y = (ly0 + ly1) / 2.0
                if lower_center_y <= upper_center_y:
                    continue

                overlap_w, _overlap_h = _rect_overlap(upper_rect, lower_rect)
                min_w = min(upper_w, lx1 - lx0)
                if min_w <= 0 or overlap_w < min_w * min_horizontal_overlap_ratio:
                    continue

                required_y = uy1 + clearance_px
                if ly0 >= required_y:
                    continue

                lower_node["y"] = required_y
                changed = True

        if not changed:
            return


def _resolve_text_text_horizontal_edge_overlaps(
    nodes: List[Dict[str, Any]],
    *,
    clearance_px: int = TEXT_VISUAL_CLEARANCE_PX,
    max_horizontal_overlap_ratio: float = TEXT_TEXT_HORIZONTAL_EDGE_MAX_RATIO,
    max_passes: int = TEXT_TEXT_HORIZONTAL_EDGE_MAX_PASSES,
) -> None:
    text_nodes = [n for n in nodes if _is_clearance_text_node(n)]
    if len(text_nodes) < 2:
        return

    for _ in range(max_passes):
        changed = False
        text_nodes.sort(key=lambda n: (float(n.get("x", 0) or 0), float(n.get("y", 0) or 0)))

        for idx, left_node in enumerate(text_nodes):
            left_rect = _node_rect(left_node)
            if not left_rect:
                continue
            lx0, ly0, lx1, ly1 = left_rect
            left_w = lx1 - lx0
            left_center_x = (lx0 + lx1) / 2.0

            for right_node in text_nodes[idx + 1:]:
                right_rect = _node_rect(right_node)
                if not right_rect:
                    continue
                rx0, ry0, rx1, ry1 = right_rect
                right_w = rx1 - rx0
                right_center_x = (rx0 + rx1) / 2.0
                if right_center_x <= left_center_x:
                    continue

                overlap_w, overlap_h = _rect_overlap(left_rect, right_rect)
                if overlap_w <= 0 or overlap_h <= 0:
                    continue

                min_w = min(left_w, right_w)
                if min_w <= 0 or overlap_w > min_w * max_horizontal_overlap_ratio:
                    continue

                candidates = [
                    (abs((lx1 + clearance_px) - rx0), right_node, lx1 + clearance_px, ry0, right_w, ry1 - ry0),
                    (abs((rx0 - clearance_px - left_w) - lx0), left_node, rx0 - clearance_px - left_w, ly0, left_w, ly1 - ly0),
                ]
                for _distance, moved_node, new_x, new_y, moved_w, moved_h in sorted(candidates, key=lambda c: c[0]):
                    candidate_rect = (new_x, new_y, new_x + moved_w, new_y + moved_h)
                    if _candidate_rect_overlaps_any_node(
                        nodes,
                        candidate_rect,
                        skip_id=str(moved_node.get("id", "")),
                        overlap_tolerance_px=1.0,
                    ):
                        continue
                    moved_node["x"] = new_x
                    changed = True
                    break

                if changed:
                    break

            if changed:
                break

        if not changed:
            return


def _has_visible_text(node: Dict[str, Any]) -> bool:
    text = str(node.get("text") or "")
    plain = _html_unescape(strip_html(text)).replace("\xa0", " ")
    plain = re.sub(r"\s+", " ", plain).strip()
    return bool(plain)


def _is_tiny_entity_text_node(node: Dict[str, Any]) -> bool:
    plain = _plain_canvas_text(node)
    if not plain or re.search(r"\s", plain):
        return False
    if re.fullmatch(r"&(?:#[0-9]+|#x[0-9a-fA-F]+|[A-Za-z][A-Za-z0-9]+);", plain):
        return True
    decoded = _html_unescape(plain)
    return bool(decoded) and not re.search(r"\s", decoded) and len(decoded) <= 2


def _compact_tiny_slide_text_heights(
    nodes: List[Dict[str, Any]],
    *,
    max_font_px: int = TINY_SLIDE_TEXT_MAX_FONT_PX,
    max_height_px: float = TINY_SLIDE_TEXT_MAX_HEIGHT_PX,
    padding: int = TINY_SLIDE_TEXT_COMPACT_PADDING,
) -> None:
    for node in nodes:
        if not _is_clearance_text_node(node) or not _has_visible_text(node):
            continue
        attrs = node.get("styleAttributes") or {}
        shape = str(attrs.get("shape") or "").lower()
        if shape not in ("", "rectangle", "round-rectangle"):
            continue

        try:
            font_px = int(round(float(attrs.get("fontSize") or OBSIDIAN_FONT_SIZE)))
            width = float(node.get("width") or 0)
            current_h = float(node.get("height") or 0)
        except Exception:
            continue
        if font_px <= 0 or font_px > max_font_px:
            continue
        is_tiny_entity = width <= 12 and _is_tiny_entity_text_node(node)
        if width <= 0 or current_h <= 0:
            continue
        if current_h > max_height_px and not is_tiny_entity:
            continue

        text = str(node.get("text") or "")
        if re.search(r"<(?:ol|ul|table|li)\b", text, re.I):
            continue
        line_height = _line_height_from_canvas_text(text)
        if is_tiny_entity:
            needed_h = max(1.0, float(font_px) * line_height + padding)
        else:
            needed_h = float(
                _estimate_render_height(
                    text,
                    width_px=width,
                    font_px=font_px,
                    line_height=line_height,
                    padding=padding,
                )
            )
        if 0 < needed_h < current_h:
            node["height"] = needed_h


def _plain_canvas_text(node: Dict[str, Any]) -> str:
    text = str(node.get("text") or "")
    plain = _html_unescape(strip_html(text)).replace("\xa0", " ")
    return re.sub(r"\s+", " ", plain).strip()


def _is_tiny_slide_number_marker(node: Dict[str, Any]) -> bool:
    if node.get("type") != "text":
        return False
    attrs = node.get("styleAttributes") or {}
    if str(attrs.get("shape") or "").lower() != "circle":
        return False
    try:
        font_px = int(round(float(attrs.get("fontSize") or OBSIDIAN_FONT_SIZE)))
        width = float(node.get("width") or 0)
        height = float(node.get("height") or 0)
    except Exception:
        return False
    if font_px > TINY_SLIDE_TEXT_MAX_FONT_PX + 1 or width > 20 or height > 20:
        return False
    return bool(re.fullmatch(r"\d{1,2}", _plain_canvas_text(node)))


def _is_tiny_empty_slide_background(node: Dict[str, Any]) -> bool:
    if node.get("type") != "text" or _has_visible_text(node):
        return False
    attrs = node.get("styleAttributes") or {}
    if str(attrs.get("shape") or "").lower() not in ("rectangle", "round-rectangle"):
        return False
    try:
        font_px = int(round(float(attrs.get("fontSize") or OBSIDIAN_FONT_SIZE)))
        height = float(node.get("height") or 0)
    except Exception:
        return False
    return 0 < font_px <= TINY_SLIDE_TEXT_MAX_FONT_PX and 0 < height <= TINY_TEXT_TEXT_VERTICAL_EDGE_MAX_HEIGHT_PX


def _resolve_tiny_slide_marker_text_overlaps(
    nodes: List[Dict[str, Any]],
    *,
    clearance_px: int = TINY_SLIDE_MARKER_TEXT_CLEARANCE_PX,
) -> None:
    markers = [n for n in nodes if _is_tiny_slide_number_marker(n)]
    if not markers:
        return

    for text_node in nodes:
        if not _is_clearance_text_node(text_node) or not _has_visible_text(text_node):
            continue
        if _is_tiny_slide_number_marker(text_node):
            continue
        attrs = text_node.get("styleAttributes") or {}
        try:
            font_px = int(round(float(attrs.get("fontSize") or OBSIDIAN_FONT_SIZE)))
        except Exception:
            continue
        if font_px > TINY_SLIDE_TEXT_MAX_FONT_PX:
            continue

        text_rect = _node_rect(text_node)
        if not text_rect:
            continue
        tx0, ty0, tx1, ty1 = text_rect
        required_x: float | None = None
        for marker in markers:
            marker_rect = _node_rect(marker)
            if not marker_rect:
                continue
            overlap_w, overlap_h = _rect_overlap(text_rect, marker_rect)
            if overlap_w <= 0 or overlap_h <= 0:
                continue
            candidate_x = marker_rect[2] + clearance_px
            if required_x is None or candidate_x > required_x:
                required_x = candidate_x

        if required_x is None or tx0 >= required_x:
            continue
        new_width = tx1 - required_x
        if new_width <= 1:
            continue
        text_node["x"] = required_x
        text_node["width"] = new_width


def _resolve_tiny_text_text_vertical_edge_overlaps(
    nodes: List[Dict[str, Any]],
    *,
    clearance_px: int = TINY_TEXT_TEXT_VERTICAL_EDGE_CLEARANCE_PX,
    max_vertical_overlap_px: float = TINY_TEXT_TEXT_VERTICAL_EDGE_MAX_OVERLAP_PX,
    max_text_height_px: float = TINY_TEXT_TEXT_VERTICAL_EDGE_MAX_HEIGHT_PX,
    min_horizontal_overlap_ratio: float = TINY_TEXT_TEXT_VERTICAL_EDGE_MIN_HORIZONTAL_RATIO,
    max_passes: int = TINY_TEXT_TEXT_VERTICAL_EDGE_MAX_PASSES,
) -> None:
    text_nodes = [
        n for n in nodes
        if (_is_clearance_text_node(n) and _has_visible_text(n)) or _is_tiny_empty_slide_background(n)
    ]
    if len(text_nodes) < 2:
        return

    for _ in range(max_passes):
        changed = False
        text_nodes.sort(key=lambda n: (float(n.get("y", 0) or 0), float(n.get("x", 0) or 0)))

        for i, upper_node in enumerate(text_nodes):
            upper_rect = _node_rect(upper_node)
            if not upper_rect:
                continue
            ux0, uy0, ux1, uy1 = upper_rect
            upper_w = ux1 - ux0
            upper_h = uy1 - uy0
            if upper_h > max_text_height_px:
                continue
            upper_center_y = (uy0 + uy1) / 2.0

            for lower_node in text_nodes[i + 1:]:
                lower_rect = _node_rect(lower_node)
                if not lower_rect:
                    continue
                lx0, ly0, lx1, ly1 = lower_rect
                lower_h = ly1 - ly0
                if lower_h > max_text_height_px:
                    continue
                if (ly0 + ly1) / 2.0 <= upper_center_y:
                    continue

                overlap_w, overlap_h = _rect_overlap(upper_rect, lower_rect)
                if overlap_w <= 0 or overlap_h <= 0:
                    continue
                if overlap_h > max_vertical_overlap_px:
                    continue

                min_w = min(upper_w, lx1 - lx0)
                if min_w <= 0 or overlap_w < min_w * min_horizontal_overlap_ratio:
                    continue

                required_y = uy1 + clearance_px
                if ly0 >= required_y:
                    continue
                lower_node["y"] = required_y
                changed = True

        if not changed:
            return


def _resolve_link_visual_overlaps(
    nodes: List[Dict[str, Any]],
    *,
    clearance_px: int = TEXT_VISUAL_CLEARANCE_PX,
    max_passes: int = LINK_VISUAL_MAX_PASSES,
) -> None:
    for _ in range(max_passes):
        changed = False
        links = [n for n in nodes if n.get("type") == "link"]
        visuals = [n for n in nodes if n.get("type") in ("file", "link")]

        for link_node in links:
            link_rect = _node_rect(link_node)
            if not link_rect:
                continue

            for other_node in visuals:
                if other_node is link_node:
                    continue
                other_rect = _node_rect(other_node)
                link_rect = _node_rect(link_node)
                if not link_rect or not other_rect:
                    continue
                overlap_w, overlap_h = _rect_overlap(link_rect, other_rect)
                if overlap_w <= 0 or overlap_h <= 0:
                    continue

                lx0, ly0, lx1, ly1 = link_rect
                ox0, oy0, ox1, oy1 = other_rect
                link_w = lx1 - lx0
                link_h = ly1 - ly0
                candidates = [
                    (lx0, oy0 - clearance_px - link_h),
                    (lx0, oy1 + clearance_px),
                    (ox0 - clearance_px - link_w, ly0),
                    (ox1 + clearance_px, ly0),
                ]

                collision_free: list[tuple[float, float, float]] = []
                for new_x, new_y in candidates:
                    candidate_rect = (new_x, new_y, new_x + link_w, new_y + link_h)
                    distance = abs(new_x - lx0) + abs(new_y - ly0)
                    if not _candidate_rect_overlaps_any_node(
                        nodes,
                        candidate_rect,
                        skip_id=str(link_node.get("id", "")),
                        overlap_tolerance_px=1.0,
                    ):
                        collision_free.append((distance, new_x, new_y))

                if not collision_free:
                    continue

                _distance, new_x, new_y = min(collision_free, key=lambda c: c[0])
                if abs(new_x - lx0) <= 1e-9 and abs(new_y - ly0) <= 1e-9:
                    continue
                link_node["x"] = new_x
                link_node["y"] = new_y
                changed = True
                break

        if not changed:
            return


def _resolve_link_text_edge_overlaps(
    nodes: List[Dict[str, Any]],
    *,
    clearance_px: int = TEXT_VISUAL_CLEARANCE_PX,
    max_edge_overlap_px: float = LINK_TEXT_EDGE_MAX_OVERLAP_PX,
    max_passes: int = LINK_TEXT_EDGE_MAX_PASSES,
) -> None:
    for _ in range(max_passes):
        changed = False
        links = [n for n in nodes if n.get("type") == "link"]
        texts = [n for n in nodes if n.get("type") == "text"]

        for link_node in links:
            link_rect = _node_rect(link_node)
            if not link_rect:
                continue

            for text_node in texts:
                text_rect = _node_rect(text_node)
                link_rect = _node_rect(link_node)
                if not link_rect or not text_rect:
                    continue

                overlap_w, overlap_h = _rect_overlap(link_rect, text_rect)
                if overlap_w <= 0 or overlap_h <= 0:
                    continue
                if min(overlap_w, overlap_h) > max_edge_overlap_px:
                    continue

                lx0, ly0, lx1, ly1 = link_rect
                tx0, ty0, tx1, ty1 = text_rect
                link_w = lx1 - lx0
                link_h = ly1 - ly0
                candidates = [
                    (lx0, ty0 - clearance_px - link_h),
                    (lx0, ty1 + clearance_px),
                    (tx0 - clearance_px - link_w, ly0),
                    (tx1 + clearance_px, ly0),
                ]

                collision_free: list[tuple[float, float, float]] = []
                for new_x, new_y in candidates:
                    candidate_rect = (new_x, new_y, new_x + link_w, new_y + link_h)
                    distance = abs(new_x - lx0) + abs(new_y - ly0)
                    if not _candidate_rect_overlaps_any_node(
                        nodes,
                        candidate_rect,
                        skip_id=str(link_node.get("id", "")),
                        overlap_tolerance_px=1.0,
                    ):
                        collision_free.append((distance, new_x, new_y))

                if not collision_free:
                    continue

                _distance, new_x, new_y = min(collision_free, key=lambda c: c[0])
                if abs(new_x - lx0) <= 1e-9 and abs(new_y - ly0) <= 1e-9:
                    continue
                link_node["x"] = new_x
                link_node["y"] = new_y
                changed = True
                break

            if changed:
                break

        if not changed:
            return


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


def _expand_rect_to_aspect_ratio(rect: Dict[str, float], ratio: float) -> Dict[str, float]:
    if ratio <= 0:
        return dict(rect)
    width = max(float(rect["width"]), 1.0)
    height = max(float(rect["height"]), 1.0)
    target_width = width
    target_height = height
    current_ratio = width / height
    if current_ratio < ratio:
        target_width = height * ratio
    elif current_ratio > ratio:
        target_height = width / ratio
    cx = float(rect["x"]) + width / 2.0
    cy = float(rect["y"]) + height / 2.0
    return {
        "x": cx - target_width / 2.0,
        "y": cy - target_height / 2.0,
        "width": target_width,
        "height": target_height,
    }


def _item_local_center_and_size(
    item: Dict[str, Any],
    node: Optional[Dict[str, Any]] = None,
    scale: float = 1.0,
) -> Optional[tuple]:
    pos = item.get("position") if isinstance(item.get("position"), dict) else {}
    geom = item.get("geometry") if isinstance(item.get("geometry"), dict) else {}
    try:
        x = float(pos.get("x") or 0.0)
        y = float(pos.get("y") or 0.0)
    except Exception:
        return None

    try:
        width = float(geom.get("width") or 0.0)
    except Exception:
        width = 0.0
    try:
        height = float(geom.get("height") or 0.0)
    except Exception:
        height = 0.0

    if node and scale:
        if width <= 0:
            width = float(node.get("width") or 0.0) / scale
        if height <= 0:
            height = float(node.get("height") or 0.0) / scale

    origin = str(pos.get("origin") or "center").lower()
    if origin == "top_left":
        x += width / 2.0
        y += height / 2.0
    return x, y, max(width, 1.0), max(height, 1.0)


def _slide_child_source_visual_height(item: Dict[str, Any], width: float) -> Optional[float]:
    geom = item.get("geometry") if isinstance(item.get("geometry"), dict) else {}
    if geom.get("height") is not None:
        return None

    item_type = str(item.get("type") or "").lower()
    if item_type not in {"text", "shape", "sticky_note"}:
        return None

    data = item.get("data") if isinstance(item.get("data"), dict) else {}
    content_html = str(data.get("content") or item.get("plain_text") or "")
    if not strip_html(content_html).strip():
        return None

    style = item.get("style") if isinstance(item.get("style"), dict) else {}
    font_px = _extract_font_base_px(item, fallback=OBSIDIAN_FONT_SIZE)
    line_height = _extract_line_height(style, default=1.35)
    return max(
        1.0,
        float(
            _estimate_render_height(
                _strip_edge_empty_paragraphs(content_html),
                width_px=max(float(width), 1.0),
                font_px=font_px,
                line_height=line_height,
                padding=0,
            )
        ),
    )


def _slide_thumbnail_content_size_boost(fit: float) -> float:
    safe_fit = max(float(fit), 1e-9)
    if safe_fit >= SLIDE_THUMBNAIL_CONTENT_BOOST_MAX_FIT:
        return 1.0
    return min(
        SLIDE_THUMBNAIL_CONTENT_BOOST_MAX,
        max(1.0, (1.0 / safe_fit) ** SLIDE_THUMBNAIL_CONTENT_BOOST_EXPONENT),
    )


def _slide_thumbnail_text_size_boost(item: Dict[str, Any], frame_boost: float) -> float:
    item_type = str(item.get("type") or "").lower()
    if item_type == "shape":
        data = item.get("data") if isinstance(item.get("data"), dict) else {}
        if not str(data.get("content") or "").strip():
            return 1.0

    font_px = _extract_font_base_px(item, fallback=0.0)
    if font_px <= 0:
        return 1.0
    if font_px >= SLIDE_THUMBNAIL_LARGE_TEXT_MIN_FONT_PX:
        return min(
            float(frame_boost),
            SLIDE_THUMBNAIL_TEXT_BOOST_MAX,
            max(SLIDE_THUMBNAIL_MEDIUM_TEXT_BOOST, font_px / SLIDE_THUMBNAIL_TEXT_BOOST_FONT_DIVISOR),
        )
    if font_px >= SLIDE_THUMBNAIL_MEDIUM_TEXT_MIN_FONT_PX:
        return min(float(frame_boost), SLIDE_THUMBNAIL_MEDIUM_TEXT_BOOST)
    return 1.0


def _layout_slide_frames_unscaled(
    by_id: Dict[str, Dict[str, Any]],
    deck_order: List[str],
    slide_frames_by_deck: Dict[str, List[str]],
    container_rects_unscaled: Dict[str, Dict[str, float]],
    content_scales_by_frame: Optional[Dict[str, float]] = None,
    content_size_boosts_by_frame: Optional[Dict[str, float]] = None,
    target_max_side_unscaled: Optional[float] = None,
) -> set[str]:
    """Lay out slide frames when Miro exposes deck membership but no per-slide coordinates."""
    synthesized_frame_ids: set[str] = set()
    max_thumbnail_side = max(float(target_max_side_unscaled or SYNTHETIC_SLIDE_MANUAL_DEFAULT_MAX_SIDE), 1.0)

    for did in deck_order:
        frame_ids = [
            fid for fid in slide_frames_by_deck.get(did, [])
            if fid in container_rects_unscaled and fid in by_id
        ]
        if not frame_ids:
            continue

        source_positions: set = set()
        for fid in frame_ids:
            pos = by_id[fid].get("position") if isinstance(by_id[fid].get("position"), dict) else {}
            try:
                source_positions.add((
                    round(float(pos.get("x") or 0.0), 4),
                    round(float(pos.get("y") or 0.0), 4),
                    str(pos.get("relativeTo") or ""),
                ))
            except Exception:
                source_positions.add((0.0, 0.0, ""))

        if len(source_positions) > 1:
            continue

        deck = by_id.get(did) or {}
        deck_pos = deck.get("position") if isinstance(deck.get("position"), dict) else {}
        try:
            anchor_x = float(deck_pos.get("x") or 0.0)
            anchor_y = float(deck_pos.get("y") or 0.0)
        except Exception:
            anchor_x = 0.0
            anchor_y = 0.0

        rects = []
        has_normalized_frame = False
        for fid in frame_ids:
            rect = dict(container_rects_unscaled[fid])
            width = max(float(rect["width"]), 1.0)
            height = max(float(rect["height"]), 1.0)
            max_side = max(width, height)
            fit = max_thumbnail_side / max_side
            if abs(fit - 1.0) > 1e-9:
                has_normalized_frame = True
                if content_scales_by_frame is not None:
                    content_scales_by_frame[fid] = fit
                width *= fit
                height *= fit
            rect["width"] = width
            rect["height"] = height
            rects.append(rect)

        max_w = max(float(r["width"]) for r in rects)
        max_h = max(float(r["height"]) for r in rects)
        gap_x = max(24.0, min(80.0, max_w * 0.08))
        use_large_deck_overview = (
            has_normalized_frame
            and len(rects) > SYNTHETIC_SLIDE_DECK_TOP_ROW_COUNT
        )

        if use_large_deck_overview:
            top_count = min(SYNTHETIC_SLIDE_DECK_TOP_ROW_COUNT, len(rects))
            top_rects = rects[:top_count]
            trailing_rects = rects[top_count:]
            gap_y = max(48.0, min(96.0, max_h * 0.55))

            top_w = (
                sum(float(r["width"]) for r in top_rects)
                + gap_x * max(0, len(top_rects) - 1)
            )
            total_w = max(top_w, max((float(r["width"]) for r in trailing_rects), default=0.0))
            total_h = max_h
            if trailing_rects:
                total_h += gap_y * len(trailing_rects)
                total_h += sum(float(r["height"]) for r in trailing_rects)

            start_x = anchor_x - total_w / 2.0
            start_y = anchor_y - total_h / 2.0

            cur_x = start_x
            for fid, rect in zip(frame_ids[:top_count], top_rects):
                width = float(rect["width"])
                height = float(rect["height"])
                container_rects_unscaled[fid] = {
                    "x": cur_x,
                    "y": start_y + (max_h - height) / 2.0,
                    "width": width,
                    "height": height,
                }
                synthesized_frame_ids.add(fid)
                cur_x += width + gap_x

            cur_y = start_y + max_h + gap_y
            for fid, rect in zip(frame_ids[top_count:], trailing_rects):
                width = float(rect["width"])
                height = float(rect["height"])
                container_rects_unscaled[fid] = {
                    "x": start_x,
                    "y": cur_y,
                    "width": width,
                    "height": height,
                }
                synthesized_frame_ids.add(fid)
                cur_y += height + gap_y
        else:
            total_w = sum(float(r["width"]) for r in rects) + gap_x * max(0, len(rects) - 1)
            total_h = max_h
            start_x = anchor_x - total_w / 2.0
            start_y = anchor_y - total_h / 2.0

            cur_x = start_x
            for fid, rect in zip(frame_ids, rects):
                width = float(rect["width"])
                height = float(rect["height"])
                container_rects_unscaled[fid] = {
                    "x": cur_x,
                    "y": start_y + (max_h - height) / 2.0,
                    "width": width,
                    "height": height,
                }
                synthesized_frame_ids.add(fid)
                cur_x += width + gap_x

    return synthesized_frame_ids


def _collect_canvas_group_subtree_ids(
    node_map: Dict[str, Dict[str, Any]],
    root_id: str,
    out: Optional[set[str]] = None,
) -> set[str]:
    if out is None:
        out = set()
    if root_id in out:
        return out
    out.add(root_id)
    node = node_map.get(root_id)
    if not isinstance(node, dict):
        return out
    for child_id in node.get("nodes") or []:
        _collect_canvas_group_subtree_ids(node_map, str(child_id), out)
    return out


def _translate_canvas_nodes(node_map: Dict[str, Dict[str, Any]], node_ids: Iterable[str], dx: float, dy: float) -> None:
    for node_id in node_ids:
        node = node_map.get(str(node_id))
        if not isinstance(node, dict):
            continue
        try:
            node["x"] = float(node["x"]) + dx
            node["y"] = float(node["y"]) + dy
        except Exception:
            continue


def _clearance_down_delta(
    rect: tuple[float, float, float, float],
    obstacles: List[tuple[float, float, float, float]],
    *,
    clearance_px: float = SYNTHETIC_SLIDE_DECK_OVERLAP_CLEARANCE_PX,
    tolerance_px: float = SYNTHETIC_SLIDE_DECK_OVERLAP_TOLERANCE_PX,
    max_passes: int = SYNTHETIC_SLIDE_DECK_OVERLAP_MAX_PASSES,
) -> float:
    dy = 0.0
    x0, y0, x1, y1 = rect

    for _ in range(max_passes):
        moved = (x0, y0 + dy, x1, y1 + dy)
        blockers: List[tuple[float, float, float, float]] = []
        for obstacle in obstacles:
            overlap_w, overlap_h = _rect_overlap(moved, obstacle)
            if overlap_w > tolerance_px and overlap_h > tolerance_px:
                blockers.append(obstacle)
        if not blockers:
            return dy

        next_dy = max(obstacle[3] + clearance_px for obstacle in blockers) - y0
        if next_dy <= dy + tolerance_px:
            return dy
        dy = next_dy

    return dy


def _resolve_synthetic_slide_deck_canvas_overlaps(
    nodes: List[Dict[str, Any]],
    node_map: Dict[str, Dict[str, Any]],
    deck_order: List[str],
    synthetic_slide_frame_ids: set[str],
) -> None:
    """Move enlarged synthetic slide decks away from neighboring canvas objects."""
    if not synthetic_slide_frame_ids:
        return

    for did in deck_order:
        deck_node = node_map.get(did)
        if not isinstance(deck_node, dict):
            continue
        deck_children = [str(child_id) for child_id in deck_node.get("nodes") or []]
        if not any(child_id in synthetic_slide_frame_ids for child_id in deck_children):
            continue

        moving_ids = _collect_canvas_group_subtree_ids(node_map, did)
        deck_rect = _node_rect(deck_node)
        if not deck_rect:
            continue

        obstacles: List[tuple[float, float, float, float]] = []
        for node in nodes:
            node_id = str(node.get("id", "") or "")
            if not node_id or node_id in moving_ids:
                continue
            if node.get("type") not in ("group", "text", "file", "link"):
                continue
            obstacle_rect = _node_rect(node)
            if obstacle_rect:
                obstacles.append(obstacle_rect)
        if not obstacles:
            continue

        dy = _clearance_down_delta(deck_rect, obstacles)
        if dy > SYNTHETIC_SLIDE_DECK_OVERLAP_TOLERANCE_PX:
            _translate_canvas_nodes(node_map, moving_ids, 0.0, dy)


def _slide_fit_data(frame_rect: Dict[str, float], boxes: List[tuple]) -> Dict[str, float]:
    min_x = min(box[0] for box in boxes)
    min_y = min(box[1] for box in boxes)
    max_x = max(box[2] for box in boxes)
    max_y = max(box[3] for box in boxes)
    bbox_w = max(max_x - min_x, 1.0)
    bbox_h = max(max_y - min_y, 1.0)
    frame_w = max(float(frame_rect["width"]), 1.0)
    frame_h = max(float(frame_rect["height"]), 1.0)

    overflow_x = max(0.0, -min_x, max_x - frame_w)
    overflow_y = max(0.0, -min_y, max_y - frame_h)
    substantial_overflow_x = overflow_x > max(SLIDE_CHILD_FIT_OVERFLOW_MIN_PX, frame_w * SLIDE_CHILD_FIT_OVERFLOW_RATIO)
    substantial_overflow_y = overflow_y > max(SLIDE_CHILD_FIT_OVERFLOW_MIN_PX, frame_h * SLIDE_CHILD_FIT_OVERFLOW_RATIO)
    oversized_bbox = bbox_w > frame_w * SLIDE_CHILD_FIT_BBOX_RATIO or bbox_h > frame_h * SLIDE_CHILD_FIT_BBOX_RATIO
    dense_oversized_bbox = (
        len(boxes) >= SLIDE_CHILD_FIT_DENSE_MIN_CHILDREN
        and (bbox_w > frame_w * SLIDE_CHILD_FIT_DENSE_BBOX_RATIO or bbox_h > frame_h * SLIDE_CHILD_FIT_DENSE_BBOX_RATIO)
    )
    needs_fit = substantial_overflow_x or substantial_overflow_y or oversized_bbox or dense_oversized_bbox
    if needs_fit:
        fit = min(1.0, frame_w / bbox_w, frame_h / bbox_h)
        origin_x = min_x
        origin_y = min_y
        offset_x = (frame_w - bbox_w * fit) / 2.0
        offset_y = (frame_h - bbox_h * fit) / 2.0
    else:
        fit = 1.0
        origin_x = 0.0
        origin_y = 0.0
        offset_x = 0.0
        offset_y = 0.0

    return {
        "fit": fit,
        "origin_x": origin_x,
        "origin_y": origin_y,
        "offset_x": offset_x,
        "offset_y": offset_y,
        "bbox_w": bbox_w,
        "bbox_h": bbox_h,
    }


def _slide_child_boxes(
    child_ids: Iterable[str],
    node_map: Dict[str, Dict[str, Any]],
    by_id: Dict[str, Dict[str, Any]],
    scale: float,
) -> List[tuple]:
    boxes: List[tuple] = []
    for cid in child_ids:
        if cid not in node_map or cid not in by_id:
            continue
        result = _item_local_center_and_size(by_id[cid], node_map[cid], scale=scale)
        if result is None:
            continue
        cx, cy, width, height = result
        boxes.append((cx - width / 2.0, cy - height / 2.0, cx + width / 2.0, cy + height / 2.0))
    return boxes


def _set_node_font_px(node: Dict[str, Any], font_px: int) -> None:
    attrs = node.get("styleAttributes")
    if isinstance(attrs, dict):
        attrs["fontSize"] = font_px
    text = node.get("text")
    if isinstance(text, str):
        if FONT_SIZE_STYLE_RE.search(text):
            node["text"] = FONT_SIZE_STYLE_RE.sub(rf"\g<1>{font_px}px", text)
        else:
            node["text"] = text


def _clamp_node_to_scaled_rect(
    node: Dict[str, Any],
    rect_unscaled: Dict[str, float],
    *,
    scale: float,
) -> None:
    frame_x = float(rect_unscaled["x"]) * scale
    frame_y = float(rect_unscaled["y"]) * scale
    frame_w = max(float(rect_unscaled["width"]) * scale, 1.0)
    frame_h = max(float(rect_unscaled["height"]) * scale, 1.0)

    node_w = max(float(node.get("width") or 0.0), 1.0)
    node_h = max(float(node.get("height") or 0.0), 1.0)
    node_x = float(node.get("x") or 0.0)
    node_y = float(node.get("y") or 0.0)

    if node_w <= frame_w:
        node_x = min(max(node_x, frame_x), frame_x + frame_w - node_w)
    if node_h <= frame_h:
        node_y = min(max(node_y, frame_y), frame_y + frame_h - node_h)

    node["x"] = node_x
    node["y"] = node_y


def _fit_slide_child_nodes_to_frame_rects(
    node_map: Dict[str, Dict[str, Any]],
    by_id: Dict[str, Dict[str, Any]],
    children: Dict[str, List[str]],
    slide_frame_ids: List[str],
    container_rects_unscaled: Dict[str, Dict[str, float]],
    scale: float,
    min_font_px: int,
    content_scales_by_frame: Optional[Dict[str, float]] = None,
    content_size_boosts_by_frame: Optional[Dict[str, float]] = None,
    sub_min_font_frame_ids: Optional[set[str]] = None,
    expandable_frame_ids: Optional[set[str]] = None,
) -> set:
    """Place slide children inside their computed slide frame rects."""
    slide_child_ids: set = set()

    for frame_id in slide_frame_ids:
        frame_rect = container_rects_unscaled.get(frame_id)
        if not frame_rect:
            continue

        child_ids = [
            cid for cid in (children.get(frame_id) or [])
            if cid in node_map and cid in by_id
        ]
        if not child_ids:
            continue
        slide_child_ids.update(child_ids)

        boxes: List[tuple] = []
        centers: Dict[str, tuple] = {}
        local_sizes: Dict[str, tuple] = {}
        for cid in child_ids:
            result = _item_local_center_and_size(by_id[cid], node_map[cid], scale=scale)
            if result is None:
                continue
            cx, cy, width, height = result
            source_visual_height = _slide_child_source_visual_height(by_id[cid], width)
            if source_visual_height is not None:
                height = source_visual_height
            centers[cid] = (cx, cy)
            local_sizes[cid] = (width, height)
            boxes.append((cx - width / 2.0, cy - height / 2.0, cx + width / 2.0, cy + height / 2.0))

        if not boxes:
            continue

        if content_scales_by_frame and frame_id in content_scales_by_frame:
            fit = float(content_scales_by_frame[frame_id])
            origin_x = 0.0
            origin_y = 0.0
            offset_x = 0.0
            offset_y = 0.0
        else:
            fit_data = _slide_fit_data(frame_rect, boxes)
            fit = float(fit_data["fit"])
            origin_x = float(fit_data["origin_x"])
            origin_y = float(fit_data["origin_y"])
            offset_x = float(fit_data["offset_x"])
            offset_y = float(fit_data["offset_y"])
        for cid, (local_x, local_y) in centers.items():
            node = node_map[cid]
            size_fit = fit
            grew_for_min_font = False
            source_item = by_id.get(cid) or {}
            source_type = str(source_item.get("type") or "").lower()
            if content_size_boosts_by_frame and frame_id in content_size_boosts_by_frame:
                boost = float(content_size_boosts_by_frame[frame_id])
                if source_type == "image":
                    size_fit *= boost
                elif source_type in {"text", "shape", "sticky_note"}:
                    size_fit *= _slide_thumbnail_text_size_boost(source_item, boost)
            if abs(size_fit - 1.0) > 1e-9:
                local_width, local_height = local_sizes.get(cid, (0.0, 0.0))
                scaled_width = float(local_width) * float(scale) * size_fit
                scaled_height = float(local_height) * float(scale) * size_fit
                text_size_multiplier = 1.0
                attrs = node.get("styleAttributes")
                if isinstance(attrs, dict) and isinstance(attrs.get("fontSize"), (int, float)):
                    source_font_px = _extract_font_base_px(
                        source_item,
                        fallback=float(attrs["fontSize"]) / max(float(scale), 1e-9),
                    )
                    scaled_font = int(round(float(source_font_px) * float(scale) * size_fit))
                    if size_fit < 1.0:
                        font_floor = (
                            SLIDE_THUMBNAIL_MIN_FONT_PX
                            if sub_min_font_frame_ids and frame_id in sub_min_font_frame_ids
                            else min_font_px
                        )
                    else:
                        font_floor = min_font_px
                    final_font = max(font_floor, scaled_font)
                    if scaled_font > 0 and final_font > scaled_font:
                        text_size_multiplier = final_font / scaled_font
                        grew_for_min_font = True
                    _set_node_font_px(node, final_font)
                node["width"] = max(1.0, scaled_width * text_size_multiplier)
                node["height"] = max(1.0, scaled_height * text_size_multiplier)

            center_x = float(frame_rect["x"]) + offset_x + (local_x - origin_x) * fit
            center_y = float(frame_rect["y"]) + offset_y + (local_y - origin_y) * fit
            node["x"] = center_x * scale - float(node["width"]) / 2.0
            node["y"] = center_y * scale - float(node["height"]) / 2.0
            can_expand_frame = bool(expandable_frame_ids and frame_id in expandable_frame_ids)
            if not (grew_for_min_font and can_expand_frame):
                _clamp_node_to_scaled_rect(node, frame_rect, scale=scale)

    return slide_child_ids


def _canvas_rect_from_unscaled(rect: Dict[str, float], scale: float) -> Dict[str, float]:
    return {
        "x": float(rect["x"]) * scale,
        "y": float(rect["y"]) * scale,
        "width": float(rect["width"]) * scale,
        "height": float(rect["height"]) * scale,
    }


def _unscaled_rect_from_canvas(rect: Dict[str, float], scale: float) -> Dict[str, float]:
    safe_scale = max(float(scale), 1e-9)
    return {
        "x": float(rect["x"]) / safe_scale,
        "y": float(rect["y"]) / safe_scale,
        "width": float(rect["width"]) / safe_scale,
        "height": float(rect["height"]) / safe_scale,
    }


def _expand_slide_frame_rects_to_child_bounds(
    node_map: Dict[str, Dict[str, Any]],
    children: Dict[str, List[str]],
    slide_frame_ids: List[str],
    container_rects_unscaled: Dict[str, Dict[str, float]],
    scale: float,
) -> set[str]:
    expanded_frame_ids: set[str] = set()
    for frame_id in slide_frame_ids:
        frame_rect = container_rects_unscaled.get(frame_id)
        if not frame_rect:
            continue
        child_ids = [cid for cid in (children.get(frame_id) or []) if cid in node_map]
        if not child_ids:
            continue
        child_bbox = _bbox_of_nodes(node_map, child_ids, padding=0)
        if not child_bbox:
            continue
        frame_canvas = _canvas_rect_from_unscaled(frame_rect, scale)
        if _rect_contains(frame_canvas, child_bbox, eps=1.0):
            continue

        union_canvas = _rect_union(frame_canvas, child_bbox)
        ratio = float(frame_rect["width"]) / max(float(frame_rect["height"]), 1e-9)
        expanded_canvas = _expand_rect_to_aspect_ratio(union_canvas, ratio)
        container_rects_unscaled[frame_id] = _unscaled_rect_from_canvas(expanded_canvas, scale)
        expanded_frame_ids.add(frame_id)
    return expanded_frame_ids


def _collect_descendant_canvas_node_ids(
    children: Dict[str, List[str]],
    node_map: Dict[str, Dict[str, Any]],
    root_id: str,
    out: Optional[set[str]] = None,
) -> set[str]:
    if out is None:
        out = set()
    for child_id in children.get(root_id) or []:
        child_id = str(child_id)
        if child_id in node_map:
            out.add(child_id)
        _collect_descendant_canvas_node_ids(children, node_map, child_id, out)
    return out


def _move_slide_frame_descendants(
    node_map: Dict[str, Dict[str, Any]],
    children: Dict[str, List[str]],
    frame_id: str,
    dx_unscaled: float,
    dy_unscaled: float,
    scale: float,
) -> None:
    dx = dx_unscaled * scale
    dy = dy_unscaled * scale
    for node_id in _collect_descendant_canvas_node_ids(children, node_map, frame_id):
        node = node_map.get(node_id)
        if not isinstance(node, dict):
            continue
        try:
            node["x"] = float(node["x"]) + dx
            node["y"] = float(node["y"]) + dy
        except Exception:
            continue


def _relayout_synthetic_slide_frames_from_current_sizes(
    deck_order: List[str],
    slide_frames_by_deck: Dict[str, List[str]],
    synthetic_slide_frame_ids: set[str],
    container_rects_unscaled: Dict[str, Dict[str, float]],
    children: Dict[str, List[str]],
    node_map: Dict[str, Dict[str, Any]],
    scale: float,
) -> None:
    for did in deck_order:
        frame_ids = [
            fid for fid in slide_frames_by_deck.get(did, [])
            if fid in synthetic_slide_frame_ids and fid in container_rects_unscaled
        ]
        if not frame_ids:
            continue

        rects = [dict(container_rects_unscaled[fid]) for fid in frame_ids]
        min_x = min(float(r["x"]) for r in rects)
        min_y = min(float(r["y"]) for r in rects)
        max_x = max(float(r["x"]) + float(r["width"]) for r in rects)
        max_y = max(float(r["y"]) + float(r["height"]) for r in rects)
        anchor_x = (min_x + max_x) / 2.0
        anchor_y = (min_y + max_y) / 2.0

        max_w = max(float(r["width"]) for r in rects)
        max_h = max(float(r["height"]) for r in rects)
        gap_x = max(24.0, min(80.0, max_w * 0.08))

        new_rects: Dict[str, Dict[str, float]] = {}
        if len(rects) > SYNTHETIC_SLIDE_DECK_TOP_ROW_COUNT:
            top_count = min(SYNTHETIC_SLIDE_DECK_TOP_ROW_COUNT, len(rects))
            top_rects = rects[:top_count]
            trailing_rects = rects[top_count:]
            gap_y = max(48.0, min(96.0, max_h * 0.55))
            top_w = sum(float(r["width"]) for r in top_rects) + gap_x * max(0, len(top_rects) - 1)
            total_w = max(top_w, max((float(r["width"]) for r in trailing_rects), default=0.0))
            total_h = max_h
            if trailing_rects:
                total_h += gap_y * len(trailing_rects)
                total_h += sum(float(r["height"]) for r in trailing_rects)

            start_x = anchor_x - total_w / 2.0
            start_y = anchor_y - total_h / 2.0
            cur_x = start_x
            for fid, rect in zip(frame_ids[:top_count], top_rects):
                width = float(rect["width"])
                height = float(rect["height"])
                new_rects[fid] = {
                    "x": cur_x,
                    "y": start_y + (max_h - height) / 2.0,
                    "width": width,
                    "height": height,
                }
                cur_x += width + gap_x

            cur_y = start_y + max_h + gap_y
            for fid, rect in zip(frame_ids[top_count:], trailing_rects):
                width = float(rect["width"])
                height = float(rect["height"])
                new_rects[fid] = {"x": start_x, "y": cur_y, "width": width, "height": height}
                cur_y += height + gap_y
        else:
            total_w = sum(float(r["width"]) for r in rects) + gap_x * max(0, len(rects) - 1)
            total_h = max_h
            start_x = anchor_x - total_w / 2.0
            start_y = anchor_y - total_h / 2.0
            cur_x = start_x
            for fid, rect in zip(frame_ids, rects):
                width = float(rect["width"])
                height = float(rect["height"])
                new_rects[fid] = {
                    "x": cur_x,
                    "y": start_y + (max_h - height) / 2.0,
                    "width": width,
                    "height": height,
                }
                cur_x += width + gap_x

        for fid, new_rect in new_rects.items():
            old_rect = container_rects_unscaled.get(fid)
            if not old_rect:
                continue
            dx = float(new_rect["x"]) - float(old_rect["x"])
            dy = float(new_rect["y"]) - float(old_rect["y"])
            if abs(dx) > 1e-9 or abs(dy) > 1e-9:
                _move_slide_frame_descendants(node_map, children, fid, dx, dy, scale)
            container_rects_unscaled[fid] = new_rect



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


def _comment_fragment_to_html(value: Any) -> str:
    text = str(value or "").strip()
    if not text:
        return ""
    if _is_html(text):
        return text
    return _html_escape(text, quote=False).replace("\n", "<br>")


def _format_comment_html(item: Dict[str, Any]) -> str:
    status = "Resolved" if item.get("resolved") else "Open"
    created_at = str(item.get("createdAt") or "").strip()
    author = ((item.get("createdBy") or {}).get("name") or "").strip()

    header_bits = [f"<strong>Comment</strong>", _html_escape(status, quote=False)]
    if author:
        header_bits.append(_html_escape(author, quote=False))
    if created_at:
        header_bits.append(_html_escape(created_at[:10], quote=False))

    parts = [f"<p>{' · '.join(header_bits)}</p>"]
    messages = item.get("messages") if isinstance(item.get("messages"), list) else []
    for message in messages:
        if not isinstance(message, dict):
            continue
        msg_author = ((message.get("createdBy") or {}).get("name") or author or "").strip()
        content_html = _comment_fragment_to_html(message.get("content") or message.get("text"))
        if not content_html:
            continue
        if msg_author:
            parts.append(f"<p><strong>{_html_escape(msg_author, quote=False)}:</strong> {content_html}</p>")
        else:
            parts.append(f"<p>{content_html}</p>")

    if len(parts) == 1:
        content_html = _comment_fragment_to_html(item.get("content") or item.get("text") or item.get("title"))
        if content_html:
            parts.append(f"<p>{content_html}</p>")

    return "".join(parts) if len(parts) > 1 else ""


def _format_code_block_html(item: Dict[str, Any], *, font_px: int, theme: str) -> tuple[str, int]:
    data = item.get("data") if isinstance(item.get("data"), dict) else {}
    code = str(data.get("code") or "")
    title = str(data.get("title") or "Code").strip()
    language = str(data.get("language") or "").strip()
    line_numbers = bool(data.get("lineNumbersVisible"))

    header_bits = []
    if title:
        header_bits.append(f"<strong>{_html_escape(title, quote=False)}</strong>")
    if language:
        header_bits.append(
            f'<span style="opacity:0.72">{_html_escape(language, quote=False)}</span>'
        )
    if line_numbers:
        header_bits.append('<span style="opacity:0.58">line-numbers</span>')

    t = (theme or "light").lower()
    pre_bg = "#111827" if t == "dark" else "#f3f4f6"
    border = "#374151" if t == "dark" else "#d1d5db"
    safe_code = _html_escape(code, quote=False)

    html_parts = []
    if header_bits:
        html_parts.append(
            '<p style="margin:0 0 6px 0;">'
            + " · ".join(header_bits)
            + "</p>"
        )
    html_parts.append(
        '<pre style="'
        f"font-family:Consolas, 'Courier New', monospace; "
        f"font-size:{font_px}px; line-height:1.45; "
        "white-space:pre-wrap; margin:0; padding:8px; "
        f"background:{pre_bg}; border:1px solid {border}; border-radius:4px;"
        f'"><code>{safe_code}</code></pre>'
    )

    return "".join(html_parts), max(1, code.count("\n") + 1)


def _estimate_code_block_height(
    code: str,
    *,
    width_px: float,
    font_px: int,
    has_header: bool,
) -> int:
    usable_w = max(1.0, float(width_px) - 40.0)
    max_cols = max(1, int(usable_w / max(1.0, font_px * 0.58)))
    code_lines = 0
    for line in (code.splitlines() or [""]):
        code_lines += max(1, (len(line) + max_cols - 1) // max_cols)
    header_lines = 1 if has_header else 0
    return int((header_lines + code_lines) * font_px * 1.45 + 48)


def _has_canvas_position(item: Dict[str, Any]) -> bool:
    pos = item.get("position")
    return (
        isinstance(pos, dict)
        and pos.get("x") is not None
        and pos.get("y") is not None
    )


def _position_only_placeholder_size(item_type: str) -> tuple[float, float]:
    sizes = {
        "flip_card": (180.0, 240.0),
        "people": (240.0, 150.0),
        "widgets_stack": (260.0, 150.0),
    }
    return sizes.get(item_type, (220.0, 130.0))




# =========================
# Converters
# =========================

def convert_item_to_canvas_node(
    item: Dict[str, Any],
    new_files_folder: str,
    vault_root: str,
    scale: float = 1.0,
    min_font_px: int = 8,
    theme: str = "light",
    grow_text_nodes: bool = False,
    text_style_mode: str = "miro",
) -> Optional[Dict[str, Any]]:
    """
    Размеры и позиция = геометрия Miro * scale.
    Шрифт = (font из Miro) * scale, но не ниже min_font_px.
    Текст сохраняется как HTML (при наличии).
    Для document: ограничение 500x700 (уменьшаем с сохранением пропорций).
    Generic Miro text/shape/sticky nodes preserve source geometry by default.
    If min-font text no longer fits, Obsidian handles the internal overflow.
    """
    item_type = (item.get("type") or "").lower()
    text_style_mode = normalize_text_style_mode(text_style_mode)
    pos = (item.get("position") or {}) if isinstance(item.get("position"), dict) else {}
    geom = (item.get("geometry") or {}) if isinstance(item.get("geometry"), dict) else {}

    width = float(geom.get("width", 250) or 250)

    # высота: если у TEXT отсутствует geometry.height — оценим по контенту
    raw_h = geom.get("height")
    if raw_h is None and item_type == "text":
        base_font_px0 = _extract_font_base_px(item, fallback=OBSIDIAN_FONT_SIZE)
        lh0 = _extract_line_height(item.get("style") or {}, default=1.35)
        content_html = ((item.get("data") or {}).get("content")) or (item.get("plain_text") or "")
        content_html = _strip_edge_empty_paragraphs(content_html)

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
        if not Path(str(local_name)).suffix:
            local_name = f"{local_name}.pdf"
        abs_path = os.path.join(new_files_folder, local_name)
        if not os.path.isfile(abs_path):
            url = _recover_attachment_url(item, "documentUrl", "url")
            if url:
                return {**base, "type": "link", "url": url}
            return None

        rel = relpath_from_vault(abs_path, vault_root)
        node: Dict[str, Any] = {**base, "type": "file", "file": rel}
        max_w, max_h = 500.0, 700.0
        w, h = float(node["width"]), float(node["height"])
        if w > max_w or h > max_h:
            k = min(max_w / max(w, 1e-6), max_h / max(h, 1e-6))
            node["width"], node["height"] = w * k, h * k
        return node


    # ---------- COMMENT SIDECAR -> TEXT ----------
    if item_type == "comment":
        html = _format_comment_html(item)
        if not html:
            return None

        font_px = compute_font_px(scale, 14, min_font_px)
        lh = 1.35
        node_w = max(COMMENT_NODE_WIDTH * scale, 220.0)
        need_h = _estimate_render_height(html, width_px=node_w, font_px=font_px, line_height=lh, padding=48)
        node_h = max(COMMENT_NODE_MIN_HEIGHT, need_h)

        anchor_x = float(pos.get("x", 0) or 0.0) * scale
        anchor_y = float(pos.get("y", 0) or 0.0) * scale
        node = {
            "id": str(item.get("id", "")),
            "type": "text",
            "x": anchor_x + COMMENT_NODE_OFFSET_X,
            "y": anchor_y - node_h / 2.0,
            "width": node_w,
            "height": node_h,
            "color": "#E6E0FF",
            "text": _render_canvas_text(
                html,
                font_px=font_px,
                line_height=lh,
                text_style_mode=text_style_mode,
            ),
        }
        node.setdefault("styleAttributes", {}).update({
            "shape": "round-rectangle",
            "fontSize": font_px,
            "textAlign": "left",
        })
        return node


    # ---------- MINDMAP_NODE -> TEXT ----------
    if item_type == "mindmap_node":
        raw_content = _extract_mindmap_node_content(item)
        if not raw_content:
            return None
        if _is_short_text_label(raw_content):
            raw_content = _compact_short_label_html(raw_content)

        style = _extract_mindmap_node_style(item)
        node: Dict[str, Any] = {**base, "type": "text", "text": ""}
        sa = node.setdefault("styleAttributes", {})

        shape = _extract_mindmap_node_shape(style)
        if shape:
            sa["shape"] = shape

        text_align = style.get("textAlign")
        sa["textAlign"] = text_align if text_align in ("left", "center", "right") else "center"

        bg = _extract_mindmap_node_bg(style)
        if bg:
            node["color"] = bg

        base_font_px = _extract_font_base_px({"style": style, "data": item.get("data") or {}}, fallback=OBSIDIAN_FONT_SIZE)
        lh = _extract_line_height(style, default=1.35)
        font_px = compute_font_px(scale, int(base_font_px), min_font_px)
        sa["fontSize"] = font_px

        text_color = str(style.get("color") or "").strip()
        wrapper_extra_color: Optional[str] = None
        if text_color and not (theme.lower() == "dark" and _is_miro_black_color(text_color)):
            wrapper_extra_color = text_color

        node["text"] = _render_canvas_text(
            raw_content,
            font_px=font_px,
            line_height=lh,
            text_style_mode=text_style_mode,
            wrapper_extra_color=wrapper_extra_color,
        )
        return node


    # ---------- TEXT / SHAPE / STICKY ----------
    if item_type in ("text", "shape", "sticky_note"):
        raw_content = ((item.get("data") or {}).get("content")
                       or item.get("plain_text")
                       or "")
        raw_content = _strip_edge_empty_paragraphs(raw_content)
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

      
        # Базовый кегль из Miro + пересчёт по масштабу
        base_font_px = _extract_font_base_px(item, fallback=OBSIDIAN_FONT_SIZE)
        lh = _extract_line_height(item.get("style") or {}, default=1.35)
        target_px = max(min_font_px, int(round(base_font_px * scale)))
        is_short_label = item_type == "text" and raw_h is None and _is_short_text_label(raw_content)
        if is_short_label:
            raw_content = _compact_short_label_html(raw_content)

        # Доступная область для вписывания текста
        if is_sticky:
            # У стикеров динамический внутренний padding
            pad_w = min(STICKY_TEXT_PADDING, base_w * STICKY_PAD_MAX_RATIO)
            pad_h = min(STICKY_TEXT_PADDING, base_h * STICKY_PAD_MAX_RATIO)
            avail_w = max(1.0, base_w - 2 * pad_w)
            avail_h = max(1.0, base_h - 2 * pad_h)
        else:
            # text / shape: _estimate_render_height сам вычитает 12px внутри
            avail_w = base_w
            avail_h = base_h

        if is_short_label:
            need_h = _estimate_render_height(
                raw_content,
                width_px=avail_w,
                font_px=target_px,
                line_height=lh,
                padding=SHORT_LABEL_RENDER_PADDING,
            )
            if need_h > avail_h:
                cy = float(node["y"]) + float(node["height"]) / 2.0
                node["height"] = need_h
                node["y"] = cy - need_h / 2.0
                base_h = need_h
                avail_h = need_h

        # Подбор кегля: берём target из Miro, уменьшаем только если не влезает
        font_px, needs_grow = _fit_font_px(
            raw_content, avail_w, avail_h,
            target_px=target_px,
            min_font_px=min_font_px,
            line_height=lh,
        )

        sa["fontSize"] = font_px

        # Generic Miro text should not silently expand over neighboring nodes in
        # fit-oriented conversions. The old growth behavior remains opt-in.
        if needs_grow and grow_text_nodes:
            need_h = _estimate_render_height(raw_content, width_px=avail_w,
                                             font_px=font_px, line_height=lh)
            if need_h > avail_h and avail_h > 0:
                grow = need_h / avail_h          # коэффициент роста
                node["width"]  = base_w  * grow
                node["height"] = base_h  * grow

        # ---- Цвет текста ----
        # Если в HTML есть span с background-color — контент из Miro, сохраняем как есть
        # (цвет текста и фон спанов не трогаем, тема игнорируется).
        # Иначе — обычная логика с учётом темы.
        has_span_bgcolor = bool(SPAN_BGCOLOR_RE.search(raw_content)) if _is_html(raw_content) else False

        style_color = ((item.get("style") or {}).get("color") or "").strip()
        content_html = raw_content
        wrapper_extra_color: Optional[str] = None

        if has_span_bgcolor:
            # Есть выделение (background-color на span/strong).
            # style.color из Miro — это цвет «по умолчанию» для всего блока,
            # но он конфликтует с тёмной темой для невыделенного текста.
            # Не ставим wrapper color — невыделенный текст наследует тему Obsidian.
            # Для каждого span/strong с background-color без явного color —
            # добавляем контрастный цвет (#000 или #fff) по W3C luminance.
            wrapper_extra_color = None
            content_html = _inject_contrast_color_on_bgcolor_spans(raw_content)
        elif _is_html(raw_content):
            inline_color = _extract_inline_color(raw_content)
            if inline_color and theme.lower() == "dark" and _is_miro_black_color(inline_color):
                content_html = _strip_inline_black_color(raw_content)
            elif not inline_color and style_color:
                if not (theme.lower() == "dark" and _is_miro_black_color(style_color)):
                    wrapper_extra_color = style_color
        else:
            # plain text
            if style_color and not (theme.lower() == "dark" and _is_miro_black_color(style_color)):
                wrapper_extra_color = style_color

        node["text"] = _render_canvas_text(
            content_html,
            font_px=font_px,
            line_height=lh,
            text_style_mode=text_style_mode,
            wrapper_extra_color=wrapper_extra_color,
        )

        # ---- Solo-URL: text-блок содержит только ссылку → type:link ----
        if item_type == "text":
            solo_url = _extract_solo_url(raw_content)
            if solo_url:
                solo_url = _html_unescape(solo_url)
                # Canvas renders tiny native link nodes as nearly invisible cards.
                _lw, _lh = _link_card_16x9_size(base["width"])
                link_node = {
                    "id":     base["id"],
                    "type":   "link",
                    "url":    solo_url,
                    "x":      base["x"],
                    "y":      base["y"],
                    "width":  _lw,
                    "height": _lh,
                }
                return link_node

        return node



    # ---------- CARD / PREVIEW / APP_CARD → TEXT ----------
    if item_type in ("card", "preview", "app_card"):
        data = item.get("data") or {}
        parts = []
        if data.get("title"):
            parts.append(f"<p>{_html_escape(str(data.get('title')), False)}</p>")
        if data.get("description"):
            parts.append(f"<p>{_html_escape(str(data.get('description')), False)}</p>")
        if item_type == "app_card":
            parts.extend(_format_app_card_fields(data.get("fields")))
        if data.get("url"):
            parts.append(f"<p>{_html_escape(str(data.get('url')), False)}</p>")
        html = "".join(parts) if parts else ""
        if not html:
            return None

        node = {**base, "type": "text", "text": ""}
        base_font_px = _extract_font_base_px(item, fallback=OBSIDIAN_FONT_SIZE)
        lh = _extract_line_height(item.get("style") or {}, default=1.35)
        font_px = compute_font_px(scale, int(base_font_px), min_font_px)
        node.setdefault("styleAttributes", {})["fontSize"] = font_px
        node["text"] = _render_canvas_text(
            html,
            font_px=font_px,
            line_height=lh,
            text_style_mode=text_style_mode,
        )

        # Obsidian adds paragraph margins/padding inside text nodes; use a conservative
        # estimate so app_card fields do not end up behind an internal scrollbar.
        need_h = _estimate_render_height(html or "", width_px=base_w, font_px=font_px, line_height=lh, padding=72)
        if need_h > node["height"]:
            node["height"] = need_h
        return node

    # ---------- CODE → TEXT ----------
    if item_type == "code":
        data = item.get("data") if isinstance(item.get("data"), dict) else {}
        code = str(data.get("code") or "")
        title = str(data.get("title") or "").strip()
        language = str(data.get("language") or "").strip()
        if not code.strip() and not title and not language:
            return None

        base_font_px = _extract_font_base_px(item, fallback=12)
        font_px = compute_font_px(scale, int(base_font_px), min_font_px)
        html, _line_count = _format_code_block_html(item, font_px=font_px, theme=theme)

        node = {**base, "type": "text", "text": ""}
        node.setdefault("styleAttributes", {})["fontSize"] = font_px
        node["text"] = _render_canvas_text(
            html,
            font_px=font_px,
            line_height=1.35,
            text_style_mode=text_style_mode,
        )

        need_h = _estimate_code_block_height(
            code,
            width_px=base_w,
            font_px=font_px,
            has_header=bool(title or language or data.get("lineNumbersVisible")),
        )
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

        if item_type == "image":
            local_name = resolve_image_file_name(item, base["id"])
            local_name = prepare_compact_attachment_reference(
                new_files_folder,
                local_name,
                base["id"],
                "img",
            )
        else:
            local_name = resolve_local_file_name(item, base["id"])
        abs_path = os.path.join(new_files_folder, local_name)
        if os.path.isfile(abs_path) or item_type == "image":
            rel = relpath_from_vault(abs_path, vault_root)
            node = {**base, "type": "file", "file": rel}

            if item_type == "document":
                max_w, max_h = 500.0, 700.0
                w, h = float(node["width"]), float(node["height"])
                if w > max_w or h > max_h:
                    k = min(max_w / max(w, 1e-6), max_h / max(h, 1e-6))
                    node["width"], node["height"] = w * k, h * k
            return node

        url = _recover_attachment_url(
            item,
            "imageUrl" if item_type == "image" else "documentUrl",
            "url",
        )
        if not url:
            return None

        node = {**base, "type": "link", "url": url}

        if item_type == "document":
            max_w, max_h = 500.0, 700.0
            w, h = float(node["width"]), float(node["height"])
            if w > max_w or h > max_h:
                k = min(max_w / max(w, 1e-6), max_h / max(h, 1e-6))
                node["width"], node["height"] = w * k, h * k
        return node

    # ---------- CARD → ТЕКСТОВАЯ НОДА С ЦВЕТОМ ----------
    if item_type == "card":
        data = item.get("data") or {}
        style = item.get("style") or {}

        title_html   = (data.get("title")       or "").strip()
        desc_html    = (data.get("description") or "").strip()
        due_raw      = (data.get("dueDate")     or "").strip()
        assignee_id  = (data.get("assigneeId")  or "").strip()
        card_color   = (style.get("cardTheme")  or "").strip()

        # Форматируем дату из ISO → читаемый вид
        due_str = ""
        if due_raw:
            try:
                import datetime
                dt = datetime.datetime.fromisoformat(due_raw.replace("Z", "+00:00"))
                due_str = dt.strftime("%d.%m.%Y")
            except Exception:
                due_str = due_raw[:10]  # просто первые 10 символов

        # Собираем HTML карточки
        parts: list[str] = []
        if title_html:
            # заголовок — оборачиваем в <strong> если не содержит своих тегов
            if not _is_html(title_html):
                parts.append(f"<p><strong>{_html_escape(title_html, False)}</strong></p>")
            else:
                parts.append(f"<div><strong>{title_html}</strong></div>")
        if desc_html:
            parts.append(desc_html if _is_html(desc_html) else f"<p>{_html_escape(desc_html, False)}</p>")
        meta: list[str] = []
        if due_str:
            meta.append(f"📅 {due_str}")
        if assignee_id:
            meta.append(f"👤 {assignee_id}")
        if meta:
            parts.append(f'<p style="color:#888888">{"  ·  ".join(meta)}</p>')

        content_html = "".join(parts) or "<p></p>"

        base_font_px = _extract_font_base_px(item, fallback=OBSIDIAN_FONT_SIZE)
        lh = _extract_line_height(style, default=1.35)
        font_px = compute_font_px(scale, int(base_font_px), min_font_px)

        node = {**base, "type": "text", "text": ""}
        node.setdefault("styleAttributes", {}).update({
            "shape": "round-rectangle",
            "fontSize": font_px,
        })
        if card_color:
            node["styleAttributes"]["backgroundColor"] = card_color

        node["text"] = _render_canvas_text(
            content_html,
            font_px=font_px,
            line_height=lh,
            text_style_mode=text_style_mode,
        )

        # подгоняем высоту под контент
        need_h = _estimate_render_height(content_html, width_px=base_w, font_px=font_px, line_height=lh)
        if need_h > base_h:
            node["height"] = need_h

        return node

    # ---------- EMBED → FILE (превью) или TEXT (ссылка) ----------
    if item_type == "embed":
        data = item.get("data") or {}
        local_name = item.get("local_name") or ""
        url        = _recover_embed_url(data) or ""
        title      = (data.get("title")        or "").strip()
        provider   = (data.get("providerName") or "").strip()

        # Ширина = miro_width × scale (уже в base["width"]), высота = 16:9.
        # Tiny embed geometry from Miro still needs a visible Canvas link card.
        content_w, content_h = _link_card_16x9_size(base["width"])

        # Допустимые расширения изображений для embed-превью
        _EMBED_IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".svg"}
        local_name_is_image = (
            local_name and
            Path(local_name).suffix.lower() in _EMBED_IMAGE_EXTS
        )

        if local_name_is_image and _attachment_file_exists(new_files_folder, local_name):
            # Скачанное превью — реальное изображение → нода-файл
            local_name = prepare_compact_attachment_reference(
                new_files_folder,
                local_name,
                base["id"],
                "embed",
            )
            if not _attachment_file_exists(new_files_folder, local_name):
                return None
            abs_path = os.path.join(new_files_folder, local_name)
            rel = relpath_from_vault(abs_path, vault_root)
            node = {**base, "type": "file", "file": rel}
            node["width"]  = content_w
            node["height"] = content_h
            return node
        elif url:
            # Превью нет → нативная ссылка-нода Obsidian Canvas (type: "link")
            node = {**base, "type": "link", "url": url}
            node.pop("text", None)
            node["width"]  = content_w
            node["height"] = content_h
            return node
        elif title or provider or data.get("html") or data.get("previewUrl"):
            parts = []
            if title:
                parts.append(f"<p><strong>{_html_escape(title, False)}</strong></p>")
            if provider:
                parts.append(f"<p>{_html_escape(provider, False)}</p>")
            parts.append("<p><em>Embed URL could not be recovered.</em></p>")
            html = "".join(parts)
            node = {**base, "type": "text", "text": ""}
            node.setdefault("styleAttributes", {})["fontSize"] = min_font_px
            node["text"] = _render_canvas_text(
                html,
                font_px=min_font_px,
                line_height=1.35,
                text_style_mode=text_style_mode,
            )
            node["width"] = content_w
            node["height"] = max(content_h, _estimate_render_height(html, width_px=content_w, font_px=min_font_px))
            return node
        else:
            return None

    # ---------- TABLE_TEXT ----------
    # Observed legacy/unsupported table cell exports carry geometry but no cell
    # text, parent table layout, or reliable per-cell canvas position. Rendering
    # those as generic unsupported placeholders creates many useless nodes at
    # (0, 0), so empty table cells are treated as source-limited noise.
    if item_type == "table_text":
        data = item.get("data") if isinstance(item.get("data"), dict) else {}
        raw_content = (
            data.get("content")
            or data.get("text")
            or data.get("title")
            or item.get("plain_text")
            or item.get("title")
            or ""
        )
        if not strip_html(str(raw_content)).strip():
            return None

        raw_content = _strip_edge_empty_paragraphs(str(raw_content))
        base_font_px = _extract_font_base_px(item, fallback=OBSIDIAN_FONT_SIZE)
        lh = _extract_line_height(item.get("style") or {}, default=1.35)
        font_px = compute_font_px(scale, int(base_font_px), min_font_px)
        node = {**base, "type": "text", "text": ""}
        node.setdefault("styleAttributes", {})["fontSize"] = font_px
        node["text"] = _render_canvas_text(
            raw_content,
            font_px=font_px,
            line_height=lh,
            text_style_mode=text_style_mode,
        )
        return node

    # ----------  TAG → TEXT-МЕТКА ----------


    if item_type == "tag":
        if (
            not isinstance(item.get("position"), dict)
            or pos.get("x") is None
            or pos.get("y") is None
            or not isinstance(item.get("geometry"), dict)
            or geom.get("width") is None
            or geom.get("height") is None
        ):
            return None

        title = item.get("title") or (item.get("data") or {}).get("title", "") or ""
        html = f"<p>[Tag] {_html_escape(title, False)}</p>"
        node = {**base, "type": "text", "text": ""}
        base_font_px = _extract_font_base_px(item, fallback=OBSIDIAN_FONT_SIZE)
        lh = _extract_line_height(item.get("style") or {}, default=1.35)
        font_px = compute_font_px(scale, int(base_font_px), min_font_px)
        node.setdefault("styleAttributes", {})["fontSize"] = font_px
        node["text"] = _render_canvas_text(
            html,
            font_px=font_px,
            line_height=lh,
            text_style_mode=text_style_mode,
        )
        need_h = _estimate_render_height(html, width_px=base_w, font_px=font_px, line_height=lh)
        if need_h > node["height"]:
            node["height"] = need_h
        return node

    # ---------- UNSUPPORTED → ЗАГЛУШКА ----------
    # Мета-элементы без контента на доске — молча дропаем
    _META_TYPES = {"board", "board_member"}
    if item_type in _META_TYPES:
        return None

    if item_type in SOURCE_LIMITED_DROP_TYPES:
        return None

    # Если нет geometry, но есть позиция, сохраняем диагностический placeholder:
    # Miro показывает такие unsupported элементы на доске, но не отдаёт их размер.
    if not item.get("geometry"):
        position_only_skip_types = {"data_table_format", "table_text"}
        if item_type not in position_only_skip_types and _has_canvas_position(item):
            default_w, default_h = _position_only_placeholder_size(item_type)
            center_x = float(pos.get("x") or 0.0) * scale
            center_y = float(pos.get("y") or 0.0) * scale
            node_w = max(default_w * scale, 120.0)
            node_h = max(default_h * scale, 80.0)
            label = item_type.replace("_", " ")
            title = (item.get("data") or {}).get("title", "") or item.get("title", "")
            title_part = f": {_html_escape(str(title), False)}" if title else ""
            placeholder_html = (
                f'<p><em>[{label}{title_part}]</em></p>'
                f'<p style="font-size:0.8em; opacity:0.6;">'
                f'Position only; size/content not exposed by Miro API</p>'
            )
            node = {
                "id": str(item.get("id", "")),
                "type": "text",
                "x": center_x - node_w / 2.0,
                "y": center_y - node_h / 2.0,
                "width": node_w,
                "height": node_h,
                "text": _render_canvas_text(
                    placeholder_html,
                    font_px=min_font_px,
                    line_height=1.4,
                    text_style_mode=text_style_mode,
                ),
            }
            node.setdefault("styleAttributes", {})["fontSize"] = min_font_px
            return node

        return None

    # Есть geometry → создаём текстовую заглушку с указанием типа
    label = item_type.replace("_", " ")
    title = (item.get("data") or {}).get("title", "")
    title_part = f": {_html_escape(title, False)}" if title else ""
    placeholder_html = (
        f'<p><em>[{label}{title_part}]</em></p>'
        f'<p style="font-size:0.8em; opacity:0.6;">Тип не поддерживается API Miro</p>'
    )
    node = {**base, "type": "text", "text": ""}
    node.setdefault("styleAttributes", {})["fontSize"] = min_font_px
    node["text"] = _render_canvas_text(
        placeholder_html,
        font_px=min_font_px,
        line_height=1.4,
        text_style_mode=text_style_mode,
    )
    return node

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


def _slide_frame_deck_id(
    mi_frame: Dict[str, Any],
    deck_ids: set,
    children: Dict[str, List[str]],
    deck_order: Optional[List[str]] = None,
) -> Optional[str]:
    """Return the owning slide_container id for a frame, if the source links one."""
    if (mi_frame.get("type") or "").lower() != "frame":
        return None
    if not deck_ids:
        return None

    par = mi_frame.get("parent")
    if isinstance(par, dict) and par.get("id") is not None:
        parent_id = str(par.get("id"))
        if parent_id in deck_ids:
            return parent_id

    fid = str(mi_frame.get("id", "") or "")
    if not fid:
        return None

    for did in (deck_order or list(deck_ids)):
        if did in deck_ids and fid in (children.get(did) or []):
            return did

    return None


def _is_slide_frame(
    mi_frame: Dict[str, Any],
    deck_ids: set,
    children: Dict[str, List[str]],
) -> bool:
    """True, если фрейм относится к slide_container (деке)."""
    return _slide_frame_deck_id(mi_frame, deck_ids, children) is not None


def _resolve_relative_positions_to_canvas_center(by_id: Dict[str, Any]) -> None:
    """
    In-place разрешение позиций parent_top_left / parent_center для узлов,
    чей родитель НЕ является стандартным контейнером (frame/group/diagram/slide_container).
    Обрабатывает деревья mindmap_node, ячейки таблиц (table_text) и любые будущие типы.

    Модифицирует item["position"] напрямую — поскольку by_id хранит те же объекты dict,
    что и all_items, изменения видны везде.
    """
    def abs_center(
        item_id: str,
        _stack: frozenset = frozenset(),
    ) -> Optional[tuple]:
        """Возвращает (cx, cy) абсолютного центра узла в координатах canvas_center."""
        if item_id in _stack:
            return None  # защита от циклических ссылок
        item = by_id.get(item_id)
        if not item:
            return None

        pos    = item.get("position") or {}
        rel    = str(pos.get("relativeTo") or "canvas_center").lower()
        x      = float(pos.get("x") or 0.0)
        y      = float(pos.get("y") or 0.0)
        origin = str(pos.get("origin") or "center").lower()
        geom   = item.get("geometry") or {}
        w      = float(geom.get("width") or 0.0)
        h      = float(geom.get("height") or 0.0)

        if rel == "canvas_center":
            cx = x if origin == "center" else x + w / 2.0
            cy = y if origin == "center" else y + h / 2.0
            return cx, cy

        par_id = str((item.get("parent") or {}).get("id") or "")
        if not par_id:
            return x, y  # нет родителя — считаем позицию абсолютной

        par_pos = abs_center(par_id, _stack | {item_id})
        if par_pos is None:
            return x, y  # не удалось разрешить → fallback

        par_item = by_id.get(par_id)
        p_geom   = (par_item.get("geometry") or {}) if par_item else {}
        p_w      = float(p_geom.get("width") or 0.0)
        p_h      = float(p_geom.get("height") or 0.0)
        p_cx, p_cy   = par_pos
        p_tl_x = p_cx - p_w / 2.0
        p_tl_y = p_cy - p_h / 2.0

        base_x = p_tl_x if rel == "parent_top_left" else p_cx
        base_y = p_tl_y if rel == "parent_top_left" else p_cy

        cx = base_x + x if origin == "center" else base_x + x + w / 2.0
        cy = base_y + y if origin == "center" else base_y + y + h / 2.0
        return cx, cy

    for item in by_id.values():
        pos = item.get("position") or {}
        rel = str(pos.get("relativeTo") or "canvas_center").lower()
        if rel not in ("parent_top_left", "parent_center"):
            continue

        par_id   = str((item.get("parent") or {}).get("id") or "")
        par_item = by_id.get(par_id)
        par_type = str((par_item.get("type") or "") if par_item else "").lower()

        # Стандартные контейнеры обрабатывает _normalize_child_pos_to_canvas — не трогаем
        if par_type in CONTAINER_TYPES:
            continue

        result = abs_center(str(item.get("id") or ""))
        if result is None:
            continue

        item["position"] = dict(pos)
        item["position"].update({
            "x": result[0],
            "y": result[1],
            "relativeTo": "canvas_center",
            "origin": "center",
        })


def _add_mindmap_hierarchy_edges(
    all_items: List[Dict[str, Any]],
    by_id: Dict[str, Dict[str, Any]],
    node_map: Dict[str, Dict[str, Any]],
    edges: List[Dict[str, Any]],
) -> None:
    existing_ids = {str(edge.get("id")) for edge in edges}

    for item in all_items:
        if (item.get("type") or "").lower() != "mindmap_node":
            continue

        child_id = str(item.get("id") or "")
        parent = item.get("parent") if isinstance(item.get("parent"), dict) else {}
        parent_id = str(parent.get("id") or "") if isinstance(parent, dict) else ""
        parent_item = by_id.get(parent_id)

        if not child_id or not parent_id or child_id not in node_map or parent_id not in node_map:
            continue
        if (parent_item.get("type") or "").lower() != "mindmap_node":
            continue

        edge_id = f"mindmap-{parent_id}-{child_id}"
        if edge_id in existing_ids:
            continue

        edges.append({
            "id": edge_id,
            "fromNode": parent_id,
            "toNode": child_id,
        })
        existing_ids.add(edge_id)


def _add_slide_sequence_edges(
    slide_ids: List[str],
    node_map: Dict[str, Dict[str, Any]],
    edges: List[Dict[str, Any]],
) -> None:
    """Advanced Canvas presentation mode follows outgoing edges from metadata.startNode."""
    existing_ids = {str(edge.get("id")) for edge in edges}
    existing_pairs = {
        (str(edge.get("fromNode") or ""), str(edge.get("toNode") or ""))
        for edge in edges
    }

    ordered_slide_ids: List[str] = []
    seen: set[str] = set()
    for slide_id in slide_ids:
        if not slide_id or slide_id in seen or slide_id not in node_map:
            continue
        ordered_slide_ids.append(slide_id)
        seen.add(slide_id)

    for from_id, to_id in zip(ordered_slide_ids, ordered_slide_ids[1:]):
        if (from_id, to_id) in existing_pairs:
            continue

        edge_id = f"slide-sequence-{from_id}-{to_id}"
        if edge_id in existing_ids:
            continue

        edges.append({
            "id": edge_id,
            "fromNode": from_id,
            "toNode": to_id,
            "fromEnd": "none",
            "toEnd": "none",
            "color": "#00000000",
        })
        existing_ids.add(edge_id)
        existing_pairs.add((from_id, to_id))


def convert_miro_to_canvas(
    json_path: str,
    target_dir: str,
    vault_root: str,
    delete_json: bool = False,
    delete_src_files: bool = False,
    scale: float = 1.0,
    min_font_px: int = 8,
    theme: str = "light",
    grow_text_nodes: bool = False,
    text_style_mode: str = "miro",
) -> str:
    """
    Основной конвейер конвертации Miro JSON → Obsidian Canvas.
    Возвращает путь к созданному .canvas.
    """
    base_name = os.path.splitext(os.path.basename(json_path))[0]
    text_style_mode = normalize_text_style_mode(text_style_mode)
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


    # --- разрешение parent_top_left/parent_center для не-контейнерных родителей
    # (mindmap_node, table_text и пр.) — до всех дальнейших вычислений позиций
    _resolve_relative_positions_to_canvas_center(by_id)

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

    # Найдём все slide_container'ы в стабильном порядке исходного JSON.
    deck_order: List[str] = []
    deck_seen: set = set()
    for it in all_items:
        if not isinstance(it, dict) or (it.get("type") or "").lower() not in DECK_TYPES:
            continue
        did = str(it.get("id", "") or "")
        if did and did not in deck_seen:
            deck_order.append(did)
            deck_seen.add(did)
    deck_ids = set(deck_order)

    # Гарантируем, что у каждой деки в children будут только её фреймы-слайды.
    slide_frame_ids: List[str] = []
    slide_frames_by_deck: Dict[str, List[str]] = {}
    for it in containers:
        if (it.get("type") or "").lower() != "frame":
            continue
        did = _slide_frame_deck_id(it, deck_ids, children, deck_order)
        if not did:
            continue
        fid = str(it.get("id", "") or "")
        if not fid:
            continue
        slide_frame_ids.append(fid)
        slide_frames_by_deck.setdefault(did, []).append(fid)

    for did in deck_order:
        lst = children.setdefault(did, [])
        seen = set(lst)
        for fid in slide_frames_by_deck.get(did, []):
            if fid and fid not in seen:
                lst.append(fid)
                seen.add(fid)

    slide_content_scales_by_frame: Dict[str, float] = {}
    slide_content_size_boosts_by_frame: Dict[str, float] = {}
    slide_target_max_side_unscaled = SYNTHETIC_SLIDE_MANUAL_DEFAULT_MAX_SIDE / max(float(scale), 1e-9)
    synthetic_slide_frame_ids = _layout_slide_frames_unscaled(
        by_id,
        deck_order,
        slide_frames_by_deck,
        container_rects_unscaled,
        slide_content_scales_by_frame,
        slide_content_size_boosts_by_frame,
        slide_target_max_side_unscaled,
    )

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
            scale=scale,
            min_font_px=min_font_px,
            theme=theme,
            grow_text_nodes=grow_text_nodes,
            text_style_mode=text_style_mode,
        )
        if node:
            nodes.append(node)
            nid = str(node.get("id", "") or "")
            if nid:
                node_map[nid] = node


    _add_mindmap_hierarchy_edges(all_items, by_id, node_map, edges)

    slide_child_node_ids = _fit_slide_child_nodes_to_frame_rects(
        node_map,
        by_id,
        children,
        slide_frame_ids,
        container_rects_unscaled,
        scale,
        min_font_px,
        content_scales_by_frame=slide_content_scales_by_frame,
        content_size_boosts_by_frame=slide_content_size_boosts_by_frame,
        sub_min_font_frame_ids=synthetic_slide_frame_ids,
        expandable_frame_ids=synthetic_slide_frame_ids,
    )
    slide_child_layout_nodes = [
        node_map[cid] for cid in slide_child_node_ids
        if cid in node_map
    ]
    _compact_tiny_slide_text_heights(slide_child_layout_nodes)
    _resolve_tiny_slide_marker_text_overlaps(slide_child_layout_nodes)
    _resolve_tiny_text_text_vertical_edge_overlaps(slide_child_layout_nodes)
    expanded_slide_frame_ids = _expand_slide_frame_rects_to_child_bounds(
        node_map,
        children,
        list(synthetic_slide_frame_ids),
        container_rects_unscaled,
        scale,
    )
    if expanded_slide_frame_ids:
        _relayout_synthetic_slide_frames_from_current_sizes(
            deck_order,
            slide_frames_by_deck,
            synthetic_slide_frame_ids,
            container_rects_unscaled,
            children,
            node_map,
            scale,
        )
    layout_nodes = [
        node for node in nodes
        if str(node.get("id", "") or "") not in slide_child_node_ids
    ]

    _resolve_text_visual_horizontal_overlaps(layout_nodes, min_font_px=min_font_px)
    _resolve_short_label_visual_vertical_overlaps(layout_nodes)
    _expand_short_inline_label_widths(layout_nodes)
    _compact_short_inline_label_heights(layout_nodes)
    _resolve_ultra_narrow_label_visual_overlaps(layout_nodes)
    _resolve_link_visual_overlaps(layout_nodes)
    _resolve_link_text_edge_overlaps(layout_nodes)
    _resolve_short_label_visual_vertical_overlaps(layout_nodes)
    _resolve_text_visual_vertical_stack_overlaps(layout_nodes)
    _resolve_text_text_vertical_overlaps(layout_nodes)
    _resolve_text_text_horizontal_edge_overlaps(layout_nodes)
    _resolve_short_label_visual_vertical_overlaps(layout_nodes)
    for _ in range(4):
        _compact_short_inline_label_heights(layout_nodes)
        _resolve_ultra_narrow_label_visual_overlaps(layout_nodes)
        _resolve_link_text_edge_overlaps(layout_nodes)
        _resolve_short_label_visual_vertical_overlaps(layout_nodes)
        _resolve_text_visual_vertical_stack_overlaps(layout_nodes)
        _resolve_text_text_vertical_overlaps(layout_nodes)
        _resolve_text_text_horizontal_edge_overlaps(layout_nodes)


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
    for did in deck_order:
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
        is_slide_frame = cid in slide_frame_id_set

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

        # фильтр по центру (для обычных frame/diagram). Для slide frames
        # parent.id авторитетнее: иначе часть содержимого слайда выпадает
        # из Advanced Canvas slide group.
        if is_frame_like and frect and not is_slide_frame:
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
            if is_slide_frame:
                rect = frect or bbox
            elif frect and bbox:
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


    _resolve_synthetic_slide_deck_canvas_overlaps(
        nodes,
        node_map,
        deck_order,
        synthetic_slide_frame_ids,
    )

    for did in deck_order:
        slide_sequence_ids: List[str] = []
        for fid in children.get(did) or []:
            if fid in slide_frame_id_set:
                slide_sequence_ids.append(fid)
        _add_slide_sequence_edges(slide_sequence_ids, node_map, edges)

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
