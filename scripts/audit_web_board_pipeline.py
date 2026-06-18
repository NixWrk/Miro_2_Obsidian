from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import sys
import tempfile
from collections import Counter
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any


REPO_ROOT = Path(__file__).resolve().parents[1]
CONVERTER_DIR = REPO_ROOT / "Json_2_Canvas"
DEFAULT_BOARD_LIST = REPO_ROOT / "work" / "MIRO2OBSIDIAN" / "Obs_Miro" / "Концепт" / "Web_boards.md"
DEFAULT_JSON_ROOT = REPO_ROOT / "work" / "MIRO2OBSIDIAN" / "web_test"
DEFAULT_OUT_DIR = REPO_ROOT / "tools" / "canvas_render" / ".out" / "web_board_audit"
OBSIDIAN_UNLOCKED_MIN_ZOOM = 2 ** -12

sys.path.insert(0, str(CONVERTER_DIR))
sys.path.insert(0, str(REPO_ROOT / "scripts"))

from Converter import OBSIDIAN_FONT_SIZE, convert_miro_to_canvas, iter_objects  # noqa: E402
from Scale_engine import ViewProfile, pick_recommended_scale  # noqa: E402
from audit_missing_miro_items import audit_missing_items  # noqa: E402
from audit_node_overlaps import audit_nodes, build_miro_source_rects, overlap_to_dict  # noqa: E402
from miro_rest_export_board import download_export_assets, export_board_items, write_json  # noqa: E402


BOARD_LINK_RE = re.compile(r"\[(?P<label>[^\]]+)\]\((?P<url>https://miro\.com/app/board/(?P<id>[^/?#]+)[^)]*)\)")
SAFE_NAME_RE = re.compile(r"[^0-9A-Za-zА-Яа-я._=-]+")


@dataclass(frozen=True)
class BoardRef:
    board_id: str
    label: str
    url: str


def load_json(path: Path) -> Any:
    with path.open("r", encoding="utf-8-sig") as f:
        return json.load(f)


def safe_name(value: str) -> str:
    value = SAFE_NAME_RE.sub("_", value.strip())
    value = re.sub(r"_+", "_", value).strip("._ ")
    return value or "board"


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
        refs.append(BoardRef(board_id=board_id, label=label, url=f"https://miro.com/app/board/{board_id}/"))
    return refs


def load_board_refs(path: Path) -> list[BoardRef]:
    if path.suffix.lower() == ".json":
        return parse_board_json(path)
    return parse_board_markdown(path)


def find_local_export(board_id: str, json_root: Path) -> Path | None:
    candidates = sorted(json_root.glob("*.json"))
    for candidate in candidates:
        if board_id in candidate.name:
            return candidate
    return None


def copy_export_to_workdir(source_json: Path, work_dir: Path) -> Path:
    work_json = work_dir / source_json.name
    shutil.copy2(source_json, work_json)
    source_files = source_json.with_name(f"{source_json.stem}_files")
    if source_files.exists():
        shutil.copytree(source_files, work_json.with_name(f"{work_json.stem}_files"))
    return work_json


def summarize_source(miro_root: Any) -> dict[str, Any]:
    items = [item for item in iter_objects(miro_root) if isinstance(item, dict)]
    by_type = Counter(str(item.get("type") or "<missing>") for item in items)
    return {
        "items": len(items),
        "by_type": dict(sorted(by_type.items())),
    }


def summarize_canvas(canvas: dict[str, Any], vault_root: Path) -> dict[str, Any]:
    nodes = [node for node in canvas.get("nodes", []) if isinstance(node, dict)]
    edges = [edge for edge in canvas.get("edges", []) if isinstance(edge, dict)]
    node_types = Counter(str(node.get("type") or "<missing>") for node in nodes)

    missing_files: list[dict[str, str]] = []
    for node in nodes:
        if node.get("type") != "file":
            continue
        rel = str(node.get("file") or "")
        if not rel:
            missing_files.append({"id": str(node.get("id") or ""), "file": "", "reason": "empty file ref"})
            continue
        if not (vault_root / rel).is_file():
            missing_files.append({"id": str(node.get("id") or ""), "file": rel, "reason": "missing local file"})

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


def summarize_overlaps(miro_root: Any, canvas: dict[str, Any], *, scale: float) -> dict[str, Any]:
    source_rects, source_missing = build_miro_source_rects(miro_root, scale=scale)
    overlaps = audit_nodes(
        canvas,
        source_rects=source_rects,
        source_missing=source_missing,
    )
    by_status = Counter(str(overlap.source_status or "<unknown>") for overlap in overlaps)
    generated = [overlap for overlap in overlaps if overlap.source_status == "generated_overlap"]
    return {
        "total": len(overlaps),
        "generated": len(generated),
        "by_source_status": dict(sorted(by_status.items())),
        "generated_examples": [overlap_to_dict(overlap) for overlap in generated[:20]],
    }


def compute_scale(miro_root: Any, *, scale_mode: str, min_zoom: float) -> tuple[float, dict[str, Any]]:
    profile = ViewProfile(min_zoom=min_zoom, scale_mode=scale_mode)
    return pick_recommended_scale(miro_root, profile, OBSIDIAN_FONT_SIZE)


def export_rest_board(board: BoardRef, output_json: Path, *, token: str, allow_missing_assets: bool) -> dict[str, Any]:
    messages: list[str] = []
    items = export_board_items(board_id=board.board_id, token=token, logger=messages.append)
    download_stats = download_export_assets(
        items,
        output_path=output_json,
        token=token,
        logger=messages.append,
        strict=not allow_missing_assets,
    )
    write_json(output_json, items)
    return {
        "path": str(output_json),
        "items": len(items),
        "download_stats": download_stats,
        "log_tail": messages[-10:],
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
) -> dict[str, Any]:
    record: dict[str, Any] = {
        "board": asdict(board),
        "status": "no_json_export",
        "source_json": str(source_json) if source_json else None,
    }
    if source_json is None:
        return record

    board_key = f"{safe_name(board.label)}_{safe_name(board.board_id)}"
    board_dir = out_dir / "converted" / board_key
    vault_root = board_dir / "vault"
    target_dir = vault_root / "MIRO2OBSIDIAN" / board_key
    target_dir.mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory(prefix=f"miro2obs_web_audit_{safe_name(board.board_id)}_") as tmp:
        work_json = copy_export_to_workdir(source_json, Path(tmp))
        miro_root = load_json(work_json)
        scale, scale_ctx = compute_scale(miro_root, scale_mode=scale_mode, min_zoom=min_zoom)
        canvas_path = Path(
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

    canvas = load_json(canvas_path)
    record.update(
        {
            "status": "ok",
            "canvas_path": str(canvas_path),
            "scale": scale,
            "scale_context": scale_ctx,
            "source": summarize_source(miro_root),
            "canvas": summarize_canvas(canvas, vault_root),
            "missing_miro_items": summarize_missing(miro_root, canvas),
            "overlaps": summarize_overlaps(miro_root, canvas, scale=scale),
        }
    )
    if record["canvas"]["missing_files"]:
        record["status"] = "canvas_missing_files"
    if record["missing_miro_items"]["actionable"] or record["overlaps"]["generated"]:
        record["status"] = "needs_review"
    return record


def render_markdown_report(payload: dict[str, Any]) -> str:
    lines = [
        "# Web Board Pipeline Audit",
        "",
        f"boards: {payload['summary']['boards']}",
        f"ok: {payload['summary']['ok']}",
        f"needs_review: {payload['summary']['needs_review']}",
        f"missing_json: {payload['summary']['missing_json']}",
        "",
        "| Board | Status | Miro items | Canvas nodes/edges | Missing/actionable | Generated overlaps | Missing files |",
        "|---|---:|---:|---:|---:|---:|---:|",
    ]
    for board in payload["boards"]:
        source_items = (board.get("source") or {}).get("items", "")
        canvas = board.get("canvas") or {}
        canvas_count = ""
        if canvas:
            canvas_count = f"{canvas.get('nodes', 0)}/{canvas.get('edges', 0)}"
        missing = board.get("missing_miro_items") or {}
        missing_count = ""
        if missing:
            missing_count = f"{missing.get('total', 0)}/{missing.get('actionable', 0)}"
        overlaps = board.get("overlaps") or {}
        generated = overlaps.get("generated", "") if overlaps else ""
        missing_files = canvas.get("missing_files", "") if canvas else ""
        label = board["board"]["label"].replace("|", "\\|")
        lines.append(
            f"| [{label}]({board['board']['url']}) | {board['status']} | {source_items} | "
            f"{canvas_count} | {missing_count} | {generated} | {missing_files} |"
        )

    lines.append("")
    lines.append("## Needs Review")
    for board in payload["boards"]:
        if board["status"] not in {"needs_review", "canvas_missing_files", "no_json_export", "export_failed", "convert_failed"}:
            continue
        lines.append("")
        lines.append(f"### {board['board']['label']}")
        lines.append(f"- id: `{board['board']['board_id']}`")
        lines.append(f"- status: `{board['status']}`")
        if board.get("source_json"):
            lines.append(f"- source_json: `{board['source_json']}`")
        if board.get("canvas_path"):
            lines.append(f"- canvas: `{board['canvas_path']}`")
        if board.get("error"):
            lines.append(f"- error: `{board['error']}`")
        missing = board.get("missing_miro_items") or {}
        if missing.get("actionable"):
            lines.append(f"- actionable missing: `{missing['actionable']}`")
            for item in missing.get("actionable_examples", [])[:5]:
                lines.append(f"  - `{item['item_id']}` `{item['item_type']}`: {item['reason']}")
        overlaps = board.get("overlaps") or {}
        if overlaps.get("generated"):
            lines.append(f"- generated overlaps: `{overlaps['generated']}`")
            for item in overlaps.get("generated_examples", [])[:5]:
                left = item["left"]["id"]
                right = item["right"]["id"]
                lines.append(f"  - `{left}` ↔ `{right}` area `{item['overlap_area']:.2f}`")
        canvas = board.get("canvas") or {}
        if canvas.get("missing_files"):
            lines.append(f"- missing files: `{canvas['missing_files']}`")
            for item in canvas.get("missing_file_examples", [])[:5]:
                lines.append(f"  - `{item['id']}`: `{item['file']}`")

    return "\n".join(lines) + "\n"


def build_summary(records: list[dict[str, Any]]) -> dict[str, Any]:
    statuses = Counter(record["status"] for record in records)
    return {
        "boards": len(records),
        "ok": statuses.get("ok", 0),
        "needs_review": statuses.get("needs_review", 0) + statuses.get("canvas_missing_files", 0),
        "missing_json": statuses.get("no_json_export", 0),
        "by_status": dict(sorted(statuses.items())),
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Audit web-listed Miro boards through JSON export and Canvas conversion.")
    parser.add_argument("--board-list", type=Path, default=DEFAULT_BOARD_LIST)
    parser.add_argument("--json-root", type=Path, default=DEFAULT_JSON_ROOT)
    parser.add_argument("--out-dir", type=Path, default=DEFAULT_OUT_DIR)
    parser.add_argument("--scale-mode", choices=["balanced", "overview", "readable"], default="readable")
    parser.add_argument("--min-zoom", type=float, default=OBSIDIAN_UNLOCKED_MIN_ZOOM)
    parser.add_argument("--text-style-mode", choices=["miro", "obsidian"], default="obsidian")
    parser.add_argument("--min-font-px", type=int, default=8)
    parser.add_argument("--limit", type=int, help="Only audit the first N boards from the list.")
    parser.add_argument("--export-rest", action="store_true", help="Refresh each board JSON through REST before conversion.")
    parser.add_argument("--token-env", default="MIRO_ACCESS_TOKEN")
    parser.add_argument("--allow-missing-assets", action="store_true")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    boards = load_board_refs(args.board_list)
    if args.limit:
        boards = boards[: args.limit]
    if not boards:
        raise SystemExit(f"No boards found in {args.board_list}")

    args.out_dir.mkdir(parents=True, exist_ok=True)
    export_dir = args.out_dir / "rest_exports"
    if args.export_rest:
        export_dir.mkdir(parents=True, exist_ok=True)
        token = os.environ.get(args.token_env)
        if not token:
            raise SystemExit(f"{args.token_env} is not set. Set it or omit --export-rest.")
    else:
        token = ""

    records: list[dict[str, Any]] = []
    for board in boards:
        source_json = find_local_export(board.board_id, args.json_root)
        record: dict[str, Any]
        if args.export_rest:
            output_json = export_dir / f"{safe_name(board.label)}_{safe_name(board.board_id)}.json"
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
                        "source_json": str(source_json) if source_json else None,
                        "error": str(exc),
                    }
                )
                continue
            else:
                record = {"export": export_info}
        else:
            record = {}

        try:
            record.update(
                audit_one_board(
                    board,
                    source_json=source_json,
                    out_dir=args.out_dir,
                    scale_mode=args.scale_mode,
                    min_zoom=args.min_zoom,
                    text_style_mode=args.text_style_mode,
                    min_font_px=args.min_font_px,
                )
            )
        except Exception as exc:  # noqa: BLE001
            record.update(
                {
                    "board": asdict(board),
                    "status": "convert_failed",
                    "source_json": str(source_json) if source_json else None,
                    "error": str(exc),
                }
            )
        records.append(record)
        print(f"{record['status']} {board.board_id} {board.label}")

    payload = {
        "schema_version": 1,
        "board_list": str(args.board_list),
        "json_root": str(args.json_root),
        "settings": {
            "scale_mode": args.scale_mode,
            "min_zoom": args.min_zoom,
            "text_style_mode": args.text_style_mode,
            "min_font_px": args.min_font_px,
            "export_rest": bool(args.export_rest),
        },
        "summary": build_summary(records),
        "boards": records,
    }
    report_json = args.out_dir / "web_board_pipeline_audit.json"
    report_md = args.out_dir / "web_board_pipeline_audit.md"
    write_json(report_json, payload)
    report_md.write_text(render_markdown_report(payload), encoding="utf-8")
    print(f"report_json={report_json}")
    print(f"report_md={report_md}")
    print("summary=" + json.dumps(payload["summary"], ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
