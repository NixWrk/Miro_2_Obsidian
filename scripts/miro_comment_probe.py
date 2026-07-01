from __future__ import annotations

import argparse
import json
import sys
from collections import Counter
from pathlib import Path
from typing import Any


REPO_ROOT = Path(__file__).resolve().parents[1]
SCRIPTS_DIR = REPO_ROOT / "scripts"
sys.path.insert(0, str(SCRIPTS_DIR))

from miro_oauth_token import DEFAULT_AUTHORIZE_URL, DEFAULT_BROWSER, DEFAULT_REDIRECT_URI  # noqa: E402
from miro_rest_export_board import resolve_token_from_args, write_json  # noqa: E402


DEFAULT_BASE_URL = "https://api.miro.com/v2"
DEFAULT_EXPERIMENTAL_BASE_URL = "https://api.miro.com/v2-experimental"


def build_comment_probe_requests(
    board_id: str,
    *,
    base_url: str = DEFAULT_BASE_URL,
    experimental_base_url: str = DEFAULT_EXPERIMENTAL_BASE_URL,
) -> list[dict[str, Any]]:
    clean_base = base_url.rstrip("/")
    clean_exp = experimental_base_url.rstrip("/")
    return [
        {
            "key": "public_items_type_comment",
            "method": "GET",
            "url": f"{clean_base}/boards/{board_id}/items",
            "params": {"type": "comment", "limit": "10"},
            "expectation": "Checks whether the public board-items endpoint accepts comment as an item type.",
        },
        {
            "key": "public_comments_collection",
            "method": "GET",
            "url": f"{clean_base}/boards/{board_id}/comments",
            "params": {},
            "expectation": "Checks whether a public comments collection exists under the board REST API.",
        },
        {
            "key": "experimental_comments_collection",
            "method": "GET",
            "url": f"{clean_exp}/boards/{board_id}/comments",
            "params": {},
            "expectation": "Checks whether the experimental board REST API exposes comments.",
        },
    ]


def classify_status(status_code: int) -> str:
    if 200 <= status_code < 300:
        return "available"
    if status_code == 400:
        return "unsupported_or_bad_request"
    if status_code in {401, 403}:
        return "auth_or_scope_blocked"
    if status_code == 404:
        return "not_found_or_endpoint_absent"
    if status_code == 429:
        return "rate_limited"
    if 500 <= status_code < 600:
        return "server_error"
    return "unexpected_status"


def _response_body(response: Any, *, include_body: bool) -> Any:
    if not include_body:
        return None
    try:
        return response.json()
    except Exception:
        text = str(getattr(response, "text", "") or "")
        return text[:2000]


def extract_comment_items(results: list[dict[str, Any]]) -> list[dict[str, Any]]:
    comments: list[dict[str, Any]] = []
    for result in results:
        if result.get("classification") != "available":
            continue
        body = result.get("body")
        if not isinstance(body, dict):
            continue
        data = body.get("data")
        if not isinstance(data, list):
            continue
        for item in data:
            if not isinstance(item, dict):
                continue
            comment = dict(item)
            comment.setdefault("type", "comment")
            comment.setdefault("source", result.get("key"))
            comments.append(comment)
    return comments


def _next_page_url(body: Any) -> str:
    if not isinstance(body, dict):
        return ""
    links = body.get("links")
    if not isinstance(links, dict):
        return ""
    return str(links.get("next") or links.get("nextPage") or "").strip()


def _fetch_paginated_comment_items(
    *,
    first_result: dict[str, Any],
    session: Any,
    token: str,
    include_body: bool,
) -> list[dict[str, Any]]:
    comments: list[dict[str, Any]] = []
    pages: list[dict[str, Any]] = []
    next_url = _next_page_url(first_result.get("body"))
    seen_urls: set[str] = set()

    while next_url and next_url not in seen_urls:
        seen_urls.add(next_url)
        response = session.get(
            next_url,
            params={},
            headers={"Authorization": f"Bearer {token}"},
            timeout=30,
        )
        status_code = int(getattr(response, "status_code", 0) or 0)
        page = {
            "key": first_result.get("key"),
            "method": "GET",
            "url": next_url,
            "params": {},
            "expectation": "Fetches the next page from an available comments collection.",
            "status_code": status_code,
            "classification": classify_status(status_code),
            "body": _response_body(response, include_body=include_body),
        }
        pages.append(page)
        if page["classification"] != "available":
            break
        comments.extend(extract_comment_items([page]))
        next_url = _next_page_url(page.get("body"))

    if pages:
        first_result["pages"] = pages
    return comments


def decide_probe_result(available_count: int, comment_count: int) -> str:
    if comment_count > 0:
        return "comments_available_with_items"
    if available_count > 0:
        return "comments_source_available_empty"
    return "separate_source_not_found_in_checked_rest_paths"


def run_comment_probe(
    *,
    board_id: str,
    token: str,
    session: Any | None = None,
    base_url: str = DEFAULT_BASE_URL,
    experimental_base_url: str = DEFAULT_EXPERIMENTAL_BASE_URL,
    include_body: bool = True,
) -> dict[str, Any]:
    if session is None:
        import requests

        session = requests.Session()

    if hasattr(session, "headers"):
        session.headers.update({"Authorization": f"Bearer {token}"})

    results: list[dict[str, Any]] = []
    for request in build_comment_probe_requests(
        board_id,
        base_url=base_url,
        experimental_base_url=experimental_base_url,
    ):
        response = session.get(
            request["url"],
            params=request["params"],
            headers={"Authorization": f"Bearer {token}"},
            timeout=30,
        )
        status_code = int(getattr(response, "status_code", 0) or 0)
        results.append(
            {
                "key": request["key"],
                "method": request["method"],
                "url": request["url"],
                "params": request["params"],
                "expectation": request["expectation"],
                "status_code": status_code,
                "classification": classify_status(status_code),
                "body": _response_body(response, include_body=include_body),
            }
        )

    by_classification = Counter(result["classification"] for result in results)
    available = [result for result in results if result["classification"] == "available"]
    comments = extract_comment_items(results)
    for result in available:
        comments.extend(
            _fetch_paginated_comment_items(
                first_result=result,
                session=session,
                token=token,
                include_body=include_body,
            )
        )
    return {
        "kind": "miro_comment_source_probe",
        "board_id": board_id,
        "summary": {
            "checked": len(results),
            "available": len(available),
            "comment_items": len(comments),
            "available_paths": [result["key"] for result in available],
            "by_classification": dict(sorted(by_classification.items())),
        },
        "decision": decide_probe_result(len(available), len(comments)),
        "requests": results,
        "comments": comments,
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Probe whether Miro comments are available from checked REST source paths.")
    parser.add_argument("--board-id", required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--base-url", default=DEFAULT_BASE_URL)
    parser.add_argument("--experimental-base-url", default=DEFAULT_EXPERIMENTAL_BASE_URL)
    parser.add_argument("--omit-body", action="store_true", help="Record status and classification only, without response bodies.")
    parser.add_argument("--token-env", default="MIRO_ACCESS_TOKEN")
    parser.add_argument("--oauth", action="store_true")
    parser.add_argument("--oauth-client-id-env", default="MIRO_CLIENT_ID")
    parser.add_argument("--oauth-client-secret-env", default="MIRO_CLIENT_SECRET")
    parser.add_argument("--oauth-redirect-uri", default=DEFAULT_REDIRECT_URI)
    parser.add_argument("--oauth-scopes", default="boards:read team:read")
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
    payload = run_comment_probe(
        board_id=args.board_id,
        token=token,
        base_url=args.base_url,
        experimental_base_url=args.experimental_base_url,
        include_body=not args.omit_body,
    )
    write_json(args.output, payload)
    print(f"checked={payload['summary']['checked']}")
    print(f"available={payload['summary']['available']}")
    print(f"decision={payload['decision']}")
    print(f"output={args.output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
