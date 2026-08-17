from __future__ import annotations

import argparse
import math
from copy import deepcopy
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterable


REPO_ROOT = Path(__file__).resolve().parents[1]
SCRIPTS_DIR = REPO_ROOT / "scripts"

from scripts.miro_capability_probe import iter_items, load_json, normalize_item_type  # noqa: E402
from scripts.miro_export_bundle import (  # noqa: E402
    copy_referenced_sidecar,
    publish_staged_bundle,
    staged_export_path,
)
from scripts.miro_rest_export_board import (  # noqa: E402
    download_export_assets,
    stable_enrichment_items,
    summarize_export_asset_requirements,
    validate_export_assets,
    validate_optional_export_assets,
    validate_rest_payload_integrity,
    write_json,
)


CANONICAL_SCHEMA_VERSION = 1
CANONICAL_EXPORTER_VERSION = "miro2obs-merge-2"
WEBSDK_SCHEMA_VERSION = 1
WEBSDK_EXPORTER_VERSION = "20260727-complete-json"
WEBSDK_CAPTURE_PROFILE = "maximum_board_v1"
WEBSDK_ITEM_SCOPE = "api_exposed_board_items"
WEBSDK_COMMENT_SCOPE = "api_exposed_board_comments"
WEBSDK_COVERAGE_BASIS = "miro.board.get_api_surface"
WEBSDK_KNOWN_LIMITATIONS = (
    "unsupported_item_details_unavailable",
    "unsupported_parent_children_not_enumerated",
    "comment_content_unavailable",
)
WEBSDK_JSON_PRESERVING_MARKER_KINDS = {
    "undefined",
    "non_finite_number",
    "bigint",
    "invalid_date",
}
CANONICAL_COVERAGE_BASIS = "rest_plus_web_sdk_union"
CANONICAL_KNOWN_LIMITATIONS = (
    "public_api_exposed_data_only",
    "unsupported_parent_children_not_enumerated",
)
DEFAULT_MAX_SOURCE_AGE_HOURS = 24.0
DEFAULT_MAX_SOURCE_SKEW_MINUTES = 60.0
_EMPTY_VALUES = (None, "", [], {})


def _first_nonempty(*values: Any) -> Any:
    for value in values:
        if value not in _EMPTY_VALUES:
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


def _normalized_data(item: dict[str, Any]) -> dict[str, Any]:
    data = item.get("data")
    if not isinstance(data, dict):
        data = {}
        item["data"] = data
    return data


def normalize_websdk_item(item: dict[str, Any]) -> dict[str, Any]:
    normalized = deepcopy(item)
    normalized["id"] = str(item.get("id"))
    normalized["type"] = normalize_item_type(item)
    normalized["source"] = str(item.get("source") or "web_sdk")
    normalized["source_surfaces"] = list(
        dict.fromkeys([*(item.get("source_surfaces") or []), "web_sdk"])
    )

    position = _websdk_position(item)
    geometry = _websdk_geometry(item)
    if position and not isinstance(normalized.get("position"), dict):
        normalized["position"] = position
    if geometry and not isinstance(normalized.get("geometry"), dict):
        normalized["geometry"] = geometry

    title = _websdk_title(item)
    if title:
        normalized.setdefault("title", title)
        _normalized_data(normalized).setdefault("title", title)

    item_type = normalized["type"]
    if item_type == "text":
        content = _first_nonempty(
            item.get("content"), _nested(item, "text", "content"), title
        )
        _normalized_data(normalized).setdefault("content", str(content or ""))
    elif item_type == "shape":
        data = _normalized_data(normalized)
        data.setdefault(
            "content",
            str(
                _first_nonempty(
                    item.get("content"), _nested(item, "shape", "content"), title
                )
                or ""
            ),
        )
        shape = _first_nonempty(item.get("shape"), _nested(item, "shape", "shape"))
        if shape:
            data.setdefault("shape", shape)
    elif item_type == "sticky_note":
        _normalized_data(normalized).setdefault(
            "content",
            str(
                _first_nonempty(
                    item.get("content"), _nested(item, "sticky_note", "content"), title
                )
                or ""
            ),
        )
    elif item_type == "image":
        image_url = _first_nonempty(
            item.get("imageUrl"), item.get("url"), _nested(item, "data", "imageUrl")
        )
        if image_url:
            _normalized_data(normalized).setdefault("imageUrl", str(image_url))
    elif item_type == "document":
        document_url = _first_nonempty(
            item.get("documentUrl"),
            item.get("url"),
            _nested(item, "data", "documentUrl"),
        )
        if document_url:
            _normalized_data(normalized).setdefault(
                "documentUrl", str(document_url)
            )
    elif item_type in {"card", "app_card", "preview", "embed"}:
        data = _normalized_data(normalized)
        for key in ("title", "description", "url", "html", "previewUrl", "fields"):
            value = _first_nonempty(item.get(key), _nested(item, "data", key))
            if value not in _EMPTY_VALUES:
                data.setdefault(key, deepcopy(value))

    return normalized


def source_board_id(payload: Any) -> str:
    if not isinstance(payload, dict):
        return ""
    board = payload.get("board") if isinstance(payload.get("board"), dict) else {}
    for key in ("id", "boardId", "board_id"):
        value = str(board.get(key) or payload.get(key) or "").strip()
        if value:
            return value
    url = str(board.get("url") or board.get("appUrl") or "").strip()
    if "/board/" in url:
        return url.split("/board/", 1)[1].split("/", 1)[0].split("?", 1)[0]
    return ""


def parse_exported_at(value: Any, *, source_label: str = "Web SDK") -> datetime:
    text = str(value or "").strip()
    if not text:
        raise ValueError(f"{source_label} export is missing exported_at")
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError as exc:
        raise ValueError(f"Invalid {source_label} exported_at: {text}") from exc
    if parsed.tzinfo is None:
        raise ValueError(f"{source_label} exported_at must include a timezone")
    return parsed.astimezone(timezone.utc)


def _finite_limit(value: Any, *, label: str) -> float:
    if (
        isinstance(value, bool)
        or not isinstance(value, (int, float))
        or not math.isfinite(float(value))
    ):
        raise ValueError(f"{label} must be a finite number")
    return float(value)


def _nonnegative_int(value: Any, *, label: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise ValueError(f"{label} must be a nonnegative integer")
    return value


def _validate_comment_list(
    payload: dict[str, Any], *, source_label: str
) -> list[dict[str, Any]]:
    comments = payload.get("comments")
    if not isinstance(comments, list) or any(
        not isinstance(comment, dict) for comment in comments
    ):
        raise ValueError(f"{source_label} export comments must be a list of objects")
    seen_ids: set[str] = set()
    for index, comment in enumerate(comments):
        comment_id = str(comment.get("id") or "").strip()
        if not comment_id:
            raise ValueError(f"{source_label} comment #{index} is missing id")
        if comment_id in seen_ids:
            raise ValueError(
                f"{source_label} export contains duplicate comment id: {comment_id}"
            )
        seen_ids.add(comment_id)
    return comments


def _validate_item_list(
    payload: dict[str, Any], *, source_label: str
) -> list[dict[str, Any]]:
    items = payload.get("items")
    if not isinstance(items, list):
        raise ValueError(f"{source_label} export items must be a list")
    seen_ids: set[str] = set()
    for index, item in enumerate(items):
        if not isinstance(item, dict):
            raise ValueError(f"{source_label} item #{index} must be an object")
        item_id = str(item.get("id") or "").strip()
        item_type = str(item.get("type") or "").strip()
        if not item_id or not item_type:
            raise ValueError(f"{source_label} item #{index} is missing id or type")
        if item_id in seen_ids:
            raise ValueError(
                f"{source_label} export contains duplicate item id: {item_id}"
            )
        seen_ids.add(item_id)
    return items


def _validate_serialization_annotations(
    value: Any, *, label: str
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    if not isinstance(value, dict):
        raise ValueError(f"{label} must be an object")
    issues = value.get("issues")
    if not isinstance(issues, list):
        raise ValueError(f"{label}.issues must be a list")
    errors = value.get("errors", issues)
    if not isinstance(errors, list):
        raise ValueError(f"{label}.errors must be a list")
    if errors:
        raise ValueError(f"{label} must contain no serialization errors")
    for index, issue in enumerate(issues):
        if not isinstance(issue, dict):
            raise ValueError(f"{label}.issues[{index}] must be an object")
        kind = str(issue.get("kind") or "").strip()
        path = str(issue.get("path") or "").strip()
        if not path:
            raise ValueError(f"{label}.issues[{index}].path is required")
        if kind not in WEBSDK_JSON_PRESERVING_MARKER_KINDS:
            raise ValueError(
                f"{label}.issues[{index}].kind is not JSON-preserving: {kind!r}"
            )
    return issues, errors


def validate_websdk_export(
    payload: Any,
    *,
    expected_board_id: str | None = None,
    max_age_hours: float = DEFAULT_MAX_SOURCE_AGE_HOURS,
    now: datetime | None = None,
) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise ValueError("Web SDK export must be a JSON object")
    max_age_hours = _finite_limit(max_age_hours, label="max_age_hours")
    if payload.get("source_surface") != "web_sdk":
        raise ValueError("Web SDK export source_surface must be 'web_sdk'")
    if payload.get("export_scope") != "board":
        raise ValueError("Web SDK export_scope must be 'board'")
    if payload.get("schema_version") != WEBSDK_SCHEMA_VERSION:
        raise ValueError(
            f"Unsupported Web SDK schema_version: {payload.get('schema_version')!r}"
        )
    if payload.get("exporter_version") != WEBSDK_EXPORTER_VERSION:
        raise ValueError(
            f"Unsupported Web SDK exporter_version: {payload.get('exporter_version')!r}"
        )
    if payload.get("capture_profile") != WEBSDK_CAPTURE_PROFILE:
        raise ValueError(
            f"Unsupported Web SDK capture_profile: {payload.get('capture_profile')!r}"
        )
    items = _validate_item_list(payload, source_label="Web SDK")
    summary = payload.get("summary")
    if not isinstance(summary, dict):
        raise ValueError("Web SDK export is missing summary")
    summary_total = _nonnegative_int(
        summary.get("total"), label="Web SDK summary.total"
    )
    if summary_total != len(items):
        raise ValueError("Web SDK summary.total does not match items length")
    by_type = summary.get("by_type")
    if not isinstance(by_type, dict):
        raise ValueError("Web SDK summary.by_type must be an object")
    expected_by_type: dict[str, int] = {}
    for item in items:
        item_type = str(item["type"])
        expected_by_type[item_type] = expected_by_type.get(item_type, 0) + 1
    normalized_by_type = {
        str(key): _nonnegative_int(
            value, label=f"Web SDK summary.by_type.{key}"
        )
        for key, value in by_type.items()
    }
    if normalized_by_type != expected_by_type:
        raise ValueError("Web SDK summary.by_type does not match items")

    completeness = payload.get("completeness")
    item_completeness = (
        completeness.get("items") if isinstance(completeness, dict) else None
    )
    if not isinstance(completeness, dict) or completeness.get("complete") is not True:
        raise ValueError("Web SDK completeness.complete must be true")
    if completeness.get("capture_complete") is not True:
        raise ValueError("Web SDK completeness.capture_complete must be true")
    if completeness.get("board_complete") is not False:
        raise ValueError("Web SDK completeness.board_complete must be false")
    if completeness.get("coverage_basis") != WEBSDK_COVERAGE_BASIS:
        raise ValueError(
            f"Web SDK completeness.coverage_basis must be {WEBSDK_COVERAGE_BASIS}"
        )
    if completeness.get("known_limitations") != list(WEBSDK_KNOWN_LIMITATIONS):
        raise ValueError("Web SDK completeness.known_limitations is unsupported")
    if (
        not isinstance(item_completeness, dict)
        or item_completeness.get("complete") is not True
    ):
        raise ValueError("Web SDK completeness.items.complete must be true")
    for field in ("raw_count", "serialized_count"):
        value = item_completeness.get(field)
        if isinstance(value, bool) or not isinstance(value, int) or value != len(items):
            raise ValueError(
                f"Web SDK completeness.items.{field} must match items length"
            )
    serialization_errors = item_completeness.get("serialization_errors")
    if not isinstance(serialization_errors, list) or serialization_errors:
        raise ValueError(
            "Web SDK completeness.items.serialization_errors must be an empty list"
        )
    serialization = completeness.get("serialization")
    if not isinstance(serialization, dict) or serialization.get("complete") is not True:
        raise ValueError("Web SDK serialization must be complete")
    _validate_serialization_annotations(
        serialization, label="Web SDK completeness.serialization"
    )

    provenance = payload.get("provenance")
    item_provenance = provenance.get("items") if isinstance(provenance, dict) else None
    if not isinstance(item_provenance, dict):
        raise ValueError("Web SDK provenance.items is required")
    if item_provenance.get("method") != "miro.board.get":
        raise ValueError("Web SDK provenance.items.method must be miro.board.get")
    if item_provenance.get("scope") != WEBSDK_ITEM_SCOPE:
        raise ValueError(f"Web SDK provenance.items.scope must be {WEBSDK_ITEM_SCOPE}")
    for field in ("raw_count", "serialized_count"):
        value = item_provenance.get(field)
        if isinstance(value, bool) or not isinstance(value, int) or value != len(items):
            raise ValueError(
                f"Web SDK provenance.items.{field} must match items length"
            )
    serialization_provenance = provenance.get("serialization")
    provenance_issues, provenance_errors = _validate_serialization_annotations(
        serialization_provenance, label="Web SDK provenance.serialization"
    )
    issue_count = _nonnegative_int(
        serialization_provenance.get("issue_count"),
        label="Web SDK provenance.serialization.issue_count",
    )
    if issue_count != len(provenance_issues):
        raise ValueError(
            "Web SDK provenance.serialization.issue_count must match issues"
        )
    error_count = _nonnegative_int(
        serialization_provenance.get("error_count", len(provenance_errors)),
        label="Web SDK provenance.serialization.error_count",
    )
    if error_count != len(provenance_errors):
        raise ValueError(
            "Web SDK provenance.serialization.error_count must match errors"
        )
    comments: list[dict[str, Any]] = []
    if "comments" in payload:
        comments = _validate_comment_list(payload, source_label="Web SDK")
        comment_completeness = completeness.get("comments")
        comment_provenance = provenance.get("comments")
        if (
            not isinstance(comment_completeness, dict)
            or comment_completeness.get("complete") is not True
        ):
            raise ValueError(
                "Web SDK completeness.comments.complete must be true when comments are present"
            )
        if not isinstance(comment_provenance, dict):
            raise ValueError(
                "Web SDK provenance.comments is required when comments are present"
            )
        if not str(comment_provenance.get("method") or "").strip():
            raise ValueError("Web SDK provenance.comments.method is required")
        if comment_provenance.get("scope") != WEBSDK_COMMENT_SCOPE:
            raise ValueError(
                f"Web SDK provenance.comments.scope must be {WEBSDK_COMMENT_SCOPE}"
            )
        for field in ("raw_count", "serialized_count"):
            completeness_count = comment_completeness.get(field)
            provenance_count = comment_provenance.get(field)
            if (
                isinstance(completeness_count, bool)
                or not isinstance(completeness_count, int)
                or completeness_count != len(comments)
            ):
                raise ValueError(
                    f"Web SDK completeness.comments.{field} must match comments length"
                )
            if (
                isinstance(provenance_count, bool)
                or not isinstance(provenance_count, int)
                or provenance_count != len(comments)
            ):
                raise ValueError(
                    f"Web SDK provenance.comments.{field} must match comments length"
                )
        if comment_completeness.get("serialization_errors") != []:
            raise ValueError(
                "Web SDK completeness.comments.serialization_errors must be an empty list"
            )

    board_id = source_board_id(payload)
    if not board_id:
        raise ValueError("Web SDK export is missing board.id")
    if expected_board_id and board_id != expected_board_id:
        raise ValueError(
            f"Web SDK board mismatch: expected {expected_board_id}, got {board_id}"
        )

    exported_at = parse_exported_at(payload.get("exported_at"))
    current = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
    if exported_at > current + timedelta(minutes=5):
        raise ValueError("Web SDK exported_at is in the future")
    if max_age_hours >= 0 and current - exported_at > timedelta(hours=max_age_hours):
        raise ValueError(
            f"Web SDK export is stale (older than {max_age_hours:g} hours)"
        )
    return {
        "board_id": board_id,
        "exported_at": exported_at,
        "item_count": len(items),
        "comment_count": len(comments),
    }


def validate_rest_export(
    payload: Any,
    *,
    expected_board_id: str | None = None,
    max_age_hours: float = DEFAULT_MAX_SOURCE_AGE_HOURS,
    now: datetime | None = None,
) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise ValueError("REST export must be a JSON object")
    max_age_hours = _finite_limit(max_age_hours, label="max_age_hours")
    if payload.get("source_surface") != "rest":
        raise ValueError("REST export source_surface must be 'rest'")
    if payload.get("export_scope") != "board":
        raise ValueError("REST export_scope must be 'board'")
    if payload.get("schema_version") != 1:
        raise ValueError(
            f"Unsupported REST schema_version: {payload.get('schema_version')!r}"
        )
    if not str(payload.get("exporter_version") or "").strip():
        raise ValueError("REST export is missing exporter_version")

    items = _validate_item_list(payload, source_label="REST")
    comments = _validate_comment_list(payload, source_label="REST")
    completeness = payload.get("completeness")
    if not isinstance(completeness, dict) or completeness.get("complete") is not True:
        raise ValueError("REST export completeness.complete must be true")
    for part in ("items", "comments", "assets"):
        part_status = completeness.get(part)
        if not isinstance(part_status, dict) or part_status.get("complete") is not True:
            raise ValueError(f"REST export completeness.{part}.complete must be true")
    provenance = payload.get("provenance")
    if not isinstance(provenance, dict):
        raise ValueError("REST export is missing provenance")
    for part in ("items", "comments"):
        part_provenance = provenance.get(part)
        if (
            not isinstance(part_provenance, dict)
            or part_provenance.get("complete") is not True
        ):
            raise ValueError(f"REST provenance.{part}.complete must be true")
    comment_provenance = provenance["comments"]
    raw_comment_count = comment_provenance.get("raw_count")
    comment_count = comment_provenance.get("comment_count")
    if isinstance(raw_comment_count, bool) or not isinstance(raw_comment_count, int):
        raise ValueError("REST provenance.comments.raw_count must be an integer")
    if isinstance(comment_count, bool) or not isinstance(comment_count, int):
        raise ValueError("REST provenance.comments.comment_count must be an integer")
    if comment_count != len(comments) or raw_comment_count < comment_count:
        raise ValueError("REST provenance comment counts do not match comments")
    asset_provenance = provenance.get("assets")
    if (
        not isinstance(asset_provenance, dict)
        or not str(asset_provenance.get("strategy") or "").strip()
    ):
        raise ValueError("REST provenance.assets.strategy is required")
    validate_rest_payload_integrity(payload, require_complete=True)

    board_id = source_board_id(payload)
    if not board_id:
        raise ValueError("REST export is missing board.id")
    if expected_board_id and board_id != expected_board_id:
        raise ValueError(
            f"REST board mismatch: expected {expected_board_id}, got {board_id}"
        )
    provenance_board_id = str(provenance.get("board_id") or "").strip()
    if not provenance_board_id:
        raise ValueError("REST provenance.board_id is required")
    if provenance_board_id != board_id:
        raise ValueError(
            f"REST provenance board mismatch: {provenance_board_id} != {board_id}"
        )

    exported_at = parse_exported_at(payload.get("exported_at"), source_label="REST")
    current = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
    if exported_at > current + timedelta(minutes=5):
        raise ValueError("REST exported_at is in the future")
    if max_age_hours >= 0 and current - exported_at > timedelta(hours=max_age_hours):
        raise ValueError(f"REST export is stale (older than {max_age_hours:g} hours)")
    return {
        "board_id": board_id,
        "exported_at": exported_at,
        "item_count": len(items),
        "comment_count": len(comments),
    }


def validate_canonical_export(
    payload: Any,
    *,
    expected_board_id: str | None = None,
    max_age_hours: float = DEFAULT_MAX_SOURCE_AGE_HOURS,
    max_source_skew_minutes: float = DEFAULT_MAX_SOURCE_SKEW_MINUTES,
    now: datetime | None = None,
) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise ValueError("Canonical export must be a JSON object")
    max_age_hours = _finite_limit(max_age_hours, label="max_age_hours")
    max_source_skew_minutes = _finite_limit(
        max_source_skew_minutes,
        label="max_source_skew_minutes",
    )
    expected_header = {
        "schema_version": CANONICAL_SCHEMA_VERSION,
        "source_surface": "canonical",
        "export_scope": "board",
        "exporter_version": CANONICAL_EXPORTER_VERSION,
    }
    for field, expected in expected_header.items():
        if payload.get(field) != expected:
            raise ValueError(f"Canonical {field} must be {expected!r}")

    items = _validate_item_list(payload, source_label="Canonical")
    comments = _validate_comment_list(payload, source_label="Canonical")
    source_records: dict[str, dict[str, list[dict[str, Any]]]] = {
        "rest": {"items": [], "comments": []},
        "web_sdk": {"items": [], "comments": []},
    }
    for label, records, collection in (
        ("item", items, "items"),
        ("comment", comments, "comments"),
    ):
        for index, record in enumerate(records):
            surfaces = record.get("source_surfaces")
            provenance = record.get("source_provenance")
            if (
                not isinstance(surfaces, list)
                or not surfaces
                or any(
                    not isinstance(surface, str) or surface not in source_records
                    for surface in surfaces
                )
                or len(surfaces) != len(set(surfaces))
            ):
                raise ValueError(
                    f"Canonical {label} #{index} has invalid source_surfaces"
                )
            if not isinstance(provenance, dict) or not isinstance(
                provenance.get("original_items"), dict
            ):
                raise ValueError(
                    f"Canonical {label} #{index} is missing original source provenance"
                )
            originals = provenance["original_items"]
            if list(originals) != surfaces or provenance.get("surfaces") != surfaces:
                raise ValueError(
                    f"Canonical {label} #{index} source provenance does not match surfaces"
                )
            ordered_originals: dict[str, dict[str, Any]] = {}
            for surface in surfaces:
                original = originals.get(surface)
                if not isinstance(original, dict):
                    raise ValueError(
                        f"Canonical {label} #{index} original {surface} record is invalid"
                    )
                if str(original.get("id") or "") != str(record.get("id") or ""):
                    raise ValueError(
                        f"Canonical {label} #{index} original {surface} id mismatch"
                    )
                ordered_originals[surface] = original
                source_records[surface][collection].append(deepcopy(original))

            normalized = {}
            if label == "item" and "web_sdk" in ordered_originals:
                normalized["web_sdk"] = normalize_websdk_item(
                    ordered_originals["web_sdk"]
                )
            expected_provenance = _item_provenance(ordered_originals, normalized)
            if provenance.get("field_sources") != expected_provenance["field_sources"]:
                raise ValueError(
                    f"Canonical {label} #{index} field provenance is inconsistent"
                )
            selected_fields = provenance.get("selected_field_sources")
            if (
                selected_fields is not None
                and selected_fields != expected_provenance["selected_field_sources"]
            ):
                raise ValueError(
                    f"Canonical {label} #{index} selected field provenance is inconsistent"
                )
    completeness = payload.get("completeness")
    if not isinstance(completeness, dict) or completeness.get("complete") is not True:
        raise ValueError("Canonical completeness.complete must be true")
    if completeness.get("capture_complete") is not True:
        raise ValueError("Canonical completeness.capture_complete must be true")
    if completeness.get("board_complete") is not False:
        raise ValueError("Canonical completeness.board_complete must be false")
    if completeness.get("coverage_basis") != CANONICAL_COVERAGE_BASIS:
        raise ValueError(
            f"Canonical completeness.coverage_basis must be {CANONICAL_COVERAGE_BASIS}"
        )
    if completeness.get("known_limitations") != list(CANONICAL_KNOWN_LIMITATIONS):
        raise ValueError("Canonical completeness.known_limitations is unsupported")
    for part in ("rest", "web_sdk", "comments", "assets"):
        status = completeness.get(part)
        if not isinstance(status, dict) or status.get("complete") is not True:
            raise ValueError(f"Canonical completeness.{part}.complete must be true")
    assets = completeness["assets"]
    if assets.get("checked") is not True or assets.get("missing") != []:
        raise ValueError("Canonical assets must be checked with no missing files")
    optional_missing = assets.get("optional_missing")
    requirements = assets.get("requirements")
    if not isinstance(optional_missing, list) or not isinstance(requirements, dict):
        raise ValueError("Canonical asset completeness metadata is malformed")
    requirement_counts = {
        key: _nonnegative_int(
            requirements.get(key), label=f"Canonical asset requirements.{key}"
        )
        for key in (
            "images",
            "documents",
            "doc_formats",
            "embeds",
            "failed",
            "optional_failed",
        )
    }
    if requirement_counts["failed"] != 0:
        raise ValueError("Canonical required asset failure count must be zero")
    if requirement_counts["optional_failed"] != len(optional_missing):
        raise ValueError("Canonical optional asset failure count is inconsistent")

    board_id = source_board_id(payload)
    if not board_id:
        raise ValueError("Canonical export is missing board.id")
    if expected_board_id and board_id != expected_board_id:
        raise ValueError(
            f"Canonical board mismatch: expected {expected_board_id}, got {board_id}"
        )
    provenance = payload.get("provenance")
    if not isinstance(provenance, dict) or provenance.get("board_id") != board_id:
        raise ValueError("Canonical provenance.board_id must match board.id")
    if not str(provenance.get("merge_strategy") or "").strip():
        raise ValueError("Canonical provenance.merge_strategy is required")
    counts = provenance.get("counts")
    if not isinstance(counts, dict):
        raise ValueError("Canonical provenance.counts is required")
    source_counts = {
        "rest_items": _nonnegative_int(
            completeness["rest"].get("items"),
            label="Canonical completeness.rest.items",
        ),
        "web_sdk_items": _nonnegative_int(
            completeness["web_sdk"].get("items"),
            label="Canonical completeness.web_sdk.items",
        ),
        "rest_comments": _nonnegative_int(
            completeness["rest"].get("comments"),
            label="Canonical completeness.rest.comments",
        ),
        "web_sdk_comments": _nonnegative_int(
            completeness["web_sdk"].get("comments"),
            label="Canonical completeness.web_sdk.comments",
        ),
    }
    comment_union_count = _nonnegative_int(
        completeness["comments"].get("items"),
        label="Canonical completeness.comments.items",
    )
    expected_counts = {
        "items": len(items),
        "comments": len(comments),
        **source_counts,
    }
    for field, value in counts.items():
        _nonnegative_int(value, label=f"Canonical provenance.counts.{field}")
    if counts != expected_counts:
        raise ValueError(
            "Canonical provenance counts do not match source and union records"
        )
    if comment_union_count != len(comments):
        raise ValueError("Canonical comment completeness count does not match comments")
    asset_provenance = provenance.get("assets")
    if (
        not isinstance(asset_provenance, dict)
        or not str(asset_provenance.get("strategy") or "").strip()
    ):
        raise ValueError("Canonical provenance.assets.strategy is required")

    source_metadata = payload.get("source_metadata")
    source_dates = provenance.get("source_exported_at")
    if not isinstance(source_metadata, dict) or not isinstance(source_dates, dict):
        raise ValueError("Canonical source metadata and timestamps are required")
    current = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
    parsed_source_dates: list[datetime] = []
    parsed_by_surface: dict[str, datetime] = {}
    for surface in ("rest", "web_sdk"):
        metadata = source_metadata.get(surface)
        if not isinstance(metadata, dict) or metadata.get("source_surface") != surface:
            raise ValueError(f"Canonical source_metadata.{surface} is invalid")
        if source_board_id(metadata) != board_id:
            raise ValueError(f"Canonical source_metadata.{surface} board mismatch")
        parsed = parse_exported_at(source_dates.get(surface), source_label=surface)
        metadata_date = parse_exported_at(
            metadata.get("exported_at"), source_label=f"{surface} metadata"
        )
        if parsed != metadata_date:
            raise ValueError(f"Canonical {surface} source timestamp mismatch")
        if parsed > current + timedelta(minutes=5):
            raise ValueError(f"Canonical {surface} source timestamp is in the future")
        if max_age_hours >= 0 and current - parsed > timedelta(hours=max_age_hours):
            raise ValueError(
                f"Canonical {surface} source is stale (older than {max_age_hours:g} hours)"
            )
        parsed_source_dates.append(parsed)
        parsed_by_surface[surface] = parsed

    reconstructed_rest = {
        **deepcopy(source_metadata["rest"]),
        "items": source_records["rest"]["items"],
        "comments": source_records["rest"]["comments"],
    }
    reconstructed_web = {
        **deepcopy(source_metadata["web_sdk"]),
        "items": source_records["web_sdk"]["items"],
    }
    web_provenance = reconstructed_web.get("provenance")
    if isinstance(web_provenance, dict) and "comments" in web_provenance:
        reconstructed_web["comments"] = source_records["web_sdk"]["comments"]
    validate_rest_export(
        reconstructed_rest,
        expected_board_id=board_id,
        max_age_hours=max_age_hours,
        now=current,
    )
    validate_websdk_export(
        reconstructed_web,
        expected_board_id=board_id,
        max_age_hours=max_age_hours,
        now=current,
    )

    declared_skew = provenance.get("source_skew_seconds")
    actual_skew = abs(
        parsed_by_surface["rest"] - parsed_by_surface["web_sdk"]
    ).total_seconds()
    if (
        isinstance(declared_skew, bool)
        or not isinstance(declared_skew, (int, float))
        or not math.isfinite(float(declared_skew))
        or float(declared_skew) < 0
    ):
        raise ValueError(
            "Canonical provenance.source_skew_seconds must be a finite nonnegative number"
        )
    if abs(float(declared_skew) - actual_skew) > 0.001:
        raise ValueError(
            "Canonical source skew metadata does not match source timestamps"
        )
    if max_source_skew_minutes >= 0 and actual_skew > max_source_skew_minutes * 60:
        raise ValueError(
            f"Canonical source timestamps differ by more than {max_source_skew_minutes:g} minutes"
        )

    exported_at = parse_exported_at(
        payload.get("exported_at"), source_label="Canonical"
    )
    if exported_at != max(parsed_source_dates):
        raise ValueError("Canonical exported_at must equal the newest source timestamp")
    merged_at = parse_exported_at(
        payload.get("merged_at"), source_label="Canonical merged_at"
    )
    if merged_at < exported_at:
        raise ValueError("Canonical merged_at cannot precede its newest source")
    if merged_at > current + timedelta(minutes=5):
        raise ValueError("Canonical merged_at is in the future")
    return {
        "board_id": board_id,
        "exported_at": exported_at,
        "item_count": len(items),
        "comment_count": len(comments),
    }


def _root_items(root: Any) -> list[dict[str, Any]]:
    value = root.get("items", []) if isinstance(root, dict) else root
    if isinstance(value, list):
        return [deepcopy(item) for item in value if isinstance(item, dict)]
    return [deepcopy(item) for item in iter_items(value)]


def _root_comments(root: Any) -> list[dict[str, Any]]:
    if not isinstance(root, dict) or not isinstance(root.get("comments"), list):
        return []
    return [deepcopy(item) for item in root["comments"] if isinstance(item, dict)]


def _root_metadata(root: Any) -> dict[str, Any]:
    if not isinstance(root, dict):
        return {}
    return {
        key: deepcopy(value)
        for key, value in root.items()
        if key not in {"items", "comments"}
    }


def _deep_enrich(target: dict[str, Any], source: dict[str, Any]) -> None:
    for key, source_value in source.items():
        if key not in target or target[key] in _EMPTY_VALUES:
            target[key] = deepcopy(source_value)
        elif isinstance(target[key], dict) and isinstance(source_value, dict):
            _deep_enrich(target[key], source_value)


def _leaf_paths(value: Any, prefix: tuple[str, ...] = ()) -> Iterable[str]:
    if isinstance(value, dict):
        for key, nested in value.items():
            yield from _leaf_paths(nested, (*prefix, str(key)))
    elif isinstance(value, list):
        if value:
            yield ".".join(prefix)
    elif value not in (None, ""):
        yield ".".join(prefix)


def _selected_field_sources(
    source_items: dict[str, dict[str, Any]], normalized: dict[str, dict[str, Any]]
) -> dict[str, str]:
    selected: dict[str, str] = {}
    for surface, item in {**source_items, **normalized}.items():
        for path in _leaf_paths(item):
            selected.setdefault(path, surface)
    return dict(sorted(selected.items()))


def _item_provenance(
    source_items: dict[str, dict[str, Any]], normalized: dict[str, dict[str, Any]]
) -> dict[str, Any]:
    field_sources: dict[str, list[str]] = {}
    for surface, item in {**source_items, **normalized}.items():
        for path in _leaf_paths(item):
            field_sources.setdefault(path, [])
            if surface not in field_sources[path]:
                field_sources[path].append(surface)
    return {
        "surfaces": list(source_items),
        "field_sources": dict(sorted(field_sources.items())),
        "selected_field_sources": _selected_field_sources(source_items, normalized),
        "original_items": deepcopy(source_items),
    }


def _with_provenance(
    canonical: dict[str, Any],
    source_items: dict[str, dict[str, Any]],
    *,
    normalized: dict[str, dict[str, Any]] | None = None,
) -> dict[str, Any]:
    canonical["source_surfaces"] = list(source_items)
    canonical["source_provenance"] = _item_provenance(source_items, normalized or {})
    return canonical


def _items_by_id(
    items: Iterable[dict[str, Any]],
) -> tuple[list[str], dict[str, dict[str, Any]]]:
    order: list[str] = []
    indexed: dict[str, dict[str, Any]] = {}
    for item in items:
        item_id = str(item.get("id") or "").strip()
        if not item_id:
            raise ValueError("Source item is missing id")
        if item_id not in indexed:
            order.append(item_id)
            indexed[item_id] = deepcopy(item)
        else:
            _deep_enrich(indexed[item_id], item)
    return order, indexed


def _merge_comments(rest_root: Any, websdk_root: Any) -> list[dict[str, Any]]:
    rest_order, rest_by_id = _items_by_id(_root_comments(rest_root))
    web_order, web_by_id = _items_by_id(_root_comments(websdk_root))
    merged: list[dict[str, Any]] = []
    for comment_id in [
        *rest_order,
        *(candidate for candidate in web_order if candidate not in rest_by_id),
    ]:
        rest_comment = rest_by_id.get(comment_id)
        web_comment = web_by_id.get(comment_id)
        canonical = deepcopy(rest_comment or web_comment or {})
        if rest_comment and web_comment:
            _deep_enrich(canonical, web_comment)
        sources = {
            key: value
            for key, value in (("rest", rest_comment), ("web_sdk", web_comment))
            if value is not None
        }
        merged.append(_with_provenance(canonical, sources))
    return merged


def merge_sources(
    rest_root: Any,
    websdk_root: Any,
    *,
    board_id: str | None = None,
    max_age_hours: float = DEFAULT_MAX_SOURCE_AGE_HOURS,
    max_source_skew_minutes: float = DEFAULT_MAX_SOURCE_SKEW_MINUTES,
    now: datetime | None = None,
) -> dict[str, Any]:
    expected_board_id = (
        board_id or source_board_id(rest_root) or source_board_id(websdk_root)
    )
    max_age_hours = _finite_limit(max_age_hours, label="max_age_hours")
    max_source_skew_minutes = _finite_limit(
        max_source_skew_minutes,
        label="max_source_skew_minutes",
    )
    rest_info = validate_rest_export(
        rest_root,
        expected_board_id=expected_board_id,
        max_age_hours=max_age_hours,
        now=now,
    )
    websdk_info = validate_websdk_export(
        websdk_root,
        expected_board_id=expected_board_id,
        max_age_hours=max_age_hours,
        now=now,
    )
    source_skew = abs(rest_info["exported_at"] - websdk_info["exported_at"])
    if max_source_skew_minutes >= 0 and source_skew > timedelta(
        minutes=max_source_skew_minutes
    ):
        raise ValueError(
            f"REST/Web SDK export timestamps differ by more than {max_source_skew_minutes:g} minutes"
        )

    rest_order, rest_by_id = _items_by_id(_root_items(rest_root))
    web_order, web_by_id = _items_by_id(_root_items(websdk_root))
    merged_items: list[dict[str, Any]] = []
    for item_id in [
        *rest_order,
        *(candidate for candidate in web_order if candidate not in rest_by_id),
    ]:
        rest_item = rest_by_id.get(item_id)
        web_item = web_by_id.get(item_id)
        normalized_web = normalize_websdk_item(web_item) if web_item else None
        canonical = deepcopy(rest_item or normalized_web or {})
        if rest_item and normalized_web:
            _deep_enrich(canonical, normalized_web)
        sources = {
            key: value
            for key, value in (("rest", rest_item), ("web_sdk", web_item))
            if value is not None
        }
        normalized = {"web_sdk": normalized_web} if normalized_web else {}
        merged_items.append(_with_provenance(canonical, sources, normalized=normalized))

    board = deepcopy(websdk_root.get("board") or {})
    rest_board = (
        rest_root.get("board")
        if isinstance(rest_root, dict) and isinstance(rest_root.get("board"), dict)
        else {}
    )
    _deep_enrich(board, rest_board)
    board.setdefault("id", websdk_info["board_id"])
    merged_comments = _merge_comments(rest_root, websdk_root)
    latest_export = max(rest_info["exported_at"], websdk_info["exported_at"])
    merge_time = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
    if merge_time < latest_export:
        merge_time = latest_export

    return {
        "schema_version": CANONICAL_SCHEMA_VERSION,
        "source_surface": "canonical",
        "export_scope": "board",
        "exporter_version": CANONICAL_EXPORTER_VERSION,
        "exported_at": latest_export.isoformat(),
        "merged_at": merge_time.isoformat(),
        "board": board,
        "items": merged_items,
        "comments": merged_comments,
        "source_metadata": {
            "rest": _root_metadata(rest_root),
            "web_sdk": _root_metadata(websdk_root),
        },
        "provenance": {
            "merge_strategy": "rest_canonical_with_web_sdk_missing_field_enrichment",
            "board_id": rest_info["board_id"],
            "source_exported_at": {
                "rest": rest_info["exported_at"].isoformat(),
                "web_sdk": websdk_info["exported_at"].isoformat(),
            },
            "source_skew_seconds": source_skew.total_seconds(),
            "counts": {
                "items": len(merged_items),
                "comments": len(merged_comments),
                "rest_items": rest_info["item_count"],
                "web_sdk_items": websdk_info["item_count"],
                "rest_comments": rest_info["comment_count"],
                "web_sdk_comments": websdk_info["comment_count"],
            },
        },
        "completeness": {
            "complete": False,
            "capture_complete": False,
            "board_complete": False,
            "coverage_basis": CANONICAL_COVERAGE_BASIS,
            "known_limitations": list(CANONICAL_KNOWN_LIMITATIONS),
            "rest": {
                "complete": True,
                "items": rest_info["item_count"],
                "comments": rest_info["comment_count"],
            },
            "web_sdk": {
                "complete": True,
                "items": websdk_info["item_count"],
                "comments": websdk_info["comment_count"],
            },
            "comments": {"complete": True, "items": len(merged_comments)},
            "assets": {"complete": False, "checked": False},
        },
    }


def finalize_merged_export(
    merged: dict[str, Any],
    *,
    source_json: Path,
    output_json: Path,
    token: str | None = None,
    max_age_hours: float = DEFAULT_MAX_SOURCE_AGE_HOURS,
    max_source_skew_minutes: float = DEFAULT_MAX_SOURCE_SKEW_MINUTES,
) -> dict[str, Any]:
    payload = deepcopy(merged)
    if token is None:
        source_missing = validate_export_assets(
            payload["items"], output_path=source_json
        )
        if source_missing:
            raise RuntimeError(
                "Source sidecar does not satisfy merged assets: "
                + "; ".join(source_missing[:5])
            )

    with staged_export_path(output_json) as staged_json:
        rest_metadata = payload.get("source_metadata", {}).get("rest", {})
        sidecar_records = [
            *payload["items"],
            *stable_enrichment_items(rest_metadata),
        ]
        copy_referenced_sidecar(
            sidecar_records,
            source_json=source_json,
            staged_json=staged_json,
        )
        asset_stats = None
        if token is not None:
            asset_stats = download_export_assets(
                payload["items"],
                output_path=staged_json,
                token=token,
                strict=False,
            )
        output_missing = validate_export_assets(
            payload["items"], output_path=staged_json
        )
        optional_missing = validate_optional_export_assets(
            payload["items"], output_path=staged_json
        )
        if output_missing:
            raise RuntimeError(
                "Staged canonical sidecar is incomplete: "
                + "; ".join(output_missing[:5])
            )
        payload["provenance"]["assets"] = {
            "strategy": (
                "referenced_rest_assets_plus_merged_downloads"
                if token is not None
                else "referenced_rest_assets_only"
            ),
            "source": str(source_json),
        }
        requirements = asset_stats or {
            **summarize_export_asset_requirements(payload["items"]),
            "failed": 0,
            "optional_failed": len(optional_missing),
        }
        payload["completeness"]["assets"] = {
            "complete": True,
            "checked": True,
            "missing": [],
            "optional_missing": optional_missing,
            "requirements": requirements,
        }
        payload["completeness"]["capture_complete"] = True
        payload["completeness"]["complete"] = True
        validate_canonical_export(
            payload,
            expected_board_id=source_board_id(payload),
            max_age_hours=max_age_hours,
            max_source_skew_minutes=max_source_skew_minutes,
        )
        write_json(staged_json, payload)
        publish_staged_bundle(staged_json, output_json)
    return payload


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Merge REST and Web SDK Miro exports into one converter-ready source JSON."
    )
    parser.add_argument("--rest-json", type=Path, required=True)
    parser.add_argument("--websdk-json", type=Path, required=True)
    parser.add_argument("--board-id", required=True)
    parser.add_argument(
        "--max-age-hours", type=float, default=DEFAULT_MAX_SOURCE_AGE_HOURS
    )
    parser.add_argument(
        "--max-source-skew-minutes",
        type=float,
        default=DEFAULT_MAX_SOURCE_SKEW_MINUTES,
    )
    parser.add_argument("--output", type=Path, required=True)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    merged = merge_sources(
        load_json(args.rest_json),
        load_json(args.websdk_json),
        board_id=args.board_id,
        max_age_hours=args.max_age_hours,
        max_source_skew_minutes=args.max_source_skew_minutes,
    )
    merged = finalize_merged_export(
        merged,
        source_json=args.rest_json,
        output_json=args.output,
        max_age_hours=args.max_age_hours,
        max_source_skew_minutes=args.max_source_skew_minutes,
    )
    print(f"merged_items={len(merged['items'])}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
