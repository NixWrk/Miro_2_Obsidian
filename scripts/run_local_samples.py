from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import sys
import tempfile
from collections import Counter
from pathlib import Path
from typing import Any


REPO_ROOT = Path(__file__).resolve().parents[1]
CONVERTER_DIR = REPO_ROOT / "Json_2_Canvas"
RENDER_DIR = REPO_ROOT / "tools" / "canvas_render"
ORACLE_DIR = REPO_ROOT / "tools" / "obsidian_oracle"
DEFAULT_SAMPLE_ROOT = REPO_ROOT / "work" / "MIRO2OBSIDIAN"
DEFAULT_OUT_DIR = RENDER_DIR / ".out" / "local_samples"

sys.path.insert(0, str(CONVERTER_DIR))

from Converter import convert_miro_to_canvas  # noqa: E402
from Scale_engine import (  # noqa: E402
    OBSIDIAN_FONT_SIZE,
    ViewProfile,
    compute_scale_preview,
    normalize_scale_mode,
)


class SampleError(RuntimeError):
    pass


def load_json(path: Path) -> Any:
    with path.open("r", encoding="utf-8-sig") as f:
        return json.load(f)


def safe_name(path: Path) -> str:
    name = re.sub(r'[<>:"/\\|?*]+', "_", path.stem).strip(". ")
    digest = hashlib.sha1(str(path).encode("utf-8")).hexdigest()[:8]
    return f"{name or 'sample'}_{digest}"


def discover_samples(sample_root: Path, *, include_miro_json: bool) -> list[Path]:
    preferred_roots = [sample_root / "web_test"]
    if include_miro_json:
        preferred_roots.append(sample_root / "Miro_2_JSON")

    samples: list[Path] = []
    for root in preferred_roots:
        if root.exists():
            samples.extend(root.glob("*.json"))
    if not samples and include_miro_json and sample_root.exists():
        samples.extend(sample_root.rglob("*.json"))
    return sorted(samples, key=lambda p: str(p).lower())


def select_samples(samples: list[Path], selectors: list[str]) -> list[Path]:
    if not selectors:
        return samples

    selected: list[Path] = []
    for selector in selectors:
        selector_path = Path(selector)
        if selector_path.exists():
            selected.append(selector_path.resolve())
            continue

        matched = [
            sample for sample in samples
            if selector.lower() in sample.name.lower()
            or selector.lower() in sample.stem.lower()
        ]
        if not matched:
            raise SystemExit(f"No local sample matched: {selector}")
        selected.extend(matched)

    unique: dict[str, Path] = {}
    for sample in selected:
        unique[str(sample.resolve())] = sample
    return sorted(unique.values(), key=lambda p: str(p).lower())


def copy_sidecar_files(source_json: Path, work_json: Path) -> None:
    source_files = source_json.with_name(source_json.stem + "_files")
    if source_files.exists():
        shutil.copytree(source_files, work_json.with_name(work_json.stem + "_files"))


def validate_canvas(canvas: dict[str, Any], vault_root: Path, *, strict_files: bool) -> Counter[str]:
    if not isinstance(canvas, dict):
        raise SampleError("Canvas root is not an object")
    nodes = canvas.get("nodes")
    edges = canvas.get("edges")
    if not isinstance(nodes, list):
        raise SampleError("Canvas has no nodes list")
    if not isinstance(edges, list):
        raise SampleError("Canvas has no edges list")
    if not nodes:
        raise SampleError("Canvas has no nodes")

    node_ids: set[str] = set()
    node_types: Counter[str] = Counter()
    missing_files: list[str] = []

    for idx, node in enumerate(nodes):
        if not isinstance(node, dict):
            raise SampleError(f"Node #{idx} is not an object")
        for key in ("id", "type", "x", "y", "width", "height"):
            if key not in node:
                raise SampleError(f"Node #{idx} is missing {key!r}")

        node_id = str(node["id"])
        if not node_id:
            raise SampleError(f"Node #{idx} has empty id")
        if node_id in node_ids:
            raise SampleError(f"Duplicate node id: {node_id}")
        node_ids.add(node_id)

        try:
            width = float(node["width"])
            height = float(node["height"])
        except (TypeError, ValueError) as exc:
            raise SampleError(f"Node {node_id} has non-numeric size") from exc
        if width <= 0 or height <= 0:
            raise SampleError(f"Node {node_id} has non-positive size")

        node_type = str(node.get("type") or "")
        node_types[node_type] += 1
        if strict_files and node_type == "file":
            rel = str(node.get("file") or "")
            if not rel:
                missing_files.append(f"{node_id}: <empty>")
            else:
                file_path = vault_root / Path(rel.replace("/", os.sep))
                if not file_path.exists():
                    missing_files.append(f"{node_id}: {rel}")

    for idx, edge in enumerate(edges):
        if not isinstance(edge, dict):
            raise SampleError(f"Edge #{idx} is not an object")
        for key in ("id", "fromNode", "toNode"):
            if key not in edge:
                raise SampleError(f"Edge #{idx} is missing {key!r}")
        if str(edge["fromNode"]) not in node_ids:
            raise SampleError(f"Edge #{idx} points from missing node")
        if str(edge["toNode"]) not in node_ids:
            raise SampleError(f"Edge #{idx} points to missing node")

    if missing_files:
        shown = "; ".join(missing_files[:5])
        more = "" if len(missing_files) <= 5 else f"; +{len(missing_files) - 5} more"
        raise SampleError(f"Missing file node targets: {shown}{more}")

    return node_types


def canvas_bbox(canvas: dict[str, Any]) -> dict[str, float]:
    xs: list[float] = []
    ys: list[float] = []
    xe: list[float] = []
    ye: list[float] = []
    for node in canvas.get("nodes", []):
        try:
            x = float(node["x"])
            y = float(node["y"])
            width = float(node["width"])
            height = float(node["height"])
        except (KeyError, TypeError, ValueError):
            continue
        xs.append(x)
        ys.append(y)
        xe.append(x + width)
        ye.append(y + height)

    if not xs:
        return {"width": 0.0, "height": 0.0}
    return {"width": max(xe) - min(xs), "height": max(ye) - min(ys)}


def check_canvas_fit(canvas: dict[str, Any], profile: ViewProfile) -> dict[str, float]:
    bbox = canvas_bbox(canvas)
    screen_w = bbox["width"] * profile.min_zoom
    screen_h = bbox["height"] * profile.min_zoom
    fits = screen_w <= profile.width and screen_h <= profile.height
    mode = normalize_scale_mode(profile.scale_mode)
    if not fits and mode != "readable":
        raise SampleError(
            "Canvas does not fit target viewport at min zoom: "
            f"bbox={bbox['width']:.2f}x{bbox['height']:.2f}, "
            f"screen@{profile.min_zoom:g}={screen_w:.2f}x{screen_h:.2f}, "
            f"target={profile.width}x{profile.height}"
        )
    return {
        **bbox,
        "screen_width": screen_w,
        "screen_height": screen_h,
        "fits": 1.0 if fits else 0.0,
    }


def resolve_scale(sample_json: Path, explicit_scale: float | None, profile: ViewProfile) -> float:
    if explicit_scale is not None:
        return float(explicit_scale)
    info = compute_scale_preview(str(sample_json), profile, OBSIDIAN_FONT_SIZE)
    return float(info["scale"])


def oracle_target(sample_key: str) -> tuple[Path, Path]:
    sys.path.insert(0, str(ORACLE_DIR))
    from common import load_config, vault_path  # noqa: WPS433

    config = load_config()
    vault_root = vault_path(config)
    target_dir = (
        vault_root
        / str(config["work_folder"])
        / str(config.get("local_samples_subfolder", "_local_samples"))
        / sample_key
    )
    target_dir.mkdir(parents=True, exist_ok=True)
    return vault_root, target_dir


def render_canvas(canvas_path: Path, screenshot_path: Path, *, fit_viewport: bool) -> None:
    sys.path.insert(0, str(RENDER_DIR))
    from capture_fixture import capture_canvas  # noqa: WPS433

    capture_canvas(canvas_path, screenshot_path, fit_viewport=fit_viewport)


def run_sample(
    sample_json: Path,
    *,
    out_dir: Path,
    scale: float | None,
    min_font_px: int,
    theme: str,
    skip_render: bool,
    strict_files: bool,
    stage_vault: bool,
    fit_render: bool,
    scale_profile: ViewProfile,
    fit_profile: ViewProfile | None,
) -> tuple[Path, Counter[str], float, dict[str, float] | None]:
    sample_key = safe_name(sample_json)
    scale_used = resolve_scale(sample_json, scale, scale_profile)

    if stage_vault:
        vault_root, target_dir = oracle_target(sample_key)
        with tempfile.TemporaryDirectory(prefix=f"miro2obs_local_{sample_key}_") as tmp:
            work_json = Path(tmp) / sample_json.name
            shutil.copy2(sample_json, work_json)
            copy_sidecar_files(sample_json, work_json)
            canvas_path = Path(convert_miro_to_canvas(
                str(work_json),
                str(target_dir),
                str(vault_root),
                scale=scale_used,
                min_font_px=min_font_px,
                theme=theme,
            ))
    else:
        with tempfile.TemporaryDirectory(prefix=f"miro2obs_local_{sample_key}_") as tmp:
            work_dir = Path(tmp)
            work_json = work_dir / sample_json.name
            shutil.copy2(sample_json, work_json)
            copy_sidecar_files(sample_json, work_json)

            vault_root = work_dir / "vault"
            target_dir = vault_root / "MIRO2OBSIDIAN" / "_local_samples" / sample_key
            target_dir.mkdir(parents=True, exist_ok=True)
            canvas_path = Path(convert_miro_to_canvas(
                str(work_json),
                str(target_dir),
                str(vault_root),
                scale=scale_used,
                min_font_px=min_font_px,
                theme=theme,
            ))

            canvas = load_json(canvas_path)
            node_types = validate_canvas(canvas, vault_root, strict_files=strict_files)
            fit_bbox = check_canvas_fit(canvas, fit_profile) if fit_profile else None

            debug_dir = out_dir / sample_key
            debug_dir.mkdir(parents=True, exist_ok=True)
            debug_canvas = debug_dir / canvas_path.name
            shutil.copy2(canvas_path, debug_canvas)

            if not skip_render:
                render_canvas(canvas_path, debug_dir / f"{canvas_path.stem}.render.png", fit_viewport=fit_render)

            return debug_canvas, node_types, scale_used, fit_bbox

    canvas = load_json(canvas_path)
    node_types = validate_canvas(canvas, vault_root, strict_files=strict_files)
    fit_bbox = check_canvas_fit(canvas, fit_profile) if fit_profile else None

    if not skip_render:
        debug_dir = out_dir / sample_key
        debug_dir.mkdir(parents=True, exist_ok=True)
        render_canvas(canvas_path, debug_dir / f"{canvas_path.stem}.render.png", fit_viewport=fit_render)

    return canvas_path, node_types, scale_used, fit_bbox


def main() -> int:
    parser = argparse.ArgumentParser(description="Run converter checks against local work Miro samples.")
    parser.add_argument("samples", nargs="*", help="Sample filename/path fragments. Defaults to all discovered JSON files.")
    parser.add_argument("--sample-root", type=Path, default=DEFAULT_SAMPLE_ROOT)
    parser.add_argument("--out-dir", type=Path, default=DEFAULT_OUT_DIR)
    parser.add_argument("--scale", type=float, default=None, help="Explicit scale. Defaults to Scale_engine auto-fit.")
    parser.add_argument("--min-font-px", type=int, default=8)
    parser.add_argument("--theme", default="dark")
    parser.add_argument("--viewport-width", type=int, default=1920)
    parser.add_argument("--viewport-height", type=int, default=1080)
    parser.add_argument("--min-zoom", type=float, default=0.12)
    parser.add_argument("--fit-margin", type=float, default=0.95)
    parser.add_argument(
        "--scale-mode",
        choices=["balanced", "overview", "readable"],
        default="balanced",
        help="Scale policy: balanced caps readability by fit, overview always fits, readable prioritizes readability.",
    )
    parser.add_argument("--skip-fit-check", action="store_true")
    parser.add_argument("--skip-render", action="store_true")
    parser.add_argument("--include-miro-json", action="store_true", help="Also discover work/MIRO2OBSIDIAN/Miro_2_JSON.")
    parser.add_argument("--allow-missing-files", action="store_true")
    parser.add_argument("--stage-vault", action="store_true", help="Write converted canvases into the local oracle vault.")
    parser.add_argument("--raw-render", action="store_true", help="Capture the full stage instead of a fitted viewport.")
    args = parser.parse_args()

    samples = discover_samples(args.sample_root, include_miro_json=args.include_miro_json)
    if not samples:
        raise SystemExit(f"No local Miro JSON samples found under {args.sample_root}")
    selected = select_samples(samples, args.samples)
    scale_profile = ViewProfile(
        width=args.viewport_width,
        height=args.viewport_height,
        min_zoom=args.min_zoom,
        fit_margin=args.fit_margin,
        scale_mode=args.scale_mode,
    )
    fit_profile = None if args.skip_fit_check else scale_profile

    ok = True
    for sample in selected:
        try:
            canvas_path, node_types, scale_used, fit_bbox = run_sample(
                sample,
                out_dir=args.out_dir,
                scale=args.scale,
                min_font_px=args.min_font_px,
                theme=args.theme,
                skip_render=args.skip_render,
                strict_files=not args.allow_missing_files,
                stage_vault=args.stage_vault,
                fit_render=not args.raw_render,
                scale_profile=scale_profile,
                fit_profile=fit_profile,
            )
            summary = ", ".join(f"{k}:{v}" for k, v in sorted(node_types.items()))
            fit_summary = ""
            if fit_bbox:
                fit_summary = (
                    f"; bbox={fit_bbox['width']:.2f}x{fit_bbox['height']:.2f}"
                    f"; screen@{args.min_zoom:g}={fit_bbox['screen_width']:.2f}x{fit_bbox['screen_height']:.2f}"
                    f"; fit={'yes' if fit_bbox['fits'] else 'no'}"
                )
            print(
                f"OK {sample.name}: mode={args.scale_mode}; scale={scale_used:.6f}; "
                f"{summary}{fit_summary}; canvas={canvas_path}"
            )
        except Exception as exc:  # noqa: BLE001
            ok = False
            print(f"FAIL {sample.name}: {exc}")

    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
