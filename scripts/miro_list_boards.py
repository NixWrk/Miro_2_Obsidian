from __future__ import annotations

import argparse
import json
import sys
from collections import Counter
from pathlib import Path
from typing import Any


REPO_ROOT = Path(__file__).resolve().parents[1]
MIRO_JSON_DIR = REPO_ROOT / "Miro_2_Json"
sys.path.insert(0, str(MIRO_JSON_DIR))
sys.path.insert(0, str(REPO_ROOT / "scripts"))

from miro_downloader import get_boards  # noqa: E402
from miro_oauth_token import DEFAULT_AUTHORIZE_URL, DEFAULT_BROWSER, DEFAULT_REDIRECT_URI  # noqa: E402
from miro_rest_export_board import resolve_token_from_args, write_json  # noqa: E402


def summarize_boards(boards: list[dict[str, Any]]) -> dict[str, Any]:
    teams = Counter(str((board.get("team") or {}).get("name") or "<unknown>") for board in boards)
    return {
        "total": len(boards),
        "by_team": dict(sorted(teams.items())),
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="List boards available to the current Miro token.")
    parser.add_argument("--output", type=Path, required=True)
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
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    token = resolve_token_from_args(args)
    boards = get_boards(token)
    payload = {
        "schema_version": 1,
        "source": "miro_rest_boards",
        "summary": summarize_boards(boards),
        "boards": boards,
    }
    write_json(args.output, payload)
    print(f"boards={len(boards)}")
    print(f"output={args.output}")
    for team, count in payload["summary"]["by_team"].items():
        print(f"team={team} boards={count}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
