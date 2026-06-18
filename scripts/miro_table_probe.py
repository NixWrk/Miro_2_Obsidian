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
TABLE_TYPES = {"table", "table_text", "data_table_format"}
TEXTISH_KEYS = {"content", "text", "title", "plain_text", "description", "value", "html"}


def build_table_probe_requests(
    board_id: str,
    *,
    base_url: str = DEFAULT_BASE_URL,
    experimental_base_url: str = DEFAULT_EXPERIMENTAL_BASE_URL,
) -> list[dict[str, Any]]:
    clean_base = base_url.rstrip("/")
    clean_exp = experimental_base_url.rstrip("/")
    return [
        {
            "key": "public_items_type_table",
            "method": "GET",
            "url": f"{clean_base}/boards/{board_id}/items",
            "params": {"type": "table", "limit": "20"},
            "expectation": "Checks whether public board-items exposes legacy table objects.",
        },
        {
            "key": "public_items_type_table_text",
            "method": "GET",
            "url": f"{clean_base}/boards/{board_id}/items",
            "params": {"type": "table_text", "limit": "20"},
            "expectation": "Checks whether public board-items exposes table cell objects.",
        },
        {
            "key": "public_data_table_formats_collection",
            "method": "GET",
            "url": f"{clean_base}/boards/{board_id}/data_table_formats",
            "params": {"limit": "20"},
            "expectation": "Checks whether the public data_table_formats collection exposes table payloads.",
        },
        {
            "key": "experimental_tables_collection",
            "method": "GET",
            "url": f"{clean_exp}/boards/{board_id}/tables",
            "params": {},
            "expectation": "Checks whether an experimental tables collection exposes richer table payloads.",
        },
        {
            "key": "experimental_data_table_formats_collection",
            "method": "GET",
            "url": f"{clean_exp}/boards/{board_id}/data_table_formats",
            "params": {"limit": "20"},
            "expectation": "Checks whether experimental data_table_formats exists.",
        },
    ]


def build_detail_probe_requests(
    board_id: str,
    table_items: list[dict[str, Any]],
    *,
    base_url: str = DEFAULT_BASE_URL,
    experimental_base_url: str = DEFAULT_EXPERIMENTAL_BASE_URL,
    max_items: int = 6,
) -> list[dict[str, Any]]:
    clean_base = base_url.rstrip("/")
    clean_exp = experimental_base_url.rstrip("/")
    requests: list[dict[str, Any]] = []
    seen: set[str] = set()
    for item in table_items:
        item_id = str(item.get("id") or "")
        item_type = str(item.get("type") or "").lower()
        if not item_id or item_id in seen:
            continue
        seen.add(item_id)
        if len(seen) > max_items:
            break
        requests.append(
            {
                "key": f"public_item_detail_{item_type}_{item_id}",
                "method": "GET",
                "url": f"{clean_base}/boards/{board_id}/items/{item_id}",
                "params": {},
                "expectation": "Checks whether item detail returns more table text than the list endpoint.",
            }
        )
        requests.append(
            {
                "key": f"experimental_item_detail_{item_type}_{item_id}",
                "method": "GET",
                "url": f"{clean_exp}/boards/{board_id}/items/{item_id}",
                "params": {},
                "expectation": "Checks whether experimental item detail returns more table text than the list endpoint.",
            }
        )
        if item_type == "table":
            requests.append(
                {
                    "key": f"experimental_table_detail_{item_id}",
                    "method": "GET",
                    "url": f"{clean_exp}/boards/{board_id}/tables/{item_id}",
                    "params": {},
                    "expectation": "Checks whether experimental table detail exposes rows/cells.",
                }
            )
            requests.append(
                {
                    "key": f"public_data_table_format_detail_{item_id}",
                    "method": "GET",
                    "url": f"{clean_base}/boards/{board_id}/data_table_formats/{item_id}",
                    "params": {},
                    "expectation": "Checks whether a table id is addressable as a data_table_format.",
                }
            )
    return requests


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


def _copy_table_item(item: dict[str, Any], source: str | None) -> dict[str, Any]:
    table_item = dict(item)
    table_item.setdefault("source", source)
    return table_item


def extract_table_items_from_value(value: Any, *, source: str) -> list[dict[str, Any]]:
    table_items: list[dict[str, Any]] = []
    seen: set[str] = set()

    def walk(nested: Any) -> None:
        if isinstance(nested, list):
            for item in nested:
                walk(item)
            return
        if not isinstance(nested, dict):
            return
        item_type = str(nested.get("type") or "").lower()
        item_id = str(nested.get("id") or "")
        if item_type in TABLE_TYPES and item_id and item_id not in seen:
            table_items.append(_copy_table_item(nested, source))
            seen.add(item_id)
            return
        for child in nested.values():
            if isinstance(child, (dict, list)):
                walk(child)

    walk(value)
    return table_items


def extract_table_items(results: list[dict[str, Any]]) -> list[dict[str, Any]]:
    table_items: list[dict[str, Any]] = []
    seen: set[str] = set()
    for result in results:
        if result.get("classification") != "available":
            continue
        body = result.get("body")
        candidates: list[Any] = []
        if isinstance(body, dict) and isinstance(body.get("data"), list):
            candidates.extend(body["data"])
        elif isinstance(body, dict):
            candidates.append(body)

        for item in candidates:
            if not isinstance(item, dict):
                continue
            item_type = str(item.get("type") or "").lower()
            item_id = str(item.get("id") or "")
            if item_type not in TABLE_TYPES or not item_id or item_id in seen:
                continue
            table_items.append(_copy_table_item(item, result.get("key")))
            seen.add(item_id)
    return table_items


def find_textish_values(value: Any, path: str = "") -> list[dict[str, str]]:
    found: list[dict[str, str]] = []
    if isinstance(value, dict):
        for key, nested in value.items():
            nested_path = f"{path}.{key}" if path else key
            if key.lower() in TEXTISH_KEYS and str(nested or "").strip():
                found.append({"path": nested_path, "value": str(nested)})
            found.extend(find_textish_values(nested, nested_path))
    elif isinstance(value, list):
        for index, nested in enumerate(value):
            found.extend(find_textish_values(nested, f"{path}[{index}]"))
    return found


def table_items_with_text(table_items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for item in table_items:
        textish = find_textish_values(item)
        if not textish:
            continue
        copy = dict(item)
        copy["textish"] = textish
        out.append(copy)
    return out


def decide_probe_result(
    *,
    table_item_count: int,
    contentful_table_item_count: int,
    auth_blocked_keys: list[str],
    available_count: int,
) -> str:
    if contentful_table_item_count > 0:
        return "table_content_available"
    if table_item_count > 0 and auth_blocked_keys:
        return "table_geometry_without_content_and_blocked_candidate"
    if table_item_count > 0:
        return "table_geometry_without_content"
    if available_count > 0:
        return "table_source_available_empty"
    if auth_blocked_keys:
        return "table_source_auth_blocked"
    return "table_source_not_found"


def _run_requests(
    requests_to_run: list[dict[str, Any]],
    *,
    token: str,
    session: Any,
    include_body: bool,
) -> list[dict[str, Any]]:
    results: list[dict[str, Any]] = []
    for request in requests_to_run:
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
    return results


def run_table_probe(
    *,
    board_id: str,
    token: str,
    session: Any | None = None,
    base_url: str = DEFAULT_BASE_URL,
    experimental_base_url: str = DEFAULT_EXPERIMENTAL_BASE_URL,
    include_body: bool = True,
    detail_limit: int = 6,
    evidence_roots: list[Any] | None = None,
    evidence_sources: list[str] | None = None,
) -> dict[str, Any]:
    if session is None:
        import requests

        session = requests.Session()

    if hasattr(session, "headers"):
        session.headers.update({"Authorization": f"Bearer {token}"})

    initial_results = _run_requests(
        build_table_probe_requests(board_id, base_url=base_url, experimental_base_url=experimental_base_url),
        token=token,
        session=session,
        include_body=include_body,
    )
    initial_table_items = extract_table_items(initial_results)
    evidence_table_items: list[dict[str, Any]] = []
    for index, root in enumerate(evidence_roots or []):
        source = (evidence_sources or [])[index] if evidence_sources and index < len(evidence_sources) else f"evidence_json_{index + 1}"
        evidence_table_items.extend(extract_table_items_from_value(root, source=source))

    detail_results = _run_requests(
        build_detail_probe_requests(
            board_id,
            initial_table_items + evidence_table_items,
            base_url=base_url,
            experimental_base_url=experimental_base_url,
            max_items=detail_limit,
        ),
        token=token,
        session=session,
        include_body=include_body,
    )
    results = initial_results + detail_results
    table_items = extract_table_items(results)
    seen_ids = {str(item.get("id")) for item in table_items}
    for item in evidence_table_items:
        item_id = str(item.get("id") or "")
        if item_id and item_id not in seen_ids:
            table_items.append(item)
            seen_ids.add(item_id)
    contentful = table_items_with_text(table_items)

    by_classification = Counter(result["classification"] for result in results)
    available = [result for result in results if result["classification"] == "available"]
    auth_blocked = [result["key"] for result in results if result["classification"] == "auth_or_scope_blocked"]

    return {
        "kind": "miro_table_source_probe",
        "board_id": board_id,
        "summary": {
            "checked": len(results),
            "available": len(available),
            "table_items": len(table_items),
            "contentful_table_items": len(contentful),
            "evidence_table_items": len(evidence_table_items),
            "available_paths": [result["key"] for result in available],
            "auth_blocked_paths": auth_blocked,
            "by_classification": dict(sorted(by_classification.items())),
        },
        "decision": decide_probe_result(
            table_item_count=len(table_items),
            contentful_table_item_count=len(contentful),
            auth_blocked_keys=auth_blocked,
            available_count=len(available),
        ),
        "requests": results,
        "evidence_sources": evidence_sources or [],
        "table_items": table_items,
        "contentful_table_items": contentful,
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Probe whether Miro table text is available from checked REST source paths.")
    parser.add_argument("--board-id", required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--base-url", default=DEFAULT_BASE_URL)
    parser.add_argument("--experimental-base-url", default=DEFAULT_EXPERIMENTAL_BASE_URL)
    parser.add_argument("--omit-body", action="store_true", help="Record status and classification only, without response bodies.")
    parser.add_argument("--detail-limit", type=int, default=6)
    parser.add_argument("--evidence-json", type=Path, action="append", default=[], help="Optional full REST/Web SDK export JSON to scan for table/table_text items.")
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
    evidence_roots = []
    evidence_sources = []
    for path in args.evidence_json:
        with path.open("r", encoding="utf-8-sig") as f:
            evidence_roots.append(json.load(f))
        evidence_sources.append(str(path))
    payload = run_table_probe(
        board_id=args.board_id,
        token=token,
        base_url=args.base_url,
        experimental_base_url=args.experimental_base_url,
        include_body=not args.omit_body,
        detail_limit=args.detail_limit,
        evidence_roots=evidence_roots,
        evidence_sources=evidence_sources,
    )
    write_json(args.output, payload)
    print(f"checked={payload['summary']['checked']}")
    print(f"available={payload['summary']['available']}")
    print(f"table_items={payload['summary']['table_items']}")
    print(f"contentful_table_items={payload['summary']['contentful_table_items']}")
    print(f"evidence_table_items={payload['summary']['evidence_table_items']}")
    print(f"decision={payload['decision']}")
    print(f"output={args.output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
