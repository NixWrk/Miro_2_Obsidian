from __future__ import annotations

import argparse
import html
import json
import re
import sys
from collections import Counter
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable


REPO_ROOT = Path(__file__).resolve().parents[1]
CONVERTER_DIR = REPO_ROOT / "Json_2_Canvas"
DEFAULT_LIMIT = 50
SOURCE_LIMITED_UNSUPPORTED_TYPES = {
    "dynamic_poll",
    "flip_card",
    "people",
    "prototyping_screen",
    "widgets_stack",
}


@dataclass(frozen=True)
class MissingMiroItem:
    item_id: str
    item_type: str
    reason: str
    detail: str = ""
    title: str = ""
    actionable: bool = False


def load_json(path: Path) -> Any:
    with path.open("r", encoding="utf-8-sig") as f:
        return json.load(f)


def text_snippet(item: dict[str, Any], *, max_len: int = 120) -> str:
    data = item.get("data") if isinstance(item.get("data"), dict) else {}
    raw = (
        data.get("title")
        or data.get("content")
        or data.get("description")
        or data.get("url")
        or item.get("title")
        or ""
    )
    plain = html.unescape(re.sub(r"<[^>]+>", " ", str(raw)))
    plain = re.sub(r"\s+", " ", plain).strip()
    if len(plain) <= max_len:
        return plain
    return plain[: max_len - 1].rstrip() + "..."


def represented_canvas_ids(canvas_root: dict[str, Any]) -> set[str]:
    represented: set[str] = set()
    for node in canvas_root.get("nodes", []):
        if isinstance(node, dict) and node.get("id") is not None:
            represented.add(str(node["id"]))
    for edge in canvas_root.get("edges", []):
        if isinstance(edge, dict) and edge.get("id") is not None:
            represented.add(str(edge["id"]))
    return represented


def _card_like_has_content(item: dict[str, Any]) -> bool:
    data = item.get("data") if isinstance(item.get("data"), dict) else {}
    if any(data.get(key) for key in ("title", "description", "url", "dueDate", "assigneeId")):
        return True
    fields = data.get("fields")
    return isinstance(fields, list) and any(fields)


def _embed_has_resolvable_output(item: dict[str, Any]) -> bool:
    data = item.get("data") if isinstance(item.get("data"), dict) else {}
    local_name = str(item.get("local_name") or "")
    if data.get("url"):
        return True
    if local_name and Path(local_name).suffix.lower() in {".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".svg"}:
        return True
    return False


def _table_like_has_recoverable_content(item: dict[str, Any]) -> bool:
    data = item.get("data") if isinstance(item.get("data"), dict) else {}
    values = (
        data.get("content"),
        data.get("text"),
        data.get("title"),
        item.get("plain_text"),
        item.get("title"),
    )
    return any(str(value or "").strip() for value in values)


def _has_canvas_position(item: dict[str, Any]) -> bool:
    position = item.get("position") if isinstance(item.get("position"), dict) else {}
    return position.get("x") is not None and position.get("y") is not None


def _has_recoverable_content(item: dict[str, Any]) -> bool:
    sys.path.insert(0, str(CONVERTER_DIR))
    from Converter import has_recoverable_item_content  # noqa: WPS433

    return has_recoverable_item_content(item)


def classify_missing_item(item: dict[str, Any]) -> MissingMiroItem:
    item_id = str(item.get("id") or "")
    item_type = str(item.get("type") or "").lower()
    title = text_snippet(item)
    data = item.get("data") if isinstance(item.get("data"), dict) else {}

    if item_type in {"board", "board_member"}:
        return MissingMiroItem(item_id, item_type, "board_metadata", "Board root metadata is not a Canvas element.", title)

    if item_type == "comment":
        return MissingMiroItem(
            item_id,
            item_type,
            "comment_missing_from_canvas",
            "Comment identity, content, or metadata should be preserved as a Canvas annotation.",
            title,
            actionable=True,
        )

    if _has_recoverable_content(item):
        return MissingMiroItem(
            item_id,
            item_type,
            "recoverable_content_missing",
            "Source exposes recoverable content; converter should preserve it in a generic placeholder.",
            title,
            actionable=True,
        )

    if item_type in {"card", "preview", "app_card"} and not _card_like_has_content(item):
        return MissingMiroItem(
            item_id,
            item_type,
            "empty_card_like_item",
            "No title, description, url, or app fields; converter drops it to avoid invisible nodes.",
            title,
        )

    if item_type == "embed" and not _embed_has_resolvable_output(item):
        html_value = str(data.get("html") or "")
        has_html = bool(html_value.strip())
        has_preview = bool(str(data.get("previewUrl") or "").strip())
        detail = "No local image preview and data.url is empty."
        if has_html or has_preview:
            detail += " HTML/preview metadata exists, so this is likely recoverable."
        return MissingMiroItem(
            item_id,
            item_type,
            "embed_without_resolvable_url",
            detail,
            title,
            actionable=has_html or has_preview,
        )

    if item_type in {"data_table_format", "table_text"} and not _table_like_has_recoverable_content(item):
        return MissingMiroItem(
            item_id,
            item_type,
            "table_source_limited",
            "Miro export exposes no recoverable table cell text/layout for this item.",
            title,
        )

    if item_type == "table" and not _table_like_has_recoverable_content(item):
        return MissingMiroItem(
            item_id,
            item_type,
            "table_source_limited",
            "Miro export exposes table geometry but no recoverable cell text/layout.",
            title,
        )

    if item_type in SOURCE_LIMITED_UNSUPPORTED_TYPES:
        return MissingMiroItem(
            item_id,
            item_type,
            "source_limited_unsupported_content",
            "Current Miro export exposes no recoverable content for this unsupported item family.",
            title,
        )

    if item_type == "connector":
        start = (item.get("startItem") or {}).get("id") if isinstance(item.get("startItem"), dict) else None
        end = (item.get("endItem") or {}).get("id") if isinstance(item.get("endItem"), dict) else None
        if not (start and end):
            return MissingMiroItem(
                item_id,
                item_type,
                "connector_without_endpoints",
                "Connector has no complete startItem/endItem ids.",
                title,
            )
        return MissingMiroItem(
            item_id,
            item_type,
            "connector_missing_from_canvas",
            f"Connector {start}->{end} has endpoints but no Canvas edge.",
            title,
            actionable=True,
        )

    if not item.get("geometry"):
        if item_type not in {"tag", "data_table_format", "table_text"} and _has_canvas_position(item):
            return MissingMiroItem(
                item_id,
                item_type,
                "unsupported_position_only",
                "Source exposes a board position but no size/content; converter should keep a diagnostic placeholder.",
                title,
                actionable=True,
            )
        return MissingMiroItem(
            item_id,
            item_type,
            "unsupported_without_geometry",
            "No geometry/content that can be placed as a Canvas node.",
            title,
        )

    return MissingMiroItem(item_id, item_type, "unclassified_missing_item", "Not represented and not covered by a known skip rule.", title, actionable=True)


def _requires_file_node(item: dict[str, Any]) -> bool:
    return (
        str(item.get("type") or "").lower() in {"image", "document", "doc_format", "embed"}
        and bool(str(item.get("local_name") or "").strip())
    )


def audit_missing_items(miro_root: Any, canvas_root: dict[str, Any]) -> list[MissingMiroItem]:
    sys.path.insert(0, str(CONVERTER_DIR))
    from Converter import iter_objects, source_completeness_issues  # noqa: WPS433

    represented = represented_canvas_ids(canvas_root)
    nodes_by_id: dict[str, list[dict[str, Any]]] = {}
    for node in canvas_root.get("nodes", []):
        if isinstance(node, dict) and node.get("id") is not None:
            nodes_by_id.setdefault(str(node["id"]), []).append(node)
    missing: list[MissingMiroItem] = []
    completeness_issues = source_completeness_issues(miro_root)
    if completeness_issues:
        coverage_only = completeness_issues == ["completeness.board_complete is false"]
        missing.append(MissingMiroItem(
            "__source__",
            "source",
            "source_coverage_limited" if coverage_only else "source_incomplete",
            "; ".join(completeness_issues),
            actionable=not coverage_only,
        ))
    for item in iter_objects(miro_root):
        if not isinstance(item, dict) or item.get("id") is None:
            continue
        item_id = str(item["id"])
        if item_id in represented:
            if _requires_file_node(item) and not any(
                str(node.get("type") or "") == "file" for node in nodes_by_id.get(item_id, [])
            ):
                missing.append(MissingMiroItem(
                    item_id,
                    str(item.get("type") or "").lower(),
                    "required_asset_not_represented",
                    f"Source declares local asset {item.get('local_name')!r}, but Canvas has no file node.",
                    text_snippet(item),
                    actionable=True,
                ))
            continue
        missing.append(classify_missing_item(item))
    return missing


def format_summary(missing: Iterable[MissingMiroItem], *, limit: int = DEFAULT_LIMIT) -> str:
    missing = list(missing)
    by_reason = Counter(item.reason for item in missing)
    by_type = Counter(item.item_type for item in missing)
    actionable = [item for item in missing if item.actionable]

    lines = [
        f"missing_items={len(missing)}",
        "by_reason=" + ", ".join(f"{key}:{value}" for key, value in sorted(by_reason.items())),
        "by_type=" + ", ".join(f"{key}:{value}" for key, value in sorted(by_type.items())),
        f"actionable={len(actionable)}",
    ]

    for item in missing[:limit]:
        title = f" title={item.title!r}" if item.title else ""
        flag = " actionable" if item.actionable else ""
        lines.append(
            f"- {item.item_id}:{item.item_type} reason={item.reason}{flag}; {item.detail}{title}"
        )
    if len(missing) > limit:
        lines.append(f"... +{len(missing) - limit} more")
    return "\n".join(lines)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Report Miro items not represented in a JSON Canvas output.")
    parser.add_argument("miro_json", type=Path)
    parser.add_argument("canvas_json", type=Path)
    parser.add_argument("--limit", type=int, default=DEFAULT_LIMIT)
    parser.add_argument("--actionable-only", action="store_true")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    missing = audit_missing_items(load_json(args.miro_json), load_json(args.canvas_json))
    if args.actionable_only:
        missing = [item for item in missing if item.actionable]
    print(format_summary(missing, limit=args.limit))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
