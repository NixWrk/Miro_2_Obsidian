# download_worker.py
# -*- coding: utf-8 -*-
"""
Вся бизнес-логика скачивания доски Miro, не зависящая от GUI.

Точка входа: run_download()

Получает на вход параметры скачивания и набор колбэков для обратной связи
с GUI. Сам не знает ничего про Tkinter — можно тестировать отдельно.
"""

import re
import sys
from glob import escape as glob_escape
from pathlib import Path
from typing import Callable, Optional
from urllib.parse import urlsplit

SCRIPTS_DIR = Path(__file__).resolve().parents[1] / "scripts"
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

from miro_rest_export_board import export_complete_board_source  # noqa: E402
from miro_downloader import (  # noqa: E402
    get_items_on_board,
    download_all,
    download_resource_with_redirect,
    apply_strategy,
    add_browser_links,
    write_json,
    _dedupe_miro_items,
)
from utils import (  # noqa: E402
    compute_target_filename,
    make_unique_in_batch,
    allocate_unique_batch_names,
)


# =============================================================================
# Вспомогательная функция: проверка конфликтов имён на диске
# =============================================================================


def collect_conflicts(future_files: list[Path]) -> list[Path]:
    """
    Возвращает список уже существующих на диске файлов, которые конфликтуют
    с будущими путями (точное имя + все индексные варианты stem*(1), stem*(2)…).
    """
    conflicts: list[Path] = []
    seen: set[Path] = set()

    def _add(hit: Path):
        try:
            key = hit.resolve() if hit.exists() else hit
        except Exception:
            key = hit
        if hit.exists() and key not in seen:
            conflicts.append(hit)
            seen.add(key)

    for f in future_files:
        p = Path(f)
        parent = p.parent

        _add(p)

        if parent.exists():
            if p.suffix:
                pattern = f"{glob_escape(p.stem)}*{p.suffix}"
                for hit in parent.glob(pattern):
                    name = hit.name
                    if name.startswith(p.stem) and name.lower().endswith(
                        p.suffix.lower()
                    ):
                        _add(hit)
            else:
                pattern = f"{glob_escape(p.stem)}.*"
                for hit in parent.glob(pattern):
                    if hit.stem.startswith(p.stem):
                        _add(hit)

    return conflicts


# =============================================================================
# Вспомогательная функция: карты локальных путей для встраивания картинок
# =============================================================================


def _norm_url(u: str) -> str | None:
    if not u:
        return None
    u = u.split("?format")[0]
    parts = urlsplit(u)
    return f"{parts.scheme}://{parts.netloc}{parts.path}"


def build_image_maps(
    images: list[dict],
    attachments_dir: Path,
) -> tuple[dict[str, Path], dict[str, dict[str, Path]], dict[str, Path]]:
    """
    Строит три карты для встраивания локальных картинок в doc_format:
      - image_src_map  : URL  -> локальный Path
      - slot_map       : parent_id -> {slot_id -> локальный Path}
      - image_id_map   : image_id -> локальный Path
    """
    image_src_map: dict[str, Path] = {}
    slot_map: dict[str, dict[str, Path]] = {}
    image_id_map: dict[str, Path] = {}

    for it in images:
        ln = it.get("local_name")
        if not ln:
            continue
        local_path = attachments_dir / ln
        u = (it.get("data") or {}).get("imageUrl") or ""

        # src map (по URL)
        key = _norm_url(u)
        if key:
            image_src_map[key] = local_path

        # slot map (по slotId внутри родительского doc_format)
        parent_id = (it.get("parent") or {}).get("id")
        slot_id = (it.get("position") or {}).get("slotId")
        if parent_id and slot_id:
            slot_map.setdefault(str(parent_id), {})[str(slot_id)] = local_path

        # id map (по числовому ID в URL)
        m = re.search(r"/images/(\d+)(?:[/?]|$)", u, flags=re.IGNORECASE)
        if m:
            image_id_map[m.group(1)] = local_path

    return image_src_map, slot_map, image_id_map


# =============================================================================
# Точка входа: run_download
# =============================================================================


def run_download(
    *,
    board_id: str,
    token: str,
    save_base: Path,
    safe_team: str,
    safe_board: str,
    rename_files: bool,
    prefer_experimental: bool,
    canonical: bool = True,
    # колбэки GUI
    log: Callable[[str], None],
    ask_strategy: Callable[[list[Path]], Optional[str]],
    ask_continue_forbidden: Callable[[str, int, str], bool],
    ask_exp_fallback: Callable[[int], bool],
    on_prepare_rows: Callable[[dict[str, Path], list[dict]], None],
    on_file_start: Callable[[str, str], object],
    on_file_done: Callable[[str], None],
    on_file_fail: Callable[[str, str], None],
    on_overall_progress: Callable[[int, int], None],
    gui_root=None,
) -> Path | None:
    """
    Полный цикл скачивания одной доски Miro.
    Все обращения к UI — только через переданные колбэки.
    """

    json_path = save_base / f"{safe_team}_{safe_board}.json"
    attachments_dir = save_base / f"{safe_team}_{safe_board}_files"
    if canonical:
        conflicts = collect_conflicts([json_path, attachments_dir])
        strategy = ask_strategy(conflicts) if conflicts else "overwrite"
        if strategy in (None, "skip"):
            return None
        real_json_path = apply_strategy(json_path, strategy)
        if real_json_path is None:
            return None
        if strategy == "rename":
            index = 1
            candidate = real_json_path
            while (
                candidate.exists()
                or candidate.with_name(f"{candidate.stem}_files").exists()
            ):
                candidate = json_path.with_name(
                    f"{json_path.stem} ({index}){json_path.suffix}"
                )
                index += 1
            real_json_path = candidate

        log("Экспортирую canonical JSON: items, comments, provenance и assets...")
        payload, export_info = export_complete_board_source(
            board_id=board_id,
            token=token,
            output_path=real_json_path,
            prefer_experimental=prefer_experimental,
            download_assets=True,
            allow_missing_assets=False,
            logger=log,
        )
        on_prepare_rows({}, [])
        on_overall_progress(1, 1)
        log(
            f"Canonical export complete: items={len(payload['items'])}, "
            f"comments={len(payload['comments'])}, "
            f"assets_failed={export_info['asset_stats']['failed']}"
        )
        return real_json_path

    attachments_dir.mkdir(parents=True, exist_ok=True)

    # ------------------------------------------------------------------
    # 1. Получаем все элементы доски
    # ------------------------------------------------------------------
    log("Подключаюсь к доске, считаю элементы...")
    items = get_items_on_board(
        board_id,
        token,
        logger=log,
        prefer_experimental_items=prefer_experimental,
        confirm_skip_source=ask_continue_forbidden,
        confirm_exp_fallback=ask_exp_fallback,
    )
    items = _dedupe_miro_items(items)
    log(f"Элементов получено: {len(items)}")

    # ------------------------------------------------------------------
    # 2. Разбиваем по типам
    # ------------------------------------------------------------------
    images = [x for x in items if x["type"] == "image"]
    documents = [x for x in items if x["type"] == "document"]
    doc_formats = [x for x in items if x["type"] == "doc_format"]
    # embed: скачиваем previewUrl, если есть
    embeds_with_preview = [
        x
        for x in items
        if x["type"] == "embed" and (x.get("data") or {}).get("previewUrl")
    ]
    all_items = images + documents + doc_formats + embeds_with_preview

    # ------------------------------------------------------------------
    # 3. Желаемые пути → проверка конфликтов → стратегия
    # ------------------------------------------------------------------
    wanted_paths: list[Path] = []
    for it in images:
        wanted_paths.append(
            attachments_dir
            / compute_target_filename(
                it, safe_team, safe_board, rename_files, is_image=True
            )
        )
    for it in documents + doc_formats:
        wanted_paths.append(
            attachments_dir
            / compute_target_filename(
                it, safe_team, safe_board, rename_files, is_image=False
            )
        )
    for it in embeds_with_preview:
        wanted_paths.append(
            attachments_dir
            / compute_target_filename(
                it, safe_team, safe_board, rename_files, is_image=True
            )
        )

    future_files = [json_path] + wanted_paths
    conflicts = collect_conflicts(future_files)

    if conflicts:
        strategy = ask_strategy(conflicts)
        if strategy is None:
            return  # пользователь отменил
    else:
        strategy = "overwrite"

    # ------------------------------------------------------------------
    # 4. Финальные пути с учётом стратегии
    # ------------------------------------------------------------------
    real_json_path = apply_strategy(json_path, strategy)
    if real_json_path is None:
        return

    batch_unique = make_unique_in_batch(wanted_paths)

    if strategy == "skip":
        return
    elif strategy == "overwrite":
        final_paths = batch_unique
    else:  # rename
        final_paths = allocate_unique_batch_names(batch_unique)

    id_to_final: dict[str, Path] = {
        it["id"]: p for it, p in zip(all_items, final_paths)
    }

    # ------------------------------------------------------------------
    # 5. Готовим строки прогресса в GUI
    # ------------------------------------------------------------------
    log(
        f"Начинаю скачивание {len(all_items)} файлов "
        f"(изображения: {len(images)}, документы: {len(documents)}, "
        f"встроенные: {len(doc_formats)}, embed-превью: {len(embeds_with_preview)})..."
    )
    on_prepare_rows(id_to_final, all_items)

    # ------------------------------------------------------------------
    # 6. Скачивание тремя фазами
    # ------------------------------------------------------------------

    def _phase_callbacks(offset: int):
        """Возвращает колбэки для одной фазы с зафиксированным offset."""

        def _start(item_id, name):
            return on_file_start(item_id, name)

        def _done(item_id):
            on_file_done(item_id)

        def _progress(done, total, _off=offset):
            on_overall_progress(_off + done, len(all_items))

        return _start, _done, _progress

    offset = 0
    asset_failures: list[tuple[str, str]] = []

    def report_asset_failure(item_id: str, reason: str) -> None:
        asset_failures.append((str(item_id), str(reason)))
        on_file_fail(item_id, reason)

    # Phase 1: IMAGES
    if images:
        log(f"Группа: картинки, файлов: {len(images)}")
        _start, _done, _progress = _phase_callbacks(offset)
        asset_failures.extend(
            download_all(
                images,
                attachments_dir,
                token,
                safe_team,
                safe_board,
                is_image=True,
                strategy=strategy,
                on_file_start=_start,
                on_file_done=_done,
                on_overall_progress=_progress,
                gui_root=gui_root,
                id_to_final_path=id_to_final,
                on_file_fail=on_file_fail,
            )
        )
        offset += len(images)

    # Карты для встраивания картинок в doc_format
    image_src_map, slot_map, image_id_map = build_image_maps(images, attachments_dir)

    # Phase 2: DOCUMENTS
    if documents:
        log(f"Группа: документы, файлов: {len(documents)}")
        _start, _done, _progress = _phase_callbacks(offset)
        asset_failures.extend(
            download_all(
                documents,
                attachments_dir,
                token,
                safe_team,
                safe_board,
                is_image=False,
                strategy=strategy,
                on_file_start=_start,
                on_file_done=_done,
                on_overall_progress=_progress,
                gui_root=gui_root,
                id_to_final_path=id_to_final,
                on_file_fail=on_file_fail,
            )
        )
        offset += len(documents)

    # Phase 3: DOC_FORMATS
    if doc_formats:
        log(f"Группа: встроенные (doc_format), файлов: {len(doc_formats)}")
        _start, _done, _progress = _phase_callbacks(offset)
        asset_failures.extend(
            download_all(
                doc_formats,
                attachments_dir,
                token,
                safe_team,
                safe_board,
                is_image=False,
                strategy=strategy,
                on_file_start=_start,
                on_file_done=_done,
                on_overall_progress=_progress,
                gui_root=gui_root,
                id_to_final_path=id_to_final,
                inline_slot_map=slot_map,
                inline_image_url_map=image_src_map,
                inline_image_id_map=image_id_map,
                on_file_fail=on_file_fail,
            )
        )

    # ------------------------------------------------------------------
    # Phase 4: EMBED PREVIEWS
    # ------------------------------------------------------------------
    if embeds_with_preview:
        log(f"Группа: embed-превью, файлов: {len(embeds_with_preview)}")
        offset += len(doc_formats)
        _start, _done, _progress = _phase_callbacks(offset)
        for idx, it in enumerate(embeds_with_preview):
            item_id = it["id"]
            preview_url = (it.get("data") or {}).get("previewUrl", "")
            final_path = id_to_final[item_id]
            _start(item_id, final_path.name)

            got_path = download_resource_with_redirect(
                preview_url,
                final_path,
                token,
                overwrite_when_guessing_ext=(strategy == "overwrite"),
            )
            if got_path:
                # Принимаем только реальные изображения, не JSON/HTML/etc.
                _IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".svg"}
                if got_path.suffix.lower() in _IMAGE_EXTS:
                    it["local_name"] = got_path.name
                    _done(item_id)
                else:
                    # Скачалось не изображение (например JSON-метаданные) —
                    # удаляем мусорный файл, превью считаем недоступным
                    try:
                        got_path.unlink(missing_ok=True)
                    except Exception:
                        pass
                    report_asset_failure(
                        item_id,
                        f"embed preview: получен не-image файл ({got_path.suffix}), игнорируем",
                    )
            else:
                report_asset_failure(item_id, "embed preview: скачивание не удалось")
            _progress(idx + 1, len(embeds_with_preview))

    # ------------------------------------------------------------------
    # 7. Сохраняем JSON
    # ------------------------------------------------------------------
    items_with_links = add_browser_links(board_id, items)
    write_json(real_json_path, items_with_links)
    if asset_failures:
        details = "; ".join(
            f"{item_id}: {reason}" for item_id, reason in asset_failures
        )
        raise RuntimeError(
            f"{len(asset_failures)} asset download(s) failed; "
            f"JSON was preserved at {real_json_path}: {details}"
        )
    return real_json_path
