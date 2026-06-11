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

from miro_oauth_token import DEFAULT_BROWSER, DEFAULT_REDIRECT_URI  # noqa: E402
from miro_rest_export_board import resolve_token_from_args, write_json  # noqa: E402


DEFAULT_BASE_URL = "https://api.miro.com/v2"
DEFAULT_EXPERIMENTAL_BASE_URL = "https://api.miro.com/v2-experimental"
SLIDE_CONTAINER_TYPE = "slide_container"
SLIDE_FRAME_TYPE = "frame"
TEXTISH_KEYS = {"content", "description", "html", "plain_text", "title", "value"}


def build_slide_probe_requests(
    board_id: str,
    *,
    base_url: str = DEFAULT_BASE_URL,
    experimental_base_url: str = DEFAULT_EXPERIMENTAL_BASE_URL,
) -> list[dict[str, Any]]:
    clean_base = base_url.rstrip("/")
    clean_exp = experimental_base_url.rstrip("/")
    return [
        {
            "key": "public_items_type_slide_container",
            "method": "GET",
            "url": f"{clean_base}/boards/{board_id}/items",
            "params": {"type": "slide_container", "limit": "20"},
            "expectation": "Checks whether public board-items exposes slide containers.",
        },
        {
            "key": "public_items_type_frame",
            "method": "GET",
            "url": f"{clean_base}/boards/{board_id}/items",
            "params": {"type": "frame", "limit": "50"},
            "expectation": "Checks whether public board-items exposes frames that can be linked to slide containers.",
        },
        {
            "key": "experimental_slides_collection",
            "method": "GET",
            "url": f"{clean_exp}/boards/{board_id}/slides",
            "params": {"limit": "20"},
            "expectation": "Checks whether an experimental slides collection exists.",
        },
        {
            "key": "experimental_slide_containers_collection",
            "method": "GET",
            "url": f"{clean_exp}/boards/{board_id}/slide_containers",
            "params": {"limit": "20"},
            "expectation": "Checks whether an experimental slide_containers collection exists.",
        },
        {
            "key": "experimental_presentations_collection",
            "method": "GET",
            "url": f"{clean_exp}/boards/{board_id}/presentations",
            "params": {"limit": "20"},
            "expectation": "Checks whether an experimental presentations/decks collection exists.",
        },
    ]


def build_detail_probe_requests(
    board_id: str,
    slide_items: list[dict[str, Any]],
    *,
    base_url: str = DEFAULT_BASE_URL,
    experimental_base_url: str = DEFAULT_EXPERIMENTAL_BASE_URL,
    max_items: int = 12,
) -> list[dict[str, Any]]:
    clean_base = base_url.rstrip("/")
    clean_exp = experimental_base_url.rstrip("/")
    requests: list[dict[str, Any]] = []
    seen: set[str] = set()

    for item in slide_items:
        item_id = str(item.get("id") or "")
        item_type = str(item.get("type") or "").lower()
        if not item_id or item_id in seen:
            continue
        if item_type not in {SLIDE_CONTAINER_TYPE, SLIDE_FRAME_TYPE}:
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
                "expectation": "Checks whether item detail exposes richer slide/deck payload.",
            }
        )
        requests.append(
            {
                "key": f"experimental_item_detail_{item_type}_{item_id}",
                "method": "GET",
                "url": f"{clean_exp}/boards/{board_id}/items/{item_id}",
                "params": {},
                "expectation": "Checks whether experimental item detail exposes richer slide/deck payload.",
            }
        )
        if item_type == SLIDE_CONTAINER_TYPE:
            requests.append(
                {
                    "key": f"experimental_slide_container_detail_{item_id}",
                    "method": "GET",
                    "url": f"{clean_exp}/boards/{board_id}/slide_containers/{item_id}",
                    "params": {},
                    "expectation": "Checks whether a slide container has an experimental detail endpoint.",
                }
            )
            requests.append(
                {
                    "key": f"experimental_slides_for_container_{item_id}",
                    "method": "GET",
                    "url": f"{clean_exp}/boards/{board_id}/slide_containers/{item_id}/slides",
                    "params": {"limit": "50"},
                    "expectation": "Checks whether slides can be listed for a specific slide container.",
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


def _iter_item_dicts(value: Any) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []

    def walk(nested: Any) -> None:
        if isinstance(nested, list):
            for child in nested:
                walk(child)
            return
        if not isinstance(nested, dict):
            return
        if nested.get("id") is not None and nested.get("type") is not None:
            items.append(nested)
            return
        for child in nested.values():
            if isinstance(child, (dict, list)):
                walk(child)

    walk(value)
    return items


def _parent_id(item: dict[str, Any]) -> str:
    parent = item.get("parent")
    if isinstance(parent, dict) and parent.get("id") is not None:
        return str(parent.get("id"))
    parent_id = item.get("parentId")
    return str(parent_id) if parent_id is not None else ""


def _copy_slide_item(item: dict[str, Any], *, source: str, role: str) -> dict[str, Any]:
    copy = dict(item)
    source = str(copy.pop("__probe_source", source) or source)
    copy.setdefault("source", source)
    copy["slide_role"] = role
    return copy


def _has_ancestor(item_id: str, root_ids: set[str], parent_by_id: dict[str, str]) -> bool:
    current = item_id
    seen: set[str] = set()
    while current and current not in seen:
        seen.add(current)
        parent = parent_by_id.get(current, "")
        if parent in root_ids:
            return True
        current = parent
    return False


def extract_slide_items_from_value(value: Any, *, source: str) -> list[dict[str, Any]]:
    raw_items = _iter_item_dicts(value)
    by_id = {str(item.get("id")): item for item in raw_items if item.get("id") is not None}
    parent_by_id = {item_id: _parent_id(item) for item_id, item in by_id.items()}
    deck_ids = {
        item_id
        for item_id, item in by_id.items()
        if str(item.get("type") or "").lower() == SLIDE_CONTAINER_TYPE
    }

    slide_items: list[dict[str, Any]] = []
    seen: set[str] = set()
    for item_id, item in by_id.items():
        item_type = str(item.get("type") or "").lower()
        role = ""
        if item_type == SLIDE_CONTAINER_TYPE:
            role = "slide_container"
        elif item_type == SLIDE_FRAME_TYPE and _has_ancestor(item_id, deck_ids, parent_by_id):
            role = "slide_frame"
        elif deck_ids and _has_ancestor(item_id, deck_ids, parent_by_id):
            role = "slide_descendant"
        if not role or item_id in seen:
            continue
        slide_items.append(_copy_slide_item(item, source=source, role=role))
        seen.add(item_id)
    return slide_items


def extract_slide_items(results: list[dict[str, Any]]) -> list[dict[str, Any]]:
    available_items: list[dict[str, Any]] = []
    singleton_bodies: list[dict[str, Any]] = []
    for result in results:
        if result.get("classification") != "available":
            continue
        body = result.get("body")
        source = str(result.get("key") or "")
        if isinstance(body, dict) and isinstance(body.get("data"), list):
            for item in body["data"]:
                if isinstance(item, dict):
                    copy = dict(item)
                    copy["__probe_source"] = source
                    available_items.append(copy)
        elif isinstance(body, dict):
            copy = dict(body)
            copy["__probe_source"] = source
            singleton_bodies.append(copy)

    slide_items = extract_slide_items_from_value(
        {"items": available_items + singleton_bodies},
        source="available_responses",
    )
    seen: set[str] = set()
    deduped: list[dict[str, Any]] = []
    for item in slide_items:
        item_id = str(item.get("id") or "")
        if item_id and item_id not in seen:
            deduped.append(item)
            seen.add(item_id)
    return deduped


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


def item_has_geometry(item: dict[str, Any]) -> bool:
    geometry = item.get("geometry") if isinstance(item.get("geometry"), dict) else {}
    position = item.get("position") if isinstance(item.get("position"), dict) else {}
    return (
        float(geometry.get("width") or 0) > 0
        and float(geometry.get("height") or 0) > 0
        and position.get("x") is not None
        and position.get("y") is not None
    )


def slide_items_with_text(slide_items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for item in slide_items:
        textish = find_textish_values(item)
        if not textish:
            continue
        copy = dict(item)
        copy["textish"] = textish
        out.append(copy)
    return out


def decide_probe_result(
    *,
    slide_container_count: int,
    slide_frame_count: int,
    slide_frame_geometry_count: int,
    available_count: int,
    auth_blocked_keys: list[str],
) -> str:
    if slide_container_count > 0 and slide_frame_count > 0 and slide_frame_geometry_count == slide_frame_count:
        return "slide_frames_with_geometry_available"
    if slide_container_count > 0 and slide_frame_count > 0:
        return "slide_frames_partially_available"
    if slide_container_count > 0:
        return "slide_container_without_recoverable_frames"
    if available_count > 0:
        return "slide_source_available_empty"
    if auth_blocked_keys:
        return "slide_source_auth_blocked"
    return "slide_source_not_found"


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


def run_slide_probe(
    *,
    board_id: str,
    token: str,
    session: Any | None = None,
    base_url: str = DEFAULT_BASE_URL,
    experimental_base_url: str = DEFAULT_EXPERIMENTAL_BASE_URL,
    include_body: bool = True,
    detail_limit: int = 12,
    evidence_roots: list[Any] | None = None,
    evidence_sources: list[str] | None = None,
) -> dict[str, Any]:
    if session is None:
        import requests

        session = requests.Session()

    if hasattr(session, "headers"):
        session.headers.update({"Authorization": f"Bearer {token}"})

    initial_results = _run_requests(
        build_slide_probe_requests(board_id, base_url=base_url, experimental_base_url=experimental_base_url),
        token=token,
        session=session,
        include_body=include_body,
    )
    initial_slide_items = extract_slide_items(initial_results)
    evidence_slide_items: list[dict[str, Any]] = []
    for index, root in enumerate(evidence_roots or []):
        source = (evidence_sources or [])[index] if evidence_sources and index < len(evidence_sources) else f"evidence_json_{index + 1}"
        evidence_slide_items.extend(extract_slide_items_from_value(root, source=source))

    detail_results = _run_requests(
        build_detail_probe_requests(
            board_id,
            initial_slide_items + evidence_slide_items,
            base_url=base_url,
            experimental_base_url=experimental_base_url,
            max_items=detail_limit,
        ),
        token=token,
        session=session,
        include_body=include_body,
    )

    results = initial_results + detail_results
    slide_items = extract_slide_items(results)
    seen_ids = {str(item.get("id")) for item in slide_items}
    for item in evidence_slide_items:
        item_id = str(item.get("id") or "")
        if item_id and item_id not in seen_ids:
            slide_items.append(item)
            seen_ids.add(item_id)

    containers = [item for item in slide_items if item.get("slide_role") == "slide_container"]
    frames = [item for item in slide_items if item.get("slide_role") == "slide_frame"]
    descendants = [item for item in slide_items if item.get("slide_role") == "slide_descendant"]
    frames_with_geometry = [item for item in frames if item_has_geometry(item)]
    contentful = slide_items_with_text(slide_items)
    by_classification = Counter(result["classification"] for result in results)
    available = [result for result in results if result["classification"] == "available"]
    auth_blocked = [result["key"] for result in results if result["classification"] == "auth_or_scope_blocked"]

    return {
        "kind": "miro_slide_source_probe",
        "board_id": board_id,
        "summary": {
            "checked": len(results),
            "available": len(available),
            "slide_containers": len(containers),
            "slide_frames": len(frames),
            "slide_frames_with_geometry": len(frames_with_geometry),
            "slide_descendants": len(descendants),
            "contentful_slide_items": len(contentful),
            "evidence_slide_items": len(evidence_slide_items),
            "available_paths": [result["key"] for result in available],
            "auth_blocked_paths": auth_blocked,
            "by_classification": dict(sorted(by_classification.items())),
        },
        "decision": decide_probe_result(
            slide_container_count=len(containers),
            slide_frame_count=len(frames),
            slide_frame_geometry_count=len(frames_with_geometry),
            available_count=len(available),
            auth_blocked_keys=auth_blocked,
        ),
        "requests": results,
        "evidence_sources": evidence_sources or [],
        "slide_items": slide_items,
        "contentful_slide_items": contentful,
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Probe whether Miro slide/deck source data is available from checked REST source paths.")
    parser.add_argument("--board-id", required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--base-url", default=DEFAULT_BASE_URL)
    parser.add_argument("--experimental-base-url", default=DEFAULT_EXPERIMENTAL_BASE_URL)
    parser.add_argument("--omit-body", action="store_true", help="Record status and classification only, without response bodies.")
    parser.add_argument("--detail-limit", type=int, default=12)
    parser.add_argument("--evidence-json", type=Path, action="append", default=[], help="Optional full REST/Web SDK export JSON to scan for slide_container-linked items.")
    parser.add_argument("--token-env", default="MIRO_ACCESS_TOKEN")
    parser.add_argument("--oauth", action="store_true")
    parser.add_argument("--oauth-client-id-env", default="MIRO_CLIENT_ID")
    parser.add_argument("--oauth-client-secret-env", default="MIRO_CLIENT_SECRET")
    parser.add_argument("--oauth-redirect-uri", default=DEFAULT_REDIRECT_URI)
    parser.add_argument("--oauth-scopes", default="boards:read team:read")
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
    evidence_roots = []
    evidence_sources = []
    for path in args.evidence_json:
        with path.open("r", encoding="utf-8-sig") as f:
            evidence_roots.append(json.load(f))
        evidence_sources.append(str(path))
    payload = run_slide_probe(
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
    print(f"slide_containers={payload['summary']['slide_containers']}")
    print(f"slide_frames={payload['summary']['slide_frames']}")
    print(f"slide_frames_with_geometry={payload['summary']['slide_frames_with_geometry']}")
    print(f"slide_descendants={payload['summary']['slide_descendants']}")
    print(f"decision={payload['decision']}")
    print(f"output={args.output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
