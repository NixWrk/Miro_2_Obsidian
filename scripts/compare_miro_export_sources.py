from __future__ import annotations

import argparse
import json
import math
import os
import shutil
import tempfile
from collections import Counter
from dataclasses import asdict, dataclass
from datetime import datetime
from pathlib import Path
from typing import Any


REPO_ROOT = Path(__file__).resolve().parents[1]
CONVERTER_DIR = REPO_ROOT / "Json_2_Canvas"
SCRIPTS_DIR = REPO_ROOT / "scripts"
MIRO_JSON_DIR = REPO_ROOT / "Miro_2_Json"
WORK_ROOT = REPO_ROOT / "work"
DEFAULT_BOARD_LIST = WORK_ROOT / "Web_boards.md"
DEFAULT_WEBSDK_ROOT = WORK_ROOT / "websdk_exports"
DEFAULT_OUT_DIR = (
    REPO_ROOT / "tools" / "canvas_render" / ".out" / "export_source_compare"
)
OBSIDIAN_UNLOCKED_MIN_ZOOM = 2**-12


from scripts.audit_web_board_pipeline import (  # noqa: E402
    BoardRef,
    audit_one_board,
    expand_text_style_modes,
    load_board_refs,
    load_json,
    remap_output_paths,
    safe_name,
)
from scripts.miro_export_bundle import (  # noqa: E402
    copy_referenced_sidecar,
    is_link_or_reparse,
    publish_staged_bundle,
    publish_staged_directory,
    require_regular_directory,
    require_regular_file,
    staged_export_path,
)
from scripts.merge_miro_sources import (  # noqa: E402
    DEFAULT_MAX_SOURCE_AGE_HOURS,
    merge_sources,
    validate_canonical_export,
    validate_websdk_export,
)
from scripts.miro_capability_probe import (  # noqa: E402
    build_coverage_rows,
    has_content,
    has_geometry,
    iter_items,
    summarize_items,
)
from Miro_2_Json.miro_downloader import get_boards  # noqa: E402
from scripts.miro_oauth_token import (  # noqa: E402
    DEFAULT_AUTHORIZE_URL,
    DEFAULT_BROWSER,
    DEFAULT_REDIRECT_URI,
    DEFAULT_SCOPES,
    DEFAULT_TIMEOUT_SECONDS,
    DEFAULT_TOKEN_URL,
    config_from_env,
)
from scripts.miro_rest_export_board import (  # noqa: E402
    download_export_assets,
    export_complete_board_source,
    stable_enrichment_items,
    resolve_token_from_args,
    validate_export_assets,
    validate_optional_export_assets,
    write_json,
)


REST_EXP = "rest_exp"
REST_STABLE = "rest_stable"
REST_EXP_NO_ASSETS = "rest_exp_no_assets"
REST_STABLE_NO_ASSETS = "rest_stable_no_assets"
LEGACY_EXP = "legacy_exp"
LEGACY_STABLE = "legacy_stable"
WEBSDK = "websdk"
MERGED_REST_EXP_WEBSDK = "merged_rest_exp_websdk"
MERGED_REST_STABLE_WEBSDK = "merged_rest_stable_websdk"

CORE_SOURCES = (
    REST_EXP,
    REST_STABLE,
    REST_EXP_NO_ASSETS,
    WEBSDK,
    MERGED_REST_EXP_WEBSDK,
)
ALL_SOURCES = (
    REST_EXP,
    REST_STABLE,
    REST_EXP_NO_ASSETS,
    REST_STABLE_NO_ASSETS,
    LEGACY_EXP,
    LEGACY_STABLE,
    WEBSDK,
    MERGED_REST_EXP_WEBSDK,
    MERGED_REST_STABLE_WEBSDK,
)


@dataclass(frozen=True)
class SourceSpec:
    key: str
    label: str
    category: str
    prefer_experimental: bool = True
    download_assets: bool = True
    dependencies: tuple[str, ...] = ()
    production_eligible: bool = False


SOURCE_SPECS: dict[str, SourceSpec] = {
    REST_EXP: SourceSpec(REST_EXP, "REST experimental + comments + assets", "rest"),
    REST_STABLE: SourceSpec(
        REST_STABLE,
        "REST stable + comments + assets",
        "rest",
        prefer_experimental=False,
    ),
    REST_EXP_NO_ASSETS: SourceSpec(
        REST_EXP_NO_ASSETS,
        "REST experimental + comments, no assets",
        "rest",
        download_assets=False,
        production_eligible=False,
    ),
    REST_STABLE_NO_ASSETS: SourceSpec(
        REST_STABLE_NO_ASSETS,
        "REST stable + comments, no assets",
        "rest",
        prefer_experimental=False,
        download_assets=False,
        production_eligible=False,
    ),
    LEGACY_EXP: SourceSpec(
        LEGACY_EXP,
        "Legacy downloader experimental",
        "legacy",
        production_eligible=False,
    ),
    LEGACY_STABLE: SourceSpec(
        LEGACY_STABLE,
        "Legacy downloader stable",
        "legacy",
        prefer_experimental=False,
        production_eligible=False,
    ),
    WEBSDK: SourceSpec(
        WEBSDK,
        "Web SDK raw export",
        "websdk",
        download_assets=False,
        production_eligible=False,
    ),
    MERGED_REST_EXP_WEBSDK: SourceSpec(
        MERGED_REST_EXP_WEBSDK,
        "Merged REST experimental + Web SDK",
        "merged",
        dependencies=(REST_EXP, WEBSDK),
        production_eligible=True,
    ),
    MERGED_REST_STABLE_WEBSDK: SourceSpec(
        MERGED_REST_STABLE_WEBSDK,
        "Merged REST stable + Web SDK",
        "merged",
        dependencies=(REST_STABLE, WEBSDK),
        production_eligible=True,
    ),
}

SIMPLICITY_PRIORITY = {
    REST_EXP: 0,
    REST_STABLE: 1,
    MERGED_REST_EXP_WEBSDK: 2,
    MERGED_REST_STABLE_WEBSDK: 3,
    LEGACY_EXP: 4,
    LEGACY_STABLE: 5,
    REST_EXP_NO_ASSETS: 6,
    REST_STABLE_NO_ASSETS: 7,
    WEBSDK: 8,
}


@dataclass(frozen=True)
class SourceResult:
    source_key: str
    source_json: Path | None
    status: str
    export_info: dict[str, Any]
    error: str = ""


class _ImmediateCallbackTarget:
    def after(self, _delay_ms: int, callback: Any) -> None:
        callback()


def progress(message: str) -> None:
    print(message, flush=True)


def expand_source_keys(value: str) -> list[str]:
    raw_keys: list[str] = []
    for part in value.split(","):
        key = part.strip()
        if not key:
            continue
        if key == "core":
            raw_keys.extend(CORE_SOURCES)
        elif key == "all":
            raw_keys.extend(ALL_SOURCES)
        else:
            raw_keys.append(key)

    keys: list[str] = []
    seen: set[str] = set()

    def add_with_dependencies(key: str) -> None:
        if key not in SOURCE_SPECS:
            known = ", ".join(sorted(SOURCE_SPECS))
            raise ValueError(
                f"Unknown source '{key}'. Known sources: {known}, core, all"
            )
        for dep in SOURCE_SPECS[key].dependencies:
            add_with_dependencies(dep)
        if key not in seen:
            keys.append(key)
            seen.add(key)

    for key in raw_keys:
        add_with_dependencies(key)
    return keys


def _source_dir(out_dir: Path, board: BoardRef, source_key: str) -> Path:
    return out_dir / "sources" / safe_name(board.board_id) / source_key


def _source_json_path(out_dir: Path, board: BoardRef, source_key: str) -> Path:
    return _source_dir(out_dir, board, source_key) / "board.json"


def _copy_json_and_sidecar(source_json: Path, target_json: Path) -> None:
    require_regular_file(source_json, label="Source JSON")
    payload = load_json(source_json)
    items = payload.get("items", []) if isinstance(payload, dict) else []
    if not isinstance(items, list):
        raise RuntimeError("Source JSON items must be a list")
    with staged_export_path(target_json) as staged_json:
        shutil.copy2(source_json, staged_json)
        copy_referenced_sidecar(items, source_json=source_json, staged_json=staged_json)
        publish_staged_bundle(staged_json, target_json)


def _looks_like_board_id(value: str, board_id: str) -> bool:
    return board_id in value or safe_name(board_id) in value


def find_websdk_export(
    board: BoardRef,
    websdk_root: Path,
    *,
    max_age_hours: float = DEFAULT_MAX_SOURCE_AGE_HOURS,
    now: datetime | None = None,
    rejected: list[dict[str, str]] | None = None,
) -> Path | None:
    if (
        isinstance(max_age_hours, bool)
        or not isinstance(max_age_hours, (int, float))
        or not math.isfinite(float(max_age_hours))
    ):
        raise ValueError("max_age_hours must be a finite number")
    if not websdk_root.exists() and not is_link_or_reparse(websdk_root):
        return None
    require_regular_directory(websdk_root, label="Web SDK export root")
    valid: list[tuple[datetime, Path]] = []
    for candidate in sorted(websdk_root.rglob("*.json")):
        try:
            require_regular_file(candidate, label="Web SDK export candidate")
            payload = load_json(candidate)
            info = validate_websdk_export(
                payload,
                expected_board_id=board.board_id,
                max_age_hours=max_age_hours,
                now=now,
            )
        except Exception as exc:  # noqa: BLE001
            if rejected is not None:
                rejected.append({"path": str(candidate), "reason": str(exc)})
            continue
        valid.append((info["exported_at"], candidate))
    return max(valid, default=(None, None), key=lambda item: item[0])[1]


def _source_stats(path: Path) -> dict[str, Any]:
    root = load_json(path)
    items = root.get("items", []) if isinstance(root, dict) else root
    stats = summarize_items(items)
    return {
        "items": sum(item.count for item in stats.values()),
        "by_type": {
            item_type: {
                "count": item.count,
                "with_geometry": item.with_geometry,
                "with_content": item.with_content,
                "unsupported": item.unsupported,
                "examples": list(item.examples),
            }
            for item_type, item in sorted(stats.items())
        },
    }


def _comments_count(path: Path) -> int:
    root = load_json(path)
    if isinstance(root, dict) and isinstance(root.get("comments"), list):
        return len(root["comments"])
    return 0


def _coverage_summary(
    rest_json: Path | None, websdk_json: Path | None
) -> dict[str, Any]:
    rest_root = load_json(rest_json) if rest_json and rest_json.exists() else []
    websdk_root = load_json(websdk_json) if websdk_json and websdk_json.exists() else []
    rows = build_coverage_rows(rest_root, websdk_root)
    actions = Counter(row.action for row in rows)
    coverage = Counter(row.coverage for row in rows)
    candidates = [
        {
            "type": row.item_type,
            "action": row.action,
            "coverage": row.coverage,
            "rest": asdict(row.rest),
            "websdk": asdict(row.websdk),
        }
        for row in rows
        if row.action in {"websdk_export_candidate", "converter_candidate"}
    ]
    return {
        "by_action": dict(sorted(actions.items())),
        "by_coverage": dict(sorted(coverage.items())),
        "candidates": candidates,
    }


def export_rest_source(
    board: BoardRef,
    output_json: Path,
    *,
    token: str,
    prefer_experimental: bool,
    download_assets: bool,
    allow_missing_assets: bool,
) -> SourceResult:
    _payload, export_info = export_complete_board_source(
        board_id=board.board_id,
        token=token,
        output_path=output_json,
        prefer_experimental=prefer_experimental,
        download_assets=download_assets,
        allow_missing_assets=allow_missing_assets,
        board_name=board.label,
        board_url=board.url,
    )
    return SourceResult(
        source_key="",
        source_json=output_json,
        status="exported",
        export_info=export_info,
    )


def export_legacy_source(
    board: BoardRef,
    output_json: Path,
    *,
    token: str,
    prefer_experimental: bool,
) -> SourceResult:
    from Miro_2_Json.download_worker import run_download  # noqa: PLC0415

    messages: list[str] = []
    failures: list[dict[str, str]] = []
    legacy_safe_board = safe_name(board.board_id)
    legacy_warning = ""

    with staged_export_path(output_json) as staged_json:
        produced_json = staged_json.parent / f"legacy_{legacy_safe_board}.json"
        try:
            run_download(
                board_id=board.board_id,
                token=token,
                save_base=staged_json.parent,
                safe_team="legacy",
                safe_board=legacy_safe_board,
                rename_files=True,
                prefer_experimental=prefer_experimental,
                canonical=False,
                log=messages.append,
                ask_strategy=lambda _conflicts: "overwrite",
                ask_continue_forbidden=lambda _source, _status, _message: True,
                ask_exp_fallback=lambda _partial_count: True,
                on_prepare_rows=lambda _id_to_final, _all_items: None,
                on_file_start=lambda _item_id, _name: None,
                on_file_done=lambda _item_id: None,
                on_file_fail=lambda item_id, reason: failures.append(
                    {"id": str(item_id), "reason": str(reason)}
                ),
                on_overall_progress=lambda _done, _total: None,
                gui_root=_ImmediateCallbackTarget(),
            )
        except UnicodeEncodeError as exc:
            if not produced_json.exists():
                raise
            legacy_warning = f"legacy_stdout_encoding_error_ignored: {exc}"

        require_regular_file(produced_json, label="Legacy downloader JSON")
        payload = load_json(produced_json)
        items = payload.get("items") if isinstance(payload, dict) else payload
        if not isinstance(items, list) or any(
            not isinstance(item, dict) for item in items
        ):
            raise RuntimeError("Legacy downloader JSON items must be a list of objects")
        shutil.copy2(produced_json, staged_json)
        copy_referenced_sidecar(
            items, source_json=produced_json, staged_json=staged_json
        )
        publish_staged_bundle(staged_json, output_json)

    return SourceResult(
        source_key="",
        source_json=output_json,
        status="exported",
        export_info={
            "items": _source_stats(output_json)["items"],
            "comments": 0,
            "asset_stats": {"failed": len(failures)},
            "asset_failures": failures[:20],
            "warning": legacy_warning,
            "log_tail": messages[-10:],
            "prefer_experimental": prefer_experimental,
            "download_assets": True,
        },
    )


def materialize_source(
    board: BoardRef,
    source_key: str,
    *,
    out_dir: Path,
    token: str,
    websdk_root: Path,
    allow_missing_assets: bool,
    exported: dict[str, SourceResult],
) -> SourceResult:
    spec = SOURCE_SPECS[source_key]
    output_json = _source_json_path(out_dir, board, source_key)

    if spec.category in {"rest", "legacy"} and not token:
        return SourceResult(
            source_key, None, "auth_missing", {}, "MIRO_ACCESS_TOKEN is not set"
        )

    try:
        if spec.category == "rest":
            result = export_rest_source(
                board,
                output_json,
                token=token,
                prefer_experimental=spec.prefer_experimental,
                download_assets=spec.download_assets,
                allow_missing_assets=allow_missing_assets,
            )
        elif spec.category == "legacy":
            result = export_legacy_source(
                board,
                output_json,
                token=token,
                prefer_experimental=spec.prefer_experimental,
            )
        elif spec.category == "websdk":
            rejected_candidates: list[dict[str, str]] = []
            websdk_json = find_websdk_export(
                board,
                websdk_root,
                rejected=rejected_candidates,
            )
            if not websdk_json:
                return SourceResult(
                    source_key,
                    None,
                    "no_websdk_export",
                    {"rejected_candidates": rejected_candidates},
                    "No matching Web SDK JSON found"
                    + (
                        f"; rejected_candidates={len(rejected_candidates)}"
                        if rejected_candidates
                        else ""
                    ),
                )
            _copy_json_and_sidecar(websdk_json, output_json)
            result = SourceResult(
                source_key,
                output_json,
                "exported",
                {
                    "items": _source_stats(output_json)["items"],
                    "comments": _comments_count(output_json),
                    "asset_stats": {},
                    "input": str(websdk_json),
                    "rejected_candidates": rejected_candidates,
                },
            )
        elif spec.category == "merged":
            missing = [
                dep
                for dep in spec.dependencies
                if dep not in exported or not exported[dep].source_json
            ]
            if missing:
                return SourceResult(
                    source_key,
                    None,
                    "dependency_missing",
                    {},
                    "Missing dependency source(s): " + ", ".join(missing),
                )
            rest_json = exported[spec.dependencies[0]].source_json
            websdk_json = exported[spec.dependencies[1]].source_json
            if not rest_json or not websdk_json:
                return SourceResult(
                    source_key,
                    None,
                    "dependency_missing",
                    {},
                    "Dependency source path is empty",
                )
            rest_root = load_json(rest_json)
            websdk_root_payload = load_json(websdk_json)
            canonical = merge_sources(
                rest_root, websdk_root_payload, board_id=board.board_id
            )
            rest_missing = validate_export_assets(
                rest_root["items"], output_path=rest_json
            )
            if rest_missing:
                raise RuntimeError(
                    f"REST dependency asset validation incomplete: {'; '.join(rest_missing[:5])}"
                )

            with staged_export_path(output_json) as staged_json:
                copy_referenced_sidecar(
                    [
                        *canonical["items"],
                        *stable_enrichment_items(rest_root),
                    ],
                    source_json=rest_json,
                    staged_json=staged_json,
                )
                asset_stats = download_export_assets(
                    canonical["items"],
                    output_path=staged_json,
                    token=token,
                    strict=False,
                )
                missing_assets = validate_export_assets(
                    canonical["items"], output_path=staged_json
                )
                optional_missing = validate_optional_export_assets(
                    canonical["items"], output_path=staged_json
                )
                if missing_assets and not allow_missing_assets:
                    raise RuntimeError(
                        f"Merged asset validation incomplete: {'; '.join(missing_assets[:5])}"
                    )
                canonical["provenance"]["assets"] = {
                    "strategy": "referenced_rest_assets_plus_merged_downloads",
                    "dependencies": list(spec.dependencies),
                }
                canonical["completeness"]["assets"] = {
                    "complete": not missing_assets,
                    "checked": True,
                    "missing": missing_assets,
                    "optional_missing": optional_missing,
                    "requirements": asset_stats,
                }
                canonical["completeness"]["capture_complete"] = not missing_assets
                canonical["completeness"]["complete"] = not missing_assets
                if not missing_assets:
                    validate_canonical_export(
                        canonical, expected_board_id=board.board_id
                    )
                write_json(staged_json, canonical)
                publish_staged_bundle(staged_json, output_json)
            result = SourceResult(
                source_key,
                output_json,
                "exported",
                {
                    "items": len(canonical["items"]),
                    "comments": len(canonical["comments"]),
                    "asset_stats": asset_stats,
                    "dependencies": list(spec.dependencies),
                    "complete": not missing_assets,
                    "degraded": bool(missing_assets),
                    "missing_assets": missing_assets,
                    "optional_missing_assets": optional_missing,
                },
            )
        else:
            raise RuntimeError(f"Unhandled source category: {spec.category}")
    except Exception as exc:  # noqa: BLE001
        return SourceResult(source_key, None, "export_failed", {}, str(exc))

    return SourceResult(
        source_key, result.source_json, result.status, result.export_info, result.error
    )


def _status_rank(status: str) -> int:
    return {
        "ok": 0,
        "needs_review": 1,
        "source_missing_assets": 2,
        "canvas_missing_files": 3,
        "render_failed": 4,
        "convert_failed": 5,
        "exported": 6,
        "no_websdk_export": 7,
        "dependency_missing": 8,
        "auth_missing": 9,
        "export_failed": 10,
    }.get(status, 99)


_IGNORED_INFORMATION_FIELDS = {
    "source",
    "source_surfaces",
    "source_provenance",
    "websdk_item",
}
_ASSET_FIELDS = {
    "documenturl",
    "imageurl",
    "local_name",
    "localpath",
    "previewurl",
    "resourceurl",
    "url",
}


def _semantic_field_path(path: tuple[str, ...]) -> tuple[str, ...]:
    aliases = {
        ("x",): ("position", "x"),
        ("y",): ("position", "y"),
        ("width",): ("geometry", "width"),
        ("height",): ("geometry", "height"),
        ("content",): ("data", "content"),
        ("title",): ("data", "title"),
        ("description",): ("data", "description"),
    }
    return aliases.get(path, path)


def _information_fields(item: dict[str, Any]) -> set[str]:
    fields: set[str] = set()

    def walk(value: Any, path: tuple[str, ...]) -> None:
        if path and path[0] in _IGNORED_INFORMATION_FIELDS:
            return
        if isinstance(value, dict):
            for key, nested in value.items():
                walk(nested, (*path, str(key)))
        elif isinstance(value, list):
            if value:
                fields.add(".".join(_semantic_field_path(path)))
        elif value not in (None, ""):
            fields.add(".".join(_semantic_field_path(path)))

    walk(item, ())
    fields.discard("id")
    fields.discard("type")
    return fields


def _has_asset_reference(item: dict[str, Any]) -> bool:
    def walk(value: Any, parent_key: str = "") -> bool:
        if isinstance(value, dict):
            return any(
                key not in _IGNORED_INFORMATION_FIELDS and walk(nested, str(key))
                for key, nested in value.items()
            )
        if isinstance(value, list):
            return any(walk(nested, parent_key) for nested in value)
        return parent_key.lower() in _ASSET_FIELDS and value not in (None, "")

    return walk(item)


def _source_items(path: Path) -> dict[str, dict[str, Any]]:
    root = load_json(path)
    items = root.get("items", []) if isinstance(root, dict) else root
    return {
        str(item["id"]): item
        for item in iter_items(items)
        if item.get("id") is not None
    }


def _source_comments(path: Path) -> dict[str, dict[str, Any]]:
    root = load_json(path)
    comments = root.get("comments", []) if isinstance(root, dict) else []
    if not isinstance(comments, list):
        return {}
    return {
        str(comment["id"]): comment
        for comment in comments
        if isinstance(comment, dict) and comment.get("id") is not None
    }


def annotate_completeness(records: list[dict[str, Any]]) -> None:
    path_cache: dict[str, dict[str, dict[str, Any]]] = {}
    comment_cache: dict[str, dict[str, dict[str, Any]]] = {}
    for record in records:
        source_json = str(record.get("source_json") or "")
        if source_json and source_json not in path_cache:
            try:
                path_cache[source_json] = _source_items(Path(source_json))
                comment_cache[source_json] = _source_comments(Path(source_json))
            except Exception:  # noqa: BLE001
                path_cache[source_json] = {}
                comment_cache[source_json] = {}

    source_maps = [items for items in path_cache.values() if items]
    union_ids = (
        set().union(*(set(items) for items in source_maps)) if source_maps else set()
    )
    union_fields = {
        (item_id, field)
        for items in source_maps
        for item_id, item in items.items()
        for field in _information_fields(item)
    }
    union_content = {
        item_id
        for items in source_maps
        for item_id, item in items.items()
        if has_content(item)
    }
    union_geometry = {
        item_id
        for items in source_maps
        for item_id, item in items.items()
        if has_geometry(item)
    }
    union_assets = {
        item_id
        for items in source_maps
        for item_id, item in items.items()
        if _has_asset_reference(item)
    }
    comment_maps = [comments for comments in comment_cache.values() if comments]
    union_comment_ids = (
        set().union(*(set(comments) for comments in comment_maps))
        if comment_maps
        else set()
    )
    union_comment_fields = {
        (comment_id, field)
        for comments in comment_maps
        for comment_id, comment in comments.items()
        for field in _information_fields(comment)
    }

    for record in records:
        items = path_cache.get(str(record.get("source_json") or ""))
        if items is None:
            continue
        item_ids = set(items)
        fields = {
            (item_id, field)
            for item_id, item in items.items()
            for field in _information_fields(item)
        }
        content = {item_id for item_id, item in items.items() if has_content(item)}
        geometry = {item_id for item_id, item in items.items() if has_geometry(item)}
        assets = {
            item_id for item_id, item in items.items() if _has_asset_reference(item)
        }
        comments = comment_cache.get(str(record.get("source_json") or ""), {})
        comment_ids = set(comments)
        comment_fields = {
            (comment_id, field)
            for comment_id, comment in comments.items()
            for field in _information_fields(comment)
        }
        record["completeness"] = {
            "union_items": len(union_ids),
            "items": len(item_ids),
            "missing_item_ids": len(union_ids - item_ids),
            "missing_item_examples": sorted(union_ids - item_ids)[:10],
            "union_fields": len(union_fields),
            "fields": len(fields),
            "missing_fields": len(union_fields - fields),
            "union_content_items": len(union_content),
            "content_items": len(content),
            "missing_content_items": len(union_content - content),
            "union_geometry_items": len(union_geometry),
            "geometry_items": len(geometry),
            "missing_geometry_items": len(union_geometry - geometry),
            "union_asset_items": len(union_assets),
            "asset_items": len(assets),
            "missing_asset_items": len(union_assets - assets),
            "union_comments": len(union_comment_ids),
            "comments": len(comment_ids),
            "missing_comment_ids": len(union_comment_ids - comment_ids),
            "missing_comment_examples": sorted(union_comment_ids - comment_ids)[:10],
            "union_comment_fields": len(union_comment_fields),
            "comment_fields": len(comment_fields),
            "missing_comment_fields": len(union_comment_fields - comment_fields),
        }


def production_ineligibility_reasons(record: dict[str, Any]) -> list[str]:
    reasons: list[str] = []
    source_key = str(record.get("source_key") or "")
    spec = SOURCE_SPECS.get(source_key)
    if not spec or not spec.production_eligible:
        reasons.append("diagnostic_or_no_assets_source")
    if not record.get("source_json"):
        reasons.append("source_json_missing")
    if str(record.get("status") or "") != "ok":
        reasons.append("conversion_not_usable")
    export = record.get("export") or {}
    if (
        export.get("partial")
        or export.get("degraded")
        or export.get("complete") is not True
    ):
        reasons.append("partial_export")
    completeness = record.get("completeness")
    union_metrics = {
        "missing_item_ids": "union_items_missing",
        "missing_fields": "union_fields_missing",
        "missing_content_items": "union_content_missing",
        "missing_geometry_items": "union_geometry_missing",
        "missing_asset_items": "union_assets_missing",
        "missing_comment_ids": "union_comments_missing",
        "missing_comment_fields": "union_comment_fields_missing",
    }
    if not isinstance(completeness, dict) or any(
        metric not in completeness for metric in union_metrics
    ):
        reasons.append("union_completeness_not_measured")
    else:
        for metric, reason in union_metrics.items():
            value = completeness.get(metric)
            if isinstance(value, bool) or not isinstance(value, int) or value < 0:
                reasons.append("union_completeness_not_measured")
                break
            if value:
                reasons.append(reason)
    if int((record.get("source_assets") or {}).get("missing") or 0):
        reasons.append("source_assets_missing")
    if int((record.get("canvas") or {}).get("missing_files") or 0):
        reasons.append("canvas_files_missing")
    if int((record.get("missing_miro_items") or {}).get("actionable") or 0):
        reasons.append("actionable_items_missing")
    if int((record.get("mapping") or {}).get("actionable") or 0):
        reasons.append("actionable_mapping_defects")
    if int((record.get("overlaps") or {}).get("generated") or 0):
        reasons.append("generated_overlaps")
    return reasons


_RECOMMENDATION_CRITERIA = (
    "missing_union_items",
    "missing_union_fields",
    "missing_content_items",
    "missing_geometry_items",
    "missing_asset_items",
    "missing_comment_ids",
    "missing_comment_fields",
    "status_rank",
    "actionable_missing",
    "actionable_mapping",
    "generated_overlaps",
    "simplicity_priority",
    "source_key_tiebreak",
)


def recommendation_key(record: dict[str, Any]) -> tuple[Any, ...]:
    completeness = record.get("completeness") or {}
    missing = record.get("missing_miro_items") or {}
    mapping = record.get("mapping") or {}
    overlaps = record.get("overlaps") or {}
    source_key = str(record.get("source_key") or "")
    unknown = 10**9
    return (
        int(completeness.get("missing_item_ids", unknown)),
        int(completeness.get("missing_fields", unknown)),
        int(completeness.get("missing_content_items", unknown)),
        int(completeness.get("missing_geometry_items", unknown)),
        int(completeness.get("missing_asset_items", unknown)),
        int(completeness.get("missing_comment_ids", unknown)),
        int(completeness.get("missing_comment_fields", unknown)),
        _status_rank(str(record.get("status") or "")),
        int(missing.get("actionable") or 0),
        int(mapping.get("actionable") or 0),
        int(overlaps.get("generated") or 0),
        SIMPLICITY_PRIORITY.get(source_key, 99),
        source_key,
    )


def _record_groups(
    records: list[dict[str, Any]],
) -> dict[tuple[str, str], list[dict[str, Any]]]:
    groups: dict[tuple[str, str], list[dict[str, Any]]] = {}
    for record in records:
        board = record.get("board") or {}
        board_id = str(board.get("board_id") or "")
        text_mode = str(record.get("text_style_mode") or "")
        if board_id and text_mode:
            groups.setdefault((board_id, text_mode), []).append(record)
    return groups


def choose_best_records(records: list[dict[str, Any]]) -> list[dict[str, Any]]:
    best: list[dict[str, Any]] = []
    for group in _record_groups(records).values():
        eligible = [
            record for record in group if not production_ineligibility_reasons(record)
        ]
        if eligible:
            best.append(min(eligible, key=recommendation_key))
    return best


def _recommendation_reason(chosen: dict[str, Any], group: list[dict[str, Any]]) -> str:
    eligible = sorted(
        (record for record in group if not production_ineligibility_reasons(record)),
        key=recommendation_key,
    )
    excluded = len(group) - len(eligible)
    if len(eligible) == 1:
        suffix = f"; excluded_ineligible={excluded}" if excluded else ""
        return "only production-eligible source" + suffix
    chosen_key = recommendation_key(chosen)
    runner_up_key = recommendation_key(eligible[1])
    for name, chosen_value, runner_up_value in zip(
        _RECOMMENDATION_CRITERIA, chosen_key, runner_up_key
    ):
        if chosen_value != runner_up_value:
            return f"{name}={chosen_value} vs {runner_up_value}"
    return "all completeness and audit criteria tied"


def build_production_source_result(payload: dict[str, Any]) -> dict[str, Any]:
    records = payload["records"]
    groups = _record_groups(records)
    board_ids = sorted(
        {
            str((record.get("board") or {}).get("board_id") or "")
            for record in records
            if str((record.get("board") or {}).get("board_id") or "")
        }
    )
    configured_modes = (payload.get("settings") or {}).get("text_modes")
    if isinstance(configured_modes, list):
        text_modes = list(
            dict.fromkeys(str(mode) for mode in configured_modes if str(mode))
        )
    else:
        text_modes = sorted({text_mode for _, text_mode in groups})

    recommendations: list[dict[str, Any]] = []
    for board_id in board_ids:
        board_records = [
            record
            for record in records
            if str((record.get("board") or {}).get("board_id") or "") == board_id
        ]
        for text_mode in text_modes:
            group = groups.get((board_id, text_mode), [])
            eligible = [
                record
                for record in group
                if not production_ineligibility_reasons(record)
            ]
            if not eligible:
                excluded_records = group or board_records
                recommendations.append(
                    {
                        "board_id": board_id,
                        "text_style_mode": text_mode,
                        "status": "no_production_eligible_source",
                        "excluded": {
                            str(
                                record.get("source_key") or ""
                            ): production_ineligibility_reasons(record)
                            for record in excluded_records
                        },
                    }
                )
                continue
            chosen = min(eligible, key=recommendation_key)
            recommendations.append(
                {
                    "board_id": board_id,
                    "text_style_mode": text_mode,
                    "status": "selected",
                    "source_key": chosen["source_key"],
                    "canonical_source": chosen["source_json"],
                    "why": _recommendation_reason(chosen, group),
                    "completeness": chosen.get("completeness") or {},
                }
            )

    selected = sum(item["status"] == "selected" for item in recommendations)
    complete = bool(recommendations) and selected == len(recommendations)
    return {
        "schema_version": 2,
        "result_type": "miro_canonical_source_recommendation",
        "complete": complete,
        "summary": {
            "expected": len(recommendations),
            "selected": selected,
            "missing": len(recommendations) - selected,
        },
        "recommendations": recommendations,
    }


def build_summary(records: list[dict[str, Any]]) -> dict[str, Any]:
    statuses = Counter(str(record.get("status") or "") for record in records)
    sources = Counter(str(record.get("source_key") or "") for record in records)
    board_ids = {
        str((record.get("board") or {}).get("board_id") or "") for record in records
    }
    board_ids.discard("")
    return {
        "boards": len(board_ids),
        "records": len(records),
        "by_status": dict(sorted(statuses.items())),
        "by_source": dict(sorted(sources.items())),
        "ok": statuses.get("ok", 0),
        "needs_review": sum(
            statuses.get(status, 0)
            for status in (
                "needs_review",
                "source_missing_assets",
                "canvas_missing_files",
                "render_failed",
            )
        ),
        "export_failed": statuses.get("export_failed", 0),
        "no_websdk_export": statuses.get("no_websdk_export", 0),
    }


def _table_cell(value: Any) -> str:
    return str(value if value is not None else "").replace("|", "\\|")


def render_markdown_report(payload: dict[str, Any]) -> str:
    lines = [
        "# Miro Export Source Comparison",
        "",
        f"boards: {payload['summary']['boards']}",
        f"records: {payload['summary']['records']}",
        f"ok: {payload['summary']['ok']}",
        f"needs_review: {payload['summary']['needs_review']}",
        f"export_failed: {payload['summary']['export_failed']}",
        f"no_websdk_export: {payload['summary']['no_websdk_export']}",
        "",
        "| Board | Source | Mode | Status | Items | Comments | Missing/actionable | Mapping/actionable | Generated overlaps | Missing files | Source assets missing |",
        "|---|---|---:|---|---:|---:|---:|---:|---:|---:|---:|",
    ]
    for record in payload["records"]:
        board = record.get("board") or {}
        missing = record.get("missing_miro_items") or {}
        mapping = record.get("mapping") or {}
        overlaps = record.get("overlaps") or {}
        canvas = record.get("canvas") or {}
        source_assets = record.get("source_assets") or {}
        export = record.get("export") or {}
        items = (record.get("source") or {}).get("items", export.get("items", ""))
        comments = export.get("comments", "")
        source_label = SOURCE_SPECS.get(
            str(record.get("source_key") or ""), SourceSpec("", "", "")
        ).label
        lines.append(
            "| "
            f"[{_table_cell(board.get('label'))}]({_table_cell(board.get('url'))}) | "
            f"{_table_cell(source_label)} | "
            f"{_table_cell(record.get('text_style_mode'))} | "
            f"{_table_cell(record.get('status'))} | "
            f"{items} | "
            f"{comments} | "
            f"{missing.get('total', '')}/{missing.get('actionable', '')} | "
            f"{mapping.get('total', '')}/{mapping.get('actionable', '')} | "
            f"{overlaps.get('generated', '')} | "
            f"{canvas.get('missing_files', '')} | "
            f"{source_assets.get('missing', '')} |"
        )
    return "\n".join(lines) + "\n"


def render_websdk_queue(payload: dict[str, Any]) -> str:
    lines = [
        "# Web SDK Export Queue",
        "",
        "Boards listed here either missed a raw Web SDK export or showed Web SDK-only candidates.",
        "",
    ]
    queued = 0
    for record in payload["records"]:
        board = record.get("board") or {}
        if record.get("status") == "no_websdk_export":
            queued += 1
            lines.append(
                f"- [ ] [{board.get('label')}]({board.get('url')}) - export raw Web SDK JSON"
            )
            lines.append(f"  - board_id: `{board.get('board_id')}`")
            continue
        coverage = record.get("coverage") or {}
        candidates = coverage.get("candidates") or []
        websdk_candidates = [
            item
            for item in candidates
            if item.get("action") == "websdk_export_candidate"
        ]
        if websdk_candidates:
            queued += 1
            types = ", ".join(f"`{item['type']}`" for item in websdk_candidates)
            lines.append(
                f"- [ ] [{board.get('label')}]({board.get('url')}) - inspect Web SDK-only type(s): {types}"
            )
            lines.append(f"  - source: `{record.get('source_key')}`")
    if not queued:
        lines.append("Queue is empty.")
    return "\n".join(lines) + "\n"


def render_recommendations(payload: dict[str, Any]) -> str:
    result = build_production_source_result(payload)
    lines = [
        "# Production Source Recommendation",
        "",
        "Rule: choose the production-eligible source with the highest union-ID, field, content, geometry, and asset completeness.",
        "",
        "| Board | Mode | Recommended source | Status | Why |",
        "|---|---:|---|---|---|",
    ]
    board_by_id = {
        str((record.get("board") or {}).get("board_id") or ""): record.get("board")
        or {}
        for record in payload["records"]
    }
    for recommendation in result["recommendations"]:
        board = board_by_id.get(recommendation["board_id"], {})
        source_key = str(recommendation.get("source_key") or "")
        spec = SOURCE_SPECS.get(source_key, SourceSpec(source_key, source_key, ""))
        reason = recommendation.get("why") or "; ".join(
            f"{key}={','.join(value)}"
            for key, value in (recommendation.get("excluded") or {}).items()
        )
        lines.append(
            "| "
            f"[{_table_cell(board.get('label'))}]({_table_cell(board.get('url'))}) | "
            f"{_table_cell(recommendation.get('text_style_mode'))} | "
            f"{_table_cell(spec.label or '-')} | "
            f"{_table_cell(recommendation.get('status'))} | "
            f"{_table_cell(reason)} |"
        )
    if not result["recommendations"]:
        lines.append("| - | - | - | - | No converted records to compare. |")
    return "\n".join(lines) + "\n"


_OUTPUT_SENTINEL = ".miro-export-source-compare"
_OUTPUT_SENTINEL_CONTENT = "miro-export-source-compare-v1\n"


def validate_output_target(out_dir: Path) -> None:
    resolved = out_dir.resolve()
    anchor = Path(resolved.anchor)
    if resolved in {anchor, REPO_ROOT.resolve()}:
        raise RuntimeError(f"Refusing to use unsafe output directory: {resolved}")
    if not out_dir.exists() and not is_link_or_reparse(out_dir):
        return
    if is_link_or_reparse(out_dir) or not out_dir.is_dir():
        raise RuntimeError(f"Output path is not a regular directory: {out_dir}")

    sentinel = out_dir / _OUTPUT_SENTINEL
    has_content = any(out_dir.iterdir())
    if sentinel.exists() or is_link_or_reparse(sentinel):
        require_regular_file(sentinel, label="Comparison output sentinel")
        if sentinel.read_text(encoding="utf-8") != _OUTPUT_SENTINEL_CONTENT:
            raise RuntimeError(f"Output sentinel is invalid: {sentinel}")
    elif has_content:
        raise RuntimeError(
            f"Refusing to replace unowned output directory without {sentinel.name}: {out_dir}"
        )


def _prepare_staged_output(
    staged_dir: Path,
    out_dir: Path,
    *,
    preserve_existing: bool,
) -> None:
    if preserve_existing and out_dir.exists():
        require_regular_directory(out_dir, label="Existing comparison output")
        shutil.copytree(out_dir, staged_dir)
    else:
        staged_dir.mkdir()
    (staged_dir / _OUTPUT_SENTINEL).write_text(
        _OUTPUT_SENTINEL_CONTENT,
        encoding="utf-8",
    )


def reset_outputs(out_dir: Path) -> None:
    validate_output_target(out_dir)
    out_dir.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(
        prefix=f".{out_dir.name}-stage-",
        dir=out_dir.parent,
    ) as temporary:
        staged_dir = Path(temporary) / out_dir.name
        _prepare_staged_output(staged_dir, out_dir, preserve_existing=False)
        publish_staged_directory(staged_dir, out_dir)


def add_auth_args(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--token-env", default="MIRO_ACCESS_TOKEN")
    parser.add_argument(
        "--oauth",
        action="store_true",
        help="Resolve a temporary token through local Miro OAuth.",
    )
    parser.add_argument("--oauth-client-id-env", default="MIRO_CLIENT_ID")
    parser.add_argument("--oauth-client-secret-env", default="MIRO_CLIENT_SECRET")
    parser.add_argument("--oauth-redirect-uri", default=DEFAULT_REDIRECT_URI)
    parser.add_argument("--oauth-scopes", default=DEFAULT_SCOPES)
    parser.add_argument("--oauth-authorize-url", default=DEFAULT_AUTHORIZE_URL)
    parser.add_argument("--oauth-token-url", default=DEFAULT_TOKEN_URL)
    parser.add_argument(
        "--oauth-timeout-seconds", type=int, default=DEFAULT_TIMEOUT_SECONDS
    )
    parser.add_argument("--oauth-browser", default=DEFAULT_BROWSER)
    parser.add_argument("--oauth-no-open-browser", action="store_true")
    parser.add_argument("--oauth-code")
    parser.add_argument("--oauth-callback-url")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Compare every available Miro export source on listed boards."
    )
    parser.add_argument("--board-list", type=Path, default=DEFAULT_BOARD_LIST)
    parser.add_argument("--websdk-root", type=Path, default=DEFAULT_WEBSDK_ROOT)
    parser.add_argument("--out-dir", type=Path, default=DEFAULT_OUT_DIR)
    parser.add_argument(
        "--sources", default="core", help="Comma list, or aliases: core, all."
    )
    parser.add_argument(
        "--scale-mode", choices=["balanced", "overview", "readable"], default="readable"
    )
    parser.add_argument("--min-zoom", type=float, default=OBSIDIAN_UNLOCKED_MIN_ZOOM)
    parser.add_argument(
        "--text-style-mode", choices=["miro", "obsidian", "both"], default="obsidian"
    )
    parser.add_argument("--min-font-px", type=int, default=8)
    parser.add_argument(
        "--limit", type=int, help="Only compare the first N boards from the list."
    )
    parser.add_argument("--allow-missing-assets", action="store_true")
    parser.add_argument(
        "--render",
        action="store_true",
        help="Capture a smoke screenshot for each converted source.",
    )
    parser.add_argument(
        "--keep-out-dir",
        action="store_true",
        help="Do not clear previous comparison artifacts.",
    )
    parser.add_argument(
        "--refresh-board-list",
        action="store_true",
        help="Fetch visible boards before comparing sources.",
    )
    parser.add_argument(
        "--refresh-board-list-only",
        action="store_true",
        help="Fetch visible boards and stop before source comparison.",
    )
    parser.add_argument(
        "--preflight",
        action="store_true",
        help="Prepare directories and write a readiness report without contacting Miro.",
    )
    add_auth_args(parser)
    return parser.parse_args()


def source_keys_require_token(source_keys: list[str]) -> bool:
    return any(SOURCE_SPECS[key].category in {"rest", "legacy"} for key in source_keys)


def resolve_runtime_token(args: argparse.Namespace, *, required: bool) -> str:
    if args.oauth:
        return resolve_token_from_args(args)
    token = os.environ.get(args.token_env, "")
    if required and not token:
        raise SystemExit(f"{args.token_env} is not set. Set it or pass --oauth.")
    return token


def refresh_board_list(path: Path, *, token: str) -> dict[str, Any]:
    boards = get_boards(token)
    payload = {
        "schema_version": 1,
        "source": "miro_rest_boards",
        "summary": {
            "total": len(boards),
            "by_team": dict(
                sorted(
                    Counter(
                        str((board.get("team") or {}).get("name") or "<unknown>")
                        for board in boards
                    ).items()
                )
            ),
        },
        "boards": boards,
    }
    write_json(path, payload)
    return payload["summary"]


def _masked(value: str) -> str:
    if not value:
        return ""
    if len(value) <= 4:
        return "*" * len(value)
    return "*" * (len(value) - 4) + value[-4:]


def preflight_report(
    args: argparse.Namespace, source_keys: list[str]
) -> dict[str, Any]:
    args.board_list.parent.mkdir(parents=True, exist_ok=True)
    validate_output_target(args.out_dir)
    args.out_dir.mkdir(parents=True, exist_ok=True)
    if args.websdk_root.exists() or is_link_or_reparse(args.websdk_root):
        require_regular_directory(args.websdk_root, label="Web SDK export root")
    else:
        args.websdk_root.mkdir(parents=True, exist_ok=True)

    token_present = bool(os.environ.get(args.token_env))
    oauth: dict[str, Any]
    try:
        config = config_from_env(
            client_id_env=args.oauth_client_id_env,
            client_secret_env=args.oauth_client_secret_env,
            redirect_uri=args.oauth_redirect_uri,
            scopes=args.oauth_scopes,
            authorize_url=args.oauth_authorize_url,
            token_url=args.oauth_token_url,
        )
        oauth = {
            "available": True,
            "client_id": _masked(config.client_id),
            "client_secret_present": bool(config.client_secret),
            "redirect_uri": config.redirect_uri,
            "scopes": config.scopes,
        }
    except Exception as exc:  # noqa: BLE001
        oauth = {"available": False, "error": str(exc)}

    board_count: int | None = None
    board_list_error = ""
    if args.board_list.exists():
        try:
            board_count = len(load_board_refs(args.board_list))
        except Exception as exc:  # noqa: BLE001
            board_list_error = str(exc)

    websdk_exports = (
        list(args.websdk_root.rglob("*.json")) if args.websdk_root.exists() else []
    )
    requires_token = source_keys_require_token(source_keys)
    has_auth_path = token_present or oauth.get("available")
    ready = bool(
        args.board_list.exists()
        and not board_list_error
        and (not requires_token or has_auth_path)
    )

    return {
        "schema_version": 1,
        "ready": ready,
        "sources": source_keys,
        "requires_token": requires_token,
        "auth": {
            "token_env": args.token_env,
            "token_env_present": token_present,
            "oauth": oauth,
        },
        "paths": {
            "board_list": str(args.board_list),
            "board_list_exists": args.board_list.exists(),
            "board_count": board_count,
            "board_list_error": board_list_error,
            "websdk_root": str(args.websdk_root),
            "websdk_exports": len(websdk_exports),
            "out_dir": str(args.out_dir),
            "reports": {
                "comparison_json": str(
                    args.out_dir / "miro_export_source_comparison.json"
                ),
                "comparison_md": str(args.out_dir / "miro_export_source_comparison.md"),
                "websdk_queue": str(args.out_dir / "websdk_needed_queue.md"),
                "recommendations": str(
                    args.out_dir / "production_source_recommendation.md"
                ),
            },
        },
        "next_steps": preflight_next_steps(
            board_list_exists=args.board_list.exists(),
            board_list_error=board_list_error,
            requires_token=requires_token,
            has_auth_path=has_auth_path,
        ),
    }


def preflight_next_steps(
    *,
    board_list_exists: bool,
    board_list_error: str,
    requires_token: bool,
    has_auth_path: bool,
) -> list[str]:
    steps: list[str] = []
    if requires_token and not has_auth_path:
        steps.append(
            "Set MIRO_ACCESS_TOKEN or pass --oauth with local Miro OAuth config."
        )
    if not board_list_exists:
        steps.append(
            "Run with --refresh-board-list --oauth to create the all-available board list."
        )
    elif board_list_error:
        steps.append("Fix or regenerate the board-list JSON; it could not be parsed.")
    if not steps:
        steps.append(
            "Run a pilot with --limit 1, then remove --limit for the full comparison."
        )
    return steps


def render_preflight_markdown(payload: dict[str, Any]) -> str:
    auth = payload["auth"]
    paths = payload["paths"]
    lines = [
        "# Miro Export Source Comparison Preflight",
        "",
        f"ready: `{str(payload['ready']).lower()}`",
        f"sources: `{', '.join(payload['sources'])}`",
        f"requires_token: `{str(payload['requires_token']).lower()}`",
        "",
        "## Auth",
        f"- token env `{auth['token_env']}` present: `{str(auth['token_env_present']).lower()}`",
        f"- oauth config available: `{str(auth['oauth'].get('available')).lower()}`",
    ]
    if auth["oauth"].get("available"):
        lines.append(f"- oauth client_id: `{auth['oauth'].get('client_id')}`")
        lines.append(f"- oauth redirect_uri: `{auth['oauth'].get('redirect_uri')}`")
        lines.append(f"- oauth scopes: `{auth['oauth'].get('scopes')}`")
    else:
        lines.append(f"- oauth error: `{auth['oauth'].get('error', '')}`")
    lines.extend(
        [
            "",
            "## Paths",
            f"- board_list: `{paths['board_list']}`",
            f"- board_list_exists: `{str(paths['board_list_exists']).lower()}`",
            f"- board_count: `{paths['board_count']}`",
            f"- websdk_root: `{paths['websdk_root']}`",
            f"- websdk_exports: `{paths['websdk_exports']}`",
            f"- out_dir: `{paths['out_dir']}`",
            "",
            "## Next Steps",
        ]
    )
    for step in payload["next_steps"]:
        lines.append(f"- {step}")
    return "\n".join(lines) + "\n"


def write_preflight_report(out_dir: Path, payload: dict[str, Any]) -> None:
    validate_output_target(out_dir)
    out_dir.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(
        prefix=f".{out_dir.name}-stage-",
        dir=out_dir.parent,
    ) as temporary:
        staged_dir = Path(temporary) / out_dir.name
        _prepare_staged_output(staged_dir, out_dir, preserve_existing=True)
        write_json(staged_dir / "export_source_compare_preflight.json", payload)
        (staged_dir / "export_source_compare_preflight.md").write_text(
            render_preflight_markdown(payload),
            encoding="utf-8",
        )
        publish_staged_directory(staged_dir, out_dir)


def build_records_for_board(
    board: BoardRef,
    *,
    source_keys: list[str],
    out_dir: Path,
    token: str,
    websdk_root: Path,
    allow_missing_assets: bool,
    text_modes: list[str],
    scale_mode: str,
    min_zoom: float,
    min_font_px: int,
    render: bool,
) -> list[dict[str, Any]]:
    exported: dict[str, SourceResult] = {}
    records: list[dict[str, Any]] = []
    rest_for_coverage: Path | None = None
    websdk_for_coverage: Path | None = None

    for source_key in source_keys:
        progress(f"start {board.board_id} [{source_key}]")
        result = materialize_source(
            board,
            source_key,
            out_dir=out_dir,
            token=token,
            websdk_root=websdk_root,
            allow_missing_assets=allow_missing_assets,
            exported=exported,
        )
        exported[source_key] = result
        if (
            source_key in {REST_EXP, REST_STABLE}
            and result.source_json
            and not rest_for_coverage
        ):
            rest_for_coverage = result.source_json
        if source_key == WEBSDK and result.source_json:
            websdk_for_coverage = result.source_json

        if result.status != "exported" or not result.source_json:
            records.append(
                {
                    "board": asdict(board),
                    "source_key": source_key,
                    "source_label": SOURCE_SPECS[source_key].label,
                    "status": result.status,
                    "source_json": str(result.source_json)
                    if result.source_json
                    else None,
                    "text_style_mode": None,
                    "export": result.export_info,
                    "error": result.error,
                }
            )
            progress(f"{result.status} {board.board_id} [{source_key}]")
            continue

        coverage = _coverage_summary(rest_for_coverage, websdk_for_coverage)
        for text_mode in text_modes:
            try:
                record = audit_one_board(
                    board,
                    source_json=result.source_json,
                    out_dir=out_dir / "audits" / source_key,
                    scale_mode=scale_mode,
                    min_zoom=min_zoom,
                    text_style_mode=text_mode,
                    min_font_px=min_font_px,
                    render=render,
                    render_dir=out_dir / "renders" / source_key,
                )
            except Exception as exc:  # noqa: BLE001
                record = {
                    "board": asdict(board),
                    "status": "convert_failed",
                    "source_json": str(result.source_json),
                    "text_style_mode": text_mode,
                    "error": str(exc),
                }
            record.update(
                {
                    "source_key": source_key,
                    "source_label": SOURCE_SPECS[source_key].label,
                    "export": result.export_info,
                    "source_type_stats": _source_stats(result.source_json),
                    "coverage": coverage,
                }
            )
            records.append(record)
            progress(f"{record['status']} {board.board_id} [{source_key}/{text_mode}]")

    annotate_completeness(records)
    return records


def _run_comparison(
    args: argparse.Namespace,
    *,
    source_keys: list[str],
    token: str,
    boards: list[BoardRef],
    out_dir: Path,
) -> dict[str, Any]:
    text_modes = expand_text_style_modes(args.text_style_mode)
    records: list[dict[str, Any]] = []
    for board in boards:
        records.extend(
            build_records_for_board(
                board,
                source_keys=source_keys,
                out_dir=out_dir,
                token=token,
                websdk_root=args.websdk_root,
                allow_missing_assets=args.allow_missing_assets,
                text_modes=text_modes,
                scale_mode=args.scale_mode,
                min_zoom=args.min_zoom,
                min_font_px=args.min_font_px,
                render=args.render,
            )
        )

    return {
        "schema_version": 2,
        "board_list": str(args.board_list),
        "websdk_root": str(args.websdk_root),
        "settings": {
            "sources": source_keys,
            "scale_mode": args.scale_mode,
            "min_zoom": args.min_zoom,
            "text_style_mode": args.text_style_mode,
            "text_modes": text_modes,
            "min_font_px": args.min_font_px,
            "allow_missing_assets": bool(args.allow_missing_assets),
            "render": bool(args.render),
        },
        "summary": build_summary(records),
        "records": records,
    }


def main() -> int:
    args = parse_args()
    try:
        source_keys = expand_source_keys(args.sources)
    except ValueError as exc:
        raise SystemExit(str(exc)) from exc

    if args.preflight:
        payload = preflight_report(args, source_keys)
        write_preflight_report(args.out_dir, payload)
        progress(f"ready={str(payload['ready']).lower()}")
        progress(
            f"preflight_json={args.out_dir / 'export_source_compare_preflight.json'}"
        )
        progress(f"preflight_md={args.out_dir / 'export_source_compare_preflight.md'}")
        for step in payload["next_steps"]:
            progress(f"next={step}")
        return 0 if payload["ready"] else 1

    if args.refresh_board_list_only:
        args.refresh_board_list = True

    if args.refresh_board_list:
        token = resolve_runtime_token(args, required=True)
        summary = refresh_board_list(args.board_list, token=token)
        progress(f"boards={summary['total']}")
        progress(f"board_list={args.board_list}")
        if args.refresh_board_list_only:
            return 0
    else:
        token = resolve_runtime_token(
            args,
            required=source_keys_require_token(source_keys),
        )

    boards = load_board_refs(args.board_list)
    if args.limit:
        boards = boards[: args.limit]
    if not boards:
        raise SystemExit(f"No boards found in {args.board_list}")
    progress(f"compare_boards={len(boards)}")
    progress(f"compare_sources={','.join(source_keys)}")

    validate_output_target(args.out_dir)
    args.out_dir.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(
        prefix=f".{args.out_dir.name}-stage-",
        dir=args.out_dir.parent,
    ) as temporary:
        staged_out_dir = Path(temporary) / args.out_dir.name
        _prepare_staged_output(
            staged_out_dir,
            args.out_dir,
            preserve_existing=bool(args.keep_out_dir),
        )
        payload = _run_comparison(
            args,
            source_keys=source_keys,
            token=token,
            boards=boards,
            out_dir=staged_out_dir,
        )
        payload = remap_output_paths(payload, staged_out_dir, args.out_dir)
        production_result = build_production_source_result(payload)

        write_json(staged_out_dir / "miro_export_source_comparison.json", payload)
        (staged_out_dir / "miro_export_source_comparison.md").write_text(
            render_markdown_report(payload),
            encoding="utf-8",
        )
        (staged_out_dir / "websdk_needed_queue.md").write_text(
            render_websdk_queue(payload),
            encoding="utf-8",
        )
        (staged_out_dir / "production_source_recommendation.md").write_text(
            render_recommendations(payload),
            encoding="utf-8",
        )
        write_json(
            staged_out_dir / "production_source_recommendation.json",
            production_result,
        )
        publish_staged_directory(staged_out_dir, args.out_dir)

    report_json = args.out_dir / "miro_export_source_comparison.json"
    report_md = args.out_dir / "miro_export_source_comparison.md"
    websdk_queue = args.out_dir / "websdk_needed_queue.md"
    recommendations = args.out_dir / "production_source_recommendation.md"
    recommendations_json = args.out_dir / "production_source_recommendation.json"
    progress(f"report_json={report_json}")
    progress(f"report_md={report_md}")
    progress(f"websdk_queue={websdk_queue}")
    progress(f"recommendations={recommendations}")
    progress(f"recommendations_json={recommendations_json}")
    progress(
        "summary=" + json.dumps(payload["summary"], ensure_ascii=False, sort_keys=True)
    )
    return 0 if production_result["complete"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
