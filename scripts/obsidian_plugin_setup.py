from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import tempfile
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from threading import Lock
from typing import Callable

from miro_export_bundle import is_link_or_reparse


REPO_ROOT = Path(__file__).resolve().parents[1]
ZOOM_UNLOCK_SOURCE = REPO_ROOT / "tools" / "obsidian_plugins" / "canvas-zoom-unlock"

ADVANCED_CANVAS_ID = "advanced-canvas"
ADVANCED_CANVAS_REPO = "Developer-Mike/obsidian-advanced-canvas"
ADVANCED_CANVAS_VERSION = "6.0.1"
ZOOM_UNLOCK_ID = "canvas-zoom-unlock"
ZOOM_UNLOCK_VERSION = "0.1.0"
ZOOM_UNLOCK_SHA256 = {
    "manifest.json": "c8957d306fb8c3542a1184ea266c0c538189b24d1dca4bcf15d095c73cc7f074",
    "main.js": "89210f339bab6201b0827feeda13dbe75b462cd32359070b8facc7bb88e048ba",
    "styles.css": "7b6966f27b7b99ca5ceb07b6c49e0d06a729aa1c4bde32e4460b82aaacb30b8a",
}
RELEASE_ASSETS = ("manifest.json", "main.js", "styles.css")
ADVANCED_CANVAS_SHA256 = {
    "6.0.1": {
        "manifest.json": "fb5804aaa69bbd2ae90d410a731236c13b2485a31ed477000925d128f0e633ad",
        "main.js": "facdddc8ffd017fcfb3f2de701cf631467ae1d45a30249a8ef015a327cd8f8ba",
        "styles.css": "8c40c1caff16e9393dff9336b936e0b6f89692ce7245deb70f107a110d5ebb3c",
    }
}

_ENABLED_PLUGINS_LOCK = Lock()


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
    text = json.dumps(payload, ensure_ascii=False, indent=2) + "\n"
    tmp: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            "w",
            encoding="utf-8",
            newline="\n",
            prefix=f".{path.name}.",
            suffix=".tmp",
            dir=path.parent,
            delete=False,
        ) as handle:
            tmp = Path(handle.name)
            handle.write(text)
        tmp.replace(path)
    finally:
        if tmp is not None:
            tmp.unlink(missing_ok=True)


def obsidian_dir(vault_root: Path) -> Path:
    return Path(vault_root) / ".obsidian"


def plugins_dir(vault_root: Path) -> Path:
    return obsidian_dir(vault_root) / "plugins"


def require_obsidian_vault(vault_root: Path) -> Path:
    vault = Path(vault_root).absolute()
    current = vault
    while True:
        if is_link_or_reparse(current):
            raise RuntimeError(
                f"Obsidian vault path contains a link or reparse point: {current}"
            )
        if current.parent == current:
            break
        current = current.parent
    if not vault.is_dir():
        raise RuntimeError(f"Obsidian vault root must be an existing directory: {vault}")
    settings = obsidian_dir(vault)
    if is_link_or_reparse(settings) or not settings.is_dir():
        raise RuntimeError(
            f"Obsidian vault must contain a regular .obsidian directory: {settings}"
        )
    plugin_root = plugins_dir(vault)
    if plugin_root.exists() and (
        is_link_or_reparse(plugin_root) or not plugin_root.is_dir()
    ):
        raise RuntimeError(
            f"Obsidian plugins path must be a regular directory: {plugin_root}"
        )
    return vault


def read_enabled_plugins(vault_root: Path) -> list[str]:
    path = obsidian_dir(vault_root) / "community-plugins.json"
    loaded = _read_json(path)
    if loaded is None:
        return []
    if not isinstance(loaded, list) or any(
        not isinstance(plugin_id, str) or not plugin_id for plugin_id in loaded
    ):
        raise RuntimeError(
            f"Obsidian enabled plugins must be a JSON array of non-empty strings: {path}"
        )
    return list(loaded)


def enable_plugins(vault_root: Path, plugin_ids: list[str]) -> list[str]:
    with _ENABLED_PLUGINS_LOCK:
        enabled = read_enabled_plugins(vault_root)
        for plugin_id in plugin_ids:
            if plugin_id not in enabled:
                enabled.append(plugin_id)
        _write_json(obsidian_dir(vault_root) / "community-plugins.json", enabled)
        return enabled


def _plugin_runtime_error(
    target: Path, plugin_id: str, version: str | None = None
) -> str | None:
    if is_link_or_reparse(target) or not target.is_dir():
        return "runtime is not a regular directory"
    for asset in RELEASE_ASSETS:
        path = target / asset
        if (
            is_link_or_reparse(path)
            or not path.is_file()
            or path.stat().st_size == 0
        ):
            return f"missing, empty, or linked {asset}"
    try:
        manifest = _read_json(target / "manifest.json")
    except (OSError, ValueError) as exc:
        return f"invalid manifest.json: {exc}"
    if not isinstance(manifest, dict) or manifest.get("id") != plugin_id:
        return f"manifest id is not {plugin_id}"
    if version is not None and manifest.get("version") != version:
        return f"manifest version is not {version}"
    return None


def _runtime_hash_error(target: Path, expected: dict[str, str]) -> str | None:
    for asset, expected_digest in expected.items():
        try:
            digest = hashlib.sha256((target / asset).read_bytes()).hexdigest()
        except OSError as exc:
            return f"cannot hash {asset}: {exc}"
        if digest != expected_digest.lower():
            return f"SHA-256 mismatch for {asset}: {digest}"
    return None


def plugin_has_runtime(
    vault_root: Path, plugin_id: str, version: str | None = None
) -> bool:
    return (
        _plugin_runtime_error(plugins_dir(vault_root) / plugin_id, plugin_id, version)
        is None
    )


def _activate_plugin(
    staged: Path,
    target: Path,
    validator: Callable[[Path], str | None],
) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(
        prefix=f".{target.name}-backup-", dir=target.parent
    ) as backup_root:
        backup_root_path = Path(backup_root)
        backup = backup_root_path / "previous"
        failed = backup_root_path / "failed"
        if target.exists():
            target.rename(backup)
        try:
            staged.rename(target)
            error = validator(target)
            if error:
                raise RuntimeError(
                    f"Activated {target.name} runtime failed verification: {error}"
                )
        except Exception:
            if target.exists():
                target.rename(failed)
            if backup.exists():
                backup.rename(target)
            raise


def install_zoom_unlock(vault_root: Path) -> Path:
    if not ZOOM_UNLOCK_SOURCE.exists():
        raise RuntimeError(
            f"Zoom unlock plugin source is missing: {ZOOM_UNLOCK_SOURCE}"
        )
    target = plugins_dir(vault_root) / ZOOM_UNLOCK_ID
    target.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(
        prefix=f".{ZOOM_UNLOCK_ID}-stage-", dir=target.parent
    ) as tmp:
        staged = Path(tmp) / ZOOM_UNLOCK_ID
        shutil.copytree(ZOOM_UNLOCK_SOURCE, staged)
        error = _plugin_runtime_error(
            staged, ZOOM_UNLOCK_ID, ZOOM_UNLOCK_VERSION
        ) or _runtime_hash_error(staged, ZOOM_UNLOCK_SHA256)
        if error:
            raise RuntimeError(f"Invalid Zoom Unlock plugin runtime: {error}")
        _activate_plugin(
            staged,
            target,
            lambda path: (
                _plugin_runtime_error(path, ZOOM_UNLOCK_ID, ZOOM_UNLOCK_VERSION)
                or _runtime_hash_error(path, ZOOM_UNLOCK_SHA256)
            ),
        )
    return target


def _download(url: str, target: Path) -> None:
    request = urllib.request.Request(
        url, headers={"User-Agent": "Miro_2_Obsidian plugin setup"}
    )
    with urllib.request.urlopen(request, timeout=60) as response:
        data = response.read()
    target.write_bytes(data)


def download_release_asset(
    repo: str,
    version: str,
    asset: str,
    target: Path,
    *,
    expected_sha256: str,
) -> str:
    target.parent.mkdir(parents=True, exist_ok=True)
    errors: list[str] = []
    for tag in (version, f"v{version}"):
        url = f"https://github.com/{repo}/releases/download/{tag}/{asset}"
        tmp: Path | None = None
        try:
            with tempfile.NamedTemporaryFile(
                prefix=f".{target.name}.",
                suffix=".part",
                dir=target.parent,
                delete=False,
            ) as handle:
                tmp = Path(handle.name)
            _download(url, tmp)
            digest = hashlib.sha256(tmp.read_bytes()).hexdigest()
            if digest != expected_sha256.lower():
                raise OSError(f"SHA-256 mismatch for {asset}: {digest}")
            tmp.replace(target)
            tmp = None
            return url
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            errors.append(f"{url}: {exc}")
        finally:
            if tmp is not None:
                tmp.unlink(missing_ok=True)
    raise RuntimeError(
        "Failed to download Advanced Canvas asset:\n" + "\n".join(errors)
    )


def install_advanced_canvas(
    vault_root: Path,
    *,
    source_plugins_dir: Path | None = None,
    version: str = ADVANCED_CANVAS_VERSION,
    repo: str = ADVANCED_CANVAS_REPO,
    logger: Callable[[str], None] | None = None,
) -> Path:
    target = plugins_dir(vault_root) / ADVANCED_CANVAS_ID
    hashes = (
        ADVANCED_CANVAS_SHA256.get(version) if repo == ADVANCED_CANVAS_REPO else None
    )
    if not hashes or any(asset not in hashes for asset in RELEASE_ASSETS):
        raise RuntimeError(
            f"No pinned release hashes for {repo} {version}; install from a verified local source."
        )
    existing_error = _plugin_runtime_error(
        target, ADVANCED_CANVAS_ID, version
    ) or _runtime_hash_error(target, hashes)
    if existing_error is None:
        if logger:
            logger("Advanced Canvas already installed and hash-verified.")
        return target
    if target.exists() and logger:
        logger(f"Replacing unverified Advanced Canvas runtime: {existing_error}")

    if source_plugins_dir:
        source = Path(source_plugins_dir) / ADVANCED_CANVAS_ID
        if source.exists():
            target.parent.mkdir(parents=True, exist_ok=True)
            with tempfile.TemporaryDirectory(
                prefix=f".{ADVANCED_CANVAS_ID}-stage-", dir=target.parent
            ) as tmp:
                staged = Path(tmp) / ADVANCED_CANVAS_ID
                shutil.copytree(source, staged)
                error = _plugin_runtime_error(
                    staged, ADVANCED_CANVAS_ID, version
                ) or _runtime_hash_error(staged, hashes)
                if error:
                    raise RuntimeError(
                        f"Invalid local Advanced Canvas runtime: {error}"
                    )
                _activate_plugin(
                    staged,
                    target,
                    lambda path: (
                        _plugin_runtime_error(path, ADVANCED_CANVAS_ID, version)
                        or _runtime_hash_error(path, hashes)
                    ),
                )
                if logger:
                    logger(f"Advanced Canvas copied from {source}")
                return target

    target.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(
        prefix=f".{ADVANCED_CANVAS_ID}-stage-", dir=target.parent
    ) as tmp:
        staged = Path(tmp) / ADVANCED_CANVAS_ID
        staged.mkdir()
        for asset in RELEASE_ASSETS:
            url = download_release_asset(
                repo,
                version,
                asset,
                staged / asset,
                expected_sha256=hashes[asset],
            )
            if logger:
                logger(f"Downloaded Advanced Canvas {asset} from {url}")
        error = _plugin_runtime_error(
            staged, ADVANCED_CANVAS_ID, version
        ) or _runtime_hash_error(staged, hashes)
        if error:
            raise RuntimeError(f"Invalid downloaded Advanced Canvas runtime: {error}")
        _activate_plugin(
            staged,
            target,
            lambda path: (
                _plugin_runtime_error(path, ADVANCED_CANVAS_ID, version)
                or _runtime_hash_error(path, hashes)
            ),
        )
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
    vault_root = require_obsidian_vault(vault_root)
    read_enabled_plugins(vault_root)
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
    parser = argparse.ArgumentParser(
        description="Install/enable Obsidian plugins needed by Miro -> Obsidian Canvas."
    )
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
