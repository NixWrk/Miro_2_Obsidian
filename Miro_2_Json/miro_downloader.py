#miro_downloader
import base64
import json
import mimetypes
import os
import re
import time
from collections import Counter
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Callable, Optional
from urllib.parse import unquote, urlsplit, urlunsplit, parse_qsl, urlencode

import requests
from ratelimit import rate_limited
from requests.adapters import HTTPAdapter
from tqdm import tqdm
from urllib3.util.retry import Retry

from utils import add_extension_unique, safe_filename, ensure_unique_filename, extract_doc_format_title


MAX_WORKERS = 8  # Количество одновременных загрузок

DEBUG = False

def _with_image_params(raw_url: str, *, fmt: str) -> str | None:
    """Собирает URL с format=<fmt> и redirect=true, не ломая остальные параметры."""
    if not raw_url:
        return None
    u = urlsplit(raw_url)
    q = dict(parse_qsl(u.query, keep_blank_values=True))
    q["format"] = fmt            # "original" или "preview"
    q["redirect"] = "true"
    return urlunsplit((u.scheme, u.netloc, u.path, urlencode(q), u.fragment))


def _file_to_data_uri(p: Path) -> str | None:
    try:
        if not p or not p.exists():
            return None
        mime, _ = mimetypes.guess_type(p.name)
        if not mime:
            mime = "application/octet-stream"
        b64 = base64.b64encode(p.read_bytes()).decode("ascii")
        return f"data:{mime};base64,{b64}"
    except Exception:
        return None

EMBED_RE = re.compile(
    r'<embed\b[^>]*\bdata-slot-id\s*=\s*["\']([^"\']+)["\'][^>]*>',
    flags=re.IGNORECASE
)

def _rewrite_embeds_to_imgs_by_slot(html: str, slots: dict[str, Path] | None) -> str:
    if not slots:
        return html

    def repl(m):
        slot = m.group(1)
        p = slots.get(str(slot))
        if not p or not p.exists():
            # не знаем картинку — просто уберём плейсхолдер
            return ""
        data_uri = _file_to_data_uri(p)
        if not data_uri:
            return ""
        # alt = реальное имя файла, NOT slotId
        alt = p.name
        return f'<img src="{data_uri}" alt="{alt}"/>'

    return EMBED_RE.sub(repl, html)


def _inline_local_img_files(html: str) -> str:
    def repl(m):
        src = m.group(1)
        if src.lower().startswith("file://"):
            # Нормализуем обратные слеши, чтобы urlsplit работал предсказуемо
            norm = src.replace("\\", "/")
            u = urlsplit(norm)
            # Собираем путь: file://<netloc><path>
            path_str = unquote((u.netloc or "") + (u.path or ""))
            # На Windows иногда прилетает '/C:/...' — убираем ведущий слэш
            if os.name == "nt" and re.match(r"^/[A-Za-z]:/", path_str):
                path_str = path_str.lstrip("/")
            p = Path(path_str)
            du = _file_to_data_uri(p) if p.exists() else None
            if du:
                return f'src="{du}"'
        return m.group(0)
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
    """
    Склеивает дубликаты из разных эндпоинтов.
    Ключ — (type, id). Приоритет источников:
      - document:  documents  > items(v2-experimental) > items(v2)
      - image:     items(v2-experimental) > items(v2)
      - остальные: без приоритета
    """
    def score(it: dict) -> int:
        t = it.get("type")
        src = (it.get("source") or "")
        if t == "document":
            if src.startswith("documents"):
                return 30
            if "items(v2-experimental)" in src:
                return 20
            if "items(v2)" in src:
                return 10
        if t == "image":
            if "items(v2-experimental)" in src:
                return 30
            if "items(v2)" in src:
                return 20
        return 0  # прочее

    best: dict[tuple[str, str], tuple[int, dict]] = {}
    for it in items:
        k = (it.get("type"), it.get("id"))
        sc = score(it)
        prev = best.get(k)
        if prev is None or sc > prev[0]:
            best[k] = (sc, it)
    return [t[1] for t in best.values()]




def dbg(*args):
    if DEBUG:
        print("[DBG]", *args)


def write_json(filename: Path, data: list[dict]) -> None:
    """Сохраняет JSON."""
    try:
        with open(filename, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=4)
        print(f"💾 JSON сохранён: {filename}")
    except OSError as e:
        print(f"❌ Ошибка записи JSON {filename}: {e}")


def read_json(file_path: Path) -> list[dict]:
    with open(file_path) as f:
        return json.load(f)


def get_file_extension(content_type: str) -> str:
    extension = mimetypes.guess_extension(content_type)
    return extension if extension else ".bin"


def get_boards(token: str) -> list[dict]:
    """Загружает список досок пользователя."""
    headers = {"Authorization": f"Bearer {token}"}
    url = "https://api.miro.com/v2/boards?limit=50"
    boards_data = []

    while url:
        r = requests.get(url, headers=headers, timeout=30)
        r.raise_for_status()
        data = r.json()
        for b in data.get("data", []):
            boards_data.append({
                "id": b["id"],
                "name": b.get("name"),
                "team": b.get("team", {}),
            })
        url = data.get("links", {}).get("next")
        time.sleep(0.2)

    return boards_data


def get_items_on_board(
    board_id: str,
    token: str,
    logger: Optional[Callable[[str], None]] = None,
    prefer_experimental_items: bool = True,
    confirm_skip_source: Optional[Callable[[str, int, str], bool]] = None,
    confirm_exp_fallback: Optional[Callable[[int], bool]] = None,
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

    def fetch_cursor_paginated(base_url: str, obj_type: str, source: str,
                               enrich: Optional[Callable[[dict], None]] = None) -> None:
        nonlocal page_no, all_items
        cursor = None
        next_url = None
        while True:
            if next_url:
                # если дали абсолютную next-ссылку — идём по ней как есть
                r = sess.get(next_url, timeout=30)
                next_url = None
            else:
                params = {"limit": MAX_LIMIT}
                if cursor:
                    params["cursor"] = cursor
                r = sess.get(base_url, params=params, timeout=30)

            if r.status_code >= 400:
                try:
                    err = r.json()
                except Exception:
                    err = r.text
                raise requests.HTTPError(f"{r.status_code} {r.reason}: {err}", response=r)

            data = r.json()
            batch = []
            for d in data.get("data", []):
                d.setdefault("type", obj_type)
                d["source"] = source
                if enrich:
                    enrich(d)
                batch.append(d)

            all_items.extend(batch)
            page_no += 1
            log(f"загружена страница {page_no} ({source}), добавлено {len(batch)} "
                f"({fmt_counts(Counter(i['type'] for i in all_items))})")

            # либо cursor, либо links.next
            cursor = data.get("cursor")
            if cursor:
                continue
            next_url = (data.get("links") or {}).get("next")
            if not next_url:
                break


    def fetch_single(url: str, as_type: str, source: str) -> None:
        r = sess.get(url, timeout=30)
        r.raise_for_status()
        d = r.json()
        if isinstance(d, dict):
            d.setdefault("type", as_type)
            d["source"] = source
            all_items.append(d)
        else:
            for x in (d or []):
                if isinstance(x, dict):
                    x.setdefault("type", as_type)
                    x["source"] = source
                    all_items.append(x)

    base_v2 = f"https://api.miro.com/v2/boards/{board_id}"
    base_exp = f"https://api.miro.com/v2-experimental/boards/{board_id}"

    # ---- ITEMS: сначала пробуем experimental (если включено), иначе сразу v2
    _exp_completed = False  # True только если пагинация experimental прошла до конца без ошибок
    if prefer_experimental_items:
        n_before_exp = len(all_items)
        try:
            fetch_cursor_paginated(f"{base_exp}/items", "item", "items(v2-experimental)", enrich_item_payload)
            _exp_completed = True
        except requests.HTTPError as e:
            n_partial = len(all_items) - n_before_exp
            if n_partial > 0:
                # Пагинация упала на середине — есть частичные данные
                log(f"items: v2-experimental прервался после {n_partial} элементов ({e})")
                do_fallback = True
                if confirm_exp_fallback:
                    do_fallback = bool(confirm_exp_fallback(n_partial))
                if do_fallback:
                    # Чистим частичные данные и переключаемся на v2
                    del all_items[n_before_exp:]
                    log("items: переключаюсь на v2 (частичные данные experimental очищены)")
                    fetch_cursor_paginated(f"{base_v2}/items", "item", "items(v2)", enrich_item_payload)
                else:
                    log("items: оставляю частичные данные experimental, v2 не запрашиваю")
            else:
                # Упало до первой страницы — тихий fallback на v2
                log(f"items: v2-experimental недоступен, переключаюсь на v2 ({e})")
                fetch_cursor_paginated(f"{base_v2}/items", "item", "items(v2)", enrich_item_payload)

    # пользователь выбрал Stable — сразу v2
    if not prefer_experimental_items:
        fetch_cursor_paginated(f"{base_v2}/items", "item", "items(v2)", enrich_item_payload)

    # ---- прочие коллекции: стабильное v2
    others = [
        (f"{base_v2}/connectors", "connector", "connectors"),
        (f"{base_v2}/tags",       "tag",       "tags"),
        (f"{base_v2}/frames",     "frame",     "frames"),
        (f"{base_v2}/documents",  "document",  "documents"),
        (f"{base_v2}/embeds",     "embed",     "embeds"),
        (f"{base_v2}/groups",     "group",     "groups"),
        (f"{base_v2}/members",    "member",    "members"),
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
            else:
                raise
        else:
            raise

    log(f"Получено: {len(all_items)} объектов ({fmt_counts(Counter(i['type'] for i in all_items))})")
    return all_items




def safe_ui_call(widget, func, *args, **kwargs):
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
    max_retries: int = 3,
    backoff_base: float = 0.8,
    retry_statuses: tuple[int, ...] = (429, 500, 502, 503, 504),
) -> Optional[Path]:
    headers = {"Authorization": f"Bearer {token}"}

    attempt = 0
    this_url = url
    redirects = 0
    max_redirects = 10

    while attempt <= max_retries:
        try:
            with requests.get(this_url, stream=True, headers=headers, timeout=timeout, allow_redirects=False) as r:
                if r.status_code in (301, 302, 303, 307, 308):
                    redirect_url = r.headers.get("location")
                    if not redirect_url:
                        return None
                    redirects += 1
                    if redirects > max_redirects:
                        return None  # слишком много редиректов
                    this_url = redirect_url
                    continue

                # неуспех — решаем, ретраить или нет
                if r.status_code != 200:
                    if r.status_code in retry_statuses and attempt < max_retries:
                        # уважаем Retry-After при наличии
                        delay = None
                        ra = r.headers.get("Retry-After")
                        if ra:
                            try:
                                delay = float(ra)
                            except Exception:
                                delay = None
                        if delay is None:
                            delay = (backoff_base * (2 ** attempt))
                        time.sleep(delay)
                        attempt += 1
                        continue
                    # без ретрая — провал
                    return None

                # --- успешный ответ: определяем итоговый путь и пишем на диск
                effective_final = final_path
                if effective_final.suffix == "":
                    ct = r.headers.get("content-type", "") or ""
                    guessed_ext = get_file_extension(ct) or ""
                    if not guessed_ext:
                        disp = (r.headers.get("content-disposition") or "")
                        m = re.search(r'filename\*?=(?:UTF-8\'\')?"?([^";]+)"?', disp)
                        if m:
                            guessed_ext = os.path.splitext(m.group(1))[1]
                    if not guessed_ext:
                        guessed_ext = ".bin"

                    candidate = effective_final.with_suffix(guessed_ext)
                    if overwrite_when_guessing_ext:
                        effective_final = candidate
                    else:
                        effective_final = add_extension_unique(effective_final, guessed_ext)

                    if on_rename and effective_final.name != final_path.name:
                        on_rename(effective_final)

                effective_final.parent.mkdir(parents=True, exist_ok=True)
                tmp_path = effective_final.with_suffix(effective_final.suffix + ".part")

                total_size = int(r.headers.get("content-length", 0)) or None
                done = 0
                with open(tmp_path, "wb") as f:
                    for chunk in r.iter_content(chunk_size=8192):
                        if not chunk:
                            continue
                        f.write(chunk)
                        done += len(chunk)
                        if on_chunk:
                            on_chunk(done, total_size)

                tmp_path.replace(effective_final)
                return effective_final

        except (requests.Timeout, requests.ConnectionError) as e:
            if attempt < max_retries:
                time.sleep(backoff_base * (2 ** attempt))
                attempt += 1
                continue
            return None
        except Exception:
            # не сетевые — без повторов (чтобы не зациклиться)
            return None

    return None








def download_all(
    resources: list[dict],
    save_path: Path,                 # не используется, оставлен для совместимости
    token: str,
    safe_team: str,
    safe_board: str,
    is_image: bool = True,
    strategy: str = "overwrite",     # совместимость
    mapping: dict[str, str] | None = None,   # не используется
    rename_files: bool = True,                # не используется
    gui_root=None,
    on_file_start=None,              # on_file_start(item_id, name) -> FileProgress
    on_file_done=None,               # on_file_done(item_id)
    on_overall_progress=None,        # on_overall_progress(done, total)
    *,
    id_to_final_path: dict[str, Path],
    inline_image_url_map: dict[str, Path] | None = None,
    inline_image_id_map: dict[str, Path] | None = None,
    inline_slot_map: dict[str, dict[str, Path]] | None = None,
    on_file_fail=None
) -> None:
    """
    ВНИМАНИЕ: Для doc_format
      - EMBED <embed data-slot-id="..."> -> <img src="data:..."> (по inline_slot_map)
      - src у <img> переписывается по URL/ID -> file://... -> затем инлайнится в data:
      - после успешной генерации PDF удаляются все файлы картинок, реально использованные в документе
    """
    total = len(resources)
    completed = 0

    # вспомогательное: собрать локальные file:// пути из HTML в множество Path
    SRC_RE = re.compile(r'src\s*=\s*["\']([^"\']+)["\']', re.IGNORECASE)

    def collect_local_file_paths_from_html(html: str) -> set[Path]:
        paths: set[Path] = set()
        for m in SRC_RE.finditer(html or ""):
            src = (m.group(1) or "").strip()
            if src.lower().startswith("file://"):
                # file://C:/...  или file:///... — аккуратно извлечём путь
                p_str = src[7:]
                try:
                    p = Path(p_str)
                    paths.add(p)
                except Exception:
                    pass
        return paths

    def task(res: dict):
        nonlocal completed
        item_id = res["id"]
        rtype = res.get("type")
        data = res.get("data") or {}

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
            nonlocal completed
            if on_file_fail:
                safe_ui_call(gui_root or fp, on_file_fail, item_id, reason)
            completed += 1
            if on_overall_progress:
                safe_ui_call(gui_root or fp, on_overall_progress, completed, total)


        # === DOC_FORMAT (HTML -> PDF с картинками) ===
        if rtype == "doc_format":
            try:
                raw_html = (data.get("html") or "")
                nice_title = extract_doc_format_title(raw_html) or res.get("id", "doc")

                # 1) EMBED -> <img data:...>
                slots_for_doc = None
                if inline_slot_map:
                    slots_for_doc = inline_slot_map.get(str(item_id)) or inline_slot_map.get(item_id)
                raw_html = _rewrite_embeds_to_imgs_by_slot(raw_html, slots_for_doc)

                # 2) подмены src
                if inline_image_url_map:
                    raw_html = _rewrite_img_src_to_local(raw_html, inline_image_url_map)
                if inline_image_id_map:
                    raw_html = _rewrite_img_src_by_id(raw_html, inline_image_id_map)

                # 2.1) собрать локальные пути (использованные)
                imgs_used: set[Path] = set()
                if slots_for_doc:
                    for p in slots_for_doc.values():
                        if p and p.exists():
                            imgs_used.add(p)
                imgs_used.update(collect_local_file_paths_from_html(raw_html))

                # 3) инлайн всего file:// в data:
                raw_html = _inline_local_img_files(raw_html)

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

                target_pdf = final_path if final_path.suffix.lower() == ".pdf" \
                             else add_extension_unique(final_path.with_suffix(""), ".pdf")
                if target_pdf.name != final_path.name:
                    rename_cb(target_pdf)

                # 4) PDF → fallback HTML
                pdf_ok = False
                try:
                    from weasyprint import HTML
                    target_pdf.parent.mkdir(parents=True, exist_ok=True)
                    tmp_pdf = target_pdf.with_suffix(target_pdf.suffix + ".part")
                    HTML(string=html, base_url=str(target_pdf.parent)).write_pdf(str(tmp_pdf))
                    tmp_pdf.replace(target_pdf)
                    res["local_name"] = target_pdf.name
                    pdf_ok = True
                except Exception:
                    try:
                        from playwright.sync_api import sync_playwright
                        target_pdf.parent.mkdir(parents=True, exist_ok=True)
                        tmp_pdf = target_pdf.with_suffix(target_pdf.suffix + ".part")
                        with sync_playwright() as p:
                            browser = p.chromium.launch()
                            page = browser.new_page()
                            page.set_content(html, wait_until="networkidle")
                            page.pdf(
                                path=str(tmp_pdf),
                                format="A4",
                                margin={"top": "20mm", "right": "20mm", "bottom": "20mm", "left": "20mm"},
                            )
                            browser.close()
                        tmp_pdf.replace(target_pdf)
                        res["local_name"] = target_pdf.name
                        pdf_ok = True
                    except Exception:
                        pdf_ok = False

                if pdf_ok:
                    # чистим использованные картинки
                    for p in set(imgs_used):
                        try:
                            if p and p.exists():
                                p.unlink()
                        except Exception:
                            pass
                    # успех
                    if on_file_done:
                        safe_ui_call(gui_root or fp, on_file_done, item_id)
                    completed += 1
                    if on_overall_progress:
                        safe_ui_call(gui_root or fp, on_overall_progress, completed, total)
                    return

                # fallback: HTML — тоже считаем успехом
                target_html = add_extension_unique(target_pdf.with_suffix(""), ".html")
                if target_html.name != final_path.name:
                    rename_cb(target_html)
                target_html.parent.mkdir(parents=True, exist_ok=True)
                tmp_html = target_html.with_suffix(target_html.suffix + ".part")
                with open(tmp_html, "w", encoding="utf-8") as f:
                    f.write(html)
                tmp_html.replace(target_html)
                res["local_name"] = target_html.name

                # пометим строку, что был fallback (не ошибка!)
                if fp:
                    safe_ui_call(gui_root or fp, fp.set_message, f"ℹ️ {target_html.name} (PDF не собрался, сохранён HTML)")

                if on_file_done:
                    safe_ui_call(gui_root or fp, on_file_done, item_id)
                completed += 1
                if on_overall_progress:
                    safe_ui_call(gui_root or fp, on_overall_progress, completed, total)
                return

            except Exception as e:
                fail_this_file(f"doc_format: {e}")
                return

                 
        # === /DOC_FORMAT ===


        # --- Обычные изображения/документы ---
        try:
            if is_image:
                raw = (data.get("imageUrl") or "")
                url = _with_image_params(raw, fmt="original")
            else:
                base = (data.get("documentUrl") or "")
                # для документов format обычно не применяют — оставим как есть + redirect
                url = _with_image_params(base, fmt="original") or (base + "?redirect=true" if base else None)
        except Exception:
            url = None
            raw = ""

        if not url:
            fail_this_file("пустой URL")
            return

        got_path = download_resource_with_redirect(
            url, final_path, token,
            on_chunk=chunk_cb,
            on_rename=rename_cb,
            overwrite_when_guessing_ext=(strategy == "overwrite"),
        )

        # ФОЛЛБЕК: у некоторых изображений нет original — пробуем preview
        if not got_path and is_image:
            url_preview = _with_image_params(raw, fmt="preview")
            if url_preview:
                got_path = download_resource_with_redirect(
                    url_preview, final_path, token,
                    on_chunk=chunk_cb,
                    on_rename=rename_cb,
                    overwrite_when_guessing_ext=(strategy == "overwrite"),
                )

        if got_path:
            res["local_name"] = got_path.name
            if on_file_done:
                safe_ui_call(gui_root or fp, on_file_done, item_id)
        else:
            fail_this_file("скачивание не удалось")
            return

        completed += 1
        if on_overall_progress:
            safe_ui_call(gui_root or fp, on_overall_progress, completed, total)

    # пул потоков на все ресурсы
    with ThreadPoolExecutor(max_workers=MAX_WORKERS) as executor:
        futures = [executor.submit(task, res) for res in resources]
        for f in as_completed(futures):
            try:
                f.result()
            except Exception as e:
                print(f"Ошибка загрузки: {e}")







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
        choice = input(
            "\nВыберите действие для ВСЕХ файлов:\n"
            "  [P] Перезаписать все\n"
            "  [D] Сохранить все как новые (с индексами)\n"
            "  [S] Пропустить все\n"
            "Ваш выбор: "
        ).strip().lower()

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



