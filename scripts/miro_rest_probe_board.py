from __future__ import annotations

import argparse
import json
import os
from copy import deepcopy
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

from miro_oauth_token import DEFAULT_AUTHORIZE_URL, DEFAULT_BROWSER, DEFAULT_REDIRECT_URI


DEFAULT_BOARD_NAME = "Miro2Obsidian REST Capability Probe"
DEFAULT_BASE_URL = "https://api.miro.com/v2"
PROBE_IMAGE_URL = "https://miro.com/blog/wp-content/uploads/2023/10/Frame-12772209-1536x806.png"
PROBE_DOCUMENT_URL = "https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf"
PROBE_EMBED_URL = "https://www.youtube.com/watch?v=aqz-KE-bpKQ"

REST_SHAPE_TYPES = (
    "rectangle",
    "round_rectangle",
    "circle",
    "triangle",
    "rhombus",
    "parallelogram",
    "trapezoid",
    "pentagon",
    "hexagon",
    "octagon",
    "wedge_round_rectangle_callout",
    "star",
    "flow_chart_predefined_process",
    "cloud",
    "cross",
    "can",
    "right_arrow",
    "left_arrow",
    "left_right_arrow",
    "left_brace",
    "right_brace",
)

REST_STICKY_COLORS = (
    "light_yellow",
    "yellow",
    "orange",
    "red",
    "light_pink",
    "pink",
    "light_blue",
    "violet",
    "blue",
    "dark_blue",
    "cyan",
    "dark_green",
    "light_green",
    "green",
    "gray",
    "black",
)

REST_TAG_COLORS = (
    "red",
    "light_green",
    "cyan",
    "yellow",
    "magenta",
    "green",
    "blue",
    "gray",
    "violet",
    "dark_green",
    "dark_blue",
    "black",
)

REST_CONNECTOR_SHAPES = ("straight", "elbowed", "curved")
REST_CONNECTOR_CAPS = (
    "none",
    "stealth",
    "rounded_stealth",
    "arrow",
    "filled_triangle",
    "triangle",
    "filled_diamond",
    "diamond",
    "filled_oval",
    "oval",
    "erd_one",
    "erd_many",
    "erd_one_or_many",
    "erd_only_one",
    "erd_zero_or_many",
    "erd_zero_or_one",
)


class MiroRestRequestError(RuntimeError):
    def __init__(self, message: str, *, status_code: int | str, response_body: str) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.response_body = response_body


@dataclass(frozen=True)
class ProbeOperation:
    key: str
    item_type: str
    method: str
    path: str
    payload: dict[str, Any]
    depends_on: tuple[str, ...] = ()


def _position(col: int, row: int) -> dict[str, int]:
    return {"x": -420 + col * 360, "y": -260 + row * 220}


def _grid_position(index: int, *, origin_x: int, origin_y: int, columns: int, gap_x: int, gap_y: int) -> dict[str, int]:
    return {
        "x": origin_x + (index % columns) * gap_x,
        "y": origin_y + (index // columns) * gap_y,
    }


def build_probe_operations() -> list[ProbeOperation]:
    operations: list[ProbeOperation] = [
        ProbeOperation(
            key="tag_todo",
            item_type="tag",
            method="POST",
            path="/boards/{board_id}/tags",
            payload={"title": "miro2obsidian-rest-todo", "fillColor": "yellow"},
        ),
        ProbeOperation(
            key="tag_urgent",
            item_type="tag",
            method="POST",
            path="/boards/{board_id}/tags",
            payload={"title": "miro2obsidian-rest-urgent", "fillColor": "magenta"},
        ),
        ProbeOperation(
            key="frame_main",
            item_type="frame",
            method="POST",
            path="/boards/{board_id}/frames",
            payload={
                "data": {"title": "REST probe frame"},
                "position": {"x": 2600, "y": 0},
                "geometry": {"width": 1050, "height": 720},
            },
        ),
        ProbeOperation(
            key="text_html",
            item_type="text",
            method="POST",
            path="/boards/{board_id}/texts",
            payload={
                "data": {"content": "<p><strong>REST text probe</strong><br/>HTML content</p>"},
                "position": _position(0, 0),
                "geometry": {"width": 280},
            },
        ),
        ProbeOperation(
            key="text_rich",
            item_type="text",
            method="POST",
            path="/boards/{board_id}/texts",
            payload={
                "data": {
                    "content": (
                        "<p><strong>REST rich text</strong><br/>"
                        "<em>italic</em>, <u>underline</u>, <s>strike</s>, "
                        "<a href='https://miro.com/'>link</a></p>"
                    )
                },
                "position": _position(1, 0),
                "geometry": {"width": 360},
                "style": {"fontSize": "18", "textAlign": "left"},
            },
        ),
        ProbeOperation(
            key="text_link_only",
            item_type="text",
            method="POST",
            path="/boards/{board_id}/texts",
            payload={
                "data": {"content": f"<p><a href='{PROBE_EMBED_URL}'>REST YouTube link probe</a></p>"},
                "position": _position(2, 0),
                "geometry": {"width": 360},
            },
        ),
        ProbeOperation(
            key="text_in_frame",
            item_type="text",
            method="POST",
            path="/boards/{board_id}/texts",
            payload={
                "data": {"content": "<p>REST child text inside frame</p>"},
                "position": {"x": 70, "y": 70},
                "geometry": {"width": 300},
                "parent": {"id": "$frame_main.id"},
            },
            depends_on=("frame_main",),
        ),
        ProbeOperation(
            key="shape_round_rect",
            item_type="shape",
            method="POST",
            path="/boards/{board_id}/shapes",
            payload={
                "data": {"content": "<p>REST shape probe</p>", "shape": "round_rectangle"},
                "position": _position(3, 0),
                "geometry": {"width": 260, "height": 120},
            },
        ),
        ProbeOperation(
            key="shape_anchor_a",
            item_type="shape",
            method="POST",
            path="/boards/{board_id}/shapes",
            payload={
                "data": {"content": "<p>REST connector anchor A</p>", "shape": "rectangle"},
                "position": _position(4, 0),
                "geometry": {"width": 220, "height": 100},
            },
        ),
        ProbeOperation(
            key="shape_anchor_b",
            item_type="shape",
            method="POST",
            path="/boards/{board_id}/shapes",
            payload={
                "data": {"content": "<p>REST connector anchor B</p>", "shape": "circle"},
                "position": _position(5, 0),
                "geometry": {"width": 140, "height": 140},
            },
        ),
        ProbeOperation(
            key="sticky_note",
            item_type="sticky_note",
            method="POST",
            path="/boards/{board_id}/sticky_notes",
            payload={
                "data": {"content": "REST sticky note probe"},
                "position": _position(0, 1),
                "geometry": {"width": 220},
            },
        ),
        ProbeOperation(
            key="sticky_rectangle",
            item_type="sticky_note",
            method="POST",
            path="/boards/{board_id}/sticky_notes",
            payload={
                "data": {"content": "REST rectangle sticky note probe", "shape": "rectangle"},
                "position": _position(1, 1),
                "geometry": {"width": 280},
                "style": {"fillColor": "light_blue"},
            },
        ),
        ProbeOperation(
            key="card_basic",
            item_type="card",
            method="POST",
            path="/boards/{board_id}/cards",
            payload={
                "data": {
                    "title": "REST card probe",
                    "description": "Card description should survive export.",
                },
                "position": _position(2, 1),
            },
        ),
        ProbeOperation(
            key="card_dates",
            item_type="card",
            method="POST",
            path="/boards/{board_id}/cards",
            payload={
                "data": {
                    "title": "REST secondary card",
                    "description": "Second card variant for REST export.",
                },
                "position": _position(3, 1),
            },
        ),
        ProbeOperation(
            key="app_card_basic",
            item_type="app_card",
            method="POST",
            path="/boards/{board_id}/app_cards",
            payload={
                "data": {
                    "title": "REST app card probe",
                    "description": "App card description should survive export.",
                },
                "position": _position(4, 1),
            },
        ),
        ProbeOperation(
            key="embed_youtube",
            item_type="embed",
            method="POST",
            path="/boards/{board_id}/embeds",
            payload={
                "data": {"url": PROBE_EMBED_URL},
                "position": _position(5, 1),
                "geometry": {"width": 480},
            },
        ),
        ProbeOperation(
            key="image_url",
            item_type="image",
            method="POST",
            path="/boards/{board_id}/images",
            payload={
                "data": {"url": PROBE_IMAGE_URL, "title": "REST image URL probe"},
                "position": _position(0, 2),
                "geometry": {"width": 420},
            },
        ),
        ProbeOperation(
            key="document_url",
            item_type="document",
            method="POST",
            path="/boards/{board_id}/documents",
            payload={
                "data": {"url": PROBE_DOCUMENT_URL, "title": "REST document URL probe"},
                "position": _position(1, 2),
            },
        ),
        ProbeOperation(
            key="connector_shape_to_sticky",
            item_type="connector",
            method="POST",
            path="/boards/{board_id}/connectors",
            payload={
                "startItem": {"id": "$shape_round_rect.id"},
                "endItem": {"id": "$sticky_note.id"},
                "shape": "elbowed",
            },
            depends_on=("shape_round_rect", "sticky_note"),
        ),
    ]

    for index, shape_type in enumerate(REST_SHAPE_TYPES):
        operations.append(
            ProbeOperation(
                key=f"shape_variant_{shape_type}",
                item_type="shape",
                method="POST",
                path="/boards/{board_id}/shapes",
                payload={
                    "data": {"content": f"<p>{shape_type}</p>", "shape": shape_type},
                    "position": _grid_position(index, origin_x=-1440, origin_y=520, columns=7, gap_x=280, gap_y=180),
                    "geometry": {"width": 220, "height": 120},
                    "style": {
                        "fillColor": "#D6EFFF" if index % 2 else "#FBE983",
                        "borderColor": "#4262ff",
                        "borderWidth": "2",
                        "textAlign": "center",
                        "textAlignVertical": "middle",
                    },
                },
            )
        )

    for index, color in enumerate(REST_STICKY_COLORS):
        operations.append(
            ProbeOperation(
                key=f"sticky_color_{color}",
                item_type="sticky_note",
                method="POST",
                path="/boards/{board_id}/sticky_notes",
                payload={
                    "data": {
                        "content": f"REST sticky {color}",
                        "shape": "square" if index % 2 == 0 else "rectangle",
                    },
                    "position": _grid_position(index, origin_x=-1440, origin_y=1160, columns=8, gap_x=260, gap_y=210),
                    "geometry": {"width": 180 if index % 2 == 0 else 240},
                    "style": {"fillColor": color, "textAlign": "center", "textAlignVertical": "middle"},
                },
            )
        )

    for index, color in enumerate(REST_TAG_COLORS):
        operations.append(
            ProbeOperation(
                key=f"tag_color_{color}",
                item_type="tag",
                method="POST",
                path="/boards/{board_id}/tags",
                payload={"title": f"miro2obsidian-rest-{color}", "fillColor": color},
            )
        )

    for index, connector_shape in enumerate(REST_CONNECTOR_SHAPES):
        operations.append(
            ProbeOperation(
                key=f"connector_{connector_shape}",
                item_type="connector",
                method="POST",
                path="/boards/{board_id}/connectors",
                payload={
                    "startItem": {"id": "$shape_anchor_a.id"},
                    "endItem": {"id": "$shape_anchor_b.id"},
                    "shape": connector_shape,
                    "captions": [{"content": f"{connector_shape} REST connector", "position": "50%"}],
                    "style": {
                        "startStrokeCap": REST_CONNECTOR_CAPS[index],
                        "endStrokeCap": REST_CONNECTOR_CAPS[index + 1],
                        "strokeStyle": "normal" if index == 0 else "dashed",
                        "strokeColor": "#4262ff",
                        "strokeWidth": str(2 + index),
                    },
                },
                depends_on=("shape_anchor_a", "shape_anchor_b"),
            )
        )

    for index, cap in enumerate(REST_CONNECTOR_CAPS):
        operations.append(
            ProbeOperation(
                key=f"connector_cap_{cap}",
                item_type="connector",
                method="POST",
                path="/boards/{board_id}/connectors",
                payload={
                    "startItem": {"id": "$shape_anchor_a.id"},
                    "endItem": {"id": "$shape_anchor_b.id"},
                    "shape": "curved",
                    "style": {
                        "startStrokeCap": cap,
                        "endStrokeCap": cap,
                        "strokeStyle": "normal" if index % 2 == 0 else "dashed",
                        "strokeColor": "#555555",
                        "strokeWidth": "1",
                    },
                },
                depends_on=("shape_anchor_a", "shape_anchor_b"),
            )
        )

    return operations


def build_manifest(board_name: str = DEFAULT_BOARD_NAME) -> dict[str, Any]:
    return {
        "schema_version": 1,
        "kind": "miro_rest_capability_probe",
        "board": {
            "name": board_name,
            "description": (
                "Generated by scripts/miro_rest_probe_board.py for Miro -> Obsidian source coverage tests. "
                "This is the maximum generated REST fixture; unsupported variants are recorded as failures."
            ),
        },
        "operations": [asdict(operation) for operation in build_probe_operations()],
    }


def resolve_placeholders(value: Any, results: dict[str, dict[str, Any]]) -> Any:
    if isinstance(value, str) and value.startswith("$"):
        parts = value[1:].split(".")
        if len(parts) != 2:
            return value
        result_key, field = parts
        if result_key not in results:
            raise KeyError(f"Missing dependency result for placeholder {value!r}")
        return results[result_key][field]
    if isinstance(value, list):
        return [resolve_placeholders(item, results) for item in value]
    if isinstance(value, dict):
        return {key: resolve_placeholders(item, results) for key, item in value.items()}
    return value


def planned_requests(manifest: dict[str, Any], board_id: str, base_url: str = DEFAULT_BASE_URL) -> list[dict[str, Any]]:
    requests: list[dict[str, Any]] = []
    for operation in manifest.get("operations", []):
        path = str(operation["path"]).format(board_id=board_id)
        requests.append(
            {
                "key": operation["key"],
                "item_type": operation["item_type"],
                "method": operation["method"],
                "url": base_url.rstrip("/") + path,
                "payload": deepcopy(operation["payload"]),
                "depends_on": list(operation.get("depends_on") or []),
            }
        )
    return requests


def _response_body(response: Any) -> str:
    try:
        return json.dumps(response.json(), ensure_ascii=False)
    except ValueError:
        return str(getattr(response, "text", ""))


def _post_json(session: Any, url: str, token: str, payload: dict[str, Any]) -> dict[str, Any]:
    response = session.post(
        url,
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        json=payload,
        timeout=30,
    )
    if not getattr(response, "ok", False):
        status_code = getattr(response, "status_code", "unknown")
        body = _response_body(response)
        raise MiroRestRequestError(
            f"Miro REST request failed with HTTP {status_code}: {body}",
            status_code=status_code,
            response_body=body,
        )
    return response.json()


def execute_manifest(
    manifest: dict[str, Any],
    token: str,
    *,
    board_id: str | None = None,
    base_url: str = DEFAULT_BASE_URL,
    session: Any | None = None,
    stop_on_error: bool = False,
) -> dict[str, Any]:
    if session is None:
        import requests

        session = requests.Session()

    results: dict[str, dict[str, Any]] = {}
    failures: list[dict[str, Any]] = []
    created_board = None
    if not board_id:
        created_board = _post_json(session, base_url.rstrip("/") + "/boards", token, manifest["board"])
        board_id = str(created_board["id"])

    for request in planned_requests(manifest, board_id, base_url=base_url):
        missing_dependencies = [key for key in request["depends_on"] if key not in results]
        if missing_dependencies:
            failures.append(
                {
                    "key": request["key"],
                    "item_type": request["item_type"],
                    "method": request["method"],
                    "url": request["url"],
                    "payload": request["payload"],
                    "status_code": "skipped",
                    "response_body": f"Missing dependency result(s): {', '.join(missing_dependencies)}",
                }
            )
            if stop_on_error:
                break
            continue

        payload = resolve_placeholders(request["payload"], results)
        try:
            results[request["key"]] = _post_json(session, request["url"], token, payload)
        except MiroRestRequestError as exc:
            failures.append(
                {
                    "key": request["key"],
                    "item_type": request["item_type"],
                    "method": request["method"],
                    "url": request["url"],
                    "payload": payload,
                    "status_code": exc.status_code,
                    "response_body": exc.response_body,
                }
            )
            if stop_on_error:
                break

    output: dict[str, Any] = {
        "ok": not failures,
        "board_id": board_id,
        "created_board": created_board,
        "items": results,
        "failures": failures,
        "summary": {
            "planned": len(manifest.get("operations", [])),
            "created": len(results),
            "failed": sum(1 for failure in failures if failure.get("status_code") != "skipped"),
            "skipped": sum(1 for failure in failures if failure.get("status_code") == "skipped"),
            "created_by_type": {},
            "failed_by_type": {},
        },
    }
    for operation in manifest.get("operations", []):
        key = operation.get("key")
        if key in results:
            item_type = str(operation.get("item_type"))
            output["summary"]["created_by_type"][item_type] = output["summary"]["created_by_type"].get(item_type, 0) + 1
    for failure in failures:
        item_type = str(failure.get("item_type"))
        output["summary"]["failed_by_type"][item_type] = output["summary"]["failed_by_type"].get(item_type, 0) + 1

    if failures:
        output["failed_request"] = failures[0]
    return output


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Create or print a REST capability-probe Miro board manifest.")
    parser.add_argument("--board-name", default=DEFAULT_BOARD_NAME)
    parser.add_argument("--board-id", help="Existing board id. If omitted with --execute, the script creates a board.")
    parser.add_argument("--execute", action="store_true", help="Actually call the Miro REST API. Default is dry-run.")
    parser.add_argument("--stop-on-error", action="store_true", help="Stop at the first REST item failure.")
    parser.add_argument(
        "--strict-failures",
        action="store_true",
        help="Return exit code 1 when item-level REST failures are recorded.",
    )
    parser.add_argument("--token-env", default="MIRO_ACCESS_TOKEN", help="Environment variable containing a Miro token.")
    parser.add_argument("--oauth", action="store_true", help="Run local OAuth flow instead of reading --token-env.")
    parser.add_argument("--oauth-client-id-env", default="MIRO_CLIENT_ID")
    parser.add_argument("--oauth-client-secret-env", default="MIRO_CLIENT_SECRET")
    parser.add_argument("--oauth-redirect-uri", default=DEFAULT_REDIRECT_URI)
    parser.add_argument("--oauth-scopes", default="boards:read boards:write team:read")
    parser.add_argument("--oauth-authorize-url", default=DEFAULT_AUTHORIZE_URL)
    parser.add_argument("--oauth-token-url", default="https://api.miro.com/v1/oauth/token")
    parser.add_argument("--oauth-timeout-seconds", type=int, default=300)
    parser.add_argument("--oauth-browser", default=DEFAULT_BROWSER, help="Browser to open for OAuth. Default: yandex.")
    parser.add_argument("--oauth-no-open-browser", action="store_true")
    parser.add_argument("--oauth-code", help="Exchange an already obtained authorization code.")
    parser.add_argument("--oauth-callback-url", help="Exchange a copied localhost callback URL containing ?code=...")
    parser.add_argument("--base-url", default=DEFAULT_BASE_URL)
    parser.add_argument("--output", type=Path, help="Write manifest/result JSON to this path.")
    return parser.parse_args()


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
            return exchange_manual_authorization(
                config,
                code=args.oauth_code,
                callback_url=args.oauth_callback_url,
            )
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


def main() -> int:
    args = parse_args()
    manifest = build_manifest(args.board_name)
    if args.execute:
        try:
            token = resolve_token_from_args(args)
        except (TimeoutError, RuntimeError) as exc:
            raise SystemExit(str(exc)) from exc
        output = execute_manifest(
            manifest,
            token,
            board_id=args.board_id,
            base_url=args.base_url,
            stop_on_error=args.stop_on_error,
        )
    else:
        output = manifest

    text = json.dumps(output, ensure_ascii=False, indent=2)
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(text + "\n", encoding="utf-8")
    else:
        print(text)
    if isinstance(output, dict) and output.get("ok") is False:
        failed = output.get("failed_request") or {}
        print(f"failed_request={failed.get('key')} status={failed.get('status_code')}")
        if args.strict_failures:
            return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
