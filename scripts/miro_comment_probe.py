from __future__ import annotations

import argparse
import time
from collections import Counter
from copy import deepcopy
from pathlib import Path
from typing import Any
from urllib.parse import parse_qsl, unquote, urljoin, urlsplit


REPO_ROOT = Path(__file__).resolve().parents[1]
SCRIPTS_DIR = REPO_ROOT / "scripts"

from scripts.miro_oauth_token import (  # noqa: E402
    DEFAULT_AUTHORIZE_URL,
    DEFAULT_BROWSER,
    DEFAULT_REDIRECT_URI,
)
from scripts.miro_rest_export_board import resolve_token_from_args, write_json  # noqa: E402


DEFAULT_BASE_URL = "https://api.miro.com/v2"
DEFAULT_EXPERIMENTAL_BASE_URL = "https://api.miro.com/v2-experimental"
RETRYABLE_STATUS_CODES = {429, 500, 502, 503, 504}
MAX_REQUEST_ATTEMPTS = 3


class CommentProbeError(RuntimeError):
    """Raised when a checked comment source cannot be read completely."""


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
            if (
                result.get("key") == "public_items_type_comment"
                and str(item.get("type") or "").lower() != "comment"
            ):
                continue
            comment = dict(item)
            comment.setdefault("type", "comment")
            comment.setdefault("source", result.get("key"))
            comments.append(comment)
    return comments


def _classify_available_payload(request_key: str, body: dict[str, Any]) -> str:
    if request_key != "public_items_type_comment":
        return "available"
    data = body.get("data") or []
    if not data:
        return "unverified_empty_comment_filter"
    if any(
        not isinstance(item, dict) or str(item.get("type") or "").lower() != "comment"
        for item in data
    ):
        return "unexpected_comment_filter_payload"
    return "available"


def _next_page_url(body: Any) -> str:
    if not isinstance(body, dict):
        return ""
    links = body.get("links")
    if not isinstance(links, dict):
        return ""
    return str(links.get("next") or links.get("nextPage") or "").strip()


def _nonnegative_int(value: Any) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value if value >= 0 else None
    if isinstance(value, str) and value.isdigit():
        return int(value)
    return None


def _pagination_int(body: dict[str, Any], key: str) -> int | None:
    if key not in body or body[key] is None:
        return None
    parsed = _nonnegative_int(body[key])
    if parsed is None:
        raise CommentProbeError(
            f"Comment pagination returned malformed {key} metadata."
        )
    return parsed


def _same_origin(left: str, right: str) -> bool:
    try:
        left_url = urlsplit(left)
        right_url = urlsplit(right)
        left_port = left_url.port or (443 if left_url.scheme.lower() == "https" else 80)
        right_port = right_url.port or (
            443 if right_url.scheme.lower() == "https" else 80
        )
    except ValueError:
        return False
    return (left_url.scheme.lower(), (left_url.hostname or "").lower(), left_port) == (
        right_url.scheme.lower(),
        (right_url.hostname or "").lower(),
        right_port,
    )


def _next_page_request(
    body: Any,
    *,
    current_url: str,
    current_params: dict[str, Any],
) -> tuple[str, dict[str, str]] | None:
    if not isinstance(body, dict) or not isinstance(body.get("data"), list):
        raise CommentProbeError("Comment pagination returned malformed data.")

    data = body["data"]
    size = _pagination_int(body, "size")
    if size is not None and size != len(data):
        raise CommentProbeError("Comment pagination size does not match returned data.")
    page_size = len(data)

    query = dict(parse_qsl(urlsplit(current_url).query, keep_blank_values=True))
    requested_offset_raw = current_params.get("offset", query.get("offset"))
    requested_offset = (
        _nonnegative_int(requested_offset_raw)
        if requested_offset_raw is not None
        else None
    )
    if requested_offset_raw is not None and requested_offset is None:
        raise CommentProbeError(
            "Comment pagination request has malformed offset metadata."
        )

    response_offset = _pagination_int(body, "offset")
    if (
        requested_offset is not None
        and response_offset is not None
        and response_offset != requested_offset
    ):
        raise CommentProbeError(
            "Comment pagination response offset does not match the request."
        )
    if (
        requested_offset is None
        and "cursor" not in query
        and response_offset not in (None, 0)
    ):
        raise CommentProbeError(
            "Comment pagination initial response has a nonzero offset."
        )
    offset = response_offset if response_offset is not None else (requested_offset or 0)

    total = _pagination_int(body, "total")
    if total is not None and offset + page_size > total:
        raise CommentProbeError("Comment pagination page exceeds declared total.")

    next_url = _next_page_url(body)
    if next_url:
        if page_size == 0:
            raise CommentProbeError(
                "Comment pagination made no progress before links.next."
            )
        resolved_url = urljoin(current_url, next_url)
        if not _same_origin(current_url, resolved_url):
            raise CommentProbeError("Comment pagination links.next changed origin.")
        return resolved_url, {}
    if total is None:
        return None

    next_offset = offset + page_size
    if next_offset >= total:
        return None
    if page_size == 0:
        raise CommentProbeError(
            f"Comment pagination made no progress at offset {offset} while total={total}."
        )
    limit = _pagination_int(body, "limit")
    if limit is None:
        limit = _nonnegative_int(current_params.get("limit")) or page_size
    return current_url, {"offset": str(next_offset), "limit": str(limit)}


def _get_with_retry(
    *,
    session: Any,
    url: str,
    params: dict[str, Any],
    token: str,
    retry_delay_seconds: float,
) -> tuple[Any, int]:
    last_error: Exception | None = None
    last_status = 0
    for attempt in range(1, MAX_REQUEST_ATTEMPTS + 1):
        try:
            response = session.get(
                url,
                params=params,
                headers={"Authorization": f"Bearer {token}"},
                timeout=30,
            )
        except Exception as exc:  # network/session boundary
            last_error = exc
        else:
            last_status = int(getattr(response, "status_code", 0) or 0)
            if last_status not in RETRYABLE_STATUS_CODES:
                return response, attempt
        if attempt < MAX_REQUEST_ATTEMPTS and retry_delay_seconds > 0:
            time.sleep(retry_delay_seconds * attempt)

    detail = (
        f"status={last_status}" if last_status else str(last_error or "request failed")
    )
    raise CommentProbeError(
        f"Comment request failed after {MAX_REQUEST_ATTEMPTS} attempts: {url} ({detail})"
    ) from last_error


def _fetch_paginated_comment_items(
    *,
    first_result: dict[str, Any],
    first_body: Any,
    session: Any,
    token: str,
    include_body: bool,
    retry_delay_seconds: float,
) -> list[dict[str, Any]]:
    if not isinstance(first_body, dict) or not isinstance(first_body.get("data"), list):
        raise CommentProbeError("Comment first page returned malformed data.")
    comments: list[dict[str, Any]] = []
    pages: list[dict[str, Any]] = []
    current_url = str(first_result.get("url") or "")
    current_params = dict(first_result.get("params") or {})
    expected_total = _pagination_int(first_body, "total")
    seen_item_ids: set[str] = set()

    def check_ids(body: dict[str, Any]) -> None:
        for item in body["data"]:
            if not isinstance(item, dict) or not str(item.get("id") or "").strip():
                raise CommentProbeError("Comment page contains a malformed item or missing ID.")
            item_id = str(item["id"])
            if item_id in seen_item_ids:
                raise CommentProbeError("Comment collection pagination repeated an ID.")
            seen_item_ids.add(item_id)

    check_ids(first_body)
    captured_records = len(first_body["data"])
    next_request = _next_page_request(
        first_body,
        current_url=current_url,
        current_params=current_params,
    )
    seen_requests: set[tuple[str, tuple[tuple[str, str], ...]]] = set()

    while next_request:
        next_url, next_params = next_request
        request_key = (next_url, tuple(sorted(next_params.items())))
        if request_key in seen_requests:
            raise CommentProbeError(
                f"Comment pagination repeated the same page: {next_url}"
            )
        seen_requests.add(request_key)
        response, attempts = _get_with_retry(
            session=session,
            url=next_url,
            params=next_params,
            token=token,
            retry_delay_seconds=retry_delay_seconds,
        )
        status_code = int(getattr(response, "status_code", 0) or 0)
        raw_body = _response_body(response, include_body=True)
        if not isinstance(raw_body, dict) or not isinstance(raw_body.get("data"), list):
            raise CommentProbeError(
                f"Comment page returned malformed data for {first_result.get('key')}: {next_url}"
            )
        page = {
            "key": first_result.get("key"),
            "method": "GET",
            "url": next_url,
            "params": next_params,
            "expectation": "Fetches the next page from an available comments collection.",
            "status_code": status_code,
            "classification": classify_status(status_code),
            "attempts": attempts,
            "body": raw_body if include_body else None,
        }
        pages.append(page)
        if page["classification"] != "available":
            raise CommentProbeError(
                f"Comment pagination failed for {first_result.get('key')}: "
                f"status={status_code} classification={page['classification']}"
            )

        page_total = _pagination_int(raw_body, "total")
        if expected_total is None:
            expected_total = page_total
        elif page_total is not None and page_total != expected_total:
            raise CommentProbeError("Comment pagination total changed between pages.")
        captured_records += len(raw_body["data"])
        check_ids(raw_body)
        comments.extend(extract_comment_items([{**page, "body": raw_body}]))
        current_url = next_url
        current_params = next_params
        next_request = _next_page_request(
            raw_body,
            current_url=current_url,
            current_params=current_params,
        )

    if expected_total is not None and captured_records != expected_total:
        raise CommentProbeError(
            f"Comment pagination captured {captured_records} records but declared total is {expected_total}."
        )
    if pages:
        first_result["pages"] = pages
    first_result["pagination"] = {
        "complete": True,
        "pages": 1 + len(pages),
        "records": captured_records,
        "declared_total": expected_total,
    }
    return comments


def decide_probe_result(available_count: int, comment_count: int) -> str:
    if comment_count > 0:
        return "comments_available_with_items"
    if available_count > 0:
        return "comments_source_available_empty"
    return "separate_source_not_found_in_checked_rest_paths"


def _audit_comment_threads(
    comments: list[dict[str, Any]],
    *,
    source_urls: dict[str, str],
    session: Any,
    token: str,
    retry_delay_seconds: float,
    collection_key: str = "replies",
) -> dict[str, Any]:
    """Verify returned evidence; follow only reply links actually supplied by Miro.

    The checked REST paths have no verified contract for resolved-thread coverage.
    Absence of a replies field or count therefore remains unknown, never zero.
    """
    threads: list[dict[str, Any]] = []
    verified_key = f"{collection_key}_verified"
    count_keys = {"replies": ("replyCount", "reply_count"), "messages": ("messageCount", "message_count")}[collection_key]
    for comment in comments:
        audit: dict[str, Any] = {"id": comment.get("id"), verified_key: False}
        threads.append(audit)
        declared = None
        for key in count_keys:
            count = _pagination_int(comment, key)
            if count is not None:
                if declared is not None and declared != count:
                    raise CommentProbeError("Comment reply counts disagree.")
                declared = count
        replies = comment.get(collection_key)
        if replies is None:
            if declared not in (None, 0):
                if collection_key == "replies" and comment.get("messages") is not None:
                    audit.update({
                        "declared_records": declared,
                        "reason": "reply_count_not_reconciled_with_messages_without_contract",
                    })
                    continue
                raise CommentProbeError("Comment declares replies but provides neither replies nor continuation.")
            audit.update({"declared_records": declared, verified_key: declared == 0})
            continue
        if isinstance(replies, list):
            page = {"data": replies}
        elif isinstance(replies, dict) and isinstance(replies.get("data"), list):
            page = deepcopy(replies)
        else:
            raise CommentProbeError("Comment replies returned malformed data.")
        collected: list[dict[str, Any]] = []
        seen_ids: set[str] = set()
        seen_urls: set[str] = set()
        current_url = source_urls[str(comment.get("source"))]
        source_url = current_url
        raw_pages = []
        while True:
            count = _pagination_int(page, "total")
            if count is not None:
                if declared is not None and declared != count:
                    raise CommentProbeError("Comment replies total changed or disagrees with reply count.")
                declared = count
            size = _pagination_int(page, "size")
            if size is not None and size != len(page["data"]):
                raise CommentProbeError("Comment replies size does not match data.")
            for reply in page["data"]:
                if not isinstance(reply, dict):
                    raise CommentProbeError("Comment replies contain a non-object.")
                reply_id = str(reply.get("id") or "")
                if reply_id and reply_id in seen_ids:
                    raise CommentProbeError("Comment reply pagination repeated an ID.")
                if reply_id:
                    seen_ids.add(reply_id)
                collected.append(deepcopy(reply))
            if declared is not None and len(collected) > declared:
                raise CommentProbeError("Comment replies exceed declared total.")
            link = _next_page_url(page)
            if not link:
                if declared is not None and len(collected) != declared:
                    raise CommentProbeError("Comment replies truncated before declared total without continuation.")
                if page.get("hasMore") is True or page.get("has_more") is True or page.get("cursor"):
                    raise CommentProbeError("Comment reply continuation has no server-provided URL.")
                break
            if not page["data"]:
                raise CommentProbeError("Comment reply pagination made no progress.")
            next_url = urljoin(current_url, link)
            # Keep authorization on the checked origin and inside this board.
            board_path = urlsplit(source_url).path.rsplit("/", 1)[0] + "/"
            parsed_next = urlsplit(next_url)
            decoded_path = unquote(parsed_next.path)
            if (
                not _same_origin(source_url, next_url)
                or not decoded_path.startswith(board_path)
                or any(part in {".", ".."} for part in decoded_path.split("/"))
                or parsed_next.username is not None
                or parsed_next.password is not None
            ):
                raise CommentProbeError("Comment reply link left the checked board or origin.")
            if next_url in seen_urls:
                raise CommentProbeError("Comment reply pagination repeated a URL.")
            seen_urls.add(next_url)
            response, _ = _get_with_retry(
                session=session, url=next_url, params={}, token=token,
                retry_delay_seconds=retry_delay_seconds,
            )
            if classify_status(int(response.status_code)) != "available":
                raise CommentProbeError("Comment reply page request failed.")
            page = _response_body(response, include_body=True)
            if not isinstance(page, dict) or not isinstance(page.get("data"), list):
                raise CommentProbeError("Comment reply page returned malformed data.")
            raw_pages.append({"url": next_url, "body": deepcopy(page)})
            current_url = next_url
        if raw_pages:
            audit[f"original_{collection_key}"] = deepcopy(replies)
            audit["pages"] = raw_pages
            if isinstance(replies, dict):
                comment[collection_key] = {**deepcopy(replies), "data": collected}
            else:
                comment[collection_key] = collected
        audit.update({
            "captured_records": len(collected), "declared_records": declared,
            verified_key: declared is not None,
        })
    coverage = {
        "scope": "returned_threads_and_server_provided_nested_links",
        verified_key: bool(threads) and all(t[verified_key] for t in threads),
        "resolved_threads_verified": False,
        "resolved_threads_reason": "checked_rest_paths_have_no_verified_resolved_thread_contract",
        "returned_resolved_thread_ids": [c.get("id") for c in comments if c.get("resolved") is True],
        "threads": threads,
    }
    if collection_key == "replies":
        message_coverage = _audit_comment_threads(
            comments, source_urls=source_urls, session=session, token=token,
            retry_delay_seconds=retry_delay_seconds, collection_key="messages",
        )
        coverage["messages_verified"] = message_coverage["messages_verified"]
        coverage["message_threads"] = message_coverage["threads"]
    return coverage


def run_comment_probe(
    *,
    board_id: str,
    token: str,
    session: Any | None = None,
    base_url: str = DEFAULT_BASE_URL,
    experimental_base_url: str = DEFAULT_EXPERIMENTAL_BASE_URL,
    include_body: bool = True,
    retry_delay_seconds: float = 0.5,
) -> dict[str, Any]:
    if session is None:
        import requests

        session = requests.Session()

    if hasattr(session, "headers"):
        session.headers.update({"Authorization": f"Bearer {token}"})

    results: list[dict[str, Any]] = []
    response_bodies: list[Any] = []
    for request in build_comment_probe_requests(
        board_id,
        base_url=base_url,
        experimental_base_url=experimental_base_url,
    ):
        response, attempts = _get_with_retry(
            session=session,
            url=request["url"],
            params=request["params"],
            token=token,
            retry_delay_seconds=retry_delay_seconds,
        )
        status_code = int(getattr(response, "status_code", 0) or 0)
        raw_body = _response_body(response, include_body=True)
        classification = classify_status(status_code)
        if classification == "available" and (
            not isinstance(raw_body, dict) or not isinstance(raw_body.get("data"), list)
        ):
            raise CommentProbeError(
                f"Comment source returned malformed data for {request['key']}: {request['url']}"
            )
        if classification == "available":
            classification = _classify_available_payload(request["key"], raw_body)
        response_bodies.append(raw_body)
        results.append(
            {
                "key": request["key"],
                "method": request["method"],
                "url": request["url"],
                "params": request["params"],
                "expectation": request["expectation"],
                "status_code": status_code,
                "classification": classification,
                "attempts": attempts,
                "body": raw_body if include_body else None,
            }
        )

    by_classification = Counter(result["classification"] for result in results)
    available_indexes = [
        index
        for index, result in enumerate(results)
        if result["classification"] == "available"
    ]
    available = [results[index] for index in available_indexes]
    comments: list[dict[str, Any]] = []
    for index in available_indexes:
        result = results[index]
        raw_body = response_bodies[index]
        comments.extend(extract_comment_items([{**result, "body": raw_body}]))
        comments.extend(
            _fetch_paginated_comment_items(
                first_result=result,
                first_body=raw_body,
                session=session,
                token=token,
                include_body=include_body,
                retry_delay_seconds=retry_delay_seconds,
            )
        )
    thread_coverage = _audit_comment_threads(
        comments, source_urls={result["key"]: result["url"] for result in available},
        session=session, token=token, retry_delay_seconds=retry_delay_seconds,
    )
    blocking = sorted(
        classification
        for classification in by_classification
        if classification
        in {
            "auth_or_scope_blocked",
            "rate_limited",
            "server_error",
            "unexpected_status",
        }
    )
    complete = bool(available) and not blocking
    if complete:
        completeness_reason = "all_available_comment_pages_fetched"
    elif blocking:
        completeness_reason = "comment_source_blocked_or_failed"
    else:
        completeness_reason = "no_available_comment_source"
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
        "completeness": {
            "complete": complete,
            "reason": completeness_reason,
            "source_available": bool(available),
            "all_available_pages_fetched": bool(available),
            "blocking_classifications": blocking,
            "scope": "available_collection_pages",
            "thread_coverage": thread_coverage,
        },
        "requests": results,
        "comments": comments,
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Probe whether Miro comments are available from checked REST source paths."
    )
    parser.add_argument("--board-id", required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--base-url", default=DEFAULT_BASE_URL)
    parser.add_argument(
        "--experimental-base-url", default=DEFAULT_EXPERIMENTAL_BASE_URL
    )
    parser.add_argument(
        "--omit-body",
        action="store_true",
        help="Record status and classification only, without response bodies.",
    )
    parser.add_argument("--token-env", default="MIRO_ACCESS_TOKEN")
    parser.add_argument("--oauth", action="store_true")
    parser.add_argument("--oauth-client-id-env", default="MIRO_CLIENT_ID")
    parser.add_argument("--oauth-client-secret-env", default="MIRO_CLIENT_SECRET")
    parser.add_argument("--oauth-redirect-uri", default=DEFAULT_REDIRECT_URI)
    parser.add_argument("--oauth-scopes", default="boards:read team:read")
    parser.add_argument("--oauth-authorize-url", default=DEFAULT_AUTHORIZE_URL)
    parser.add_argument(
        "--oauth-token-url", default="https://api.miro.com/v1/oauth/token"
    )
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
