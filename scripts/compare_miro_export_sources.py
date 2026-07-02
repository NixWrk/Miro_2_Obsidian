from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
from collections import Counter
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any


REPO_ROOT = Path(__file__).resolve().parents[1]
CONVERTER_DIR = REPO_ROOT / "Json_2_Canvas"
SCRIPTS_DIR = REPO_ROOT / "scripts"
MIRO_JSON_DIR = REPO_ROOT / "Miro_2_Json"
DEFAULT_BOARD_LIST = REPO_ROOT / "work" / "MIRO2OBSIDIAN" / "Obs_Miro" / "Концепт" / "Web_boards.md"
DEFAULT_WEBSDK_ROOT = REPO_ROOT / "work" / "MIRO2OBSIDIAN" / "websdk_exports"
DEFAULT_OUT_DIR = REPO_ROOT / "tools" / "canvas_render" / ".out" / "export_source_compare"
OBSIDIAN_UNLOCKED_MIN_ZOOM = 2 ** -12

for path in (MIRO_JSON_DIR, CONVERTER_DIR, SCRIPTS_DIR):
    sys.path.insert(0, str(path))

from audit_web_board_pipeline import (  # noqa: E402
    BoardRef,
    audit_one_board,
    expand_text_style_modes,
    load_board_refs,
    load_json,
    safe_name,
)
from merge_miro_sources import merge_sources  # noqa: E402
from miro_capability_probe import build_coverage_rows, summarize_items  # noqa: E402
from miro_downloader import get_boards  # noqa: E402
from miro_oauth_token import (  # noqa: E402
    DEFAULT_AUTHORIZE_URL,
    DEFAULT_BROWSER,
    DEFAULT_REDIRECT_URI,
    DEFAULT_SCOPES,
    DEFAULT_TIMEOUT_SECONDS,
    DEFAULT_TOKEN_URL,
    config_from_env,
)
from miro_rest_export_board import (  # noqa: E402
    build_board_source_payload,
    download_export_assets,
    export_board_comments,
    export_board_items,
    resolve_token_from_args,
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

CORE_SOURCES = (REST_EXP, REST_STABLE, REST_EXP_NO_ASSETS, WEBSDK, MERGED_REST_EXP_WEBSDK)
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


SOURCE_SPECS: dict[str, SourceSpec] = {
    REST_EXP: SourceSpec(REST_EXP, "REST experimental + comments + assets", "rest"),
    REST_STABLE: SourceSpec(REST_STABLE, "REST stable + comments + assets", "rest", prefer_experimental=False),
    REST_EXP_NO_ASSETS: SourceSpec(
        REST_EXP_NO_ASSETS,
        "REST experimental + comments, no assets",
        "rest",
        download_assets=False,
    ),
    REST_STABLE_NO_ASSETS: SourceSpec(
        REST_STABLE_NO_ASSETS,
        "REST stable + comments, no assets",
        "rest",
        prefer_experimental=False,
        download_assets=False,
    ),
    LEGACY_EXP: SourceSpec(LEGACY_EXP, "Legacy downloader experimental", "legacy"),
    LEGACY_STABLE: SourceSpec(LEGACY_STABLE, "Legacy downloader stable", "legacy", prefer_experimental=False),
    WEBSDK: SourceSpec(WEBSDK, "Web SDK raw export", "websdk", download_assets=False),
    MERGED_REST_EXP_WEBSDK: SourceSpec(
        MERGED_REST_EXP_WEBSDK,
        "Merged REST experimental + Web SDK",
        "merged",
        dependencies=(REST_EXP, WEBSDK),
    ),
    MERGED_REST_STABLE_WEBSDK: SourceSpec(
        MERGED_REST_STABLE_WEBSDK,
        "Merged REST stable + Web SDK",
        "merged",
        dependencies=(REST_STABLE, WEBSDK),
    ),
}

SIMPLICITY_PRIORITY = {
    REST_EXP: 0,
    REST_STABLE: 1,
    REST_EXP_NO_ASSETS: 2,
    REST_STABLE_NO_ASSETS: 3,
    MERGED_REST_EXP_WEBSDK: 4,
    MERGED_REST_STABLE_WEBSDK: 5,
    LEGACY_EXP: 6,
    LEGACY_STABLE: 7,
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
            raise ValueError(f"Unknown source '{key}'. Known sources: {known}, core, all")
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


def _sidecar_dir(path: Path) -> Path:
    return path.with_name(f"{path.stem}_files")


def _copy_sidecar(source_json: Path, target_json: Path) -> None:
    source_dir = _sidecar_dir(source_json)
    if source_dir.exists():
        target_dir = _sidecar_dir(target_json)
        if target_dir.exists():
            shutil.rmtree(target_dir)
        shutil.copytree(source_dir, target_dir)


def _copy_json_and_sidecar(source_json: Path, target_json: Path) -> None:
    target_json.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source_json, target_json)
    _copy_sidecar(source_json, target_json)


def _looks_like_board_id(value: str, board_id: str) -> bool:
    return board_id in value or safe_name(board_id) in value


def _websdk_board_id(payload: Any) -> str:
    if not isinstance(payload, dict):
        return ""
    board = payload.get("board") if isinstance(payload.get("board"), dict) else {}
    for key in ("id", "boardId", "board_id"):
        value = str(board.get(key) or "").strip()
        if value:
            return value
    url = str(board.get("url") or board.get("appUrl") or "").strip()
    marker = "/board/"
    if marker in url:
        return url.split(marker, 1)[1].split("/", 1)[0].split("?", 1)[0]
    return ""


def find_websdk_export(board: BoardRef, websdk_root: Path) -> Path | None:
    if not websdk_root.exists():
        return None
    candidates = sorted(websdk_root.rglob("*.json"))
    for candidate in candidates:
        if _looks_like_board_id(candidate.name, board.board_id):
            return candidate
    for candidate in candidates:
        try:
            payload = load_json(candidate)
        except Exception:  # noqa: BLE001
            continue
        if _websdk_board_id(payload) == board.board_id:
            return candidate
    return None


def _source_stats(path: Path) -> dict[str, Any]:
    root = load_json(path)
    stats = summarize_items(root)
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


def _coverage_summary(rest_json: Path | None, websdk_json: Path | None) -> dict[str, Any]:
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
    messages: list[str] = []
    items = export_board_items(
        board_id=board.board_id,
        token=token,
        prefer_experimental=prefer_experimental,
        logger=messages.append,
    )
    comments = export_board_comments(board_id=board.board_id, token=token, logger=messages.append)
    asset_stats: dict[str, int] = {}
    if download_assets:
        asset_stats = download_export_assets(
            items,
            output_path=output_json,
            token=token,
            logger=messages.append,
            strict=not allow_missing_assets,
        )
    write_json(output_json, build_board_source_payload(items, comments))
    return SourceResult(
        source_key="",
        source_json=output_json,
        status="exported",
        export_info={
            "items": len(items),
            "comments": len(comments),
            "asset_stats": asset_stats,
            "log_tail": messages[-10:],
            "prefer_experimental": prefer_experimental,
            "download_assets": download_assets,
        },
    )


def export_legacy_source(
    board: BoardRef,
    output_json: Path,
    *,
    token: str,
    prefer_experimental: bool,
) -> SourceResult:
    from download_worker import run_download  # noqa: PLC0415

    messages: list[str] = []
    failures: list[dict[str, str]] = []
    output_json.parent.mkdir(parents=True, exist_ok=True)
    legacy_safe_board = safe_name(board.board_id)
    produced_json = output_json.parent / f"legacy_{legacy_safe_board}.json"
    produced_files = output_json.parent / f"legacy_{legacy_safe_board}_files"

    legacy_warning = ""
    try:
        run_download(
            board_id=board.board_id,
            token=token,
            save_base=output_json.parent,
            safe_team="legacy",
            safe_board=legacy_safe_board,
            rename_files=True,
            prefer_experimental=prefer_experimental,
            log=messages.append,
            ask_strategy=lambda _conflicts: "overwrite",
            ask_continue_forbidden=lambda _source, _status, _message: True,
            ask_exp_fallback=lambda _partial_count: True,
            on_prepare_rows=lambda _id_to_final, _all_items: None,
            on_file_start=lambda _item_id, _name: None,
            on_file_done=lambda _item_id: None,
            on_file_fail=lambda item_id, reason: failures.append({"id": str(item_id), "reason": str(reason)}),
            on_overall_progress=lambda _done, _total: None,
            gui_root=_ImmediateCallbackTarget(),
        )
    except UnicodeEncodeError as exc:
        if not produced_json.exists():
            raise
        legacy_warning = f"legacy_stdout_encoding_error_ignored: {exc}"
    if not produced_json.exists():
        raise RuntimeError(f"Legacy downloader did not write {produced_json}")

    shutil.move(str(produced_json), str(output_json))
    if produced_files.exists():
        target_files = _sidecar_dir(output_json)
        if target_files.exists():
            shutil.rmtree(target_files)
        shutil.move(str(produced_files), str(target_files))

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
        return SourceResult(source_key, None, "auth_missing", {}, f"MIRO_ACCESS_TOKEN is not set")

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
            websdk_json = find_websdk_export(board, websdk_root)
            if not websdk_json:
                return SourceResult(source_key, None, "no_websdk_export", {}, "No matching Web SDK JSON found")
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
                },
            )
        elif spec.category == "merged":
            missing = [dep for dep in spec.dependencies if dep not in exported or not exported[dep].source_json]
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
                return SourceResult(source_key, None, "dependency_missing", {}, "Dependency source path is empty")
            rest_root = load_json(rest_json)
            websdk_root_payload = load_json(websdk_json)
            comments = rest_root.get("comments") if isinstance(rest_root, dict) and isinstance(rest_root.get("comments"), list) else []
            rest_items_root = rest_root.get("items") if isinstance(rest_root, dict) and isinstance(rest_root.get("items"), list) else rest_root
            merged_items = merge_sources(rest_items_root, websdk_root_payload)
            write_json(output_json, build_board_source_payload(merged_items, comments))
            _copy_sidecar(rest_json, output_json)
            result = SourceResult(
                source_key,
                output_json,
                "exported",
                {
                    "items": len(merged_items),
                    "comments": len(comments),
                    "asset_stats": {},
                    "dependencies": list(spec.dependencies),
                },
            )
        else:
            raise RuntimeError(f"Unhandled source category: {spec.category}")
    except Exception as exc:  # noqa: BLE001
        return SourceResult(source_key, None, "export_failed", {}, str(exc))

    return SourceResult(source_key, result.source_json, result.status, result.export_info, result.error)


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


def recommendation_key(record: dict[str, Any]) -> tuple[int, int, int, int, int, int, int, int]:
    missing = record.get("missing_miro_items") or {}
    mapping = record.get("mapping") or {}
    overlaps = record.get("overlaps") or {}
    canvas = record.get("canvas") or {}
    source_assets = record.get("source_assets") or {}
    source_key = str(record.get("source_key") or "")
    return (
        _status_rank(str(record.get("status") or "")),
        int(missing.get("actionable") or 0),
        int(mapping.get("actionable") or 0),
        int(overlaps.get("generated") or 0),
        int(canvas.get("missing_files") or 0),
        int(source_assets.get("missing") or 0),
        SIMPLICITY_PRIORITY.get(source_key, 99),
        -int((record.get("source") or {}).get("items") or 0),
    )


def choose_best_records(records: list[dict[str, Any]]) -> list[dict[str, Any]]:
    by_board_mode: dict[tuple[str, str], list[dict[str, Any]]] = {}
    for record in records:
        board = record.get("board") or {}
        board_id = str(board.get("board_id") or "")
        text_mode = str(record.get("text_style_mode") or "")
        if not board_id or not text_mode:
            continue
        by_board_mode.setdefault((board_id, text_mode), []).append(record)
    return [min(group, key=recommendation_key) for group in by_board_mode.values() if group]


def build_summary(records: list[dict[str, Any]]) -> dict[str, Any]:
    statuses = Counter(str(record.get("status") or "") for record in records)
    sources = Counter(str(record.get("source_key") or "") for record in records)
    board_ids = {str((record.get("board") or {}).get("board_id") or "") for record in records}
    board_ids.discard("")
    return {
        "boards": len(board_ids),
        "records": len(records),
        "by_status": dict(sorted(statuses.items())),
        "by_source": dict(sorted(sources.items())),
        "ok": statuses.get("ok", 0),
        "needs_review": sum(
            statuses.get(status, 0)
            for status in ("needs_review", "source_missing_assets", "canvas_missing_files", "render_failed")
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
        source_label = SOURCE_SPECS.get(str(record.get("source_key") or ""), SourceSpec("", "", "")).label
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
            lines.append(f"- [ ] [{board.get('label')}]({board.get('url')}) - export raw Web SDK JSON")
            lines.append(f"  - board_id: `{board.get('board_id')}`")
            continue
        coverage = record.get("coverage") or {}
        candidates = coverage.get("candidates") or []
        websdk_candidates = [item for item in candidates if item.get("action") == "websdk_export_candidate"]
        if websdk_candidates:
            queued += 1
            types = ", ".join(f"`{item['type']}`" for item in websdk_candidates)
            lines.append(f"- [ ] [{board.get('label')}]({board.get('url')}) - inspect Web SDK-only type(s): {types}")
            lines.append(f"  - source: `{record.get('source_key')}`")
    if not queued:
        lines.append("Queue is empty.")
    return "\n".join(lines) + "\n"


def render_recommendations(payload: dict[str, Any]) -> str:
    best = choose_best_records(payload["records"])
    lines = [
        "# Production Source Recommendation",
        "",
        "Rule: keep REST experimental as the default unless another source materially improves audit quality.",
        "",
        "| Board | Mode | Recommended source | Status | Why |",
        "|---|---:|---|---|---|",
    ]
    for record in best:
        board = record.get("board") or {}
        source_key = str(record.get("source_key") or "")
        spec = SOURCE_SPECS.get(source_key, SourceSpec(source_key, source_key, ""))
        missing = (record.get("missing_miro_items") or {}).get("actionable", "")
        mapping = (record.get("mapping") or {}).get("actionable", "")
        overlaps = (record.get("overlaps") or {}).get("generated", "")
        reason = f"actionable_missing={missing}, mapping={mapping}, generated_overlaps={overlaps}"
        lines.append(
            "| "
            f"[{_table_cell(board.get('label'))}]({_table_cell(board.get('url'))}) | "
            f"{_table_cell(record.get('text_style_mode'))} | "
            f"{_table_cell(spec.label)} | "
            f"{_table_cell(record.get('status'))} | "
            f"{_table_cell(reason)} |"
        )
    if not best:
        lines.append("| - | - | - | - | No converted records to compare. |")
    return "\n".join(lines) + "\n"


def reset_outputs(out_dir: Path) -> None:
    shutil.rmtree(out_dir, ignore_errors=True)
    out_dir.mkdir(parents=True, exist_ok=True)


def add_auth_args(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--token-env", default="MIRO_ACCESS_TOKEN")
    parser.add_argument("--oauth", action="store_true", help="Resolve a temporary token through local Miro OAuth.")
    parser.add_argument("--oauth-client-id-env", default="MIRO_CLIENT_ID")
    parser.add_argument("--oauth-client-secret-env", default="MIRO_CLIENT_SECRET")
    parser.add_argument("--oauth-redirect-uri", default=DEFAULT_REDIRECT_URI)
    parser.add_argument("--oauth-scopes", default=DEFAULT_SCOPES)
    parser.add_argument("--oauth-authorize-url", default=DEFAULT_AUTHORIZE_URL)
    parser.add_argument("--oauth-token-url", default=DEFAULT_TOKEN_URL)
    parser.add_argument("--oauth-timeout-seconds", type=int, default=DEFAULT_TIMEOUT_SECONDS)
    parser.add_argument("--oauth-browser", default=DEFAULT_BROWSER)
    parser.add_argument("--oauth-no-open-browser", action="store_true")
    parser.add_argument("--oauth-code")
    parser.add_argument("--oauth-callback-url")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Compare every available Miro export source on listed boards.")
    parser.add_argument("--board-list", type=Path, default=DEFAULT_BOARD_LIST)
    parser.add_argument("--websdk-root", type=Path, default=DEFAULT_WEBSDK_ROOT)
    parser.add_argument("--out-dir", type=Path, default=DEFAULT_OUT_DIR)
    parser.add_argument("--sources", default="core", help="Comma list, or aliases: core, all.")
    parser.add_argument("--scale-mode", choices=["balanced", "overview", "readable"], default="readable")
    parser.add_argument("--min-zoom", type=float, default=OBSIDIAN_UNLOCKED_MIN_ZOOM)
    parser.add_argument("--text-style-mode", choices=["miro", "obsidian", "both"], default="obsidian")
    parser.add_argument("--min-font-px", type=int, default=8)
    parser.add_argument("--limit", type=int, help="Only compare the first N boards from the list.")
    parser.add_argument("--allow-missing-assets", action="store_true")
    parser.add_argument("--render", action="store_true", help="Capture a smoke screenshot for each converted source.")
    parser.add_argument("--keep-out-dir", action="store_true", help="Do not clear previous comparison artifacts.")
    parser.add_argument("--refresh-board-list", action="store_true", help="Fetch visible boards before comparing sources.")
    parser.add_argument("--refresh-board-list-only", action="store_true", help="Fetch visible boards and stop before source comparison.")
    parser.add_argument("--preflight", action="store_true", help="Prepare directories and write a readiness report without contacting Miro.")
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
            "by_team": dict(sorted(Counter(str((board.get("team") or {}).get("name") or "<unknown>") for board in boards).items())),
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


def preflight_report(args: argparse.Namespace, source_keys: list[str]) -> dict[str, Any]:
    args.board_list.parent.mkdir(parents=True, exist_ok=True)
    args.websdk_root.mkdir(parents=True, exist_ok=True)
    args.out_dir.mkdir(parents=True, exist_ok=True)

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

    websdk_exports = list(args.websdk_root.rglob("*.json")) if args.websdk_root.exists() else []
    requires_token = source_keys_require_token(source_keys)
    has_auth_path = token_present or oauth.get("available")
    ready = bool(args.board_list.exists() and not board_list_error and (not requires_token or has_auth_path))

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
                "comparison_json": str(args.out_dir / "miro_export_source_comparison.json"),
                "comparison_md": str(args.out_dir / "miro_export_source_comparison.md"),
                "websdk_queue": str(args.out_dir / "websdk_needed_queue.md"),
                "recommendations": str(args.out_dir / "production_source_recommendation.md"),
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
        steps.append("Set MIRO_ACCESS_TOKEN or pass --oauth with local Miro OAuth config.")
    if not board_list_exists:
        steps.append("Run with --refresh-board-list --oauth to create the all-available board list.")
    elif board_list_error:
        steps.append("Fix or regenerate the board-list JSON; it could not be parsed.")
    if not steps:
        steps.append("Run a pilot with --limit 1, then remove --limit for the full comparison.")
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
    write_json(out_dir / "export_source_compare_preflight.json", payload)
    (out_dir / "export_source_compare_preflight.md").write_text(render_preflight_markdown(payload), encoding="utf-8")


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
        if source_key in {REST_EXP, REST_STABLE} and result.source_json and not rest_for_coverage:
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
                    "source_json": str(result.source_json) if result.source_json else None,
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

    return records


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
        progress(f"preflight_json={args.out_dir / 'export_source_compare_preflight.json'}")
        progress(f"preflight_md={args.out_dir / 'export_source_compare_preflight.md'}")
        for step in payload["next_steps"]:
            progress(f"next={step}")
        return 0

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
        token = resolve_runtime_token(args, required=source_keys_require_token(source_keys) and args.oauth)

    boards = load_board_refs(args.board_list)
    if args.limit:
        boards = boards[: args.limit]
    if not boards:
        raise SystemExit(f"No boards found in {args.board_list}")
    progress(f"compare_boards={len(boards)}")
    progress(f"compare_sources={','.join(source_keys)}")

    if not args.keep_out_dir:
        reset_outputs(args.out_dir)
    else:
        args.out_dir.mkdir(parents=True, exist_ok=True)

    text_modes = expand_text_style_modes(args.text_style_mode)
    records: list[dict[str, Any]] = []
    for board in boards:
        records.extend(
            build_records_for_board(
                board,
                source_keys=source_keys,
                out_dir=args.out_dir,
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

    payload = {
        "schema_version": 1,
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

    report_json = args.out_dir / "miro_export_source_comparison.json"
    report_md = args.out_dir / "miro_export_source_comparison.md"
    websdk_queue = args.out_dir / "websdk_needed_queue.md"
    recommendations = args.out_dir / "production_source_recommendation.md"
    write_json(report_json, payload)
    report_md.write_text(render_markdown_report(payload), encoding="utf-8")
    websdk_queue.write_text(render_websdk_queue(payload), encoding="utf-8")
    recommendations.write_text(render_recommendations(payload), encoding="utf-8")

    progress(f"report_json={report_json}")
    progress(f"report_md={report_md}")
    progress(f"websdk_queue={websdk_queue}")
    progress(f"recommendations={recommendations}")
    progress("summary=" + json.dumps(payload["summary"], ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
