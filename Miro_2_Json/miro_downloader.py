# miro_downloader
import base64
import html as html_lib
import ipaddress
import json
import math
import mimetypes
import os
import re
import socket
import tempfile
import time
from collections import Counter
from copy import deepcopy
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path
from threading import Lock
from typing import Callable, Optional
from urllib.parse import unquote, urljoin, urlsplit, urlunsplit, parse_qsl, urlencode

import requests
from ratelimit import rate_limited
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

from utils import (
    add_extension_unique,
    ensure_unique_filename,
    extract_doc_format_title,
)


MAX_WORKERS = 8  # Количество одновременных загрузок

DEBUG = False
MAX_RETRY_DELAY_SECONDS = 60.0


def _retry_delay_seconds(retry_after: str | None, fallback: float) -> float:
    delay: float | None = None
    if retry_after:
        try:
            delay = float(retry_after)
        except (TypeError, ValueError):
            try:
                retry_at = parsedate_to_datetime(retry_after)
                if retry_at.tzinfo is None:
                    retry_at = retry_at.replace(tzinfo=timezone.utc)
                delay = (retry_at - datetime.now(timezone.utc)).total_seconds()
            except (TypeError, ValueError, OverflowError):
                delay = None
    if delay is None or not math.isfinite(delay) or delay < 0:
        delay = float(fallback)
    if not math.isfinite(delay) or delay < 0:
        delay = 0.0
    return min(delay, MAX_RETRY_DELAY_SECONDS)


def _with_image_params(raw_url: str, *, fmt: str) -> str | None:
    """Собирает URL с format=<fmt> и redirect=true, не ломая остальные параметры."""
    if not raw_url:
        return None
    u = urlsplit(raw_url)
    q = dict(parse_qsl(u.query, keep_blank_values=True))
    q["format"] = fmt  # "original" или "preview"
    q["redirect"] = "true"
    return urlunsplit((u.scheme, u.netloc, u.path, urlencode(q), u.fragment))


def _is_path_within(path: Path, root: Path) -> bool:
    try:
        path.resolve().relative_to(root.resolve())
        return True
    except (OSError, ValueError):
        return False


def _file_uri_to_path(src: str) -> Path | None:
    normalized = html_lib.unescape(src).strip().replace("\\", "/")
    parsed = urlsplit(normalized)
    if parsed.scheme.lower() != "file":
        return None
    if parsed.netloc and parsed.netloc.lower() != "localhost":
        return None
    path_str = unquote(parsed.path or "")
    if os.name == "nt" and re.match(r"^/[A-Za-z]:/", path_str):
        path_str = path_str[1:]
    return Path(path_str) if path_str else None


def _file_to_data_uri(p: Path, *, allowed_root: Path) -> str | None:
    try:
        if not p or not _is_path_within(p, allowed_root) or not p.is_file():
            return None
        mime, _ = mimetypes.guess_type(p.name)
        if not mime:
            mime = "application/octet-stream"
        b64 = base64.b64encode(p.read_bytes()).decode("ascii")
        return f"data:{mime};base64,{b64}"
    except Exception:
        return None


def _resource_url_is_allowed(resource_url: str, *, allowed_root: Path) -> bool:
    parsed = urlsplit(html_lib.unescape(resource_url).strip())
    scheme = parsed.scheme.lower()
    if scheme in {"data", "about"}:
        return True
    if scheme != "file":
        return False
    path = _file_uri_to_path(resource_url)
    return bool(path and _is_path_within(path, allowed_root))


def _download_url_is_allowed(resource_url: str) -> bool:
    try:
        parsed = urlsplit(resource_url)
        host = (parsed.hostname or "").lower().rstrip(".")
        port = parsed.port or 443
    except ValueError:
        return False
    if (
        parsed.scheme.lower() != "https"
        or not host
        or parsed.username
        or parsed.password
    ):
        return False
    if host == "localhost" or host.endswith((".localhost", ".local")):
        return False
    try:
        addresses = {ipaddress.ip_address(host)}
    except ValueError:
        try:
            addresses = {
                ipaddress.ip_address(sockaddr[0])
                for _family, _type, _proto, _canonname, sockaddr in socket.getaddrinfo(
                    host,
                    port,
                    type=socket.SOCK_STREAM,
                )
            }
        except (OSError, ValueError):
            return False
    return bool(addresses) and all(address.is_global for address in addresses)


def _miro_api_url_is_allowed(resource_url: str) -> bool:
    try:
        parsed = urlsplit(resource_url)
        port = parsed.port
    except ValueError:
        return False
    return bool(
        parsed.scheme.lower() == "https"
        and (parsed.hostname or "").lower() == "api.miro.com"
        and port in (None, 443)
        and not parsed.username
        and not parsed.password
    )


EMBED_RE = re.compile(
    r'<embed\b[^>]*\bdata-slot-id\s*=\s*["\']([^"\']+)["\'][^>]*>', flags=re.IGNORECASE
)


def _rewrite_embeds_to_imgs_by_slot(
    html: str,
    slots: dict[str, Path] | None,
    *,
    allowed_root: Path,
) -> str:
    if not slots:
        return html

    def repl(m):
        slot = m.group(1)
        p = slots.get(str(slot))
        if not p or not p.exists():
            # не знаем картинку — просто уберём плейсхолдер
            return ""
        data_uri = _file_to_data_uri(p, allowed_root=allowed_root)
        if not data_uri:
            return ""
        # alt = реальное имя файла, NOT slotId
        alt = p.name
        return f'<img src="{data_uri}" alt="{alt}"/>'

    return EMBED_RE.sub(repl, html)


def _inline_local_img_files(html: str, *, allowed_root: Path) -> str:
    def repl(m):
        src = m.group(1)
        if urlsplit(html_lib.unescape(src).strip()).scheme.lower() != "file":
            return m.group(0)
        p = _file_uri_to_path(src)
        if p:
            du = _file_to_data_uri(p, allowed_root=allowed_root)
            if du:
                return f'src="{du}"'
        return 'src=""'

    return re.sub(r'src\s*=\s*["\']([^"\']+)["\']', repl, html, flags=re.IGNORECASE)


IMG_ID_RE = re.compile(r"/images/(\d+)(?:[/?]|$)", re.IGNORECASE)


def _rewrite_img_src_to_local(html: str, mp: dict[str, Path]) -> str:
    if not mp:
        return html

    def repl(m):
        src = m.group(1)
        key = _norm_url(src)
        p = mp.get(key)
        if p and p.exists():
            return f'src="{p.resolve().as_uri()}"'
        return m.group(0)

    return re.sub(r'src\s*=\s*["\']([^"\']+)["\']', repl, html, flags=re.IGNORECASE)


def _rewrite_img_src_by_id(html: str, id_map: dict[str, Path]) -> str:
    if not id_map:
        return html

    def repl(m):
        src = m.group(1)
        m2 = IMG_ID_RE.search(src)
        if not m2:
            return m.group(0)
        img_id = m2.group(1)
        p = id_map.get(img_id)
        if not p or not p.exists():
            return m.group(0)
        # корректный URI
        return f'src="{p.resolve().as_uri()}"'

    return re.sub(r'src\s*=\s*["\']([^"\']+)["\']', repl, html, flags=re.IGNORECASE)


def _norm_url(u: str) -> str:
    # приводим к базовому виду как при скачивании: без query/format
    if not u:
        return ""
    u = u.split("?")[0]
    parts = urlsplit(u)
    return f"{parts.scheme}://{parts.netloc}{parts.path}"


def _dedupe_miro_items(items: list[dict]) -> list[dict]:
    """Merge duplicate endpoint records without discarding source fields."""

    def score(item: dict) -> int:
        item_type = item.get("type")
        source = str(item.get("source") or "")
        if item_type == "document":
            if source.startswith("documents"):
                return 30
            if "items(v2-experimental)" in source:
                return 20
            if "items(v2)" in source:
                return 10
        if item_type == "image":
            if "items(v2-experimental)" in source:
                return 30
            if "items(v2)" in source:
                return 20
        return 0

    def fill_missing(target: dict, source: dict) -> None:
        for key, value in source.items():
            if key not in target or target[key] in (None, "", [], {}):
                target[key] = deepcopy(value)
            elif isinstance(target[key], dict) and isinstance(value, dict):
                fill_missing(target[key], value)

    order: list[tuple[str, str]] = []
    grouped: dict[tuple[str, str], list[dict]] = {}
    for index, item in enumerate(items):
        item_id = item.get("id")
        key = (
            ("__missing_id__", str(index))
            if item_id in (None, "")
            else (str(item.get("type") or ""), str(item_id))
        )
        if key not in grouped:
            order.append(key)
            grouped[key] = []
        grouped[key].append(item)

    merged: list[dict] = []
    for key in order:
        variants = grouped[key]
        best_index = max(
            range(len(variants)), key=lambda index: (score(variants[index]), -index)
        )
        canonical = deepcopy(variants[best_index])
        for variant in variants:
            fill_missing(canonical, variant)

        surfaces = list(canonical.get("source_surfaces") or [])
        for variant in variants:
            source = str(variant.get("source") or "").strip()
            if source and source not in surfaces:
                surfaces.append(source)
        if surfaces:
            canonical["source_surfaces"] = surfaces
        if len(variants) > 1:
            canonical["source_provenance"] = {
                "merge_strategy": "highest_fidelity_then_fill_missing",
                "original_items": deepcopy(variants),
            }
        merged.append(canonical)
    return merged


def dbg(*args):
    if DEBUG:
        print("[DBG]", *args)


def _temporary_path(destination: Path, suffix: str) -> Path:
    destination.parent.mkdir(parents=True, exist_ok=True)
    descriptor, name = tempfile.mkstemp(
        prefix=f".{destination.name}.", suffix=suffix, dir=destination.parent
    )
    os.close(descriptor)
    return Path(name)


def _reject_nonfinite_json_constant(value: str) -> None:
    raise ValueError(f"Non-finite JSON value is not supported: {value}")


def write_json(filename: Path, data: list[dict]) -> None:
    """Atomically save JSON and surface every write failure."""
    temporary = _temporary_path(filename, ".tmp")
    try:
        with temporary.open("w", encoding="utf-8") as file:
            json.dump(data, file, ensure_ascii=False, indent=4, allow_nan=False)
        temporary.replace(filename)
    finally:
        temporary.unlink(missing_ok=True)
    print(f"💾 JSON сохранён: {filename}")


def read_json(file_path: Path) -> list[dict]:
    with open(file_path, encoding="utf-8-sig") as file:
        return json.load(file, parse_constant=_reject_nonfinite_json_constant)


def get_file_extension(content_type: str) -> str:
    return mimetypes.guess_extension(content_type) or ""


_TEXTUAL_ASSET_SUFFIXES = {
    ".csv",
    ".htm",
    ".html",
    ".json",
    ".md",
    ".svg",
    ".txt",
    ".xml",
}
_IMAGE_MEDIA_TYPES = {
    "image/avif",
    "image/bmp",
    "image/gif",
    "image/heic",
    "image/heif",
    "image/jpeg",
    "image/png",
    "image/svg+xml",
    "image/tiff",
    "image/vnd.microsoft.icon",
    "image/webp",
}


def _looks_like_image(prefix: bytes) -> bool:
    lower = prefix.lstrip().lower()
    return bool(
        prefix.startswith(
            (b"\x89PNG\r\n\x1a\n", b"\xff\xd8\xff", b"GIF87a", b"GIF89a", b"BM")
        )
        or prefix.startswith((b"II*\x00", b"MM\x00*", b"\x00\x00\x01\x00"))
        or (prefix.startswith(b"RIFF") and prefix[8:12] == b"WEBP")
        or (
            len(prefix) >= 12
            and prefix[4:8] == b"ftyp"
            and prefix[8:12]
            in {b"avif", b"avis", b"heic", b"heix", b"hevc", b"hevx", b"mif1", b"msf1"}
        )
        or (lower.startswith((b"<svg", b"<?xml")) and b"<svg" in lower[:1024])
    )


def downloaded_file_error(
    path: Path,
    *,
    content_type: str = "",
    expected_path: Path | None = None,
    expected_kind: str = "",
    expected_size: int | None = None,
) -> str | None:
    """Return why a downloaded file is unusable for its declared resource kind."""
    try:
        if not path.is_file():
            return "downloaded path is not a regular file"
        size = path.stat().st_size
        if size == 0:
            return "downloaded file is empty"
        if expected_size is not None and size != expected_size:
            return (
                f"downloaded file size mismatch: expected {expected_size}, got {size}"
            )
        with path.open("rb") as file:
            raw_prefix = file.read(4096)
        prefix = raw_prefix.lstrip().lower()
    except OSError as exc:
        return f"downloaded file cannot be inspected: {exc}"

    suffix = (expected_path or path).suffix.lower()
    media_type = content_type.split(";", 1)[0].strip().lower()
    if expected_kind == "image":
        if media_type and media_type not in _IMAGE_MEDIA_TYPES:
            return f"unexpected image content type: {media_type}"
        if not _looks_like_image(raw_prefix):
            return "downloaded file does not have a supported image signature"
        return None
    if suffix in _TEXTUAL_ASSET_SUFFIXES:
        return None
    if media_type in {
        "text/html",
        "text/plain",
        "application/json",
        "application/problem+json",
    }:
        return f"unexpected error response content type: {media_type}"
    if prefix.startswith((b"<!doctype html", b"<html", b"<head", b"<body")):
        return "downloaded file contains an HTML response"
    if prefix.startswith((b"{", b"[")) and (
        b'"error"' in prefix or b'"message"' in prefix
    ):
        return "downloaded file contains a JSON error response"
    return None


def _get_with_retry(
    url: str, *, headers: dict[str, str], timeout: int = 30, max_retries: int = 3
):
    for attempt in range(max_retries + 1):
        response = requests.get(url, headers=headers, timeout=timeout)
        if (
            response.status_code not in (429, 500, 502, 503, 504)
            or attempt >= max_retries
        ):
            return response
        delay = _retry_delay_seconds(
            response.headers.get("Retry-After"), 0.5 * (2**attempt)
        )
        time.sleep(delay)
    raise RuntimeError("unreachable retry loop")


def get_boards(token: str) -> list[dict]:
    """Download every board page while retaining the complete board payload."""
    headers = {"Authorization": f"Bearer {token}"}
    url = "https://api.miro.com/v2/boards?limit=50"
    boards_data: list[dict] = []
    board_ids: set[str] = set()
    seen_urls: set[str] = set()
    expected_total: int | None = None

    while url:
        if url in seen_urls:
            raise RuntimeError("Board pagination repeated the same URL.")
        if not _miro_api_url_is_allowed(url):
            raise RuntimeError("Board pagination links.next left api.miro.com.")
        seen_urls.add(url)

        captured_before = len(boards_data)
        query = dict(parse_qsl(urlsplit(url).query, keep_blank_values=True))
        requested_offset_raw = query.get("offset", str(captured_before))
        try:
            requested_offset = int(requested_offset_raw)
        except (TypeError, ValueError) as exc:
            raise RuntimeError(
                "Board pagination request has malformed offset metadata."
            ) from exc
        if requested_offset < 0:
            raise RuntimeError(
                "Board pagination request has malformed offset metadata."
            )

        response = _get_with_retry(url, headers=headers)
        response.raise_for_status()
        payload = response.json()
        if not isinstance(payload, dict) or not isinstance(payload.get("data"), list):
            raise RuntimeError("Board pagination returned malformed data.")
        for raw_board in payload["data"]:
            if not isinstance(raw_board, dict):
                raise RuntimeError(
                    "Board pagination returned a non-object board record."
                )
            board = dict(raw_board)
            board.setdefault("team", {})
            board_id = str(board.get("id") or "").strip()
            if not board_id:
                raise RuntimeError("Board pagination returned a board without id.")
            if board_id in board_ids:
                raise RuntimeError(
                    f"Board pagination returned duplicate board id: {board_id}"
                )
            board_ids.add(board_id)
            boards_data.append(board)

        batch_count = len(payload["data"])
        size = payload.get("size")
        if size is not None and (
            isinstance(size, bool) or not isinstance(size, int) or size != batch_count
        ):
            raise RuntimeError("Board pagination size does not match returned data.")
        response_offset = payload.get("offset")
        if response_offset is not None:
            if (
                isinstance(response_offset, bool)
                or not isinstance(response_offset, int)
                or response_offset < 0
            ):
                raise RuntimeError(
                    "Board pagination returned malformed offset metadata."
                )
            if response_offset != requested_offset:
                raise RuntimeError(
                    "Board pagination response offset does not match the request."
                )
        total = payload.get("total")
        if total is not None:
            if isinstance(total, bool) or not isinstance(total, int) or total < 0:
                raise RuntimeError(
                    "Board pagination returned malformed total metadata."
                )
            if expected_total is None:
                expected_total = total
            elif total != expected_total:
                raise RuntimeError("Board pagination total changed between pages.")

        links = payload.get("links") if isinstance(payload.get("links"), dict) else {}
        next_url = str(links.get("next") or "").strip()
        if next_url:
            if batch_count == 0:
                raise RuntimeError(
                    "Board pagination made no progress before links.next."
                )
            url = urljoin(url, next_url)
        elif (
            expected_total is not None
            and expected_total > requested_offset + batch_count
        ):
            if batch_count <= 0:
                raise RuntimeError(
                    "Board pagination made no progress before reaching total."
                )
            query["offset"] = str(requested_offset + batch_count)
            parsed = urlsplit(url)
            url = urlunsplit(
                (
                    parsed.scheme,
                    parsed.netloc,
                    parsed.path,
                    urlencode(query),
                    parsed.fragment,
                )
            )
        else:
            url = ""
        if url:
            time.sleep(0.2)

    if expected_total is not None and len(boards_data) != expected_total:
        raise RuntimeError(
            f"Board pagination captured {len(boards_data)} boards but declared total is {expected_total}."
        )
    return boards_data


def get_items_on_board(
    board_id: str,
    token: str,
    logger: Optional[Callable[[str], None]] = None,
    prefer_experimental_items: bool = True,
    confirm_skip_source: Optional[Callable[[str, int, str], bool]] = None,
    confirm_exp_fallback: Optional[Callable[[int], bool]] = None,
    metadata: dict | None = None,
) -> list[dict]:
    """
    Максимально полная выкачка данных по доске (для бэкапа) через Miro REST v2.
    Возвращает единый список dict'ов, где у каждого объекта:
      - 'type'       : тип верхнего уровня (как в REST, напр. 'item', 'connector', 'tag', 'frame', 'member', 'board', ...)
      - 'source'     : из какого эндпоинта получен объект (напр. 'items', 'connectors', 'members', 'board')
      - 'subtype'    : уточняющий подтип, если доступен (напр. для фигур: 'flow_chart_decision', для текстов: 'text')
      - остальные поля — как вернул API.

    Примечания:
      - Комментарии и talktrack недоступны через публичный REST и требуют Board Export API (Enterprise).
      - Бинарники (оригиналы) отдельных типов не всегда доступны на прямую; REST вернёт метаданные/URLs.
      - Если prefer_experimental_items=True, items берутся из v2-experimental (даёт контент фигур/flowchart).
        При частичном падении пагинации вызывается confirm_exp_fallback(n_partial) — пользователь решает,
        переключаться ли на v2 (True) или оставить частичные данные (False).
    """

    MAX_LIMIT = 50  # у Miro ограничение на страницу

    # ---- Session + Retry
    retry = Retry(
        total=5,
        backoff_factor=0.5,
        status_forcelist=(429, 500, 502, 503, 504),
        allowed_methods=("GET",),
        raise_on_status=False,
    )
    sess = requests.Session()
    sess.headers.update({"Authorization": f"Bearer {token}"})
    sess.mount("https://", HTTPAdapter(max_retries=retry))

    all_items: list[dict] = []
    page_no = 0
    source_pages: Counter[str] = Counter()
    source_records: Counter[str] = Counter()
    skipped_sources: list[str] = []
    partial_sources: list[str] = []

    def log(msg: str) -> None:
        if logger:
            logger(msg)

    def fmt_counts(cnt: Counter) -> str:
        pairs = sorted(cnt.items(), key=lambda kv: (-kv[1], kv[0]))
        return ", ".join(f"{k}: {v}" for k, v in pairs)

    # ---- безопасное извлечение subtype/текста
    def enrich_item_payload(d: dict) -> None:
        t = d.get("type")
        subtype = None
        plain_text = None
        if t == "shape":
            shp = d.get("shape") or {}
            subtype = shp.get("shape")
            plain_text = shp.get("content")
        elif t == "sticky_note":
            sn = d.get("sticky_note") or {}
            subtype = "sticky_note"
            plain_text = sn.get("content")
        elif t == "text":
            txt = d.get("text") or {}
            subtype = "text"
            plain_text = txt.get("content")
        d["subtype"] = subtype
        if plain_text is not None:
            d["plain_text"] = plain_text

    def fetch_cursor_paginated(
        base_url: str,
        obj_type: str,
        source: str,
        enrich: Optional[Callable[[dict], None]] = None,
    ) -> None:
        nonlocal page_no, all_items
        cursor = ""
        next_url = ""
        seen_requests: set[tuple[str, tuple[tuple[str, str], ...]]] = set()
        while True:
            if next_url:
                request_url = urljoin(base_url, next_url)
                params: dict[str, str] = {}
            else:
                request_url = base_url
                params = {"limit": str(MAX_LIMIT)}
                if cursor:
                    params["cursor"] = cursor

            if not _miro_api_url_is_allowed(request_url):
                raise RuntimeError(f"{source} pagination links.next left api.miro.com.")
            request_key = (request_url, tuple(sorted(params.items())))
            if request_key in seen_requests:
                raise RuntimeError(f"{source} pagination repeated the same request.")
            seen_requests.add(request_key)

            response = sess.get(request_url, params=params, timeout=30)
            if response.status_code >= 400:
                try:
                    error_body = response.json()
                except Exception:
                    error_body = response.text
                reason = getattr(response, "reason", "")
                raise requests.HTTPError(
                    f"{response.status_code} {reason}: {error_body}",
                    response=response,
                )

            payload = response.json()
            if not isinstance(payload, dict) or not isinstance(
                payload.get("data"), list
            ):
                raise RuntimeError(f"{source} pagination returned malformed data.")
            batch: list[dict] = []
            for raw_item in payload["data"]:
                if not isinstance(raw_item, dict):
                    raise RuntimeError(
                        f"{source} pagination returned a non-object item."
                    )
                raw_item.setdefault("type", obj_type)
                raw_item["source"] = source
                if enrich:
                    enrich(raw_item)
                batch.append(raw_item)

            all_items.extend(batch)
            page_no += 1
            source_pages[source] += 1
            source_records[source] += len(batch)
            log(
                f"загружена страница {page_no} ({source}), добавлено {len(batch)} "
                f"({fmt_counts(Counter(i['type'] for i in all_items))})"
            )

            next_cursor = str(payload.get("cursor") or "").strip()
            links = (
                payload.get("links") if isinstance(payload.get("links"), dict) else {}
            )
            next_link = str(links.get("next") or "").strip()
            if next_cursor:
                cursor = next_cursor
                next_url = ""
            elif next_link:
                cursor = ""
                next_url = urljoin(request_url, next_link)
            else:
                break

    def fetch_single(url: str, as_type: str, source: str) -> None:
        if not _miro_api_url_is_allowed(url):
            raise RuntimeError(f"{source} endpoint left api.miro.com.")
        response = sess.get(url, timeout=30)
        response.raise_for_status()
        payload = response.json()
        if not isinstance(payload, dict):
            raise RuntimeError(f"{source} endpoint returned malformed data.")
        payload.setdefault("type", as_type)
        payload["source"] = source
        all_items.append(payload)
        source_pages[source] += 1
        source_records[source] += 1

    base_v2 = f"https://api.miro.com/v2/boards/{board_id}"
    base_exp = f"https://api.miro.com/v2-experimental/boards/{board_id}"

    # ---- ITEMS: сначала пробуем experimental (если включено), иначе сразу v2
    _exp_completed = (
        False  # True только если пагинация experimental прошла до конца без ошибок
    )
    if prefer_experimental_items:
        n_before_exp = len(all_items)
        try:
            fetch_cursor_paginated(
                f"{base_exp}/items",
                "item",
                "items(v2-experimental)",
                enrich_item_payload,
            )
            _exp_completed = True
        except requests.HTTPError as e:
            n_partial = len(all_items) - n_before_exp
            if n_partial > 0:
                # Пагинация упала на середине — есть частичные данные
                log(
                    f"items: v2-experimental прервался после {n_partial} элементов ({e})"
                )
                do_fallback = True
                if confirm_exp_fallback:
                    do_fallback = bool(confirm_exp_fallback(n_partial))
                if do_fallback:
                    # Чистим частичные данные и переключаемся на v2
                    del all_items[n_before_exp:]
                    log(
                        "items: переключаюсь на v2 (частичные данные experimental очищены)"
                    )
                    fetch_cursor_paginated(
                        f"{base_v2}/items", "item", "items(v2)", enrich_item_payload
                    )
                else:
                    log(
                        "items: оставляю частичные данные experimental, v2 не запрашиваю"
                    )
                    partial_sources.append("items(v2-experimental)")
            else:
                # Упало до первой страницы — тихий fallback на v2
                log(f"items: v2-experimental недоступен, переключаюсь на v2 ({e})")
                fetch_cursor_paginated(
                    f"{base_v2}/items", "item", "items(v2)", enrich_item_payload
                )

    # пользователь выбрал Stable — сразу v2
    if not prefer_experimental_items:
        fetch_cursor_paginated(
            f"{base_v2}/items", "item", "items(v2)", enrich_item_payload
        )

    # ---- прочие коллекции: стабильное v2
    others = [
        (f"{base_v2}/connectors", "connector", "connectors"),
        (f"{base_v2}/tags", "tag", "tags"),
        (f"{base_v2}/frames", "frame", "frames"),
        (f"{base_v2}/documents", "document", "documents"),
        (f"{base_v2}/embeds", "embed", "embeds"),
        (f"{base_v2}/groups", "group", "groups"),
        (f"{base_v2}/members", "member", "members"),
    ]
    for url, t, src in others:
        try:
            fetch_cursor_paginated(url, t, src)
        except requests.HTTPError as e:
            status = getattr(e.response, "status_code", None)
            if status in (401, 403):
                # вытащим человеческое сообщение из тела ответа, если есть
                try:
                    err_json = e.response.json()
                    msg_txt = err_json.get("message") or str(err_json)
                except Exception:
                    msg_txt = str(e)

                allow = False
                if confirm_skip_source:
                    # спросим: продолжать без этой коллекции?
                    allow = bool(confirm_skip_source(src, status, msg_txt))

                if allow:
                    log(f"{src}: доступ запрещён ({status}), пропускаю.")
                    skipped_sources.append(src)
                    continue  # идём дальше, не падаем целиком

            # если не 401/403 или пользователь отказался — падаем как обычно
            raise

    # ---- метаданные доски
    try:
        fetch_single(base_v2, "board", "board")
    except requests.HTTPError as e:
        status = getattr(e.response, "status_code", None)
        if status in (401, 403):
            try:
                err_json = e.response.json()
                msg_txt = err_json.get("message") or str(err_json)
            except Exception:
                msg_txt = str(e)
            allow = False
            if confirm_skip_source:
                allow = bool(confirm_skip_source("board", status, msg_txt))
            if allow:
                log(f"board: доступ запрещён ({status}), пропускаю метаданные.")
                skipped_sources.append("board")
            else:
                raise
        else:
            raise

    log(
        f"Получено: {len(all_items)} объектов ({fmt_counts(Counter(i['type'] for i in all_items))})"
    )
    if metadata is not None:
        metadata.update(
            {
                "complete": not skipped_sources and not partial_sources,
                "requested_items_source": (
                    "rest_v2_experimental" if prefer_experimental_items else "rest_v2"
                ),
                "experimental_completed": _exp_completed,
                "source_pages": dict(sorted(source_pages.items())),
                "source_records": dict(sorted(source_records.items())),
                "skipped_sources": list(skipped_sources),
                "partial_sources": list(partial_sources),
                "raw_item_count": len(all_items),
            }
        )
    return all_items


def safe_ui_call(widget, func, *args, **kwargs):
    if widget is None:
        return func(*args, **kwargs)
    if widget:  # защита от None
        widget.after(0, lambda: func(*args, **kwargs))


@rate_limited(calls=1900, period=60)
def download_resource_with_redirect(
    url: str,
    final_path: Path,
    token: str,
    timeout=30,
    on_chunk: Optional[Callable[[int, Optional[int]], None]] = None,
    on_rename: Optional[Callable[[Path], None]] = None,
    overwrite_when_guessing_ext: bool = False,
    *,
    expected_kind: str = "",
    max_retries: int = 3,
    backoff_base: float = 0.8,
    retry_statuses: tuple[int, ...] = (429, 500, 502, 503, 504),
) -> Optional[Path]:
    for attempt in range(max_retries + 1):
        this_url = url
        redirects = 0
        retry_delay: float | None = None
        tmp_path: Path | None = None
        try:
            while True:
                if not _download_url_is_allowed(this_url):
                    return None
                parsed_url = urlsplit(this_url)
                headers = {}
                if (
                    parsed_url.scheme.lower() == "https"
                    and (parsed_url.hostname or "").lower() == "api.miro.com"
                    and parsed_url.port in (None, 443)
                ):
                    headers["Authorization"] = f"Bearer {token}"

                with requests.get(
                    this_url,
                    stream=True,
                    headers=headers,
                    timeout=timeout,
                    allow_redirects=False,
                ) as response:
                    if response.status_code in (301, 302, 303, 307, 308):
                        redirect_url = response.headers.get("location")
                        if not redirect_url:
                            return None
                        redirects += 1
                        if redirects > 10:
                            return None
                        this_url = urljoin(this_url, redirect_url)
                        continue

                    if response.status_code != 200:
                        if (
                            response.status_code not in retry_statuses
                            or attempt >= max_retries
                        ):
                            return None
                        retry_delay = _retry_delay_seconds(
                            response.headers.get("Retry-After"),
                            backoff_base * (2**attempt),
                        )
                        break

                    effective_final = final_path
                    content_type = response.headers.get("content-type", "") or ""
                    if effective_final.suffix == "":
                        guessed_ext = get_file_extension(content_type)
                        disposition = response.headers.get("content-disposition") or ""
                        match = re.search(
                            r"filename\*?=(?:UTF-8'')?\"?([^\";]+)\"?",
                            disposition,
                            re.IGNORECASE,
                        )
                        disposition_ext = (
                            Path(unquote(match.group(1))).suffix if match else ""
                        )
                        if disposition_ext and (
                            not guessed_ext or guessed_ext == ".bin"
                        ):
                            guessed_ext = disposition_ext
                        if not re.fullmatch(r"\.[A-Za-z0-9]{1,16}", guessed_ext or ""):
                            guessed_ext = ".bin"

                        candidate = effective_final.with_suffix(guessed_ext)
                        effective_final = (
                            candidate
                            if overwrite_when_guessing_ext
                            else add_extension_unique(effective_final, guessed_ext)
                        )
                        if on_rename and effective_final.name != final_path.name:
                            on_rename(effective_final)

                    tmp_path = _temporary_path(effective_final, ".part")
                    raw_length = response.headers.get("content-length")
                    try:
                        total_size = (
                            int(raw_length) if raw_length not in (None, "") else None
                        )
                    except (TypeError, ValueError):
                        return None
                    if total_size is not None and total_size < 0:
                        return None

                    done = 0
                    with tmp_path.open("wb") as file:
                        for chunk in response.iter_content(chunk_size=8192):
                            if not chunk:
                                continue
                            file.write(chunk)
                            done += len(chunk)
                            if on_chunk:
                                on_chunk(done, total_size)

                    expected_size = (
                        total_size
                        if not response.headers.get("content-encoding")
                        else None
                    )
                    invalid_reason = downloaded_file_error(
                        tmp_path,
                        content_type=content_type,
                        expected_path=effective_final,
                        expected_kind=expected_kind,
                        expected_size=expected_size,
                    )
                    if invalid_reason:
                        if attempt >= max_retries:
                            return None
                        retry_delay = backoff_base * (2**attempt)
                        break
                    tmp_path.replace(effective_final)
                    return effective_final
        except (requests.Timeout, requests.ConnectionError):
            if attempt >= max_retries:
                return None
            retry_delay = backoff_base * (2**attempt)
        except Exception:
            return None
        finally:
            if tmp_path is not None:
                tmp_path.unlink(missing_ok=True)

        if retry_delay is None:
            return None
        time.sleep(retry_delay)
    return None


def download_all(
    resources: list[dict],
    save_path: Path,  # не используется, оставлен для совместимости
    token: str,
    safe_team: str,
    safe_board: str,
    is_image: bool = True,
    strategy: str = "overwrite",  # совместимость
    mapping: dict[str, str] | None = None,  # не используется
    rename_files: bool = True,  # не используется
    gui_root=None,
    on_file_start=None,  # on_file_start(item_id, name) -> FileProgress
    on_file_done=None,  # on_file_done(item_id)
    on_overall_progress=None,  # on_overall_progress(done, total)
    *,
    id_to_final_path: dict[str, Path],
    inline_image_url_map: dict[str, Path] | None = None,
    inline_image_id_map: dict[str, Path] | None = None,
    inline_slot_map: dict[str, dict[str, Path]] | None = None,
    on_file_fail=None,
) -> list[tuple[str, str]]:
    """
    ВНИМАНИЕ: Для doc_format
      - EMBED <embed data-slot-id="..."> -> <img src="data:..."> (по inline_slot_map)
      - src у <img> переписывается по URL/ID -> file://... -> затем инлайнится в data:
      - исходные файлы картинок сохраняются рядом с JSON и могут использоваться другими нодами
    """
    total = len(resources)
    completed = 0
    failures: list[tuple[str, str]] = []
    state_lock = Lock()

    def mark_completed() -> int:
        nonlocal completed
        with state_lock:
            completed += 1
            return completed

    def task(res: dict):
        nonlocal completed
        item_id = str(res["id"])
        rtype = res.get("type")
        data = res.get("data") if isinstance(res.get("data"), dict) else {}

        final_path = id_to_final_path[item_id]  # конечный путь, рассчитанный заранее

        fp = None
        if on_file_start:
            fp = on_file_start(item_id, final_path.name)

        def chunk_cb(done, total_size):
            if fp:
                safe_ui_call(gui_root or fp, fp.set_progress, done, total_size)

        def rename_cb(new_path: Path):
            if fp and new_path.name != final_path.name:

                def _upd():
                    try:
                        fp.label.configure(text=new_path.name)
                    except Exception:
                        pass

                safe_ui_call(gui_root or fp, _upd)

        def fail_this_file(reason: str):
            with state_lock:
                failures.append((str(item_id), reason))
            if on_file_fail:
                safe_ui_call(gui_root or fp, on_file_fail, item_id, reason)
            completed_now = mark_completed()
            if on_overall_progress:
                safe_ui_call(gui_root or fp, on_overall_progress, completed_now, total)

        # === DOC_FORMAT (HTML -> PDF с картинками) ===
        if rtype == "doc_format":
            try:
                sidecar_root = final_path.parent.resolve()
                raw_html = data.get("html") or ""
                nice_title = extract_doc_format_title(raw_html) or res.get("id", "doc")

                # 1) EMBED -> <img data:...>
                slots_for_doc = None
                if inline_slot_map:
                    slots_for_doc = inline_slot_map.get(
                        str(item_id)
                    ) or inline_slot_map.get(item_id)
                raw_html = _rewrite_embeds_to_imgs_by_slot(
                    raw_html,
                    slots_for_doc,
                    allowed_root=sidecar_root,
                )

                # 2) подмены src
                if inline_image_url_map:
                    raw_html = _rewrite_img_src_to_local(raw_html, inline_image_url_map)
                if inline_image_id_map:
                    raw_html = _rewrite_img_src_by_id(raw_html, inline_image_id_map)

                # 3) инлайн всего file:// в data:
                raw_html = _inline_local_img_files(raw_html, allowed_root=sidecar_root)

                html = f"""<!DOCTYPE html>
        <html lang="ru">
        <head>
          <meta charset="utf-8">
          <title>{nice_title}</title>
          <meta name="viewport" content="width=device-width, initial-scale=1">
          <style>
            @page {{ size: A4; margin: 20mm; }}
            body {{ font-family: -apple-system, Segoe UI, Roboto, Arial, sans-serif; font-size: 12pt; line-height: 1.35; }}
            p {{ margin: 0 0 8px; }}
            ol,ul {{ margin: 6px 0 6px 22px; }}
            img {{ max-width: 100%; height: auto; display: block; }}
          </style>
        </head>
        <body>
        {raw_html}
        </body>
        </html>"""

                target_pdf = (
                    final_path
                    if final_path.suffix.lower() == ".pdf"
                    else add_extension_unique(final_path.with_suffix(""), ".pdf")
                )
                if target_pdf.name != final_path.name:
                    rename_cb(target_pdf)

                # 4) PDF → fallback HTML
                pdf_ok = False
                try:
                    from weasyprint import HTML, default_url_fetcher

                    def sidecar_url_fetcher(resource_url, *args, **kwargs):
                        if not _resource_url_is_allowed(
                            str(resource_url), allowed_root=sidecar_root
                        ):
                            raise ValueError("resource URL is not allowed")
                        return default_url_fetcher(resource_url, *args, **kwargs)

                    target_pdf.parent.mkdir(parents=True, exist_ok=True)
                    tmp_pdf = _temporary_path(target_pdf, ".part")
                    HTML(
                        string=html,
                        base_url=str(target_pdf.parent),
                        url_fetcher=sidecar_url_fetcher,
                    ).write_pdf(str(tmp_pdf))
                    tmp_pdf.replace(target_pdf)
                    res["local_name"] = target_pdf.name
                    pdf_ok = True
                except Exception:
                    try:
                        from playwright.sync_api import sync_playwright

                        target_pdf.parent.mkdir(parents=True, exist_ok=True)
                        tmp_pdf = _temporary_path(target_pdf, ".part")
                        with sync_playwright() as p:
                            browser = p.chromium.launch()
                            page = browser.new_page()

                            def route_sidecar_files(route):
                                resource_url = route.request.url
                                if not _resource_url_is_allowed(
                                    resource_url, allowed_root=sidecar_root
                                ):
                                    route.abort()
                                    return
                                route.continue_()

                            page.route("**/*", route_sidecar_files)
                            page.set_content(html, wait_until="networkidle")
                            page.pdf(
                                path=str(tmp_pdf),
                                format="A4",
                                margin={
                                    "top": "20mm",
                                    "right": "20mm",
                                    "bottom": "20mm",
                                    "left": "20mm",
                                },
                            )
                            browser.close()
                        tmp_pdf.replace(target_pdf)
                        res["local_name"] = target_pdf.name
                        pdf_ok = True
                    except Exception:
                        pdf_ok = False

                if pdf_ok:
                    # успех
                    if on_file_done:
                        safe_ui_call(gui_root or fp, on_file_done, item_id)
                    completed_now = mark_completed()
                    if on_overall_progress:
                        safe_ui_call(
                            gui_root or fp, on_overall_progress, completed_now, total
                        )
                    return

                # fallback: HTML — тоже считаем успехом
                target_html = add_extension_unique(target_pdf.with_suffix(""), ".html")
                if target_html.name != final_path.name:
                    rename_cb(target_html)
                target_html.parent.mkdir(parents=True, exist_ok=True)
                tmp_html = _temporary_path(target_html, ".part")
                with open(tmp_html, "w", encoding="utf-8") as f:
                    f.write(html)
                tmp_html.replace(target_html)
                res["local_name"] = target_html.name

                # пометим строку, что был fallback (не ошибка!)
                if fp:
                    safe_ui_call(
                        gui_root or fp,
                        fp.set_message,
                        f"ℹ️ {target_html.name} (PDF не собрался, сохранён HTML)",
                    )

                if on_file_done:
                    safe_ui_call(gui_root or fp, on_file_done, item_id)
                completed_now = mark_completed()
                if on_overall_progress:
                    safe_ui_call(
                        gui_root or fp, on_overall_progress, completed_now, total
                    )
                return

            except Exception as e:
                fail_this_file(f"doc_format: {e}")
                return

        # === /DOC_FORMAT ===

        # --- Обычные изображения/документы ---
        try:
            if is_image:
                raw = data.get("imageUrl") or ""
                url = _with_image_params(raw, fmt="original")
            else:
                base = data.get("documentUrl") or ""
                # для документов format обычно не применяют — оставим как есть + redirect
                url = _with_image_params(base, fmt="original") or (
                    base + "?redirect=true" if base else None
                )
        except Exception:
            url = None
            raw = ""

        if not url:
            fail_this_file("пустой URL")
            return

        got_path = download_resource_with_redirect(
            url,
            final_path,
            token,
            on_chunk=chunk_cb,
            on_rename=rename_cb,
            overwrite_when_guessing_ext=(strategy == "overwrite"),
            expected_kind="image" if is_image else "document",
        )

        # ФОЛЛБЕК: у некоторых изображений нет original — пробуем preview
        if not got_path and is_image:
            url_preview = _with_image_params(raw, fmt="preview")
            if url_preview:
                got_path = download_resource_with_redirect(
                    url_preview,
                    final_path,
                    token,
                    on_chunk=chunk_cb,
                    on_rename=rename_cb,
                    overwrite_when_guessing_ext=(strategy == "overwrite"),
                    expected_kind="image",
                )

        if got_path:
            res["local_name"] = got_path.name
            if on_file_done:
                safe_ui_call(gui_root or fp, on_file_done, item_id)
        else:
            fail_this_file("скачивание не удалось")
            return

        completed_now = mark_completed()
        if on_overall_progress:
            safe_ui_call(gui_root or fp, on_overall_progress, completed_now, total)

    # пул потоков на все ресурсы
    errors: list[Exception] = []
    with ThreadPoolExecutor(max_workers=MAX_WORKERS) as executor:
        futures = [executor.submit(task, res) for res in resources]
        for future in as_completed(futures):
            try:
                future.result()
            except Exception as exc:
                errors.append(exc)
    if errors:
        raise RuntimeError(
            f"{len(errors)} asset download worker(s) failed."
        ) from errors[0]
    return failures


def get_items_statistics(items: list[dict]) -> dict[str, int]:
    counts = Counter(item["type"] for item in items)
    counts["total"] = len(items)
    return dict(counts)


def print_items_statistics(items: list[dict]) -> None:
    stats = get_items_statistics(items)
    print("\n📊 Статистика элементов на доске:")
    for t, count in stats.items():
        if t != "total":
            print(f"  {t}: {count}")
    print(f"  Всего элементов: {stats['total']}")


def add_browser_links(board_id: str, items: list[dict]) -> list[dict]:
    """Добавляет ссылки для каждого элемента на Miro web UI."""
    bid = unquote(board_id)
    for it in items:
        item_id = it.get("id")
        if not item_id:
            continue
        web = f"https://miro.com/app/board/{bid}/?moveToWidget={item_id}"
        it.setdefault("links", {})["web"] = web
    return items


def check_existing_files_once(file_paths: list[Path]) -> str:
    """Возвращает стратегию: 'overwrite', 'rename', 'skip'."""
    conflicts = [p for p in file_paths if p.exists()]
    if not conflicts:
        return "overwrite"

    print("⚠️ Найдены существующие файлы:")
    for p in conflicts:
        print(f"  {p.name}")

    while True:
        choice = (
            input(
                "\nВыберите действие для ВСЕХ файлов:\n"
                "  [P] Перезаписать все\n"
                "  [D] Сохранить все как новые (с индексами)\n"
                "  [S] Пропустить все\n"
                "Ваш выбор: "
            )
            .strip()
            .lower()
        )

        if choice == "p":
            return "overwrite"
        elif choice == "d":
            return "rename"
        elif choice == "s":
            return "skip"
        else:
            print("Введите P, D или S.")


def apply_strategy(path: Path, strategy: str) -> Path | None:
    dbg("apply_strategy IN :", strategy, "->", path)
    if strategy == "overwrite":
        dbg("apply_strategy OUT:", path)
        return path
    elif strategy == "rename":
        out = ensure_unique_filename(path)
        dbg("apply_strategy OUT:", out)
        return out
    elif strategy == "skip":
        dbg("apply_strategy OUT: None (skip)")
        return None
    dbg("apply_strategy OUT (default overwrite):", path)
    return path
