from __future__ import annotations

import argparse
import json
from collections import Counter
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, Iterable


YES = "yes"
NO = "no"
LIMITED = "limited"
OBSERVED = "observed"
UNKNOWN = "unknown"
META = "metadata"


@dataclass(frozen=True)
class Capability:
    item_type: str
    rest_read: str
    websdk_read: str
    rest_create: str
    websdk_create: str
    converter_output: str
    source_class: str
    notes: str = ""


@dataclass(frozen=True)
class TypeStats:
    count: int = 0
    with_geometry: int = 0
    with_content: int = 0
    unsupported: int = 0
    examples: tuple[str, ...] = ()


@dataclass(frozen=True)
class CoverageRow:
    item_type: str
    rest: TypeStats
    websdk: TypeStats
    capability: Capability
    coverage: str
    action: str


CAPABILITIES: tuple[Capability, ...] = (
    Capability("text", YES, YES, "POST /texts", "createText", "text node", "supported"),
    Capability("shape", YES, YES, "POST /shapes", "createShape", "text node with shape", "supported"),
    Capability("sticky_note", YES, YES, "POST /sticky_notes", "createStickyNote", "text node", "supported"),
    Capability("image", YES, YES, "POST /images", "createImage", "file node", "supported"),
    Capability("document", OBSERVED, LIMITED, "POST /documents", NO, "file node", "supported", "REST enum/export can expose documents."),
    Capability("doc_format", OBSERVED, UNKNOWN, UNKNOWN, UNKNOWN, "file node", "supported", "Observed rich document export."),
    Capability("card", YES, YES, "POST /cards", "createCard", "text node or empty drop", "supported"),
    Capability("app_card", YES, YES, "POST /app_cards", "createAppCard", "text node or empty drop", "supported"),
    Capability("preview", OBSERVED, YES, UNKNOWN, "createPreview", "text node or empty drop", "supported"),
    Capability("embed", YES, YES, "POST /embeds", "createEmbed", "file/link/diagnostic node", "supported"),
    Capability("frame", YES, YES, "POST /frames", "createFrame", "group node", "supported"),
    Capability("diagram", OBSERVED, UNKNOWN, UNKNOWN, UNKNOWN, "group node", "observed"),
    Capability("group", OBSERVED, YES, UNKNOWN, "createGroup", "structural", "observed"),
    Capability("connector", YES, YES, "POST /connectors", "createConnector", "edge", "supported"),
    Capability("tag", OBSERVED, YES, "POST /tags", "createTag", "text label", "observed"),
    Capability("mindmap_node", NO, YES, NO, "experimental.createMindmapNode", "drop/placeholder", "supported"),
    Capability("board", META, META, "POST /boards", NO, "drop", "metadata"),
    Capability("board_member", META, META, NO, NO, "drop", "metadata"),
    Capability("member", META, META, NO, NO, "drop", "metadata"),
    Capability("data_table_format", OBSERVED, LIMITED, NO, NO, "drop", "source_limited"),
    Capability("slide_container", OBSERVED, UNKNOWN, UNKNOWN, UNKNOWN, "drop descendants", "source_limited"),
    Capability("emoji", NO, LIMITED, NO, NO, "drop/placeholder", "source_limited"),
    Capability("kanban", NO, LIMITED, NO, NO, "drop/placeholder", "source_limited"),
    Capability("mindmap", NO, LIMITED, NO, NO, "drop/placeholder", "source_limited", "Legacy/unsupported family; Web SDK experimental emits mindmap_node."),
    Capability("mockup", NO, LIMITED, NO, NO, "drop/placeholder", "source_limited"),
    Capability("stroke", NO, LIMITED, NO, NO, "drop/placeholder", "source_limited"),
    Capability("table", NO, LIMITED, NO, NO, "drop/placeholder", "source_limited"),
    Capability("usm", NO, LIMITED, NO, NO, "drop/placeholder", "source_limited"),
    Capability("code", UNKNOWN, UNKNOWN, UNKNOWN, UNKNOWN, "drop/placeholder", "needs_probe"),
    Capability("wireframe", UNKNOWN, UNKNOWN, UNKNOWN, UNKNOWN, "drop/placeholder", "needs_probe"),
    Capability("webscreen", UNKNOWN, UNKNOWN, UNKNOWN, UNKNOWN, "drop/placeholder", "needs_probe"),
    Capability("svg", UNKNOWN, UNKNOWN, UNKNOWN, UNKNOWN, "drop/placeholder", "needs_probe"),
    Capability("grid", UNKNOWN, UNKNOWN, UNKNOWN, UNKNOWN, "drop/placeholder", "needs_probe"),
    Capability("comment", LIMITED, LIMITED, UNKNOWN, UNKNOWN, "not exported", "separate_source"),
)

CONTENT_KEYS = {
    "content",
    "description",
    "documentUrl",
    "fields",
    "html",
    "imageUrl",
    "previewUrl",
    "title",
    "url",
}


def capability_by_type() -> dict[str, Capability]:
    return {cap.item_type: cap for cap in CAPABILITIES}


def unknown_capability(item_type: str) -> Capability:
    return Capability(item_type, UNKNOWN, UNKNOWN, UNKNOWN, UNKNOWN, "unknown", "unknown")


def load_json(path: Path) -> Any:
    with path.open("r", encoding="utf-8-sig") as f:
        return json.load(f)


def iter_items(value: Any) -> Iterable[dict[str, Any]]:
    if isinstance(value, list):
        for item in value:
            yield from iter_items(item)
        return

    if not isinstance(value, dict):
        return

    if value.get("id") is not None and value.get("type") is not None:
        yield value
        return

    traversed_keys: set[str] = set()
    for key in ("items", "data", "children"):
        nested = value.get(key)
        if isinstance(nested, list):
            yield from iter_items(nested)
            traversed_keys.add(key)
        elif isinstance(nested, dict):
            yield from iter_items(nested)
            traversed_keys.add(key)

    for key, nested in value.items():
        if key in traversed_keys:
            continue
        if isinstance(nested, (dict, list)):
            yield from iter_items(nested)


def normalize_item_type(item: dict[str, Any]) -> str:
    item_type = str(item.get("type") or "").strip().lower()
    if item_type == "item":
        for key in ("subtype", "itemType", "kind"):
            value = str(item.get(key) or "").strip().lower()
            if value:
                return value
    return item_type


def _positive_number(value: Any) -> bool:
    try:
        return float(value) > 0
    except (TypeError, ValueError):
        return False


def has_geometry(item: dict[str, Any]) -> bool:
    item_type = normalize_item_type(item)
    geometry = item.get("geometry") if isinstance(item.get("geometry"), dict) else {}
    position = item.get("position") if isinstance(item.get("position"), dict) else {}
    has_size = _positive_number(geometry.get("width")) and _positive_number(geometry.get("height"))
    has_position = position.get("x") is not None and position.get("y") is not None

    if not has_size:
        has_size = _positive_number(item.get("width")) and _positive_number(item.get("height"))
    if not has_position:
        has_position = item.get("x") is not None and item.get("y") is not None

    if item_type == "text" and has_position and _positive_number(geometry.get("width")):
        return True

    return has_size and has_position


def has_content(item: dict[str, Any]) -> bool:
    for key in CONTENT_KEYS:
        value = item.get(key)
        if value:
            return True

    data = item.get("data") if isinstance(item.get("data"), dict) else {}
    for key in CONTENT_KEYS:
        value = data.get(key)
        if value:
            return True

    for nested_key in (
        "text",
        "shape",
        "sticky_note",
        "card",
        "app_card",
        "document",
        "image",
        "embed",
        "preview",
        "nodeView",
    ):
        nested = item.get(nested_key)
        if not isinstance(nested, dict):
            continue
        for key in CONTENT_KEYS:
            value = nested.get(key)
            if value:
                return True

    return False


def summarize_items(root: Any) -> dict[str, TypeStats]:
    counters: dict[str, Counter[str]] = {}
    examples: dict[str, list[str]] = {}

    for item in iter_items(root):
        item_type = normalize_item_type(item)
        if not item_type:
            continue
        counters.setdefault(item_type, Counter())
        examples.setdefault(item_type, [])
        counters[item_type]["count"] += 1
        if has_geometry(item):
            counters[item_type]["with_geometry"] += 1
        if has_content(item):
            counters[item_type]["with_content"] += 1
        if item.get("isSupported") is False:
            counters[item_type]["unsupported"] += 1
        if len(examples[item_type]) < 3:
            examples[item_type].append(str(item.get("id")))

    return {
        item_type: TypeStats(
            count=counter["count"],
            with_geometry=counter["with_geometry"],
            with_content=counter["with_content"],
            unsupported=counter["unsupported"],
            examples=tuple(examples[item_type]),
        )
        for item_type, counter in counters.items()
    }


def empty_stats() -> TypeStats:
    return TypeStats()


def classify_row(capability: Capability, rest: TypeStats, websdk: TypeStats) -> tuple[str, str]:
    observed_rest = rest.count > 0
    observed_websdk = websdk.count > 0

    if observed_rest and observed_websdk:
        coverage = "both"
    elif observed_rest:
        coverage = "rest_only"
    elif observed_websdk:
        coverage = "websdk_only"
    else:
        coverage = "not_seen"

    if capability.source_class == "metadata":
        return coverage, "metadata"
    if observed_websdk and not observed_rest:
        return coverage, "websdk_export_candidate"
    if observed_rest and capability.converter_output.startswith(("drop", "not exported")):
        if rest.with_geometry or rest.with_content:
            return coverage, "converter_candidate"
        return coverage, "intentional_or_source_limited"
    if observed_rest or observed_websdk:
        return coverage, "covered_or_audit_needed"
    if capability.source_class in {"source_limited", "needs_probe", "separate_source"}:
        return coverage, capability.source_class
    if any(value not in {NO, UNKNOWN, LIMITED} for value in (capability.rest_create, capability.websdk_create)):
        return coverage, "generated_probe_candidate"
    return coverage, "not_prioritized"


def build_coverage_rows(rest_root: Any | None = None, websdk_root: Any | None = None) -> list[CoverageRow]:
    rest_summary = summarize_items(rest_root or [])
    websdk_summary = summarize_items(websdk_root or [])
    capabilities = capability_by_type()
    item_types = sorted(set(capabilities) | set(rest_summary) | set(websdk_summary))

    rows: list[CoverageRow] = []
    for item_type in item_types:
        capability = capabilities.get(item_type, unknown_capability(item_type))
        rest = rest_summary.get(item_type, empty_stats())
        websdk = websdk_summary.get(item_type, empty_stats())
        coverage, action = classify_row(capability, rest, websdk)
        rows.append(CoverageRow(item_type, rest, websdk, capability, coverage, action))
    return rows


def _stats_cell(stats: TypeStats) -> str:
    if stats.count == 0:
        return "-"
    bits = [str(stats.count)]
    if stats.with_geometry:
        bits.append(f"g:{stats.with_geometry}")
    if stats.with_content:
        bits.append(f"c:{stats.with_content}")
    if stats.unsupported:
        bits.append(f"unsupported:{stats.unsupported}")
    return " ".join(bits)


def render_markdown_report(rows: list[CoverageRow]) -> str:
    lines = [
        "# Miro capability probe report",
        "",
        "| Type | REST | Web SDK | Coverage | Converter | Action |",
        "|---|---:|---:|---|---|---|",
    ]

    for row in rows:
        if row.rest.count == 0 and row.websdk.count == 0 and row.action in {"not_prioritized"}:
            continue
        lines.append(
            "| "
            f"`{row.item_type}` | "
            f"{_stats_cell(row.rest)} | "
            f"{_stats_cell(row.websdk)} | "
            f"{row.coverage} | "
            f"{row.capability.converter_output} | "
            f"{row.action} |"
        )

    lines.extend(
        [
            "",
            "Legend: `g` = items with placeable geometry, `c` = items with recoverable content.",
            "Use `websdk_export_candidate` rows to prioritize the Miro app exporter.",
            "Use `converter_candidate` rows to create new `CONV-*` problems only after a fixture exists.",
        ]
    )
    return "\n".join(lines)


def rows_to_json(rows: list[CoverageRow]) -> str:
    payload = []
    for row in rows:
        entry = asdict(row)
        payload.append(entry)
    return json.dumps(payload, ensure_ascii=False, indent=2)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Compare Miro REST/Web SDK exports against the project capability matrix.")
    parser.add_argument("--rest-json", type=Path, help="Miro REST export JSON.")
    parser.add_argument("--websdk-json", type=Path, help="Miro Web SDK export JSON.")
    parser.add_argument("--format", choices=("markdown", "json"), default="markdown")
    parser.add_argument("--output", type=Path, help="Optional report output path.")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    rest_root = load_json(args.rest_json) if args.rest_json else []
    websdk_root = load_json(args.websdk_json) if args.websdk_json else []
    rows = build_coverage_rows(rest_root, websdk_root)
    report = rows_to_json(rows) if args.format == "json" else render_markdown_report(rows)

    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(report + "\n", encoding="utf-8")
    else:
        print(report)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
