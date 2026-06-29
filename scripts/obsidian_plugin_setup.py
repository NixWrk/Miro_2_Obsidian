from __future__ import annotations

import argparse
import json
import shutil
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Callable


REPO_ROOT = Path(__file__).resolve().parents[1]
ZOOM_UNLOCK_SOURCE = REPO_ROOT / "tools" / "obsidian_plugins" / "canvas-zoom-unlock"

ADVANCED_CANVAS_ID = "advanced-canvas"
ADVANCED_CANVAS_REPO = "Developer-Mike/obsidian-advanced-canvas"
ADVANCED_CANVAS_VERSION = "6.0.1"
ZOOM_UNLOCK_ID = "canvas-zoom-unlock"
RELEASE_ASSETS = ("manifest.json", "main.js", "styles.css")


@dataclass(frozen=True)
class PluginSetupResult:
    vault_root: Path
    enabled_plugins: list[str]
    installed: list[str]
    skipped: list[str]


def _read_json(path: Path) -> object:
    if not path.exists():
        return None
    text = path.read_text(encoding="utf-8-sig").strip()
    if not text:
        return None
    return json.loads(text)


def _write_json(path: Path, payload: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def obsidian_dir(vault_root: Path) -> Path:
    return Path(vault_root) / ".obsidian"


def plugins_dir(vault_root: Path) -> Path:
    return obsidian_dir(vault_root) / "plugins"


def read_enabled_plugins(vault_root: Path) -> list[str]:
    loaded = _read_json(obsidian_dir(vault_root) / "community-plugins.json")
    if isinstance(loaded, list):
        return [str(plugin_id) for plugin_id in loaded]
    return []


def enable_plugins(vault_root: Path, plugin_ids: list[str]) -> list[str]:
    enabled = read_enabled_plugins(vault_root)
    for plugin_id in plugin_ids:
        if plugin_id not in enabled:
            enabled.append(plugin_id)
    _write_json(obsidian_dir(vault_root) / "community-plugins.json", enabled)
    return enabled


def plugin_has_runtime(vault_root: Path, plugin_id: str) -> bool:
    target = plugins_dir(vault_root) / plugin_id
    return (target / "manifest.json").is_file() and (target / "main.js").is_file()


def install_zoom_unlock(vault_root: Path) -> Path:
    if not ZOOM_UNLOCK_SOURCE.exists():
        raise RuntimeError(f"Zoom unlock plugin source is missing: {ZOOM_UNLOCK_SOURCE}")
    target = plugins_dir(vault_root) / ZOOM_UNLOCK_ID
    target.mkdir(parents=True, exist_ok=True)
    for name in RELEASE_ASSETS:
        source_file = ZOOM_UNLOCK_SOURCE / name
        if source_file.exists():
            shutil.copy2(source_file, target / name)
    return target


def _download(url: str, target: Path) -> None:
    request = urllib.request.Request(url, headers={"User-Agent": "Miro_2_Obsidian plugin setup"})
    with urllib.request.urlopen(request, timeout=60) as response:
        data = response.read()
    target.write_bytes(data)


def download_release_asset(repo: str, version: str, asset: str, target: Path) -> str:
    errors: list[str] = []
    for tag in (version, f"v{version}"):
        url = f"https://github.com/{repo}/releases/download/{tag}/{asset}"
        try:
            tmp = target.with_suffix(target.suffix + ".part")
            _download(url, tmp)
            tmp.replace(target)
            return url
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            errors.append(f"{url}: {exc}")
    raise RuntimeError("Failed to download Advanced Canvas asset:\n" + "\n".join(errors))


def install_advanced_canvas(
    vault_root: Path,
    *,
    source_plugins_dir: Path | None = None,
    version: str = ADVANCED_CANVAS_VERSION,
    repo: str = ADVANCED_CANVAS_REPO,
    logger: Callable[[str], None] | None = None,
) -> Path:
    target = plugins_dir(vault_root) / ADVANCED_CANVAS_ID
    if plugin_has_runtime(vault_root, ADVANCED_CANVAS_ID):
        if logger:
            logger("Advanced Canvas already installed.")
        return target

    if source_plugins_dir:
        source = Path(source_plugins_dir) / ADVANCED_CANVAS_ID
        if source.exists():
            if target.exists():
                shutil.rmtree(target)
            shutil.copytree(source, target)
            if logger:
                logger(f"Advanced Canvas copied from {source}")
            return target

    target.mkdir(parents=True, exist_ok=True)
    for asset in RELEASE_ASSETS:
        url = download_release_asset(repo, version, asset, target / asset)
        if logger:
            logger(f"Downloaded Advanced Canvas {asset} from {url}")
    return target


def setup_obsidian_plugins(
    vault_root: Path,
    *,
    install_advanced: bool = True,
    install_zoom: bool = True,
    advanced_source_plugins_dir: Path | None = None,
    advanced_version: str = ADVANCED_CANVAS_VERSION,
    logger: Callable[[str], None] | None = None,
) -> PluginSetupResult:
    vault_root = Path(vault_root)
    plugins_dir(vault_root).mkdir(parents=True, exist_ok=True)

    installed: list[str] = []
    skipped: list[str] = []

    if install_advanced:
        install_advanced_canvas(
            vault_root,
            source_plugins_dir=advanced_source_plugins_dir,
            version=advanced_version,
            logger=logger,
        )
        installed.append(ADVANCED_CANVAS_ID)
    else:
        skipped.append(ADVANCED_CANVAS_ID)

    if install_zoom:
        install_zoom_unlock(vault_root)
        installed.append(ZOOM_UNLOCK_ID)
        if logger:
            logger("Canvas Zoom Unlock installed from local repo files.")
    else:
        skipped.append(ZOOM_UNLOCK_ID)

    enabled = enable_plugins(vault_root, installed)
    if logger and installed:
        logger("Enabled Obsidian plugins: " + ", ".join(installed))
    return PluginSetupResult(
        vault_root=vault_root,
        enabled_plugins=enabled,
        installed=installed,
        skipped=skipped,
    )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Install/enable Obsidian plugins needed by Miro -> Obsidian Canvas.")
    parser.add_argument("--vault-root", type=Path, required=True)
    parser.add_argument("--no-advanced-canvas", action="store_true")
    parser.add_argument("--no-zoom-unlock", action="store_true")
    parser.add_argument("--advanced-source-plugins-dir", type=Path)
    parser.add_argument("--advanced-version", default=ADVANCED_CANVAS_VERSION)
    return parser


def main() -> int:
    args = build_parser().parse_args()
    result = setup_obsidian_plugins(
        args.vault_root,
        install_advanced=not args.no_advanced_canvas,
        install_zoom=not args.no_zoom_unlock,
        advanced_source_plugins_dir=args.advanced_source_plugins_dir,
        advanced_version=args.advanced_version,
        logger=print,
    )
    print(f"vault_root={result.vault_root}")
    print("enabled_plugins=" + ",".join(result.enabled_plugins))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
