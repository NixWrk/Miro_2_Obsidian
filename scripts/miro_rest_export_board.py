from __future__ import annotations

import argparse
import json
import os
import tempfile
from collections import Counter
from copy import deepcopy
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


REPO_ROOT = Path(__file__).resolve().parents[1]
MIRO_JSON_DIR = REPO_ROOT / "Miro_2_Json"

from Miro_2_Json.miro_downloader import (  # noqa: E402
    _dedupe_miro_items,
    add_browser_links,
    download_all,
    download_resource_with_redirect,
    downloaded_file_error,
    get_items_on_board,
)
from scripts.miro_export_bundle import (  # noqa: E402
    publish_staged_bundle,
    referenced_local_names,
    sidecar_path,
    staged_export_path,
)
from scripts.miro_oauth_token import (  # noqa: E402
    DEFAULT_AUTHORIZE_URL,
    DEFAULT_BROWSER,
    DEFAULT_REDIRECT_URI,
    DEFAULT_SCOPES,
)
from Miro_2_Json.utils import allocate_unique_batch_names, compute_target_filename  # noqa: E402


IMAGE_URL_KEYS = ("imageUrl", "url", "downloadUrl", "previewUrl", "thumbnailUrl")
DOCUMENT_URL_KEYS = ("documentUrl", "url", "downloadUrl")
EMBED_PREVIEW_URL_KEYS = ("previewUrl", "thumbnailUrl", "imageUrl")
IMAGE_EXTS = {
    ".avif",
    ".bmp",
    ".gif",
    ".heic",
    ".heif",
    ".ico",
    ".jpeg",
    ".jpg",
    ".png",
    ".svg",
    ".tif",
    ".tiff",
    ".webp",
}
REST_EXPORTER_VERSION = "miro2obs-rest-2"


def export_board_items(
    *,
    board_id: str,
    token: str,
    prefer_experimental: bool = True,
    logger: Any | None = None,
    metadata: dict[str, Any] | None = None,
) -> list[dict[str, Any]]:

    def strict_log(message: str) -> None:
        if logger:
            logger(message)
        if prefer_experimental and "переключаюсь на v2" in message:
            raise RuntimeError(
                "REST v2-experimental items export failed; stable item replacement is disabled."
            )

    def reject_partial_fallback(partial_count: int) -> bool:
        raise RuntimeError(
            "REST v2-experimental items pagination failed after "
            f"{partial_count} items; partial and stable replacement results are rejected."
        )

    endpoint_metadata: dict[str, Any] = {}
    raw_items = get_items_on_board(
        board_id,
        token,
        logger=strict_log,
        prefer_experimental_items=prefer_experimental,
        confirm_skip_source=lambda source, status, message: False,
        confirm_exp_fallback=reject_partial_fallback,
        metadata=endpoint_metadata,
    )
    if endpoint_metadata.get("complete") is not True:
        raise RuntimeError("REST item export reported incomplete endpoint coverage.")
    if prefer_experimental and not endpoint_metadata.get("source_pages", {}).get(
        "items(v2-experimental)"
    ):
        raise RuntimeError(
            "REST v2-experimental export did not prove that its first items page completed."
        )
    if prefer_experimental and any(
        item.get("source") == "items(v2)" for item in raw_items
    ):
        raise RuntimeError(
            "Stable items were returned for an experimental export; canonical replacement is rejected."
        )
    items = add_browser_links(board_id, _dedupe_miro_items(raw_items))
    if metadata is not None:
        source_counts = Counter(str(item.get("source") or "unknown") for item in items)
        metadata.update(
            {
                "complete": True,
                "requested_items_source": "rest_v2_experimental"
                if prefer_experimental
                else "rest_v2",
                "sources": dict(sorted(source_counts.items())),
                "raw_count": len(raw_items),
                "item_count": len(items),
                "endpoint_export": endpoint_metadata,
            }
        )
    return items


def export_board_comments(
    *,
    board_id: str,
    token: str,
    logger: Any | None = None,
    metadata: dict[str, Any] | None = None,
) -> list[dict[str, Any]]:
    from scripts.miro_comment_probe import run_comment_probe  # noqa: PLC0415

    payload = run_comment_probe(board_id=board_id, token=token)
    completeness = payload.get("completeness")
    if not isinstance(completeness, dict) or completeness.get("complete") is not True:
        reason = (
            completeness.get("reason")
            if isinstance(completeness, dict)
            else "missing_completeness"
        )
        raise RuntimeError(f"Comment export is incomplete: {reason}")

    comments = payload.get("comments")
    if not isinstance(comments, list):
        raise RuntimeError("Comment probe returned a malformed comments collection.")
    if any(not isinstance(comment, dict) for comment in comments):
        raise RuntimeError("Comment probe returned a non-object comment.")
    summary = payload.get("summary") if isinstance(payload.get("summary"), dict) else {}
    declared_count = summary.get("comment_items")
    if isinstance(declared_count, bool) or not isinstance(declared_count, int):
        raise RuntimeError("Comment probe summary.comment_items must be an integer.")
    if declared_count != len(comments):
        raise RuntimeError(
            "Comment probe summary.comment_items does not match comments length."
        )
    comments = _dedupe_miro_items(comments)
    if metadata is not None:
        metadata.update(
            {
                "complete": True,
                "decision": str(payload.get("decision") or "unknown"),
                "available_paths": list(summary.get("available_paths") or []),
                "raw_count": declared_count,
                "comment_count": len(comments),
                "probe_completeness": dict(completeness),
                "probe": payload,
            }
        )
    if logger:
        logger(
            f"comments={len(comments)} decision={payload.get('decision') or 'unknown'}"
        )
    return comments


def build_board_source_payload(
    items: list[dict[str, Any]],
    comments: list[dict[str, Any]],
    *,
    provenance: dict[str, Any] | None = None,
    completeness: dict[str, Any] | None = None,
    board_id: str | None = None,
    source_surface: str = "rest",
) -> dict[str, Any]:
    payload: dict[str, Any] = {"items": items, "comments": comments}
    if board_id:
        board_item = next(
            (item for item in items if str(item.get("type") or "").lower() == "board"),
            None,
        )
        board = dict(board_item) if board_item else {}
        board.setdefault("id", board_id)
        payload.update(
            {
                "exporter_version": REST_EXPORTER_VERSION,
                "schema_version": 1,
                "source_surface": source_surface,
                "export_scope": "board",
                "exported_at": datetime.now(timezone.utc).isoformat(),
                "board": board,
            }
        )
    if provenance is not None:
        payload["provenance"] = provenance
    if completeness is not None:
        payload["completeness"] = completeness
    return payload


def write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{path.name}.", suffix=".tmp", dir=path.parent
    )
    os.close(descriptor)
    temporary = Path(temporary_name)
    try:
        temporary.write_text(
            json.dumps(payload, ensure_ascii=False, indent=2, allow_nan=False) + "\n",
            encoding="utf-8",
        )
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)


def _asset_dir_for_output(output_path: Path) -> Path:
    return sidecar_path(output_path)


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
    wanted: list[Path] = []
    for item in resources:
        local_name = str(item.get("local_name") or "")
        try:
            relative = referenced_local_names([{"local_name": local_name}])[0]
        except (IndexError, RuntimeError):
            relative = None
        if relative is not None and len(relative.parts) == 1:
            wanted.append(attachments_dir / relative)
        else:
            wanted.append(
                attachments_dir
                / compute_target_filename(
                    item,
                    "rest",
                    safe_board,
                    rename_files=True,
                    is_image=is_image,
                )
            )
    final_paths = allocate_unique_batch_names(wanted)
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


def _ensure_data_url(
    item: dict[str, Any], canonical_key: str, keys: tuple[str, ...]
) -> bool:
    data = item.get("data")
    if data is None:
        data = {}
        item["data"] = data
    elif not isinstance(data, dict):
        return False
    value = _first_data_url(item, (canonical_key,))
    if value:
        return True
    value = _first_data_url(item, keys)
    if not value:
        return False
    data[canonical_key] = value
    return True


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
        data = item.get("data") if isinstance(item.get("data"), dict) else {}
        image_url = str(data.get("imageUrl") or "")

        key = _norm_url_without_format(image_url)
        if key:
            image_src_map[key] = local_path

        parent = item.get("parent") if isinstance(item.get("parent"), dict) else {}
        position = (
            item.get("position") if isinstance(item.get("position"), dict) else {}
        )
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
    attachments_root = attachments_dir.resolve()
    for item in resources:
        item_id = str(item.get("id") or "<missing-id>")
        local_name = str(item.get("local_name") or "")
        if not local_name:
            missing.append(f"{item_id}: missing local_name")
            continue
        try:
            local_path = referenced_local_names([{"local_name": local_name}])[0]
        except (IndexError, RuntimeError):
            missing.append(f"{item_id}: invalid local_name: {local_name}")
            continue
        resolved_path = (attachments_root / local_path).resolve()
        try:
            resolved_path.relative_to(attachments_root)
        except ValueError:
            missing.append(
                f"{item_id}: local_name escapes asset directory: {local_name}"
            )
            continue
        if not resolved_path.is_file():
            missing.append(f"{item_id}: missing file {local_name}")
            continue
        expected_kind = (
            "image" if str(item.get("type") or "") in {"image", "embed"} else "document"
        )
        invalid_reason = downloaded_file_error(
            resolved_path,
            expected_path=resolved_path,
            expected_kind=expected_kind,
        )
        if invalid_reason:
            missing.append(f"{item_id}: invalid file {local_name}: {invalid_reason}")
    return missing


def _missing_asset_items(
    resources: list[dict[str, Any]], *, attachments_dir: Path
) -> list[dict[str, Any]]:
    return [
        item
        for item in resources
        if _validate_downloaded_assets([item], attachments_dir=attachments_dir)
    ]


def _required_asset_resources(
    items: list[dict[str, Any]],
) -> tuple[
    list[dict[str, Any]],
    list[dict[str, Any]],
    list[dict[str, Any]],
    list[dict[str, Any]],
]:
    images = [item for item in items if item.get("type") == "image"]
    documents = [item for item in items if item.get("type") == "document"]
    for item in images:
        _ensure_data_url(item, "imageUrl", IMAGE_URL_KEYS)
    for item in documents:
        _ensure_data_url(item, "documentUrl", DOCUMENT_URL_KEYS)
    doc_formats = [
        item
        for item in items
        if item.get("type") == "doc_format"
        and isinstance(item.get("data"), dict)
        and item["data"].get("html")
    ]
    embeds = [
        item
        for item in items
        if item.get("type") == "embed"
        and _ensure_data_url(item, "previewUrl", EMBED_PREVIEW_URL_KEYS)
    ]
    return images, documents, doc_formats, embeds


def summarize_export_asset_requirements(items: list[dict[str, Any]]) -> dict[str, int]:
    images, documents, doc_formats, embeds = _required_asset_resources(items)
    return {
        "images": len(images),
        "documents": len(documents),
        "doc_formats": len(doc_formats),
        "embeds": len(embeds),
    }


def validate_export_assets(
    items: list[dict[str, Any]], *, output_path: Path
) -> list[str]:
    images, documents, doc_formats, embeds = _required_asset_resources(items)
    return _validate_downloaded_assets(
        images + documents + doc_formats,
        attachments_dir=_asset_dir_for_output(output_path),
    )


def validate_optional_export_assets(
    items: list[dict[str, Any]], *, output_path: Path
) -> list[str]:
    _images, _documents, _doc_formats, embeds = _required_asset_resources(items)
    return _validate_downloaded_assets(
        embeds,
        attachments_dir=_asset_dir_for_output(output_path),
    )


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

    images, documents, doc_formats, embeds = _required_asset_resources(items)

    def run_download_passes(
        resources: list[dict[str, Any]],
        *,
        is_image: bool,
        label: str,
        inline_slot_map: dict[str, dict[str, Path]] | None = None,
        inline_image_url_map: dict[str, Path] | None = None,
        inline_image_id_map: dict[str, Path] | None = None,
    ) -> None:
        remaining = _missing_asset_items(resources, attachments_dir=attachments_dir)
        if not remaining:
            return
        final_paths = _id_to_final_paths(
            remaining,
            attachments_dir=attachments_dir,
            safe_board=safe_board,
            is_image=is_image,
        )
        for attempt in range(1, 4):
            download_all(
                remaining,
                attachments_dir,
                token,
                "rest",
                safe_board,
                is_image=is_image,
                strategy="overwrite",
                id_to_final_path=final_paths,
                inline_slot_map=inline_slot_map,
                inline_image_url_map=inline_image_url_map,
                inline_image_id_map=inline_image_id_map,
                gui_root=_ImmediateCallbackTarget(),
                on_file_fail=on_fail,
            )
            remaining = _missing_asset_items(remaining, attachments_dir=attachments_dir)
            if not remaining:
                return
            if logger and attempt < 3:
                logger(
                    f"asset_retry label={label} attempt={attempt + 1} remaining={len(remaining)}"
                )

    def on_fail(item_id: str, reason: str) -> None:
        if logger:
            logger(f"asset_failed id={item_id} reason={reason}")

    def on_optional_fail(item_id: str, reason: str) -> None:
        if logger:
            logger(f"asset_optional_failed id={item_id} reason={reason}")

    downloadable_images = [
        item for item in images if _first_data_url(item, ("imageUrl",))
    ]
    run_download_passes(downloadable_images, is_image=True, label="images")

    image_src_map, slot_map, image_id_map = _build_image_maps(images, attachments_dir)

    downloadable_documents = [
        item for item in documents if _first_data_url(item, ("documentUrl",))
    ]
    run_download_passes(downloadable_documents, is_image=False, label="documents")

    run_download_passes(
        doc_formats,
        is_image=False,
        label="doc_formats",
        inline_slot_map=slot_map,
        inline_image_url_map=image_src_map,
        inline_image_id_map=image_id_map,
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
        local_name = str(item.get("local_name") or "")
        if (
            not _validate_downloaded_assets([item], attachments_dir=attachments_dir)
            and (attachments_dir / local_name).suffix.lower() in IMAGE_EXTS
        ):
            continue
        if not final_path or not preview_url:
            continue
        got_path = download_resource_with_redirect(
            preview_url,
            final_path,
            token,
            overwrite_when_guessing_ext=True,
            expected_kind="image",
        )
        if got_path and got_path.suffix.lower() in IMAGE_EXTS:
            item["local_name"] = got_path.name
        else:
            if got_path:
                try:
                    got_path.unlink(missing_ok=True)
                except OSError:
                    pass
            on_optional_fail(
                item_id, "embed preview download failed or was not an image"
            )

    required_resources = images + documents + doc_formats
    missing_assets = _validate_downloaded_assets(
        required_resources, attachments_dir=attachments_dir
    )
    optional_missing = _validate_downloaded_assets(
        embeds, attachments_dir=attachments_dir
    )
    failed = len(missing_assets)
    if missing_assets:
        for reason in missing_assets:
            if logger:
                logger(f"asset_missing {reason}")
        if strict:
            shown = "; ".join(missing_assets[:5])
            more = (
                "" if len(missing_assets) <= 5 else f"; +{len(missing_assets) - 5} more"
            )
            raise RuntimeError(f"Asset download incomplete: {shown}{more}")
    if logger:
        for reason in optional_missing:
            logger(f"asset_optional_missing {reason}")

    stats = {
        "images": len(images),
        "documents": len(documents),
        "doc_formats": len(doc_formats),
        "embeds": len(embeds),
        "failed": failed,
        "optional_failed": len(optional_missing),
    }
    if logger:
        logger(
            "assets="
            f"images:{stats['images']} documents:{stats['documents']} "
            f"doc_formats:{stats['doc_formats']} embeds:{stats['embeds']} "
            f"failed:{stats['failed']} optional_failed:{stats['optional_failed']}"
        )
    return stats


def stable_enrichment_items(payload: dict[str, Any]) -> list[dict[str, Any]]:
    provenance = payload.get("provenance")
    assets = provenance.get("assets") if isinstance(provenance, dict) else None
    enrichment = (
        assets.get("stable_enrichment") if isinstance(assets, dict) else None
    )
    if enrichment is None:
        return []
    items = enrichment.get("items") if isinstance(enrichment, dict) else None
    if not isinstance(items, list) or any(not isinstance(item, dict) for item in items):
        raise ValueError("REST stable asset enrichment items must be a list of objects")
    return items


def _required_int(mapping: dict[str, Any], key: str, *, label: str) -> int:
    value = mapping.get(key)
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise ValueError(f"{label}.{key} must be a nonnegative integer")
    return value


def validate_rest_payload_integrity(
    payload: dict[str, Any],
    *,
    require_complete: bool = True,
) -> None:
    items = payload.get("items")
    comments = payload.get("comments")
    if not isinstance(items, list) or any(not isinstance(item, dict) for item in items):
        raise ValueError("REST payload items must be a list of objects")
    if not isinstance(comments, list) or any(
        not isinstance(comment, dict) for comment in comments
    ):
        raise ValueError("REST payload comments must be a list of objects")

    provenance = payload.get("provenance")
    if not isinstance(provenance, dict):
        raise ValueError("REST payload provenance is required")
    item_provenance = provenance.get("items")
    comment_provenance = provenance.get("comments")
    if (
        not isinstance(item_provenance, dict)
        or item_provenance.get("complete") is not True
    ):
        raise ValueError("REST provenance.items.complete must be true")
    if (
        not isinstance(comment_provenance, dict)
        or comment_provenance.get("complete") is not True
    ):
        raise ValueError("REST provenance.comments.complete must be true")

    item_count = _required_int(item_provenance, "item_count", label="provenance.items")
    raw_item_count = _required_int(
        item_provenance, "raw_count", label="provenance.items"
    )
    if item_count != len(items) or raw_item_count < item_count:
        raise ValueError("REST provenance item counts do not match items")
    declared_sources = item_provenance.get("sources")
    actual_sources = Counter(str(item.get("source") or "unknown") for item in items)
    if not isinstance(declared_sources, dict) or declared_sources != dict(
        sorted(actual_sources.items())
    ):
        raise ValueError("REST provenance.items.sources does not match items")

    comment_count = _required_int(
        comment_provenance, "comment_count", label="provenance.comments"
    )
    raw_comment_count = _required_int(
        comment_provenance, "raw_count", label="provenance.comments"
    )
    if comment_count != len(comments) or raw_comment_count < comment_count:
        raise ValueError("REST provenance comment counts do not match comments")

    asset_provenance = provenance.get("assets")
    if not isinstance(asset_provenance, dict) or not str(
        asset_provenance.get("strategy") or ""
    ).strip():
        raise ValueError("REST provenance.assets.strategy is required")
    if payload.get("exporter_version") == REST_EXPORTER_VERSION:
        copied = _required_int(
            asset_provenance,
            "local_names_copied",
            label="provenance.assets",
        )
        stable_metadata = asset_provenance.get("stable_enrichment")
        stable_items = stable_enrichment_items(payload)
        if stable_metadata is None:
            if copied != 0 or asset_provenance.get("strategy") != "source_items_only":
                raise ValueError("REST stable asset enrichment metadata is inconsistent")
        else:
            if (
                not isinstance(stable_metadata, dict)
                or stable_metadata.get("complete") is not True
                or stable_metadata.get("requested_items_source") != "rest_v2"
                or asset_provenance.get("strategy")
                != "experimental_items_with_stable_local_name_enrichment"
            ):
                raise ValueError("REST stable asset enrichment metadata is invalid")
            stable_count = _required_int(
                stable_metadata,
                "item_count",
                label="provenance.assets.stable_enrichment",
            )
            stable_raw_count = _required_int(
                stable_metadata,
                "raw_count",
                label="provenance.assets.stable_enrichment",
            )
            stable_sources = Counter(
                str(item.get("source") or "unknown") for item in stable_items
            )
            if (
                stable_count != len(stable_items)
                or stable_raw_count < stable_count
                or copied > stable_count
                or stable_metadata.get("sources")
                != dict(sorted(stable_sources.items()))
            ):
                raise ValueError("REST stable asset enrichment counts are inconsistent")

    completeness = payload.get("completeness")
    if not isinstance(completeness, dict):
        raise ValueError("REST payload completeness is required")
    item_status = completeness.get("items")
    comment_status = completeness.get("comments")
    assets = completeness.get("assets")
    if not isinstance(item_status, dict) or item_status.get("complete") is not True:
        raise ValueError("REST completeness.items.complete must be true")
    if (
        not isinstance(comment_status, dict)
        or comment_status.get("complete") is not True
    ):
        raise ValueError("REST completeness.comments.complete must be true")
    if not isinstance(assets, dict):
        raise ValueError("REST completeness.assets is required")
    missing = assets.get("missing")
    optional_missing = assets.get("optional_missing")
    requirements = assets.get("requirements")
    if (
        not isinstance(missing, list)
        or not isinstance(optional_missing, list)
        or not isinstance(requirements, dict)
    ):
        raise ValueError("REST asset completeness metadata is malformed")
    requirement_counts = {
        key: _required_int(requirements, key, label="completeness.assets.requirements")
        for key in (
            "images",
            "documents",
            "doc_formats",
            "embeds",
            "failed",
            "optional_failed",
        )
    }
    if requirement_counts["failed"] != len(missing):
        raise ValueError(
            "REST required asset failure count does not match missing files"
        )
    if requirement_counts["optional_failed"] != len(optional_missing):
        raise ValueError(
            "REST optional asset failure count does not match optional missing files"
        )
    assets_complete = assets.get("complete") is True
    if assets_complete != (not missing):
        raise ValueError("REST asset completeness does not match missing files")
    required_total = sum(
        requirement_counts[key] for key in ("images", "documents", "doc_formats")
    )
    if assets_complete and required_total and assets.get("checked") is not True:
        raise ValueError("REST required assets must be checked")
    expected_complete = assets_complete
    if completeness.get("complete") is not expected_complete:
        raise ValueError("REST top-level completeness does not match component status")
    if require_complete and not expected_complete:
        raise ValueError("REST payload is incomplete")


def _copy_asset_local_names(
    base_items: list[dict[str, Any]], donor_items: list[dict[str, Any]]
) -> int:
    donor_names = {
        str(item.get("id")): str(item.get("local_name") or "")
        for item in donor_items
        if item.get("id") is not None and item.get("local_name")
    }
    copied = 0
    for item in base_items:
        local_name = donor_names.get(str(item.get("id") or ""))
        if local_name and not item.get("local_name"):
            item["local_name"] = local_name
            copied += 1
    return copied


def _build_complete_board_source(
    *,
    board_id: str,
    token: str,
    output_path: Path,
    prefer_experimental: bool = True,
    download_assets: bool = True,
    allow_missing_assets: bool = False,
    board_name: str | None = None,
    board_url: str | None = None,
    logger: Any | None = None,
) -> tuple[dict[str, Any], dict[str, Any]]:
    """Write the richest proven REST source without replacing canonical items."""
    messages: list[str] = []

    def log(message: str) -> None:
        messages.append(message)
        if logger:
            logger(message)

    item_provenance: dict[str, Any] = {}
    comment_provenance: dict[str, Any] = {}
    items = export_board_items(
        board_id=board_id,
        token=token,
        prefer_experimental=prefer_experimental,
        logger=log,
        metadata=item_provenance,
    )
    comments = export_board_comments(
        board_id=board_id,
        token=token,
        logger=log,
        metadata=comment_provenance,
    )

    requirements = summarize_export_asset_requirements(items)
    missing_assets: list[str] = []
    optional_missing: list[str] = []
    stable_asset_provenance: dict[str, Any] | None = None
    copied = 0
    if download_assets:
        download_export_assets(
            items, output_path=output_path, token=token, logger=log, strict=False
        )
        missing_assets = validate_export_assets(items, output_path=output_path)
        if missing_assets and prefer_experimental:
            stable_asset_provenance = {}
            stable_items = export_board_items(
                board_id=board_id,
                token=token,
                prefer_experimental=False,
                logger=log,
                metadata=stable_asset_provenance,
            )
            download_export_assets(
                stable_items,
                output_path=output_path,
                token=token,
                logger=log,
                strict=False,
            )
            stable_asset_provenance["items"] = deepcopy(stable_items)
            copied = _copy_asset_local_names(items, stable_items)
            missing_assets = validate_export_assets(items, output_path=output_path)
            log(f"asset_bridge copied={copied} missing={len(missing_assets)}")
    elif sum(requirements[key] for key in ("images", "documents", "doc_formats")):
        missing_assets = ["asset download disabled"]
    optional_missing = validate_optional_export_assets(items, output_path=output_path)
    if missing_assets and not allow_missing_assets:
        shown = "; ".join(missing_assets[:5])
        more = "" if len(missing_assets) <= 5 else f"; +{len(missing_assets) - 5} more"
        raise RuntimeError(f"Asset validation incomplete: {shown}{more}")

    asset_stats = {
        **requirements,
        "failed": len(missing_assets),
        "optional_failed": len(optional_missing),
    }
    if stable_asset_provenance is not None:
        asset_stats["bridged"] = copied
    asset_complete = not missing_assets
    completeness = {
        "complete": bool(
            item_provenance.get("complete") is True
            and comment_provenance.get("complete") is True
            and asset_complete
        ),
        "items": {"complete": item_provenance.get("complete") is True},
        "comments": {"complete": comment_provenance.get("complete") is True},
        "assets": {
            "complete": asset_complete,
            "checked": download_assets,
            "missing": missing_assets,
            "optional_missing": optional_missing,
            "requirements": dict(asset_stats),
        },
    }
    payload = build_board_source_payload(
        items,
        comments,
        board_id=board_id,
        provenance={
            "board_id": board_id,
            "items": item_provenance,
            "comments": comment_provenance,
            "assets": {
                "strategy": (
                    "experimental_items_with_stable_local_name_enrichment"
                    if stable_asset_provenance is not None
                    else "source_items_only"
                ),
                "stable_enrichment": stable_asset_provenance,
                "local_names_copied": copied,
            },
        },
        completeness=completeness,
    )
    if board_name:
        payload["board"].setdefault("name", board_name)
    if board_url:
        payload["board"].setdefault("url", board_url)
    validate_rest_payload_integrity(payload, require_complete=not allow_missing_assets)
    write_json(output_path, payload)
    return payload, {
        "path": str(output_path),
        "items": len(items),
        "comments": len(comments),
        "asset_stats": asset_stats,
        "log_tail": messages[-10:],
        "prefer_experimental": prefer_experimental,
        "download_assets": download_assets,
        "complete": completeness["complete"],
        "degraded": not completeness["complete"],
        "missing_assets": missing_assets,
        "completeness": completeness,
    }


def export_complete_board_source(
    *,
    board_id: str,
    token: str,
    output_path: Path,
    prefer_experimental: bool = True,
    download_assets: bool = True,
    allow_missing_assets: bool = False,
    board_name: str | None = None,
    board_url: str | None = None,
    logger: Any | None = None,
) -> tuple[dict[str, Any], dict[str, Any]]:
    """Build and publish one self-consistent REST JSON/sidecar bundle."""
    with staged_export_path(output_path) as staged_json:
        payload, info = _build_complete_board_source(
            board_id=board_id,
            token=token,
            output_path=staged_json,
            prefer_experimental=prefer_experimental,
            download_assets=download_assets,
            allow_missing_assets=allow_missing_assets,
            board_name=board_name,
            board_url=board_url,
            logger=logger,
        )
        publish_staged_bundle(staged_json, output_path)
    info["path"] = str(output_path)
    return payload, info


def resolve_token_from_args(args: argparse.Namespace) -> str:
    if args.oauth:
        from scripts.miro_oauth_token import (
            authorize_and_get_token,
            config_from_env,
            exchange_manual_authorization,
        )

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
                config, code=args.oauth_code, callback_url=args.oauth_callback_url
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


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Export a Miro board through the existing REST downloader path."
    )
    parser.add_argument("--board-id", required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument(
        "--stable-items",
        action="store_true",
        help="Use stable v2 items instead of v2-experimental.",
    )
    parser.add_argument(
        "--no-download-assets",
        action="store_true",
        help="Write JSON only; do not create the sidecar _files folder.",
    )
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
    parser.add_argument("--oauth-scopes", default=DEFAULT_SCOPES)
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
    _payload, info = export_complete_board_source(
        board_id=args.board_id,
        token=token,
        output_path=args.output,
        prefer_experimental=not args.stable_items,
        download_assets=not args.no_download_assets,
        allow_missing_assets=args.allow_missing_assets,
    )
    print(f"items={info['items']}")
    print(f"comments={info['comments']}")
    print(f"complete={str(info['complete']).lower()}")
    print(f"output={args.output}")
    for message in info["log_tail"][-5:]:
        print(f"log={message}")
    return 0 if info["complete"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
