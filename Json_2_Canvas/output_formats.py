"""Board-format transforms for the four export shapes miro2obsidian can write.

`Json_2_Canvas.Converter.convert_miro_to_canvas` always produces the
Advanced-Canvas-flavoured board: HTML text, `styleAttributes`, group `nodes`
lists, image `ratio`, and the `metadata`/`miroSource` root keys. The functions
here take that board dict and reshape it into the other two board formats the
project promises (plain JSON Canvas 1.0 for `native-canvas`, plus `miroSource`
and `miroCanvas` for the plugin's `miro-canvas`). `raw-json` and
`advanced-canvas` are not board transforms - `advanced-canvas` is today's
output as-is, and `raw-json` has no board at all - so they are not represented
as functions here; callers branch on them before reaching this module.

Every function is pure: it reads its `board` argument and returns a new dict,
never mutating what it was given.
"""

from __future__ import annotations

import copy
from typing import Any

from Json_2_Canvas.Converter import _html_to_markdown_fragment, _is_html

#: The board format Converter.py writes today; the regression suite pins its
#: byte-for-byte output to this shape.
ADVANCED_CANVAS = "advanced-canvas"

#: Plain JSON Canvas 1.0: no plugin required, Markdown text instead of HTML.
NATIVE_CANVAS = "native-canvas"

#: Native-canvas nodes/edges plus the untouched miroSource, for the
#: miro-canvas plugin to draw the Miro look from.
MIRO_CANVAS = "miro-canvas"

#: No board at all: the canonical Miro export JSON as the pipeline produced it.
RAW_JSON = "raw-json"

#: Every format `--format`/the GUI's Format menu accepts, in the order they
#: are offered to a user (today's default first).
OUTPUT_FORMATS = (ADVANCED_CANVAS, NATIVE_CANVAS, MIRO_CANVAS, RAW_JSON)

#: JSON Canvas 1.0 node fields, plus `subpath` (a same-file heading/block
#: anchor JSON Canvas already defines for `file` nodes). Advanced-Canvas-only
#: fields such as `styleAttributes`, `ratio`, and a group's own `nodes` list
#: are deliberately not in this tuple, so `_sanitized_node` drops them.
_NODE_FIELDS = (
    "id",
    "type",
    "x",
    "y",
    "width",
    "height",
    "color",
    "text",
    "file",
    "subpath",
    "url",
    "label",
    "background",
    "backgroundStyle",
)

#: JSON Canvas 1.0 edge fields. Advanced-Canvas-only fields such as an edge's
#: `styleAttributes` are deliberately not in this tuple.
_EDGE_FIELDS = (
    "id",
    "fromNode",
    "fromSide",
    "fromEnd",
    "toNode",
    "toSide",
    "toEnd",
    "color",
    "label",
)


def normalize_output_format(value: str | None) -> str:
    """The canonical spelling of an `--format`/Format-menu value, or raise."""
    normalized = (value or ADVANCED_CANVAS).strip().lower()
    if normalized not in OUTPUT_FORMATS:
        raise ValueError(
            f"Unknown output format: {value!r}. Expected one of: "
            + ", ".join(OUTPUT_FORMATS)
        )
    return normalized


def _sanitized_text(text: Any) -> Any:
    """A node's `text` value, with any Miro-authored HTML turned into Markdown.

    Converter.py always wraps `text` node content in an HTML `<div>`/`<span>`
    (even plain content, for its inline font-size styling), so this is what
    strips that wrapper along with any rich inline markup, keeping bold,
    italic, links, and lists as Markdown with no HTML tags left.
    """
    if isinstance(text, str) and _is_html(text):
        return _html_to_markdown_fragment(text)
    return text


def _sanitized_node(node: dict[str, Any]) -> dict[str, Any]:
    sanitized = {field: node[field] for field in _NODE_FIELDS if field in node}
    if "text" in sanitized:
        sanitized["text"] = _sanitized_text(sanitized["text"])
    return sanitized


def _sanitized_edge(edge: dict[str, Any]) -> dict[str, Any]:
    return {field: edge[field] for field in _EDGE_FIELDS if field in edge}


def to_native_canvas(board: dict[str, Any]) -> dict[str, Any]:
    """Plain JSON Canvas 1.0: only the spec's own node/edge fields, no HTML text."""
    nodes = [_sanitized_node(node) for node in board.get("nodes") or []]
    edges = [_sanitized_edge(edge) for edge in board.get("edges") or []]
    return {"nodes": nodes, "edges": edges}


def to_miro_canvas(board: dict[str, Any]) -> dict[str, Any]:
    """`native-canvas` nodes/edges, plus the untouched `miroSource` and a
    `miroCanvas` marker for the plugin. Node ids are already the Miro item
    ids Converter.py used, so the plugin binds a node to its source item by
    id alone; nothing else of Advanced Canvas needs to survive here."""
    board_for_plugin = to_native_canvas(board)
    if "miroSource" in board:
        board_for_plugin["miroSource"] = copy.deepcopy(board["miroSource"])
    board_for_plugin["miroCanvas"] = {"schemaVersion": 1}
    return board_for_plugin


def apply_output_format(board: dict[str, Any], output_format: str) -> dict[str, Any]:
    """Reshape an advanced-canvas board dict into `output_format`.

    Only the two new board formats go through here; `advanced-canvas` needs no
    rewrite and `raw-json` has no board, so callers handle those before
    reaching this function.
    """
    if output_format == NATIVE_CANVAS:
        return to_native_canvas(board)
    if output_format == MIRO_CANVAS:
        return to_miro_canvas(board)
    raise ValueError(f"{output_format!r} is not a board transform")
