from __future__ import annotations

import argparse
import json
import math
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable


REPO_ROOT = Path(__file__).resolve().parents[1]
CONVERTER_DIR = REPO_ROOT / "Json_2_Canvas"
SCRIPTS_DIR = REPO_ROOT / "scripts"

sys.path.insert(0, str(CONVERTER_DIR))
sys.path.insert(0, str(SCRIPTS_DIR))

from Converter import convert_miro_to_canvas, source_completeness_issues  # noqa: E402
from Scale_engine import (  # noqa: E402
    DEFAULT_FIT_MARGIN,
    OBSIDIAN_FONT_SIZE,
    ViewProfile,
    compute_scale_preview,
)
from miro_oauth_token import (  # noqa: E402
    DEFAULT_AUTHORIZE_URL,
    DEFAULT_BROWSER,
    DEFAULT_REDIRECT_URI,
    DEFAULT_SCOPES,
)
from miro_export_bundle import staged_export_path  # noqa: E402
from merge_miro_sources import (  # noqa: E402
    finalize_merged_export,
    merge_sources,
    validate_canonical_export,
    validate_rest_export,
)
from miro_capability_probe import load_json  # noqa: E402
from miro_rest_export_board import export_complete_board_source, resolve_token_from_args  # noqa: E402
from obsidian_plugin_setup import (  # noqa: E402
    ADVANCED_CANVAS_VERSION,
    setup_obsidian_plugins,
)
from obsidian_vault_settings import resolve_attachment_dir  # noqa: E402


@dataclass(frozen=True)
class PipelineResult:
    source_json: Path
    canvas_path: Path
    item_count: int
    asset_stats: dict[str, int]
    scale: float
    scale_context: dict[str, Any]
    messages: list[str]
    completeness: dict[str, Any] = field(default_factory=dict)


def pipeline_result_is_degraded(result: PipelineResult) -> bool:
    return bool(result.completeness) and result.completeness.get("complete") is not True


def _validated_scale(value: Any) -> float:
    if isinstance(value, bool):
        raise ValueError("scale must be a positive finite number")
    try:
        scale = float(value)
    except (TypeError, ValueError) as exc:
        raise ValueError("scale must be a positive finite number") from exc
    if not math.isfinite(scale) or scale <= 0:
        raise ValueError("scale must be a positive finite number")
    return scale


def resolve_scale(
    source_json: Path,
    *,
    explicit_scale: float | None,
    profile: ViewProfile,
) -> tuple[float, dict[str, Any]]:
    if explicit_scale is not None:
        return _validated_scale(explicit_scale), {"scale_source": "explicit"}

    info = compute_scale_preview(str(source_json), profile, OBSIDIAN_FONT_SIZE)
    context = dict(info.get("context") or {})
    context["scale_source"] = "auto"
    return _validated_scale(info["scale"]), context


def run_rest_experimental_pipeline(
    *,
    board_id: str,
    token: str,
    source_json: Path,
    target_dir: Path,
    vault_root: Path,
    scale: float | None = None,
    view_profile: ViewProfile | None = None,
    min_font_px: int = 8,
    theme: str = "dark",
    text_style_mode: str = "miro",
    allow_missing_assets: bool = False,
    prefer_experimental: bool = True,
    websdk_json: Path | None = None,
    install_obsidian_plugins: bool = False,
    advanced_canvas_source_plugins_dir: Path | None = None,
    advanced_canvas_version: str = ADVANCED_CANVAS_VERSION,
    attachment_dir: Path | None = None,
    logger: Callable[[str], None] | None = None,
) -> PipelineResult:
    messages: list[str] = []

    def log(message: str) -> None:
        messages.append(message)
        if logger:
            logger(message)

    source_json = Path(source_json)
    target_dir = Path(target_dir)
    vault_root = Path(vault_root)
    attachment_dir = Path(attachment_dir) if attachment_dir else None
    profile = view_profile or ViewProfile(min_font_px=min_font_px)
    if scale is not None:
        _validated_scale(scale)
    if websdk_json is not None and allow_missing_assets:
        raise ValueError(
            "Web SDK union requires a complete REST asset source; "
            "--allow-missing-assets is diagnostic-only."
        )

    rest_label = "REST v2-experimental" if prefer_experimental else "REST v2 stable"
    log(f"Exporting the complete board through {rest_label}.")
    if websdk_json is None:
        payload, export_info = export_complete_board_source(
            board_id=board_id,
            token=token,
            output_path=source_json,
            prefer_experimental=prefer_experimental,
            download_assets=True,
            allow_missing_assets=allow_missing_assets,
            logger=log,
        )
    else:
        websdk_json = Path(websdk_json)
        with staged_export_path(source_json) as staged_rest_json:
            payload, export_info = export_complete_board_source(
                board_id=board_id,
                token=token,
                output_path=staged_rest_json,
                prefer_experimental=prefer_experimental,
                download_assets=True,
                allow_missing_assets=False,
                logger=log,
            )
            log(f"Merging verified Web SDK export: {websdk_json}")
            merged = merge_sources(
                payload,
                load_json(websdk_json),
                board_id=board_id,
            )
            payload = finalize_merged_export(
                merged,
                source_json=staged_rest_json,
                output_json=source_json,
                token=token,
            )
        log("Canonical REST + Web SDK union is complete.")

    if install_obsidian_plugins:
        log(
            "Installing/enabling Advanced Canvas and Canvas Zoom Unlock in the selected vault."
        )
        setup_obsidian_plugins(
            vault_root,
            advanced_source_plugins_dir=advanced_canvas_source_plugins_dir,
            advanced_version=advanced_canvas_version,
            logger=log,
        )

    items = payload["items"]
    completeness = dict(payload["completeness"])
    asset_stats = dict(
        (completeness.get("assets") or {}).get("requirements")
        or export_info["asset_stats"]
    )

    selected_scale, scale_context = resolve_scale(
        source_json,
        explicit_scale=scale,
        profile=profile,
    )
    log(
        f"Converting through the single Converter.py path at scale={selected_scale:.6f}."
    )
    target_dir.mkdir(parents=True, exist_ok=True)
    canvas_path = Path(
        convert_miro_to_canvas(
            str(source_json),
            str(target_dir),
            str(vault_root),
            scale=selected_scale,
            min_font_px=min_font_px,
            theme=theme,
            text_style_mode=text_style_mode,
            attachment_dir=str(attachment_dir) if attachment_dir else None,
        )
    )
    log(f"Canvas written: {canvas_path}")

    return PipelineResult(
        source_json=source_json,
        canvas_path=canvas_path,
        item_count=len(items),
        asset_stats=asset_stats,
        scale=selected_scale,
        scale_context=scale_context,
        messages=messages,
        completeness=completeness,
    )


def inspect_existing_source(source_json: Path) -> tuple[Any, dict[str, Any]]:
    try:
        payload = load_json(Path(source_json))
    except (OSError, ValueError) as exc:
        raise ValueError(f"Existing JSON cannot be read: {exc}") from exc

    issues: list[str] = []
    surface = payload.get("source_surface") if isinstance(payload, dict) else None
    validator = {
        "rest": validate_rest_export,
        "canonical": validate_canonical_export,
    }.get(str(surface))
    if validator is None:
        issues.append("source is not a verified REST or canonical board envelope")
    else:
        try:
            validator(payload, max_age_hours=-1)
        except ValueError as exc:
            issues.append(str(exc))

    declared = payload.get("completeness") if isinstance(payload, dict) else None
    if not isinstance(declared, dict):
        issues.append("completeness envelope is missing")
        declared = {}
    else:
        issues.extend(
            issue
            for issue in source_completeness_issues(payload)
            if issue != "completeness.board_complete is false"
        )
        required_sections = {
            "rest": ("items", "comments", "assets"),
            "canonical": ("rest", "web_sdk", "comments", "assets"),
        }.get(str(surface), ())
        for section_name in required_sections:
            if section_name not in declared:
                issues.append(f"completeness.{section_name} is missing")
        assets = declared.get("assets")
        if isinstance(assets, dict) and assets.get("checked") is not True:
            issues.append("completeness.assets.checked is not true")

    issues = list(dict.fromkeys(issues))
    completeness = {
        **declared,
        "complete": not issues,
        "verified": not issues,
        "issues": issues,
    }
    return payload, completeness


def run_existing_json_pipeline(
    *,
    source_json: Path,
    target_dir: Path,
    vault_root: Path,
    scale: float | None = None,
    view_profile: ViewProfile | None = None,
    min_font_px: int = 8,
    theme: str = "dark",
    text_style_mode: str = "miro",
    allow_incomplete_source: bool = False,
    install_obsidian_plugins: bool = False,
    advanced_canvas_source_plugins_dir: Path | None = None,
    advanced_canvas_version: str = ADVANCED_CANVAS_VERSION,
    attachment_dir: Path | None = None,
    logger: Callable[[str], None] | None = None,
) -> PipelineResult:
    messages: list[str] = []

    def log(message: str) -> None:
        messages.append(message)
        if logger:
            logger(message)

    source_json = Path(source_json)
    target_dir = Path(target_dir)
    vault_root = Path(vault_root)
    attachment_dir = Path(attachment_dir) if attachment_dir else None
    profile = view_profile or ViewProfile(min_font_px=min_font_px)
    if scale is not None:
        _validated_scale(scale)
    payload, completeness = inspect_existing_source(source_json)
    if completeness["issues"] and not allow_incomplete_source:
        raise ValueError(
            "Existing JSON is incomplete or unverified: "
            + "; ".join(completeness["issues"])
            + ". Use --allow-incomplete-source only for an explicitly degraded conversion."
        )
    if completeness["issues"]:
        log(
            "WARNING: converting explicitly allowed incomplete/unverified Existing JSON: "
            + "; ".join(completeness["issues"])
        )

    if install_obsidian_plugins:
        log(
            "Installing/enabling Advanced Canvas and Canvas Zoom Unlock in the selected vault."
        )
        setup_obsidian_plugins(
            vault_root,
            advanced_source_plugins_dir=advanced_canvas_source_plugins_dir,
            advanced_version=advanced_canvas_version,
            logger=log,
        )

    selected_scale, scale_context = resolve_scale(
        source_json,
        explicit_scale=scale,
        profile=profile,
    )
    log(f"Converting existing JSON through Converter.py at scale={selected_scale:.6f}.")
    target_dir.mkdir(parents=True, exist_ok=True)
    canvas_path = Path(
        convert_miro_to_canvas(
            str(source_json),
            str(target_dir),
            str(vault_root),
            scale=selected_scale,
            min_font_px=min_font_px,
            theme=theme,
            text_style_mode=text_style_mode,
            attachment_dir=str(attachment_dir) if attachment_dir else None,
        )
    )
    log(f"Canvas written: {canvas_path}")

    return PipelineResult(
        source_json=source_json,
        canvas_path=canvas_path,
        item_count=len(payload.get("items", []))
        if isinstance(payload, dict) and isinstance(payload.get("items"), list)
        else 0,
        asset_stats={},
        scale=selected_scale,
        scale_context=scale_context,
        messages=messages,
        completeness=completeness,
    )


def add_auth_args(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--token-env", default="MIRO_ACCESS_TOKEN")
    parser.add_argument("--oauth", action="store_true")
    parser.add_argument("--oauth-client-id-env", default="MIRO_CLIENT_ID")
    parser.add_argument("--oauth-client-secret-env", default="MIRO_CLIENT_SECRET")
    parser.add_argument("--oauth-redirect-uri", default=DEFAULT_REDIRECT_URI)
    parser.add_argument("--oauth-scopes", default=DEFAULT_SCOPES)
    parser.add_argument("--oauth-authorize-url", default=DEFAULT_AUTHORIZE_URL)
    parser.add_argument(
        "--oauth-token-url", default="https://api.miro.com/v1/oauth/token"
    )
    parser.add_argument("--oauth-timeout-seconds", type=int, default=300)
    parser.add_argument("--oauth-browser", default=DEFAULT_BROWSER)
    parser.add_argument("--oauth-no-open-browser", action="store_true")
    parser.add_argument("--oauth-code")
    parser.add_argument("--oauth-callback-url")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Run the canonical Miro -> JSON -> Obsidian Canvas pipeline: "
            "REST v2-experimental export, asset download, one Converter.py call."
        )
    )
    parser.add_argument(
        "--existing-json",
        action="store_true",
        help="Convert --source-json directly without contacting Miro.",
    )
    parser.add_argument("--board-id", help="Required unless --existing-json is used.")
    parser.add_argument("--source-json", type=Path, required=True)
    parser.add_argument(
        "--websdk-json",
        type=Path,
        help="Merge a fresh maximum-profile Web SDK board export before conversion.",
    )
    parser.add_argument("--target-dir", type=Path, required=True)
    parser.add_argument("--vault-root", type=Path, required=True)
    parser.add_argument(
        "--scale", type=float, help="Explicit converter scale. Defaults to auto scale."
    )
    parser.add_argument(
        "--scale-mode", choices=["balanced", "overview", "readable"], default="balanced"
    )
    parser.add_argument("--viewport-width", type=int, default=1920)
    parser.add_argument("--viewport-height", type=int, default=1080)
    parser.add_argument("--min-zoom", type=float, default=0.12)
    parser.add_argument("--fit-margin", type=float, default=DEFAULT_FIT_MARGIN)
    parser.add_argument("--min-node-width", type=int, default=60)
    parser.add_argument("--min-node-height", type=int, default=40)
    parser.add_argument("--min-font-px", type=int, default=8)
    parser.add_argument("--theme", choices=["dark", "light"], default="dark")
    parser.add_argument(
        "--text-style-mode", choices=["miro", "obsidian"], default="miro"
    )
    parser.add_argument("--allow-missing-assets", action="store_true")
    parser.add_argument(
        "--allow-incomplete-source",
        action="store_true",
        help="Allow an explicitly degraded Existing JSON conversion; exits with status 2.",
    )
    parser.add_argument(
        "--stable-items",
        action="store_true",
        help="Use stable v2 items instead of v2-experimental.",
    )
    parser.add_argument("--install-obsidian-plugins", action="store_true")
    parser.add_argument("--advanced-canvas-source-plugins-dir", type=Path)
    parser.add_argument("--advanced-canvas-version", default=ADVANCED_CANVAS_VERSION)
    parser.add_argument(
        "--attachment-dir",
        type=Path,
        help="Override attachment output dir. Defaults to the Obsidian vault Files & Links setting.",
    )
    add_auth_args(parser)
    return parser


def view_profile_from_args(args: argparse.Namespace) -> ViewProfile:
    return ViewProfile(
        width=args.viewport_width,
        height=args.viewport_height,
        min_zoom=args.min_zoom,
        fit_margin=args.fit_margin,
        min_node_w=args.min_node_width,
        min_node_h=args.min_node_height,
        min_font_px=args.min_font_px,
        scale_mode=args.scale_mode,
    )


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    attachment_dir = args.attachment_dir or resolve_attachment_dir(
        args.vault_root, args.target_dir
    )
    if args.existing_json:
        if args.websdk_json is not None:
            parser.error("--websdk-json cannot be combined with --existing-json")
        if args.allow_missing_assets:
            parser.error(
                "--allow-missing-assets cannot be combined with --existing-json; "
                "use --allow-incomplete-source"
            )
        if args.stable_items:
            parser.error("--stable-items cannot be combined with --existing-json")
        result = run_existing_json_pipeline(
            source_json=args.source_json,
            target_dir=args.target_dir,
            vault_root=args.vault_root,
            scale=args.scale,
            view_profile=view_profile_from_args(args),
            min_font_px=args.min_font_px,
            theme=args.theme,
            text_style_mode=args.text_style_mode,
            allow_incomplete_source=args.allow_incomplete_source,
            install_obsidian_plugins=args.install_obsidian_plugins,
            advanced_canvas_source_plugins_dir=args.advanced_canvas_source_plugins_dir,
            advanced_canvas_version=args.advanced_canvas_version,
            attachment_dir=attachment_dir,
        )
    else:
        if not args.board_id:
            parser.error("--board-id is required unless --existing-json is used")
        if args.allow_incomplete_source:
            parser.error("--allow-incomplete-source requires --existing-json")
        if args.websdk_json is not None and args.allow_missing_assets:
            parser.error(
                "--websdk-json cannot be combined with --allow-missing-assets"
            )
        token = resolve_token_from_args(args)
        result = run_rest_experimental_pipeline(
            board_id=args.board_id,
            token=token,
            source_json=args.source_json,
            target_dir=args.target_dir,
            vault_root=args.vault_root,
            scale=args.scale,
            view_profile=view_profile_from_args(args),
            min_font_px=args.min_font_px,
            theme=args.theme,
            text_style_mode=args.text_style_mode,
            allow_missing_assets=args.allow_missing_assets,
            prefer_experimental=not args.stable_items,
            websdk_json=args.websdk_json,
            install_obsidian_plugins=args.install_obsidian_plugins,
            advanced_canvas_source_plugins_dir=args.advanced_canvas_source_plugins_dir,
            advanced_canvas_version=args.advanced_canvas_version,
            attachment_dir=attachment_dir,
        )
    print(f"items={result.item_count}")
    print(f"source_json={result.source_json}")
    print(f"canvas={result.canvas_path}")
    print(f"scale={result.scale:.6f}")
    print("asset_stats=" + json.dumps(result.asset_stats, sort_keys=True))
    for message in result.messages[-8:]:
        print(f"log={message}")
    if pipeline_result_is_degraded(result):
        print("status=degraded")
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
