from __future__ import annotations

import argparse
import shutil
import sys
import tempfile
from pathlib import Path
from typing import Any


REPO_ROOT = Path(__file__).resolve().parents[1]
SCRIPTS_DIR = REPO_ROOT / "scripts"
sys.path.insert(0, str(SCRIPTS_DIR))

from merge_miro_sources import (  # noqa: E402
    DEFAULT_MAX_SOURCE_AGE_HOURS,
    finalize_merged_export,
    merge_sources,
    validate_rest_export,
)
from miro_export_bundle import (  # noqa: E402
    copy_referenced_sidecar,
    is_link_or_reparse,
    publish_staged_bundle,
    publish_staged_directory,
    require_regular_directory,
    require_regular_file,
    staged_export_path,
)
from miro_rest_export_board import stable_enrichment_items, validate_export_assets, write_json  # noqa: E402
from miro_capability_probe import (  # noqa: E402
    build_coverage_rows,
    load_json,
    render_markdown_report,
    rows_to_json,
)


DEFAULT_WORK_DIR = Path("work") / "MIRO2OBSIDIAN" / "source_expansion"
WEBSDK_APP_ENTRYPOINT = "index.html"
OUTPUT_SENTINEL_NAME = ".miro-source-expansion"
OUTPUT_SENTINEL_CONTENT = "miro-source-expansion-v1\n"


def _path_for_markdown(path: Path) -> str:
    return str(path).replace("\\", "\\\\")


def build_workflow_plan(
    output_dir: Path, *, board_id: str | None = None, websdk_port: int = 8766
) -> str:
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
            "Direct Miro export requires your own Miro Developer App. Use `MIRO_CLIENT_ID` and `MIRO_CLIENT_SECRET` with `--oauth`, or set `MIRO_ACCESS_TOKEN` only when that token was issued by your own app.",
            "OAuth opens Yandex Browser by default and uses `http://localhost:8765/callback`.",
            "The generator records partial API failures in the result JSON instead of hiding successful items.",
            "If the Miro plan cannot create more boards, create or choose an empty board in the app-visible team and pass its id with `--board-id`.",
            "",
            "Developer token-env run:",
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
            "## 3. Finalize probe items before either export",
            "",
            "If Web SDK-only generated probes are needed, create them now. Do not mutate the board between the REST and Web SDK exports.",
            "",
            "## 4. Export the board through the existing REST downloader",
            "",
            f"Save the resulting REST JSON as `{_path_for_markdown(rest_export)}`.",
            "",
            "## 5. Export the same unchanged board through the Web SDK app",
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
            "In the OAuth Redirect URI `Options` menu, select `Use this URI for SDK authorization` for `http://localhost:8765/callback`.",
            "On the board, open `+ More apps` / `+ More tools` at the bottom of the left-hand app toolbar. The app should appear there under its configured app name.",
            "If this team does not show installed apps in `+ More tools`, create or duplicate the probe board in an app-visible team and keep REST/Web SDK exports on that same board.",
            "",
            "Open the app from the board toolbar, export the board, and save the JSON as:",
            "",
            "If `Create probe items` was used after the REST snapshot, repeat the REST export before continuing.",
            "",
            f"`{_path_for_markdown(websdk_export)}`",
            "",
            "## 6. Run targeted source probes when candidates require them",
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
            "## 7. Analyze and merge",
            "",
            "```powershell",
            (
                "python scripts\\miro_source_expansion_workflow.py analyze "
                f"--rest-json {_path_for_markdown(rest_export)} "
                f"--websdk-json {_path_for_markdown(websdk_export)} "
                f"--board-id {board_id or '<board_id>'} "
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


def validate_output_target(output_dir: Path) -> None:
    resolved = output_dir.resolve()
    if resolved in {Path(resolved.anchor), REPO_ROOT.resolve()}:
        raise RuntimeError(f"Refusing to use unsafe output directory: {resolved}")
    if not output_dir.exists() and not is_link_or_reparse(output_dir):
        return
    if is_link_or_reparse(output_dir) or not output_dir.is_dir():
        raise RuntimeError(f"Output path is not a regular directory: {output_dir}")

    sentinel = output_dir / OUTPUT_SENTINEL_NAME
    has_content = any(output_dir.iterdir())
    if sentinel.exists() or is_link_or_reparse(sentinel):
        require_regular_file(sentinel, label="Source expansion output sentinel")
        if sentinel.read_text(encoding="utf-8") != OUTPUT_SENTINEL_CONTENT:
            raise RuntimeError(f"Output sentinel is invalid: {sentinel}")
    elif has_content:
        raise RuntimeError(
            f"Refusing to replace unowned analysis directory without {sentinel.name}: {output_dir}"
        )


def _prepare_staged_output(
    staged_dir: Path,
    output_dir: Path,
    *,
    preserve_existing: bool,
) -> None:
    if preserve_existing and output_dir.exists():
        require_regular_directory(output_dir, label="Existing source expansion output")
        shutil.copytree(output_dir, staged_dir)
    else:
        staged_dir.mkdir()
    (staged_dir / OUTPUT_SENTINEL_NAME).write_text(
        OUTPUT_SENTINEL_CONTENT,
        encoding="utf-8",
    )


def write_workflow_plan(
    output_dir: Path,
    *,
    board_id: str | None = None,
    websdk_port: int = 8766,
) -> Path:
    validate_output_target(output_dir)
    output_dir.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(
        prefix=f".{output_dir.name}-stage-",
        dir=output_dir.parent,
    ) as temporary:
        staged_dir = Path(temporary) / output_dir.name
        _prepare_staged_output(staged_dir, output_dir, preserve_existing=True)
        (staged_dir / "workflow_plan.md").write_text(
            build_workflow_plan(
                output_dir,
                board_id=board_id,
                websdk_port=websdk_port,
            )
            + "\n",
            encoding="utf-8",
        )
        publish_staged_directory(staged_dir, output_dir)
    return output_dir / "workflow_plan.md"


def run_analysis(
    rest_json: Path,
    websdk_json: Path | None,
    output_dir: Path,
    *,
    board_id: str | None = None,
    max_age_hours: float = DEFAULT_MAX_SOURCE_AGE_HOURS,
) -> dict[str, Path]:
    require_regular_file(rest_json, label="REST source JSON")
    if websdk_json is not None:
        require_regular_file(websdk_json, label="Web SDK source JSON")
    validate_output_target(output_dir)

    rest_root = load_json(rest_json)
    websdk_root = load_json(websdk_json) if websdk_json else []
    rows = build_coverage_rows(rest_root, websdk_root)

    output_dir.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(
        prefix=f".{output_dir.name}-stage-",
        dir=output_dir.parent,
    ) as temporary:
        staged_dir = Path(temporary) / output_dir.name
        _prepare_staged_output(staged_dir, output_dir, preserve_existing=False)
        report_md = staged_dir / "capability_report.md"
        report_json = staged_dir / "capability_report.json"
        next_actions = staged_dir / "next_actions.md"
        merged_json = staged_dir / "merged.miro.json"

        report_md.write_text(render_markdown_report(rows) + "\n", encoding="utf-8")
        report_json.write_text(rows_to_json(rows) + "\n", encoding="utf-8")
        next_actions.write_text(render_next_actions(rows) + "\n", encoding="utf-8")

        if websdk_json:
            merged = merge_sources(
                rest_root,
                websdk_root,
                board_id=board_id,
                max_age_hours=max_age_hours,
            )
            finalize_merged_export(
                merged,
                source_json=rest_json,
                output_json=merged_json,
                max_age_hours=max_age_hours,
            )
        else:
            validate_rest_export(
                rest_root,
                expected_board_id=board_id,
                max_age_hours=max_age_hours,
            )
            source_missing = validate_export_assets(
                rest_root["items"], output_path=rest_json
            )
            if source_missing:
                raise RuntimeError(
                    "REST source sidecar is incomplete: "
                    + "; ".join(source_missing[:5])
                )
            with staged_export_path(merged_json) as staged_json:
                copy_referenced_sidecar(
                    [*rest_root["items"], *stable_enrichment_items(rest_root)],
                    source_json=rest_json,
                    staged_json=staged_json,
                )
                staged_missing = validate_export_assets(
                    rest_root["items"], output_path=staged_json
                )
                if staged_missing:
                    raise RuntimeError(
                        "Staged REST sidecar is incomplete: "
                        + "; ".join(staged_missing[:5])
                    )
                write_json(staged_json, rest_root)
                publish_staged_bundle(staged_json, merged_json)

        publish_staged_directory(staged_dir, output_dir)

    return {
        "capability_report_md": output_dir / "capability_report.md",
        "capability_report_json": output_dir / "capability_report.json",
        "next_actions": output_dir / "next_actions.md",
        "merged_json": output_dir / "merged.miro.json",
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Orchestrate the Miro source expansion probe workflow."
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    plan_parser = subparsers.add_parser(
        "plan", help="Create a local workflow checklist."
    )
    plan_parser.add_argument("--output-dir", type=Path, default=DEFAULT_WORK_DIR)
    plan_parser.add_argument("--board-id")
    plan_parser.add_argument("--websdk-port", type=int, default=8766)

    analyze_parser = subparsers.add_parser(
        "analyze",
        help="Analyze REST/Web SDK exports and write merged source artifacts.",
    )
    analyze_parser.add_argument("--rest-json", type=Path, required=True)
    analyze_parser.add_argument("--websdk-json", type=Path)
    analyze_parser.add_argument("--board-id")
    analyze_parser.add_argument(
        "--max-age-hours", type=float, default=DEFAULT_MAX_SOURCE_AGE_HOURS
    )
    analyze_parser.add_argument("--output-dir", type=Path, default=DEFAULT_WORK_DIR)

    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if args.command == "plan":
        path = write_workflow_plan(
            args.output_dir, board_id=args.board_id, websdk_port=args.websdk_port
        )
        print(f"workflow_plan={path}")
        return 0

    if args.command == "analyze":
        artifacts = run_analysis(
            args.rest_json,
            args.websdk_json,
            args.output_dir,
            board_id=args.board_id,
            max_age_hours=args.max_age_hours,
        )
        for key, path in artifacts.items():
            print(f"{key}={path}")
        return 0

    raise AssertionError(f"Unknown command: {args.command}")


if __name__ == "__main__":
    raise SystemExit(main())
