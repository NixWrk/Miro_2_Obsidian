from __future__ import annotations

import argparse
import json
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable


REPO_ROOT = Path(__file__).resolve().parents[1]
CONVERTER_DIR = REPO_ROOT / "Json_2_Canvas"
SCRIPTS_DIR = REPO_ROOT / "scripts"

sys.path.insert(0, str(CONVERTER_DIR))
sys.path.insert(0, str(SCRIPTS_DIR))

from Converter import convert_miro_to_canvas  # noqa: E402
from Scale_engine import OBSIDIAN_FONT_SIZE, ViewProfile, compute_scale_preview  # noqa: E402
from miro_oauth_token import DEFAULT_AUTHORIZE_URL, DEFAULT_BROWSER, DEFAULT_REDIRECT_URI  # noqa: E402
from miro_rest_export_board import (  # noqa: E402
    build_board_source_payload,
    download_export_assets,
    export_board_comments,
    export_board_items,
    resolve_token_from_args,
    summarize_export_asset_requirements,
    validate_export_assets,
    write_json,
)
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


def resolve_scale(
    source_json: Path,
    *,
    explicit_scale: float | None,
    profile: ViewProfile,
) -> tuple[float, dict[str, Any]]:
    if explicit_scale is not None:
        return float(explicit_scale), {"scale_source": "explicit"}

    info = compute_scale_preview(str(source_json), profile, OBSIDIAN_FONT_SIZE)
    context = dict(info.get("context") or {})
    context["scale_source"] = "auto"
    return float(info["scale"]), context


def copy_asset_local_names(base_items: list[dict[str, Any]], donor_items: list[dict[str, Any]]) -> int:
    donor_by_id = {
        str(item.get("id")): str(item.get("local_name") or "")
        for item in donor_items
        if item.get("id") is not None and item.get("local_name")
    }
    copied = 0
    for item in base_items:
        item_id = str(item.get("id") or "")
        donor_local_name = donor_by_id.get(item_id)
        if not donor_local_name or item.get("local_name"):
            continue
        item["local_name"] = donor_local_name
        copied += 1
    return copied


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

    if install_obsidian_plugins:
        log("Installing/enabling Advanced Canvas and Canvas Zoom Unlock in the selected vault.")
        setup_obsidian_plugins(
            vault_root,
            advanced_source_plugins_dir=advanced_canvas_source_plugins_dir,
            advanced_version=advanced_canvas_version,
            logger=log,
        )

    def export_items(*, use_experimental: bool) -> list[dict[str, Any]]:
        rest_label = "REST v2-experimental" if use_experimental else "REST v2 stable"
        log(f"Exporting board through {rest_label} items.")
        return export_board_items(
            board_id=board_id,
            token=token,
            prefer_experimental=use_experimental,
            logger=log,
        )

    def download_assets(exported_items: list[dict[str, Any]], *, strict: bool) -> dict[str, int]:
        log("Downloading required assets next to the source JSON.")
        return download_export_assets(
            exported_items,
            output_path=source_json,
            token=token,
            logger=log,
            strict=strict,
        )

    items = export_items(use_experimental=prefer_experimental)
    comments = export_board_comments(
        board_id=board_id,
        token=token,
        logger=log,
    )

    try:
        asset_stats = download_assets(items, strict=not allow_missing_assets)
    except RuntimeError as exc:
        if not prefer_experimental or allow_missing_assets:
            raise
        log(f"REST v2-experimental assets incomplete: {exc}")
        log("Using REST v2 stable only to fill missing asset local_names.")
        stable_items = export_items(use_experimental=False)
        download_assets(stable_items, strict=False)
        copied = copy_asset_local_names(items, stable_items)
        missing_assets = validate_export_assets(items, output_path=source_json)
        asset_stats = summarize_export_asset_requirements(items)
        asset_stats["failed"] = len(missing_assets)
        asset_stats["bridged"] = copied
        log(f"asset_bridge copied={copied} missing={len(missing_assets)}")
        if missing_assets:
            shown = "; ".join(missing_assets[:5])
            more = "" if len(missing_assets) <= 5 else f"; +{len(missing_assets) - 5} more"
            raise RuntimeError(f"Asset download incomplete after stable asset bridge: {shown}{more}") from exc

    write_json(source_json, build_board_source_payload(items, comments))

    selected_scale, scale_context = resolve_scale(
        source_json,
        explicit_scale=scale,
        profile=profile,
    )
    log(f"Converting through the single Converter.py path at scale={selected_scale:.6f}.")
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
    )


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

    if install_obsidian_plugins:
        log("Installing/enabling Advanced Canvas and Canvas Zoom Unlock in the selected vault.")
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
        item_count=0,
        asset_stats={},
        scale=selected_scale,
        scale_context=scale_context,
        messages=messages,
    )


def add_auth_args(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--token-env", default="MIRO_ACCESS_TOKEN")
    parser.add_argument("--oauth", action="store_true")
    parser.add_argument("--oauth-client-id-env", default="MIRO_CLIENT_ID")
    parser.add_argument("--oauth-client-secret-env", default="MIRO_CLIENT_SECRET")
    parser.add_argument("--oauth-redirect-uri", default=DEFAULT_REDIRECT_URI)
    parser.add_argument("--oauth-scopes", default="boards:read boards:write team:read")
    parser.add_argument("--oauth-authorize-url", default=DEFAULT_AUTHORIZE_URL)
    parser.add_argument("--oauth-token-url", default="https://api.miro.com/v1/oauth/token")
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
    parser.add_argument("--target-dir", type=Path, required=True)
    parser.add_argument("--vault-root", type=Path, required=True)
    parser.add_argument("--scale", type=float, help="Explicit converter scale. Defaults to auto scale.")
    parser.add_argument("--scale-mode", choices=["balanced", "overview", "readable"], default="balanced")
    parser.add_argument("--viewport-width", type=int, default=1920)
    parser.add_argument("--viewport-height", type=int, default=1080)
    parser.add_argument("--min-zoom", type=float, default=0.12)
    parser.add_argument("--fit-margin", type=float, default=0.95)
    parser.add_argument("--min-node-width", type=int, default=60)
    parser.add_argument("--min-node-height", type=int, default=40)
    parser.add_argument("--min-font-px", type=int, default=8)
    parser.add_argument("--theme", choices=["dark", "light"], default="dark")
    parser.add_argument("--text-style-mode", choices=["miro", "obsidian"], default="miro")
    parser.add_argument("--allow-missing-assets", action="store_true")
    parser.add_argument("--stable-items", action="store_true", help="Use stable v2 items instead of v2-experimental.")
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
    attachment_dir = args.attachment_dir or resolve_attachment_dir(args.vault_root, args.target_dir)
    if args.existing_json:
        result = run_existing_json_pipeline(
            source_json=args.source_json,
            target_dir=args.target_dir,
            vault_root=args.vault_root,
            scale=args.scale,
            view_profile=view_profile_from_args(args),
            min_font_px=args.min_font_px,
            theme=args.theme,
            text_style_mode=args.text_style_mode,
            install_obsidian_plugins=args.install_obsidian_plugins,
            advanced_canvas_source_plugins_dir=args.advanced_canvas_source_plugins_dir,
            advanced_canvas_version=args.advanced_canvas_version,
            attachment_dir=attachment_dir,
        )
    else:
        if not args.board_id:
            parser.error("--board-id is required unless --existing-json is used")
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
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
