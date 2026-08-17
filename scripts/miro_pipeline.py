from __future__ import annotations

import argparse
import json
from pathlib import Path

from Json_2_Canvas.Scale_engine import DEFAULT_FIT_MARGIN, ViewProfile
from miro2obsidian import application
from scripts.miro_oauth_token import (
    DEFAULT_AUTHORIZE_URL,
    DEFAULT_BROWSER,
    DEFAULT_REDIRECT_URI,
    DEFAULT_SCOPES,
)
from scripts.miro_rest_export_board import resolve_token_from_args
from scripts.obsidian_plugin_setup import ADVANCED_CANVAS_VERSION
from scripts.obsidian_vault_settings import resolve_attachment_dir


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
        result = application.run_existing_json_pipeline(
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
        result = application.run_rest_experimental_pipeline(
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
    if application.pipeline_result_is_degraded(result):
        print("status=degraded")
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
