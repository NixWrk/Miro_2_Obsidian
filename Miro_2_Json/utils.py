#utils.py
from pathlib import Path
import re
import os
from collections import Counter
MAX_FILENAME_LENGTH = 200

def extract_doc_format_title(html: str) -> str:
    if not html:
        return "doc"
    text = re.sub(r"<[^>]+>", "", html)
    text = text.strip()
    return text[:100] if text else "doc"

def add_extension_unique(base_path: Path, ext: str) -> Path:
    parent, stem = base_path.parent, base_path.stem
    if ext and not ext.startswith("."):
        ext = "." + ext
    cand = parent / f"{stem}{ext}"
    i = 1
    while cand.exists():
        cand = parent / f"{stem} ({i}){ext}"
        i += 1
    return cand

def allocate_unique_batch_names(base_paths: list[Path]) -> list[Path]:
    """
    На вход — список желаемых путей (могут дублироваться).
    Возвращает список таких же длин, но уникальных путей:
    - сначала проверяем существование на диске;
    - затем учитываем дубликаты внутри этого же запуска.
    """
    used = set()               # уже выданные в этой партии
    counts = Counter(p.name for p in base_paths)
    result = []

    for p in base_paths:
        parent, stem, ext = p.parent, p.stem, p.suffix
        cand = p

        # если файл уже есть на диске или имя уже отдали ранее — подбираем индекс
        idx = 1
        while cand.exists() or cand in used:
            suffix = f" ({idx})"
            cand = parent / f"{stem}{suffix}{ext}"
            idx += 1

        used.add(cand)
        result.append(cand)

    return result



def make_unique_in_batch(base_paths: list[Path]) -> list[Path]:
    """
    Гарантирует уникальность имён только внутри текущей партии.
    1-й файл с именем 'name.ext' остаётся как есть,
    2-й -> 'name (1).ext', 3-й -> 'name (2).ext', и т.д.
    Проверка существования на диске здесь НЕ выполняется.
    """
    counters: dict[tuple[Path, str, str], int] = {}
    result: list[Path] = []

    for p in base_paths:
        parent, stem, ext = p.parent, p.stem, p.suffix
        key = (parent, stem, ext)
        n = counters.get(key, 0)

        cand = p if n == 0 else parent / f"{stem} ({n}){ext}"
        counters[key] = n + 1

        # на всякий случай избегаем совпадений с уже выданными из-за коллизий
        while cand in result:
            n = counters[key]
            cand = parent / f"{stem} ({n}){ext}"
            counters[key] = n + 1

        result.append(cand)

    return result


def safe_filename(name: str) -> str:
    """Делает имя файла безопасным."""
    name = re.sub(r'[\\/*?:"<>|]', "_", name)
    if len(name) > MAX_FILENAME_LENGTH:
        root, ext = os.path.splitext(name)
        name = root[:MAX_FILENAME_LENGTH - len(ext)] + ext
    return name


def ensure_unique_filename(path: Path) -> Path:
    """
    Возвращает уникальное имя файла: name.ext -> name (1).ext ...
    Если расширения нет — учитывает также name.*.
    """
    parent = path.parent
    stem = path.stem
    ext = path.suffix
    counter = 1

    if ext:
        candidate = parent / f"{stem}{ext}"
        while candidate.exists():
            candidate = parent / f"{stem} ({counter}){ext}"
            counter += 1
        return candidate

    # без расширения: проверяем и stem и stem.*
    candidate = parent / stem
    if not candidate.exists() and not any(parent.glob(f"{stem}.*")):
        return candidate

    while True:
        candidate = parent / f"{stem} ({counter})"
        if not candidate.exists() and not any(parent.glob(f"{stem} ({counter}).*")):
            return candidate
        counter += 1



def compute_target_filename(item: dict, safe_team: str, safe_board: str,
                            rename_files: bool, is_image: bool) -> str:
    """
    Вычисляет целевое имя файла для элемента доски.
    Обрабатывает image, document и doc_format (→ .pdf).
    """
    t = item.get("type")
    data = item.get("data") or {}

    if t == "doc_format":
        base = extract_doc_format_title(data.get("html", "")) or item.get("id", "doc")
        ext = ".pdf"
    elif t == "embed":
        # Для embed: base — из title (без расширения), ext — из previewUrl
        raw_title = data.get("title") or data.get("providerName") or item.get("id", "embed")
        base = Path(raw_title).stem  # убираем возможное расширение из title
        preview_url = data.get("previewUrl", "")
        ext = Path(preview_url.split("?")[0]).suffix if preview_url else ""
        # Если расширение не определяется из URL — оставляем пустым,
        # download_resource_with_redirect угадает по Content-Type
    else:
        title = data.get("title")
        if title:
            p = Path(title)
            base, ext = p.stem, p.suffix
        else:
            base, ext = item.get("id", "file"), ""
        if not ext:
            url = data.get("imageUrl" if is_image else "documentUrl", "")
            if url:
                ext = Path(url.split("?")[0]).suffix

    base = safe_filename(base)
    return f"{safe_team}_{safe_board}_{base}{ext}" if rename_files else f"{base}{ext}"


