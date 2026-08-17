from __future__ import annotations

import math
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

from Json_2_Canvas.Converter import convert_miro_to_canvas, source_completeness_issues
from Json_2_Canvas.Scale_engine import OBSIDIAN_FONT_SIZE, ViewProfile, compute_scale_preview
from scripts.miro_export_bundle import staged_export_path
from scripts.merge_miro_sources import (
    finalize_merged_export,
    merge_sources,
    validate_canonical_export,
    validate_rest_export,
)
from scripts.miro_capability_probe import load_json
from scripts.miro_rest_export_board import export_complete_board_source
from scripts.obsidian_plugin_setup import (
    ADVANCED_CANVAS_VERSION,
    setup_obsidian_plugins,
)


@dataclass(frozen=True)
class PipelineResult:
    source_json: Path
    canvas_path: Path
    item_count: int
    asset_stats: dict[str, int]
    scale: float
    scale_context: dict[str, Any]
    messages: list[str]
    completeness: dict[str, Any] = field(default_factory=dict)


def pipeline_result_is_degraded(result: PipelineResult) -> bool:
    return bool(result.completeness) and result.completeness.get("complete") is not True


def _validated_scale(value: Any) -> float:
    if isinstance(value, bool):
        raise ValueError("scale must be a positive finite number")
    try:
        scale = float(value)
    except (TypeError, ValueError) as exc:
        raise ValueError("scale must be a positive finite number") from exc
    if not math.isfinite(scale) or scale <= 0:
        raise ValueError("scale must be a positive finite number")
    return scale


def resolve_scale(
    source_json: Path,
    *,
    explicit_scale: float | None,
    profile: ViewProfile,
) -> tuple[float, dict[str, Any]]:
    if explicit_scale is not None:
        return _validated_scale(explicit_scale), {"scale_source": "explicit"}

    info = compute_scale_preview(str(source_json), profile, OBSIDIAN_FONT_SIZE)
    context = dict(info.get("context") or {})
    context["scale_source"] = "auto"
    return _validated_scale(info["scale"]), context


def run_rest_experimental_pipeline(
    *,
    board_id: str,
    token: str,
    source_json: Path,
    target_dir: Path,
    vault_root: Path,
    scale: float | None = None,
    view_profile: ViewProfile | None = None,
    min_font_px: int = 8,
    theme: str = "dark",
    text_style_mode: str = "miro",
    allow_missing_assets: bool = False,
    prefer_experimental: bool = True,
    websdk_json: Path | None = None,
    install_obsidian_plugins: bool = False,
    advanced_canvas_source_plugins_dir: Path | None = None,
    advanced_canvas_version: str = ADVANCED_CANVAS_VERSION,
    attachment_dir: Path | None = None,
    logger: Callable[[str], None] | None = None,
) -> PipelineResult:
    messages: list[str] = []

    def log(message: str) -> None:
        messages.append(message)
        if logger:
            logger(message)

    source_json = Path(source_json)
    target_dir = Path(target_dir)
    vault_root = Path(vault_root)
    attachment_dir = Path(attachment_dir) if attachment_dir else None
    profile = view_profile or ViewProfile(min_font_px=min_font_px)
    if scale is not None:
        _validated_scale(scale)
    if websdk_json is not None and allow_missing_assets:
        raise ValueError(
            "Web SDK union requires a complete REST asset source; "
            "--allow-missing-assets is diagnostic-only."
        )

    rest_label = "REST v2-experimental" if prefer_experimental else "REST v2 stable"
    log(f"Exporting the complete board through {rest_label}.")
    if websdk_json is None:
        payload, export_info = export_complete_board_source(
            board_id=board_id,
            token=token,
            output_path=source_json,
            prefer_experimental=prefer_experimental,
            download_assets=True,
            allow_missing_assets=allow_missing_assets,
            logger=log,
        )
    else:
        websdk_json = Path(websdk_json)
        with staged_export_path(source_json) as staged_rest_json:
            payload, export_info = export_complete_board_source(
                board_id=board_id,
                token=token,
                output_path=staged_rest_json,
                prefer_experimental=prefer_experimental,
                download_assets=True,
                allow_missing_assets=False,
                logger=log,
            )
            log(f"Merging verified Web SDK export: {websdk_json}")
            merged = merge_sources(
                payload,
                load_json(websdk_json),
                board_id=board_id,
            )
            payload = finalize_merged_export(
                merged,
                source_json=staged_rest_json,
                output_json=source_json,
                token=token,
            )
        log("Canonical REST + Web SDK union is complete.")

    if install_obsidian_plugins:
        log(
            "Installing/enabling Advanced Canvas and Canvas Zoom Unlock in the selected vault."
        )
        setup_obsidian_plugins(
            vault_root,
            advanced_source_plugins_dir=advanced_canvas_source_plugins_dir,
            advanced_version=advanced_canvas_version,
            logger=log,
        )

    items = payload["items"]
    completeness = dict(payload["completeness"])
    asset_stats = dict(
        (completeness.get("assets") or {}).get("requirements")
        or export_info["asset_stats"]
    )

    selected_scale, scale_context = resolve_scale(
        source_json,
        explicit_scale=scale,
        profile=profile,
    )
    log(
        f"Converting through the single Converter.py path at scale={selected_scale:.6f}."
    )
    target_dir.mkdir(parents=True, exist_ok=True)
    canvas_path = Path(
        convert_miro_to_canvas(
            str(source_json),
            str(target_dir),
            str(vault_root),
            scale=selected_scale,
            min_font_px=min_font_px,
            theme=theme,
            text_style_mode=text_style_mode,
            attachment_dir=str(attachment_dir) if attachment_dir else None,
        )
    )
    log(f"Canvas written: {canvas_path}")

    return PipelineResult(
        source_json=source_json,
        canvas_path=canvas_path,
        item_count=len(items),
        asset_stats=asset_stats,
        scale=selected_scale,
        scale_context=scale_context,
        messages=messages,
        completeness=completeness,
    )


def inspect_existing_source(source_json: Path) -> tuple[Any, dict[str, Any]]:
    try:
        payload = load_json(Path(source_json))
    except (OSError, ValueError) as exc:
        raise ValueError(f"Existing JSON cannot be read: {exc}") from exc

    issues: list[str] = []
    surface = payload.get("source_surface") if isinstance(payload, dict) else None
    validator = {
        "rest": validate_rest_export,
        "canonical": validate_canonical_export,
    }.get(str(surface))
    if validator is None:
        issues.append("source is not a verified REST or canonical board envelope")
    else:
        try:
            validator(payload, max_age_hours=-1)
        except ValueError as exc:
            issues.append(str(exc))

    declared = payload.get("completeness") if isinstance(payload, dict) else None
    if not isinstance(declared, dict):
        issues.append("completeness envelope is missing")
        declared = {}
    else:
        issues.extend(
            issue
            for issue in source_completeness_issues(payload)
            if issue != "completeness.board_complete is false"
        )
        required_sections = {
            "rest": ("items", "comments", "assets"),
            "canonical": ("rest", "web_sdk", "comments", "assets"),
        }.get(str(surface), ())
        for section_name in required_sections:
            if section_name not in declared:
                issues.append(f"completeness.{section_name} is missing")
        assets = declared.get("assets")
        if isinstance(assets, dict) and assets.get("checked") is not True:
            issues.append("completeness.assets.checked is not true")

    issues = list(dict.fromkeys(issues))
    completeness = {
        **declared,
        "complete": not issues,
        "verified": not issues,
        "issues": issues,
    }
    return payload, completeness


def run_existing_json_pipeline(
    *,
    source_json: Path,
    target_dir: Path,
    vault_root: Path,
    scale: float | None = None,
    view_profile: ViewProfile | None = None,
    min_font_px: int = 8,
    theme: str = "dark",
    text_style_mode: str = "miro",
    allow_incomplete_source: bool = False,
    install_obsidian_plugins: bool = False,
    advanced_canvas_source_plugins_dir: Path | None = None,
    advanced_canvas_version: str = ADVANCED_CANVAS_VERSION,
    attachment_dir: Path | None = None,
    logger: Callable[[str], None] | None = None,
) -> PipelineResult:
    messages: list[str] = []

    def log(message: str) -> None:
        messages.append(message)
        if logger:
            logger(message)

    source_json = Path(source_json)
    target_dir = Path(target_dir)
    vault_root = Path(vault_root)
    attachment_dir = Path(attachment_dir) if attachment_dir else None
    profile = view_profile or ViewProfile(min_font_px=min_font_px)
    if scale is not None:
        _validated_scale(scale)
    payload, completeness = inspect_existing_source(source_json)
    if completeness["issues"] and not allow_incomplete_source:
        raise ValueError(
            "Existing JSON is incomplete or unverified: "
            + "; ".join(completeness["issues"])
            + ". Use --allow-incomplete-source only for an explicitly degraded conversion."
        )
    if completeness["issues"]:
        log(
            "WARNING: converting explicitly allowed incomplete/unverified Existing JSON: "
            + "; ".join(completeness["issues"])
        )

    if install_obsidian_plugins:
        log(
            "Installing/enabling Advanced Canvas and Canvas Zoom Unlock in the selected vault."
        )
        setup_obsidian_plugins(
            vault_root,
            advanced_source_plugins_dir=advanced_canvas_source_plugins_dir,
            advanced_version=advanced_canvas_version,
            logger=log,
        )

    selected_scale, scale_context = resolve_scale(
        source_json,
        explicit_scale=scale,
        profile=profile,
    )
    log(f"Converting existing JSON through Converter.py at scale={selected_scale:.6f}.")
    target_dir.mkdir(parents=True, exist_ok=True)
    canvas_path = Path(
        convert_miro_to_canvas(
            str(source_json),
            str(target_dir),
            str(vault_root),
            scale=selected_scale,
            min_font_px=min_font_px,
            theme=theme,
            text_style_mode=text_style_mode,
            attachment_dir=str(attachment_dir) if attachment_dir else None,
        )
    )
    log(f"Canvas written: {canvas_path}")

    return PipelineResult(
        source_json=source_json,
        canvas_path=canvas_path,
        item_count=len(payload.get("items", []))
        if isinstance(payload, dict) and isinstance(payload.get("items"), list)
        else 0,
        asset_stats={},
        scale=selected_scale,
        scale_context=scale_context,
        messages=messages,
        completeness=completeness,
    )


