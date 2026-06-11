from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Any


REPO_ROOT = Path(__file__).resolve().parents[1]
MIRO_JSON_DIR = REPO_ROOT / "Miro_2_Json"
sys.path.insert(0, str(MIRO_JSON_DIR))
sys.path.insert(0, str(REPO_ROOT / "scripts"))

from miro_downloader import _dedupe_miro_items, add_browser_links, get_items_on_board  # noqa: E402
from miro_oauth_token import DEFAULT_BROWSER, DEFAULT_REDIRECT_URI  # noqa: E402


def export_board_items(
    *,
    board_id: str,
    token: str,
    prefer_experimental: bool = True,
    logger: Any | None = None,
) -> list[dict[str, Any]]:
    items = get_items_on_board(
        board_id,
        token,
        logger=logger,
        prefer_experimental_items=prefer_experimental,
        confirm_skip_source=lambda source, status, message: True,
        confirm_exp_fallback=lambda partial_count: True,
    )
    return add_browser_links(board_id, _dedupe_miro_items(items))


def write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def resolve_token_from_args(args: argparse.Namespace) -> str:
    if args.oauth:
        from miro_oauth_token import authorize_and_get_token, config_from_env, exchange_manual_authorization

        config = config_from_env(
            client_id_env=args.oauth_client_id_env,
            client_secret_env=args.oauth_client_secret_env,
            redirect_uri=args.oauth_redirect_uri,
            scopes=args.oauth_scopes,
            authorize_url=args.oauth_authorize_url,
            token_url=args.oauth_token_url,
        )
        if args.oauth_code or args.oauth_callback_url:
            return exchange_manual_authorization(config, code=args.oauth_code, callback_url=args.oauth_callback_url)
        return authorize_and_get_token(
            config,
            timeout_seconds=args.oauth_timeout_seconds,
            open_browser=not args.oauth_no_open_browser,
            browser=args.oauth_browser,
        )

    token = os.environ.get(args.token_env)
    if not token:
        raise SystemExit(f"{args.token_env} is not set. Set it or pass --oauth.")
    return token


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Export a Miro board through the existing REST downloader path.")
    parser.add_argument("--board-id", required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--stable-items", action="store_true", help="Use stable v2 items instead of v2-experimental.")
    parser.add_argument("--token-env", default="MIRO_ACCESS_TOKEN")
    parser.add_argument("--oauth", action="store_true")
    parser.add_argument("--oauth-client-id-env", default="MIRO_CLIENT_ID")
    parser.add_argument("--oauth-client-secret-env", default="MIRO_CLIENT_SECRET")
    parser.add_argument("--oauth-redirect-uri", default=DEFAULT_REDIRECT_URI)
    parser.add_argument("--oauth-scopes", default="boards:read boards:write team:read")
    parser.add_argument("--oauth-authorize-url", default="https://miro.com/app-install/")
    parser.add_argument("--oauth-token-url", default="https://api.miro.com/v1/oauth/token")
    parser.add_argument("--oauth-timeout-seconds", type=int, default=300)
    parser.add_argument("--oauth-browser", default=DEFAULT_BROWSER)
    parser.add_argument("--oauth-no-open-browser", action="store_true")
    parser.add_argument("--oauth-code")
    parser.add_argument("--oauth-callback-url")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    token = resolve_token_from_args(args)
    messages: list[str] = []
    items = export_board_items(
        board_id=args.board_id,
        token=token,
        prefer_experimental=not args.stable_items,
        logger=messages.append,
    )
    write_json(args.output, items)
    print(f"items={len(items)}")
    print(f"output={args.output}")
    for message in messages[-5:]:
        print(f"log={message}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
