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

from miro_downloader import (  # noqa: E402
    _dedupe_miro_items,
    add_browser_links,
    download_all,
    download_resource_with_redirect,
    get_items_on_board,
)
from miro_oauth_token import DEFAULT_BROWSER, DEFAULT_REDIRECT_URI  # noqa: E402
from utils import compute_target_filename, make_unique_in_batch  # noqa: E402


IMAGE_URL_KEYS = ("imageUrl", "url", "downloadUrl", "previewUrl", "thumbnailUrl")
DOCUMENT_URL_KEYS = ("documentUrl", "url", "downloadUrl")
EMBED_PREVIEW_URL_KEYS = ("previewUrl", "thumbnailUrl", "imageUrl")
IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".svg"}


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


def _asset_dir_for_output(output_path: Path) -> Path:
    return output_path.with_name(f"{output_path.stem}_files")


class _ImmediateCallbackTarget:
    def after(self, _delay_ms: int, callback: Any) -> None:
        callback()


def _id_to_final_paths(
    resources: list[dict[str, Any]],
    *,
    attachments_dir: Path,
    safe_board: str,
    is_image: bool,
) -> dict[str, Path]:
    wanted = [
        attachments_dir / compute_target_filename(
            item,
            "rest",
            safe_board,
            rename_files=True,
            is_image=is_image,
        )
        for item in resources
    ]
    final_paths = make_unique_in_batch(wanted)
    return {
        str(item["id"]): path
        for item, path in zip(resources, final_paths)
        if item.get("id") is not None
    }


def _first_data_url(item: dict[str, Any], keys: tuple[str, ...]) -> str:
    data = item.get("data") if isinstance(item.get("data"), dict) else {}
    for key in keys:
        value = str(data.get(key) or "").strip()
        if value:
            return value
    return ""


def _ensure_data_url(item: dict[str, Any], canonical_key: str, keys: tuple[str, ...]) -> bool:
    data = item.setdefault("data", {})
    if not isinstance(data, dict):
        data = {}
        item["data"] = data
    value = _first_data_url(item, (canonical_key,))
    if value:
        return True
    value = _first_data_url(item, keys)
    if not value:
        return False
    data[canonical_key] = value
    return True


def _is_doc_format_slot_image(item: dict[str, Any]) -> bool:
    position = item.get("position") if isinstance(item.get("position"), dict) else {}
    if position.get("slotId"):
        return True

    parent = item.get("parent") if isinstance(item.get("parent"), dict) else {}
    links = parent.get("links") if isinstance(parent.get("links"), dict) else {}
    return "/doc_formats/" in str(links.get("self") or "")


def _norm_url_without_format(raw_url: str) -> str | None:
    if not raw_url:
        return None
    from urllib.parse import urlsplit

    url = raw_url.split("?format")[0]
    parts = urlsplit(url)
    if not parts.scheme or not parts.netloc:
        return None
    return f"{parts.scheme}://{parts.netloc}{parts.path}"


def _build_image_maps(
    images: list[dict[str, Any]],
    attachments_dir: Path,
) -> tuple[dict[str, Path], dict[str, dict[str, Path]], dict[str, Path]]:
    image_src_map: dict[str, Path] = {}
    slot_map: dict[str, dict[str, Path]] = {}
    image_id_map: dict[str, Path] = {}

    for item in images:
        local_name = item.get("local_name")
        if not local_name:
            continue
        local_path = attachments_dir / str(local_name)
        image_url = str((item.get("data") or {}).get("imageUrl") or "")

        key = _norm_url_without_format(image_url)
        if key:
            image_src_map[key] = local_path

        parent = item.get("parent") if isinstance(item.get("parent"), dict) else {}
        position = item.get("position") if isinstance(item.get("position"), dict) else {}
        parent_id = parent.get("id")
        slot_id = position.get("slotId")
        if parent_id and slot_id:
            slot_map.setdefault(str(parent_id), {})[str(slot_id)] = local_path

        import re

        match = re.search(r"/images/(\d+)(?:[/?]|$)", image_url, flags=re.IGNORECASE)
        if match:
            image_id_map[match.group(1)] = local_path

    return image_src_map, slot_map, image_id_map


def _validate_downloaded_assets(
    resources: list[dict[str, Any]],
    *,
    attachments_dir: Path,
) -> list[str]:
    missing: list[str] = []
    for item in resources:
        if item.get("type") == "image" and _is_doc_format_slot_image(item):
            continue
        item_id = str(item.get("id") or "<missing-id>")
        local_name = str(item.get("local_name") or "")
        if not local_name:
            missing.append(f"{item_id}: missing local_name")
            continue
        if not (attachments_dir / local_name).is_file():
            missing.append(f"{item_id}: missing file {local_name}")
    return missing


def download_export_assets(
    items: list[dict[str, Any]],
    *,
    output_path: Path,
    token: str,
    logger: Any | None = None,
    strict: bool = True,
) -> dict[str, int]:
    attachments_dir = _asset_dir_for_output(output_path)
    attachments_dir.mkdir(parents=True, exist_ok=True)
    safe_board = output_path.stem

    images = [
        item for item in items
        if item.get("type") == "image" and _ensure_data_url(item, "imageUrl", IMAGE_URL_KEYS)
    ]
    documents = [
        item for item in items
        if item.get("type") == "document" and _ensure_data_url(item, "documentUrl", DOCUMENT_URL_KEYS)
    ]
    doc_formats = [
        item for item in items
        if item.get("type") == "doc_format" and (item.get("data") or {}).get("html")
    ]
    embeds = [
        item for item in items
        if item.get("type") == "embed" and _ensure_data_url(item, "previewUrl", EMBED_PREVIEW_URL_KEYS)
    ]

    failed = 0

    def on_fail(item_id: str, reason: str) -> None:
        nonlocal failed
        failed += 1
        if logger:
            logger(f"asset_failed id={item_id} reason={reason}")

    def on_optional_fail(item_id: str, reason: str) -> None:
        if logger:
            logger(f"asset_optional_failed id={item_id} reason={reason}")

    if images:
        download_all(
            images,
            attachments_dir,
            token,
            "rest",
            safe_board,
            is_image=True,
            strategy="overwrite",
            id_to_final_path=_id_to_final_paths(
                images,
                attachments_dir=attachments_dir,
                safe_board=safe_board,
                is_image=True,
            ),
            gui_root=_ImmediateCallbackTarget(),
            on_file_fail=on_fail,
        )

    image_src_map, slot_map, image_id_map = _build_image_maps(images, attachments_dir)

    if documents:
        download_all(
            documents,
            attachments_dir,
            token,
            "rest",
            safe_board,
            is_image=False,
            strategy="overwrite",
            id_to_final_path=_id_to_final_paths(
                documents,
                attachments_dir=attachments_dir,
                safe_board=safe_board,
                is_image=False,
            ),
            gui_root=_ImmediateCallbackTarget(),
            on_file_fail=on_fail,
        )

    if doc_formats:
        download_all(
            doc_formats,
            attachments_dir,
            token,
            "rest",
            safe_board,
            is_image=False,
            strategy="overwrite",
            id_to_final_path=_id_to_final_paths(
                doc_formats,
                attachments_dir=attachments_dir,
                safe_board=safe_board,
                is_image=False,
            ),
            inline_slot_map=slot_map,
            inline_image_url_map=image_src_map,
            inline_image_id_map=image_id_map,
            gui_root=_ImmediateCallbackTarget(),
            on_file_fail=on_fail,
        )

    embed_paths = _id_to_final_paths(
        embeds,
        attachments_dir=attachments_dir,
        safe_board=safe_board,
        is_image=True,
    )
    for item in embeds:
        item_id = str(item.get("id") or "")
        preview_url = str((item.get("data") or {}).get("previewUrl") or "")
        final_path = embed_paths.get(item_id)
        if not final_path or not preview_url:
            continue
        got_path = download_resource_with_redirect(
            preview_url,
            final_path,
            token,
            overwrite_when_guessing_ext=True,
        )
        if got_path and got_path.suffix.lower() in IMAGE_EXTS:
            item["local_name"] = got_path.name
        else:
            if got_path:
                try:
                    got_path.unlink(missing_ok=True)
                except OSError:
                    pass
            on_optional_fail(item_id, "embed preview download failed or was not an image")

    required_resources = images + documents + doc_formats
    missing_assets = _validate_downloaded_assets(required_resources, attachments_dir=attachments_dir)
    if missing_assets:
        failed += len(missing_assets)
        for reason in missing_assets:
            if logger:
                logger(f"asset_missing {reason}")
        if strict:
            shown = "; ".join(missing_assets[:5])
            more = "" if len(missing_assets) <= 5 else f"; +{len(missing_assets) - 5} more"
            raise RuntimeError(f"Asset download incomplete: {shown}{more}")

    stats = {
        "images": len(images),
        "documents": len(documents),
        "doc_formats": len(doc_formats),
        "embeds": len(embeds),
        "failed": failed,
    }
    if logger:
        logger(
            "assets="
            f"images:{stats['images']} documents:{stats['documents']} "
            f"doc_formats:{stats['doc_formats']} embeds:{stats['embeds']} "
            f"failed:{stats['failed']}"
        )
    return stats


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
    parser.add_argument("--no-download-assets", action="store_true", help="Write JSON only; do not create the sidecar _files folder.")
    parser.add_argument(
        "--allow-missing-assets",
        action="store_true",
        help="Keep writing JSON if a downloadable attachment fails; converter may fall back to links.",
    )
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
    if not args.no_download_assets:
        download_export_assets(
            items,
            output_path=args.output,
            token=token,
            logger=messages.append,
            strict=not args.allow_missing_assets,
        )
    write_json(args.output, items)
    print(f"items={len(items)}")
    print(f"output={args.output}")
    for message in messages[-5:]:
        print(f"log={message}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
