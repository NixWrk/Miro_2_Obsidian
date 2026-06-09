from __future__ import annotations

import argparse
import json
import sys
from copy import deepcopy
from pathlib import Path
from typing import Any


REPO_ROOT = Path(__file__).resolve().parents[1]
SCRIPTS_DIR = REPO_ROOT / "scripts"
sys.path.insert(0, str(SCRIPTS_DIR))

from miro_capability_probe import iter_items, load_json, normalize_item_type  # noqa: E402


def _first_nonempty(*values: Any) -> Any:
    for value in values:
        if value not in (None, "", [], {}):
            return value
    return None


def _nested(item: dict[str, Any], *keys: str) -> Any:
    current: Any = item
    for key in keys:
        if not isinstance(current, dict):
            return None
        current = current.get(key)
    return current


def _websdk_position(item: dict[str, Any]) -> dict[str, Any] | None:
    if isinstance(item.get("position"), dict):
        return deepcopy(item["position"])
    x = _first_nonempty(item.get("x"), _nested(item, "bounds", "x"))
    y = _first_nonempty(item.get("y"), _nested(item, "bounds", "y"))
    if x is None or y is None:
        return None
    return {"x": x, "y": y}


def _websdk_geometry(item: dict[str, Any]) -> dict[str, Any] | None:
    if isinstance(item.get("geometry"), dict):
        return deepcopy(item["geometry"])
    width = _first_nonempty(item.get("width"), _nested(item, "bounds", "width"))
    height = _first_nonempty(item.get("height"), _nested(item, "bounds", "height"))
    if width is None or height is None:
        return None
    return {"width": width, "height": height}


def _websdk_title(item: dict[str, Any]) -> str:
    value = _first_nonempty(
        item.get("title"),
        item.get("content"),
        item.get("plainText"),
        _nested(item, "data", "title"),
        _nested(item, "text", "content"),
        _nested(item, "shape", "content"),
        _nested(item, "sticky_note", "content"),
    )
    return str(value or "")


def normalize_websdk_item(item: dict[str, Any]) -> dict[str, Any]:
    item_type = normalize_item_type(item)
    normalized: dict[str, Any] = {
        "id": str(item.get("id")),
        "type": item_type,
        "source": "web_sdk",
        "source_surfaces": ["web_sdk"],
        "websdk_item": deepcopy(item),
    }

    position = _websdk_position(item)
    geometry = _websdk_geometry(item)
    if position:
        normalized["position"] = position
    if geometry:
        normalized["geometry"] = geometry

    title = _websdk_title(item)
    if title:
        normalized["title"] = title
        normalized["data"] = {"title": title}

    if item_type == "text":
        content = _first_nonempty(item.get("content"), _nested(item, "text", "content"), title)
        normalized.setdefault("data", {})["content"] = str(content or "")
    elif item_type == "shape":
        data = normalized.setdefault("data", {})
        data["content"] = str(_first_nonempty(item.get("content"), _nested(item, "shape", "content"), title) or "")
        shape = _first_nonempty(item.get("shape"), _nested(item, "shape", "shape"))
        if shape:
            data["shape"] = shape
    elif item_type == "sticky_note":
        normalized.setdefault("data", {})["content"] = str(
            _first_nonempty(item.get("content"), _nested(item, "sticky_note", "content"), title) or ""
        )
    elif item_type in {"card", "app_card", "preview", "embed"}:
        data = normalized.setdefault("data", {})
        for key in ("title", "description", "url", "html", "previewUrl", "fields"):
            value = _first_nonempty(item.get(key), _nested(item, "data", key))
            if value:
                data[key] = value

    return normalized


def merge_sources(rest_root: Any, websdk_root: Any) -> list[dict[str, Any]]:
    rest_items = [deepcopy(item) for item in iter_items(rest_root)]
    websdk_items = [deepcopy(item) for item in iter_items(websdk_root)]
    websdk_by_id = {str(item.get("id")): item for item in websdk_items if item.get("id") is not None}

    merged: list[dict[str, Any]] = []
    seen_ids: set[str] = set()
    for item in rest_items:
        item_id = str(item.get("id"))
        seen_ids.add(item_id)
        surfaces = list(dict.fromkeys([*(item.get("source_surfaces") or []), "rest"]))
        if item_id in websdk_by_id:
            surfaces = list(dict.fromkeys([*surfaces, "web_sdk"]))
            item["websdk_item"] = websdk_by_id[item_id]
        item["source_surfaces"] = surfaces
        merged.append(item)

    for item in websdk_items:
        item_id = str(item.get("id"))
        if item_id in seen_ids:
            continue
        merged.append(normalize_websdk_item(item))

    return merged


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Merge REST and Web SDK Miro exports into one converter-ready source JSON.")
    parser.add_argument("--rest-json", type=Path, required=True)
    parser.add_argument("--websdk-json", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    merged = merge_sources(load_json(args.rest_json), load_json(args.websdk_json))
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(merged, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"merged_items={len(merged)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
