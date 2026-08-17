from __future__ import annotations

import argparse
import json
import os
import re

import tempfile
from collections import Counter
from dataclasses import asdict, dataclass
from datetime import datetime
from pathlib import Path
from typing import Any


REPO_ROOT = Path(__file__).resolve().parents[1]
CONVERTER_DIR = REPO_ROOT / "Json_2_Canvas"
WORK_ROOT = REPO_ROOT / "work"
DEFAULT_BOARD_LIST = WORK_ROOT / "Web_boards.md"
DEFAULT_JSON_ROOT = WORK_ROOT / "websdk_exports"
DEFAULT_OUT_DIR = REPO_ROOT / "tools" / "canvas_render" / ".out" / "web_board_audit"
RENDER_DIR = REPO_ROOT / "tools" / "canvas_render"
OBSIDIAN_UNLOCKED_MIN_ZOOM = 2**-12
AUDIT_SENTINEL_NAME = ".miro-web-board-audit"
AUDIT_SENTINEL_CONTENT = "miro-web-board-audit-v1\n"

from Json_2_Canvas.Converter import OBSIDIAN_FONT_SIZE, convert_miro_to_canvas  # noqa: E402
from Json_2_Canvas.Scale_engine import ViewProfile, pick_recommended_scale  # noqa: E402
from scripts.audit_item_node_mapping import summarize_mapping  # noqa: E402
from scripts.audit_missing_miro_items import audit_missing_items  # noqa: E402
from scripts.audit_node_overlaps import audit_nodes, build_miro_source_rects, overlap_to_dict  # noqa: E402
from scripts.merge_miro_sources import (  # noqa: E402
    DEFAULT_MAX_SOURCE_AGE_HOURS,
    validate_canonical_export,
    validate_rest_export,
    validate_websdk_export,
)
from scripts.miro_export_bundle import (  # noqa: E402
    copy_referenced_sidecar,
    is_link_or_reparse,
    publish_staged_directory,
    referenced_local_names,
    require_regular_directory,
    require_regular_file,
    sidecar_path,
)
from scripts.miro_capability_probe import load_json as load_strict_json  # noqa: E402
from scripts.miro_rest_export_board import export_complete_board_source, write_json  # noqa: E402


BOARD_LINK_RE = re.compile(
    r"\[(?P<label>[^\]]+)\]\((?P<url>https://miro\.com/app/board/(?P<id>[^/?#]+)[^)]*)\)"
)
SAFE_NAME_RE = re.compile(r"[^0-9A-Za-zА-Яа-я._=-]+")


@dataclass(frozen=True)
class BoardRef:
    board_id: str
    label: str
    url: str


def load_json(path: Path) -> Any:
    return load_strict_json(path)


def safe_name(value: str) -> str:
    value = SAFE_NAME_RE.sub("_", value.strip())
    value = re.sub(r"_+", "_", value).strip("._ ")
    return value or "board"


def board_artifact_key(board: BoardRef, text_style_mode: str) -> str:
    return f"{safe_name(board.board_id)}_{safe_name(text_style_mode)}"


def expand_text_style_modes(mode: str) -> list[str]:
    if mode == "both":
        return ["miro", "obsidian"]
    return [mode]


def validate_output_target(out_dir: Path) -> None:
    if not out_dir.exists() and not out_dir.is_symlink():
        return
    require_regular_directory(out_dir, label="Audit output directory")
    entries = list(out_dir.iterdir())
    if not entries:
        return

    sentinel = out_dir / AUDIT_SENTINEL_NAME
    if sentinel.exists() or sentinel.is_symlink():
        require_regular_file(sentinel, label="Audit output sentinel")
        if sentinel.read_text(encoding="utf-8") == AUDIT_SENTINEL_CONTENT:
            return
        raise RuntimeError(f"Audit output sentinel has unexpected content: {sentinel}")

    if out_dir.resolve() == DEFAULT_OUT_DIR.resolve(strict=False):
        return
    raise RuntimeError(
        f"Refusing to replace non-empty unowned audit output directory: {out_dir}. "
        f"Use an empty directory or one containing {AUDIT_SENTINEL_NAME}."
    )


def write_output_sentinel(out_dir: Path) -> None:
    (out_dir / AUDIT_SENTINEL_NAME).write_text(AUDIT_SENTINEL_CONTENT, encoding="utf-8")


def parse_board_markdown(path: Path) -> list[BoardRef]:
    refs: list[BoardRef] = []
    seen: set[str] = set()
    text = path.read_text(encoding="utf-8-sig")
    for match in BOARD_LINK_RE.finditer(text):
        board_id = match.group("id")
        if board_id in seen:
            continue
        seen.add(board_id)
        label = match.group("label").strip()
        refs.append(BoardRef(board_id=board_id, label=label, url=match.group("url")))
    return refs


def parse_board_json(path: Path) -> list[BoardRef]:
    payload = load_json(path)
    boards = payload.get("boards") if isinstance(payload, dict) else payload
    refs: list[BoardRef] = []
    if not isinstance(boards, list):
        return refs
    for board in boards:
        if not isinstance(board, dict) or not board.get("id"):
            continue
        board_id = str(board["id"])
        label = str(board.get("name") or board_id)
        refs.append(
            BoardRef(
                board_id=board_id,
                label=label,
                url=f"https://miro.com/app/board/{board_id}/",
            )
        )
    return refs


def load_board_refs(path: Path) -> list[BoardRef]:
    if path.suffix.lower() == ".json":
        return parse_board_json(path)
    return parse_board_markdown(path)


def validate_source_for_board(
    payload: Any,
    board_id: str,
    *,
    max_age_hours: float = DEFAULT_MAX_SOURCE_AGE_HOURS,
    now: datetime | None = None,
) -> dict[str, Any]:
    surface = payload.get("source_surface") if isinstance(payload, dict) else None
    validators = {
        "rest": validate_rest_export,
        "web_sdk": validate_websdk_export,
        "canonical": validate_canonical_export,
    }
    if surface is None:
        raise ValueError("strict source envelope missing")
    validator = validators.get(str(surface))
    if validator is None:
        raise ValueError(f"Unsupported source_surface: {surface!r}")
    info = validator(
        payload,
        expected_board_id=board_id,
        max_age_hours=max_age_hours,
        now=now,
    )
    return {
        "verified": True,
        "source_surface": str(surface),
        "board_id": info["board_id"],
        "exported_at": info["exported_at"].isoformat(),
    }


def find_local_export(
    board_id: str,
    json_root: Path,
    *,
    max_age_hours: float = DEFAULT_MAX_SOURCE_AGE_HOURS,
    now: datetime | None = None,
    rejected: list[dict[str, str]] | None = None,
) -> Path | None:
    if not json_root.exists() and not json_root.is_symlink():
        return None
    if is_link_or_reparse(json_root) or not json_root.is_dir():
        raise RuntimeError(f"JSON root is not a regular directory: {json_root}")

    candidates = [
        candidate
        for candidate in sorted(json_root.glob("*.json"))
        if board_id in candidate.name
    ]
    valid: list[tuple[datetime, str, Path]] = []
    for candidate in candidates:
        try:
            require_regular_file(candidate, label="Miro source JSON")
            validation = validate_source_for_board(
                load_json(candidate),
                board_id,
                max_age_hours=max_age_hours,
                now=now,
            )
            exported_at = datetime.fromisoformat(str(validation["exported_at"]))
        except (
            OSError,
            RuntimeError,
            UnicodeError,
            ValueError,
            json.JSONDecodeError,
        ) as exc:
            if rejected is not None:
                rejected.append({"path": str(candidate), "reason": str(exc)})
            continue
        valid.append((exported_at, candidate.name, candidate))
    return max(valid)[2] if valid else None


def stage_export_for_conversion(
    payload: dict[str, Any], source_json: Path, work_dir: Path
) -> Path:
    work_json = work_dir / source_json.name
    items = payload.get("items")
    if not isinstance(items, list):
        raise ValueError("strict source items must be a list")
    write_json(work_json, payload)
    copy_referenced_sidecar(items, source_json=source_json, staged_json=work_json)
    return work_json


def summarize_source(miro_root: Any) -> dict[str, Any]:
    if not isinstance(miro_root, dict):
        return {"items": 0, "comments": 0, "by_type": {}}
    items = [item for item in miro_root.get("items", []) if isinstance(item, dict)]
    comments = [
        comment
        for comment in miro_root.get("comments", [])
        if isinstance(comment, dict)
    ]
    by_type = Counter(str(item.get("type") or "<missing>") for item in items)
    return {
        "items": len(items),
        "comments": len(comments),
        "by_type": dict(sorted(by_type.items())),
    }


def _source_item_requires_asset(item: dict[str, Any]) -> bool:
    item_type = str(item.get("type") or "").lower()
    data = item.get("data") if isinstance(item.get("data"), dict) else {}
    if item_type == "image":
        return any(
            str(data.get(key) or "").strip()
            for key in ("imageUrl", "url", "downloadUrl")
        )
    if item_type == "document":
        return any(
            str(data.get(key) or "").strip()
            for key in ("documentUrl", "url", "downloadUrl")
        )
    if item_type == "doc_format":
        return bool(str(data.get("html") or "").strip())
    return False


def summarize_source_assets(miro_root: Any, source_json: Path) -> dict[str, Any]:
    if not isinstance(miro_root, dict) or not isinstance(miro_root.get("items"), list):
        raise ValueError("strict source items must be a list")

    attachments_dir = sidecar_path(source_json)
    sidecar_exists = attachments_dir.exists() or attachments_dir.is_symlink()
    if sidecar_exists:
        require_regular_directory(attachments_dir, label="Source asset sidecar")
    sidecar_root = attachments_dir.resolve(strict=False)
    examples: list[dict[str, str]] = []
    total = 0

    for item in miro_root["items"]:
        if not isinstance(item, dict):
            continue
        raw_name = str(item.get("local_name") or "").strip()
        requires_asset = _source_item_requires_asset(item)
        if not raw_name and not requires_asset:
            continue

        total += 1
        if not raw_name:
            examples.append(
                {
                    "id": str(item.get("id") or ""),
                    "type": str(item.get("type") or ""),
                    "local_name": "",
                    "expected_path": str(attachments_dir),
                    "reason": "missing local_name",
                }
            )
            continue

        relative = referenced_local_names([item])[0]
        expected = attachments_dir / relative
        try:
            expected.resolve(strict=False).relative_to(sidecar_root)
        except (OSError, ValueError) as exc:
            raise RuntimeError(f"Asset escapes source sidecar: {raw_name}") from exc

        if expected.exists() or expected.is_symlink():
            require_regular_file(expected, label="Referenced source asset")
            continue

        reason = "missing source file" if sidecar_exists else "missing source sidecar"
        examples.append(
            {
                "id": str(item.get("id") or ""),
                "type": str(item.get("type") or ""),
                "local_name": raw_name,
                "expected_path": str(expected),
                "reason": reason,
            }
        )

    return {
        "local_refs": total,
        "missing": len(examples),
        "sidecar_exists": sidecar_exists,
        "missing_examples": examples[:20],
    }


def summarize_canvas(canvas: dict[str, Any], vault_root: Path) -> dict[str, Any]:
    nodes = [node for node in canvas.get("nodes", []) if isinstance(node, dict)]
    edges = [edge for edge in canvas.get("edges", []) if isinstance(edge, dict)]
    node_types = Counter(str(node.get("type") or "<missing>") for node in nodes)
    vault_resolved = vault_root.resolve()

    missing_files: list[dict[str, str]] = []
    for node in nodes:
        if node.get("type") != "file":
            continue
        rel = str(node.get("file") or "").strip()
        if not rel:
            missing_files.append(
                {
                    "id": str(node.get("id") or ""),
                    "file": "",
                    "reason": "empty file ref",
                }
            )
            continue
        relative = Path(rel.replace("\\", "/"))
        candidate = vault_root / relative
        try:
            if relative.is_absolute():
                raise ValueError("absolute path")
            candidate.resolve(strict=False).relative_to(vault_resolved)
        except (OSError, ValueError):
            missing_files.append(
                {
                    "id": str(node.get("id") or ""),
                    "file": rel,
                    "reason": "file ref escapes vault",
                }
            )
            continue
        try:
            require_regular_file(candidate, label="Canvas file reference")
        except RuntimeError:
            missing_files.append(
                {
                    "id": str(node.get("id") or ""),
                    "file": rel,
                    "reason": "missing or unsafe local file",
                }
            )

    return {
        "nodes": len(nodes),
        "edges": len(edges),
        "node_types": dict(sorted(node_types.items())),
        "missing_files": len(missing_files),
        "missing_file_examples": missing_files[:20],
    }


def summarize_missing(miro_root: Any, canvas: dict[str, Any]) -> dict[str, Any]:
    missing = audit_missing_items(miro_root, canvas)
    by_reason = Counter(item.reason for item in missing)
    by_type = Counter(item.item_type for item in missing)
    actionable = [item for item in missing if item.actionable]
    return {
        "total": len(missing),
        "actionable": len(actionable),
        "by_reason": dict(sorted(by_reason.items())),
        "by_type": dict(sorted(by_type.items())),
        "actionable_examples": [asdict(item) for item in actionable[:20]],
    }


def summarize_overlaps(
    miro_root: Any, canvas: dict[str, Any], *, scale: float
) -> dict[str, Any]:
    source_rects, source_missing = build_miro_source_rects(miro_root, scale=scale)
    overlaps = audit_nodes(
        canvas,
        source_rects=source_rects,
        source_missing=source_missing,
    )
    by_status = Counter(
        str(overlap.source_status or "<unknown>") for overlap in overlaps
    )
    generated = [
        overlap for overlap in overlaps if overlap.source_status == "generated_overlap"
    ]
    return {
        "total": len(overlaps),
        "generated": len(generated),
        "by_source_status": dict(sorted(by_status.items())),
        "generated_examples": [overlap_to_dict(overlap) for overlap in generated[:20]],
    }


def compute_scale(
    miro_root: Any, *, scale_mode: str, min_zoom: float
) -> tuple[float, dict[str, Any]]:
    profile = ViewProfile(min_zoom=min_zoom, scale_mode=scale_mode)
    return pick_recommended_scale(miro_root, profile, OBSIDIAN_FONT_SIZE)


def export_rest_board(
    board: BoardRef, output_json: Path, *, token: str, allow_missing_assets: bool
) -> dict[str, Any]:
    _payload, info = export_complete_board_source(
        board_id=board.board_id,
        token=token,
        output_path=output_json,
        allow_missing_assets=allow_missing_assets,
        board_name=board.label,
        board_url=board.url,
    )
    return {
        **info,
        "download_stats": info["asset_stats"],
    }


def render_canvas_check(canvas_path: Path, screenshot_path: Path) -> dict[str, Any]:
    try:
        from capture_fixture import capture_canvas  # type: ignore  # noqa: PLC0415
        from PIL import Image  # noqa: PLC0415

        capture_canvas(canvas_path, screenshot_path, fit_viewport=True)
        with Image.open(screenshot_path) as image:
            rgb = image.convert("RGB")
            extrema = rgb.getextrema()
            nonblank = any(low != high for low, high in extrema)
            width, height = rgb.size
        return {
            "path": str(screenshot_path),
            "width": width,
            "height": height,
            "extrema": extrema,
            "nonblank": nonblank,
        }
    except Exception as exc:  # noqa: BLE001
        return {
            "path": str(screenshot_path),
            "nonblank": False,
            "error": str(exc),
        }


def audit_one_board(
    board: BoardRef,
    *,
    source_json: Path | None,
    out_dir: Path,
    scale_mode: str,
    min_zoom: float,
    text_style_mode: str,
    min_font_px: int,
    render: bool = False,
    render_dir: Path | None = None,
    max_source_age_hours: float = DEFAULT_MAX_SOURCE_AGE_HOURS,
) -> dict[str, Any]:
    record: dict[str, Any] = {
        "board": asdict(board),
        "status": "no_json_export",
        "source_json": str(source_json) if source_json else None,
        "text_style_mode": text_style_mode,
    }
    if source_json is None:
        return record

    try:
        require_regular_file(source_json, label="Miro source JSON")
        miro_root = load_json(source_json)
        source_validation = validate_source_for_board(
            miro_root,
            board.board_id,
            max_age_hours=max_source_age_hours,
        )
        source_assets = summarize_source_assets(miro_root, source_json)
    except (
        OSError,
        RuntimeError,
        UnicodeError,
        ValueError,
        json.JSONDecodeError,
    ) as exc:
        record.update(
            {
                "status": "source_invalid",
                "source_validation": {"verified": False, "reason": str(exc)},
                "error": str(exc),
            }
        )
        return record

    record.update(
        {
            "source_validation": source_validation,
            "source": summarize_source(miro_root),
            "source_assets": source_assets,
        }
    )
    if source_assets["missing"]:
        record["status"] = "source_missing_assets"
        return record

    board_key = board_artifact_key(board, text_style_mode)
    converted_root = out_dir / "converted"
    converted_root.mkdir(parents=True, exist_ok=True)
    final_board_dir = converted_root / board_key

    with (
        tempfile.TemporaryDirectory(
            prefix=f"miro2obs_web_source_{safe_name(board.board_id)}_"
        ) as source_tmp,
        tempfile.TemporaryDirectory(
            prefix=f".{board_key}-", dir=converted_root
        ) as board_tmp,
    ):
        staged_board_dir = Path(board_tmp) / board_key
        vault_root = staged_board_dir / "vault"
        target_dir = vault_root / "MIRO2OBSIDIAN" / board_key
        target_dir.mkdir(parents=True, exist_ok=True)
        work_json = stage_export_for_conversion(
            miro_root, source_json, Path(source_tmp)
        )
        scale, scale_ctx = compute_scale(
            miro_root, scale_mode=scale_mode, min_zoom=min_zoom
        )
        staged_canvas_path = Path(
            convert_miro_to_canvas(
                str(work_json),
                str(target_dir),
                str(vault_root),
                scale=scale,
                min_font_px=min_font_px,
                theme="dark",
                text_style_mode=text_style_mode,
            )
        )
        require_regular_file(staged_canvas_path, label="Generated Canvas")
        canvas_relative = staged_canvas_path.resolve().relative_to(
            staged_board_dir.resolve()
        )
        canvas = load_json(staged_canvas_path)
        canvas_summary = summarize_canvas(canvas, vault_root)
        missing_summary = summarize_missing(miro_root, canvas)
        mapping_summary = summarize_mapping(miro_root, canvas, scale=scale)
        overlap_summary = summarize_overlaps(miro_root, canvas, scale=scale)
        publish_staged_directory(staged_board_dir, final_board_dir)

    canvas_path = final_board_dir / canvas_relative
    record.update(
        {
            "status": "ok",
            "canvas_path": str(canvas_path),
            "scale": scale,
            "scale_context": scale_ctx,
            "canvas": canvas_summary,
            "missing_miro_items": missing_summary,
            "mapping": mapping_summary,
            "overlaps": overlap_summary,
        }
    )
    if record["canvas"]["missing_files"]:
        record["status"] = "canvas_missing_files"
    elif (
        record["missing_miro_items"]["actionable"]
        or record["mapping"]["actionable"]
        or record["overlaps"]["generated"]
    ):
        record["status"] = "needs_review"
    if render:
        actual_render_dir = render_dir or (out_dir / "renders")
        screenshot_path = actual_render_dir / f"{board_key}.render.png"
        record["render"] = render_canvas_check(canvas_path, screenshot_path)
        if not record["render"].get("nonblank"):
            record["status"] = "render_failed"
    return record


def render_status(record: dict[str, Any]) -> str:
    render = record.get("render")
    if not render:
        return ""
    if render.get("error"):
        return "fail"
    return "ok" if render.get("nonblank") else "blank"


def render_markdown_report(payload: dict[str, Any]) -> str:
    lines = [
        "# Web Board Pipeline Audit",
        "",
        f"boards: {payload['summary']['boards']}",
        f"records: {payload['summary']['records']}",
        f"ok: {payload['summary']['ok']}",
        f"needs_review: {payload['summary']['needs_review']}",
        f"missing_json: {payload['summary']['missing_json']}",
        "",
        "| Board | Mode | Status | Miro items/comments | Canvas nodes/edges | Missing/actionable | Mapping issues | Generated overlaps | Missing files | Render |",
        "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
    ]
    for board in payload["boards"]:
        source = board.get("source") or {}
        source_items = source.get("items", "")
        source_comments = source.get("comments", "")
        source_count = f"{source_items}/{source_comments}" if source else ""
        canvas = board.get("canvas") or {}
        canvas_count = ""
        if canvas:
            canvas_count = f"{canvas.get('nodes', 0)}/{canvas.get('edges', 0)}"
        missing = board.get("missing_miro_items") or {}
        missing_count = ""
        if missing:
            missing_count = f"{missing.get('total', 0)}/{missing.get('actionable', 0)}"
        mapping = board.get("mapping") or {}
        mapping_count = ""
        if mapping:
            mapping_count = f"{mapping.get('total', 0)}/{mapping.get('actionable', 0)}"
        overlaps = board.get("overlaps") or {}
        generated = overlaps.get("generated", "") if overlaps else ""
        missing_files = canvas.get("missing_files", "") if canvas else ""
        label = board["board"]["label"].replace("|", "\\|")
        mode = board.get("text_style_mode") or ""
        lines.append(
            f"| [{label}]({board['board']['url']}) | {mode} | {board['status']} | {source_count} | "
            f"{canvas_count} | {missing_count} | {mapping_count} | {generated} | {missing_files} | {render_status(board)} |"
        )

    lines.append("")
    lines.append("## Needs Review")
    for board in payload["boards"]:
        if board["status"] not in {
            "needs_review",
            "source_missing_assets",
            "canvas_missing_files",
            "no_json_export",
            "export_failed",
            "convert_failed",
            "render_failed",
            "source_invalid",
        }:
            continue
        lines.append("")
        lines.append(f"### {board['board']['label']}")
        lines.append(f"- id: `{board['board']['board_id']}`")
        if board.get("text_style_mode"):
            lines.append(f"- mode: `{board['text_style_mode']}`")
        lines.append(f"- status: `{board['status']}`")
        if board.get("source_json"):
            lines.append(f"- source_json: `{board['source_json']}`")
        if board.get("canvas_path"):
            lines.append(f"- canvas: `{board['canvas_path']}`")
        if board.get("error"):
            lines.append(f"- error: `{board['error']}`")
        source_assets = board.get("source_assets") or {}
        if source_assets.get("missing"):
            lines.append(f"- source assets missing: `{source_assets['missing']}`")
            for item in source_assets.get("missing_examples", [])[:5]:
                lines.append(
                    f"  - `{item['id']}` `{item['type']}`: "
                    f"`{item['local_name']}` ({item['reason']})"
                )
        missing = board.get("missing_miro_items") or {}
        if missing.get("actionable"):
            lines.append(f"- actionable missing: `{missing['actionable']}`")
            for item in missing.get("actionable_examples", [])[:5]:
                lines.append(
                    f"  - `{item['item_id']}` `{item['item_type']}`: {item['reason']}"
                )
        mapping = board.get("mapping") or {}
        if mapping.get("actionable"):
            lines.append(f"- mapping issues: `{mapping['actionable']}`")
            by_reason = mapping.get("by_reason") or {}
            if by_reason:
                lines.append(
                    "- mapping by reason: `"
                    + ", ".join(f"{key}:{value}" for key, value in by_reason.items())
                    + "`"
                )
            for item in mapping.get("examples", [])[:5]:
                detail = item.get("detail") or ""
                detail_suffix = f" - {detail}" if detail else ""
                lines.append(
                    f"  - `{item['item_id']}` `{item['item_type']}`: "
                    f"{item['reason']} ({item.get('canvas_kind', '')}:{item.get('canvas_type', '')})"
                    f"{detail_suffix}"
                )
        overlaps = board.get("overlaps") or {}
        if overlaps.get("generated"):
            lines.append(f"- generated overlaps: `{overlaps['generated']}`")
            for item in overlaps.get("generated_examples", [])[:5]:
                left = item["left"]["id"]
                right = item["right"]["id"]
                lines.append(
                    f"  - `{left}` ↔ `{right}` area `{item['overlap_area']:.2f}`"
                )
        canvas = board.get("canvas") or {}
        if canvas.get("missing_files"):
            lines.append(f"- missing files: `{canvas['missing_files']}`")
            for item in canvas.get("missing_file_examples", [])[:5]:
                lines.append(f"  - `{item['id']}`: `{item['file']}`")
        render = board.get("render") or {}
        if render.get("error"):
            lines.append(f"- render error: `{render['error']}`")
        elif render and not render.get("nonblank"):
            lines.append("- render error: `blank screenshot`")

    return "\n".join(lines) + "\n"


def issue_tags(record: dict[str, Any]) -> list[str]:
    tags: list[str] = []
    if record["status"] == "no_json_export":
        tags.append("получить source snapshot")
    if record["status"] == "export_failed":
        tags.append("REST export failed")
    if record["status"] == "convert_failed":
        tags.append("conversion failed")
    if record["status"] == "render_failed":
        tags.append("render failed")
    if record["status"] == "source_invalid":
        tags.append("invalid source envelope")

    source_assets = record.get("source_assets") or {}
    if source_assets.get("missing"):
        tags.append("source attachments missing")
    canvas = record.get("canvas") or {}
    if canvas.get("missing_files"):
        tags.append("missing attachments")
    missing = record.get("missing_miro_items") or {}
    if missing.get("actionable"):
        tags.append("actionable missing Miro items")
    mapping = record.get("mapping") or {}
    if mapping.get("actionable"):
        tags.append("source/canvas mapping mismatch")
    overlaps = record.get("overlaps") or {}
    if overlaps.get("generated"):
        tags.append("generated overlaps")
    return tags


def render_queue_report(payload: dict[str, Any]) -> str:
    lines = [
        "# Web Board Review Queue",
        "",
        "Правило очереди: один цикл — одна проблема; после фикса прогоняется весь список web-досок.",
        "",
    ]
    queued = 0
    for record in payload["boards"]:
        tags = issue_tags(record)
        if not tags:
            continue
        queued += 1
        mode = record.get("text_style_mode") or "source"
        board = record["board"]
        lines.append(
            f"- [ ] [{board['label']}]({board['url']}) `{mode}` — {', '.join(tags)}"
        )
        if record.get("canvas_path"):
            lines.append(f"  - canvas: `{record['canvas_path']}`")
        if record.get("source_json"):
            lines.append(f"  - source_json: `{record['source_json']}`")

    if not queued:
        lines.append("Очередь пуста.")
    return "\n".join(lines) + "\n"


def build_summary(records: list[dict[str, Any]]) -> dict[str, Any]:
    statuses = Counter(record["status"] for record in records)
    review_statuses = {
        "needs_review",
        "source_missing_assets",
        "canvas_missing_files",
        "render_failed",
        "convert_failed",
        "export_failed",
        "source_invalid",
    }
    board_ids = {
        record["board"]["board_id"] for record in records if record.get("board")
    }
    return {
        "boards": len(board_ids),
        "records": len(records),
        "ok": statuses.get("ok", 0),
        "needs_review": sum(statuses.get(status, 0) for status in review_statuses),
        "missing_json": statuses.get("no_json_export", 0),
        "by_status": dict(sorted(statuses.items())),
    }


def audit_succeeded(summary: dict[str, Any]) -> bool:
    return bool(summary.get("records")) and summary.get("ok") == summary.get("records")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Audit web-listed Miro boards through JSON export and Canvas conversion."
    )
    parser.add_argument("--board-list", type=Path, default=DEFAULT_BOARD_LIST)
    parser.add_argument("--json-root", type=Path, default=DEFAULT_JSON_ROOT)
    parser.add_argument("--out-dir", type=Path, default=DEFAULT_OUT_DIR)
    parser.add_argument(
        "--scale-mode", choices=["balanced", "overview", "readable"], default="readable"
    )
    parser.add_argument("--min-zoom", type=float, default=OBSIDIAN_UNLOCKED_MIN_ZOOM)
    parser.add_argument(
        "--text-style-mode", choices=["miro", "obsidian", "both"], default="obsidian"
    )
    parser.add_argument("--min-font-px", type=int, default=8)
    parser.add_argument(
        "--limit", type=int, help="Only audit the first N boards from the list."
    )
    parser.add_argument(
        "--export-rest",
        action="store_true",
        help="Refresh each board JSON through REST before conversion.",
    )
    parser.add_argument("--token-env", default="MIRO_ACCESS_TOKEN")
    parser.add_argument("--allow-missing-assets", action="store_true")
    parser.add_argument(
        "--max-source-age-hours", type=float, default=DEFAULT_MAX_SOURCE_AGE_HOURS
    )
    parser.add_argument(
        "--render",
        action="store_true",
        help="Capture a smoke screenshot for each converted Canvas.",
    )
    return parser.parse_args()


def remap_output_paths(value: Any, staged_root: Path, published_root: Path) -> Any:
    staged_prefix = str(staged_root.resolve())
    published_prefix = str(published_root.resolve(strict=False))
    if isinstance(value, dict):
        return {
            key: remap_output_paths(item, staged_root, published_root)
            for key, item in value.items()
        }
    if isinstance(value, list):
        return [remap_output_paths(item, staged_root, published_root) for item in value]
    if isinstance(value, str) and (
        value == staged_prefix or value.startswith(staged_prefix + os.sep)
    ):
        return published_prefix + value[len(staged_prefix) :]
    return value


def run_audit(args: argparse.Namespace, out_dir: Path) -> dict[str, Any]:
    boards = load_board_refs(args.board_list)
    if args.limit:
        boards = boards[: args.limit]
    if not boards:
        raise RuntimeError(f"No boards found in {args.board_list}")

    export_dir = out_dir / "rest_exports"
    if args.export_rest:
        export_dir.mkdir(parents=True, exist_ok=True)
        token = os.environ.get(args.token_env)
        if not token:
            raise RuntimeError(
                f"{args.token_env} is not set. Set it or omit --export-rest."
            )
    else:
        token = ""

    text_modes = expand_text_style_modes(args.text_style_mode)
    records: list[dict[str, Any]] = []
    for board in boards:
        rejected_sources: list[dict[str, str]] = []
        source_json = None
        if not args.export_rest:
            source_json = find_local_export(
                board.board_id,
                args.json_root,
                max_age_hours=args.max_source_age_hours,
                rejected=rejected_sources,
            )

        export_info: dict[str, Any] | None = None
        if args.export_rest:
            output_json = export_dir / f"{safe_name(board.board_id)}.json"
            try:
                export_info = export_rest_board(
                    board,
                    output_json,
                    token=token,
                    allow_missing_assets=args.allow_missing_assets,
                )
                source_json = output_json
            except Exception as exc:  # noqa: BLE001
                records.append(
                    {
                        "board": asdict(board),
                        "status": "export_failed",
                        "source_json": None,
                        "text_style_mode": None,
                        "error": str(exc),
                    }
                )
                continue

        if source_json is None:
            status = "source_invalid" if rejected_sources else "no_json_export"
            record = {
                "board": asdict(board),
                "status": status,
                "source_json": None,
                "text_style_mode": None,
                "source_candidates_rejected": rejected_sources,
            }
            if rejected_sources:
                record["error"] = (
                    f"Rejected {len(rejected_sources)} matching local export candidate(s)."
                )
            records.append(record)
            print(f"{record['status']} {board.board_id} {board.label}")
            continue

        for text_mode in text_modes:
            record = {"export": export_info} if export_info else {}
            try:
                record.update(
                    audit_one_board(
                        board,
                        source_json=source_json,
                        out_dir=out_dir,
                        scale_mode=args.scale_mode,
                        min_zoom=args.min_zoom,
                        text_style_mode=text_mode,
                        min_font_px=args.min_font_px,
                        render=args.render,
                        render_dir=out_dir / "renders",
                        max_source_age_hours=args.max_source_age_hours,
                    )
                )
            except Exception as exc:  # noqa: BLE001
                record.update(
                    {
                        "board": asdict(board),
                        "status": "convert_failed",
                        "source_json": str(source_json),
                        "text_style_mode": text_mode,
                        "error": str(exc),
                    }
                )
            if rejected_sources:
                record["source_candidates_rejected"] = rejected_sources
            records.append(record)
            print(f"{record['status']} {board.board_id} {board.label} [{text_mode}]")

    return {
        "schema_version": 2,
        "board_list": str(args.board_list),
        "json_root": str(args.json_root),
        "settings": {
            "scale_mode": args.scale_mode,
            "min_zoom": args.min_zoom,
            "text_style_mode": args.text_style_mode,
            "text_modes": text_modes,
            "min_font_px": args.min_font_px,
            "export_rest": bool(args.export_rest),
            "render": bool(args.render),
            "max_source_age_hours": args.max_source_age_hours,
        },
        "summary": build_summary(records),
        "boards": records,
    }


def main() -> int:
    args = parse_args()
    validate_output_target(args.out_dir)
    args.out_dir.parent.mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory(
        prefix=f".{args.out_dir.name}-stage-",
        dir=args.out_dir.parent,
    ) as temporary:
        staged_out_dir = Path(temporary) / args.out_dir.name
        staged_out_dir.mkdir()
        write_output_sentinel(staged_out_dir)
        payload = run_audit(args, staged_out_dir)
        payload = remap_output_paths(payload, staged_out_dir, args.out_dir)

        write_json(staged_out_dir / "web_board_pipeline_audit.json", payload)
        (staged_out_dir / "web_board_pipeline_audit.md").write_text(
            render_markdown_report(payload),
            encoding="utf-8",
        )
        (staged_out_dir / "web_board_review_queue.md").write_text(
            render_queue_report(payload),
            encoding="utf-8",
        )
        publish_staged_directory(staged_out_dir, args.out_dir)

    report_json = args.out_dir / "web_board_pipeline_audit.json"
    report_md = args.out_dir / "web_board_pipeline_audit.md"
    queue_md = args.out_dir / "web_board_review_queue.md"
    print(f"report_json={report_json}")
    print(f"report_md={report_md}")
    print(f"queue_md={queue_md}")
    print(
        "summary=" + json.dumps(payload["summary"], ensure_ascii=False, sort_keys=True)
    )
    return 0 if audit_succeeded(payload["summary"]) else 1


if __name__ == "__main__":
    raise SystemExit(main())
