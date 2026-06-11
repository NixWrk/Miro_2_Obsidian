from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any


REPO_ROOT = Path(__file__).resolve().parents[1]
SCRIPTS_DIR = REPO_ROOT / "scripts"
sys.path.insert(0, str(SCRIPTS_DIR))

from merge_miro_sources import merge_sources  # noqa: E402
from miro_capability_probe import (  # noqa: E402
    build_coverage_rows,
    load_json,
    render_markdown_report,
    rows_to_json,
)


DEFAULT_WORK_DIR = Path("work") / "MIRO2OBSIDIAN" / "source_expansion"
WEBSDK_APP_ENTRYPOINT = "index-20260611-deep-table.html"


def _path_for_markdown(path: Path) -> str:
    return str(path).replace("\\", "\\\\")


def build_workflow_plan(output_dir: Path, *, board_id: str | None = None, websdk_port: int = 8766) -> str:
    rest_manifest = output_dir / "rest_probe_manifest.json"
    rest_result = output_dir / "rest_probe_result.json"
    rest_export = output_dir / "rest_export.json"
    websdk_export = output_dir / "websdk_export.json"
    slide_probe = output_dir / "slide_probe_result.json"
    merged = output_dir / "merged.miro.json"

    board_arg = f" --board-id {board_id}" if board_id else ""

    return "\n".join(
        [
            "# Miro source expansion workflow",
            "",
            "Goal: compare REST and Web SDK exports, then create a converter-ready merged source.",
            "",
            "## 1. Prepare REST probe manifest",
            "",
            "```powershell",
            f"python scripts\\miro_rest_generate_probe_board.py --output {_path_for_markdown(rest_manifest)}",
            "```",
            "",
            "## 2. Create or update the maximum REST probe board",
            "",
            "Set `MIRO_ACCESS_TOKEN` in the shell, or set `MIRO_CLIENT_ID` and `MIRO_CLIENT_SECRET` and use `--oauth`.",
            "OAuth opens Yandex Browser by default and uses `http://127.0.0.1:8000/callback`.",
            "The generator records partial API failures in the result JSON instead of hiding successful items.",
            "If the Miro plan cannot create more boards, create or choose an empty board in the app-visible team and pass its id with `--board-id`.",
            "",
            "Token-env run:",
            "",
            "```powershell",
            f"python scripts\\miro_rest_generate_probe_board.py --execute{board_arg} --output {_path_for_markdown(rest_result)}",
            "```",
            "",
            "Local OAuth run:",
            "",
            "```powershell",
            f"python scripts\\miro_rest_generate_probe_board.py --execute --oauth{board_arg} --output {_path_for_markdown(rest_result)}",
            "```",
            "",
            "## 3. Export the board through the existing REST downloader",
            "",
            f"Save the resulting REST JSON as `{_path_for_markdown(rest_export)}`.",
            "",
            "## 4. Export the same board through the Web SDK app",
            "",
            "```powershell",
            f"python tools\\miro_websdk_exporter\\serve_no_cache.py --port {websdk_port}",
            "```",
            "",
            (
                f"Register `http://localhost:{websdk_port}/{WEBSDK_APP_ENTRYPOINT}` as the Miro Web SDK App URL. "
                "Upload `tools\\miro_websdk_exporter\\icon-outline.svg` as the outline icon so the app appears on the board toolbar."
            ),
            "The exported JSON must include `exporter_version`; if it does not, reload the Miro board and reopen the app panel because an older Web SDK panel is still cached.",
            (
                "Install the app into the same Miro team as the target board. If several `export to Json` apps exist, "
                "verify the App URL in `Profile settings` -> `Your apps`, then rename the Web SDK app or use its icon to identify it."
            ),
            "In the OAuth Redirect URI `Options` menu, select `Use this URI for SDK authorization` for `http://localhost:8000/callback`.",
            "On the board, open `+ More apps` / `+ More tools` at the bottom of the left-hand app toolbar. The app should appear there under its configured app name.",
            "If this team does not show installed apps in `+ More tools`, create or duplicate the probe board in an app-visible team and keep REST/Web SDK exports on that same board.",
            "",
            "Open the app from the board toolbar, export the board, and save the JSON as:",
            "",
            "For maximum generated coverage, click `Create probe items` in the app before exporting the board.",
            "",
            f"`{_path_for_markdown(websdk_export)}`",
            "",
            "## 5. Run targeted source probes when candidates require them",
            "",
            "Slide/deck probe for real Miro slide decks:",
            "",
            "```powershell",
            (
                "python scripts\\miro_slide_probe.py "
                f"--board-id {board_id or '<board_id>'} "
                f"--evidence-json {_path_for_markdown(rest_export)} "
                f"--evidence-json {_path_for_markdown(websdk_export)} "
                f"--output {_path_for_markdown(slide_probe)}"
            ),
            "```",
            "",
            "Run this only when the board contains a real Miro slide deck or when `next_actions.md` keeps `slide_container` as a candidate.",
            "",
            "## 6. Analyze and merge",
            "",
            "```powershell",
            (
                "python scripts\\miro_source_expansion_workflow.py analyze "
                f"--rest-json {_path_for_markdown(rest_export)} "
                f"--websdk-json {_path_for_markdown(websdk_export)} "
                f"--output-dir {_path_for_markdown(output_dir)}"
            ),
            "```",
            "",
            "Expected local artifacts:",
            "",
            f"- `{_path_for_markdown(output_dir / 'capability_report.md')}`",
            f"- `{_path_for_markdown(output_dir / 'capability_report.json')}`",
            f"- `{_path_for_markdown(output_dir / 'next_actions.md')}`",
            f"- `{_path_for_markdown(merged)}`",
            "",
            "Create new `CONV-*` problems only from rows marked `converter_candidate` or confirmed Web SDK-only source gains.",
        ]
    )


def _candidate_rows(rows: list[Any]) -> list[Any]:
    interesting_actions = {
        "converter_candidate",
        "generated_probe_candidate",
        "websdk_export_candidate",
        "needs_probe",
        "separate_source",
        "source_limited",
    }
    return [row for row in rows if row.action in interesting_actions]


def render_next_actions(rows: list[Any]) -> str:
    candidates = _candidate_rows(rows)
    lines = [
        "# Miro source expansion next actions",
        "",
        "| Type | Coverage | Action | REST | Web SDK |",
        "|---|---|---|---:|---:|",
    ]
    for row in candidates:
        lines.append(
            f"| `{row.item_type}` | {row.coverage} | {row.action} | "
            f"{row.rest.count} | {row.websdk.count} |"
        )
    if not candidates:
        lines.append("| _none_ | - | - | 0 | 0 |")

    lines.extend(
        [
            "",
            "Policy:",
            "",
            "- `converter_candidate`: create a minimal fixture and a `CONV-*` problem.",
            "- `generated_probe_candidate`: add a generated REST/Web SDK probe before changing converter code.",
            "- `websdk_export_candidate`: preserve/export through Web SDK first, then decide converter behavior.",
            "- `needs_probe`: create or manually inspect a source sample before changing converter code.",
            "- `source_limited`: create a manual source fixture/export first; do not treat it as a converter bug yet.",
            "- `separate_source`: treat as a separate API/export pipeline.",
        ]
    )
    return "\n".join(lines)


def write_workflow_plan(output_dir: Path, *, board_id: str | None = None, websdk_port: int = 8765) -> Path:
    output_dir.mkdir(parents=True, exist_ok=True)
    path = output_dir / "workflow_plan.md"
    path.write_text(build_workflow_plan(output_dir, board_id=board_id, websdk_port=websdk_port) + "\n", encoding="utf-8")
    return path


def run_analysis(rest_json: Path, websdk_json: Path | None, output_dir: Path) -> dict[str, Path]:
    output_dir.mkdir(parents=True, exist_ok=True)
    rest_root = load_json(rest_json)
    websdk_root = load_json(websdk_json) if websdk_json else []
    rows = build_coverage_rows(rest_root, websdk_root)

    report_md = output_dir / "capability_report.md"
    report_json = output_dir / "capability_report.json"
    next_actions = output_dir / "next_actions.md"
    merged_json = output_dir / "merged.miro.json"

    report_md.write_text(render_markdown_report(rows) + "\n", encoding="utf-8")
    report_json.write_text(rows_to_json(rows) + "\n", encoding="utf-8")
    next_actions.write_text(render_next_actions(rows) + "\n", encoding="utf-8")

    if websdk_json:
        merged = merge_sources(rest_root, websdk_root)
    else:
        merged = rest_root
    merged_json.write_text(json.dumps(merged, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    return {
        "capability_report_md": report_md,
        "capability_report_json": report_json,
        "next_actions": next_actions,
        "merged_json": merged_json,
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Orchestrate the Miro source expansion probe workflow.")
    subparsers = parser.add_subparsers(dest="command", required=True)

    plan_parser = subparsers.add_parser("plan", help="Create a local workflow checklist.")
    plan_parser.add_argument("--output-dir", type=Path, default=DEFAULT_WORK_DIR)
    plan_parser.add_argument("--board-id")
    plan_parser.add_argument("--websdk-port", type=int, default=8766)

    analyze_parser = subparsers.add_parser("analyze", help="Analyze REST/Web SDK exports and write merged source artifacts.")
    analyze_parser.add_argument("--rest-json", type=Path, required=True)
    analyze_parser.add_argument("--websdk-json", type=Path)
    analyze_parser.add_argument("--output-dir", type=Path, default=DEFAULT_WORK_DIR)

    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if args.command == "plan":
        path = write_workflow_plan(args.output_dir, board_id=args.board_id, websdk_port=args.websdk_port)
        print(f"workflow_plan={path}")
        return 0

    if args.command == "analyze":
        artifacts = run_analysis(args.rest_json, args.websdk_json, args.output_dir)
        for key, path in artifacts.items():
            print(f"{key}={path}")
        return 0

    raise AssertionError(f"Unknown command: {args.command}")


if __name__ == "__main__":
    raise SystemExit(main())
