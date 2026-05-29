from __future__ import annotations

import argparse
import shutil
import urllib.error
import urllib.request
from pathlib import Path

from common import load_config, obsidian_dir


DEFAULT_REPOS = {
    "advanced-canvas": "Developer-Mike/obsidian-advanced-canvas",
}

ASSETS = ("manifest.json", "main.js", "styles.css")


def download(url: str, target: Path) -> None:
    request = urllib.request.Request(
        url,
        headers={"User-Agent": "Miro_2_Obsidian oracle runtime installer"},
    )
    with urllib.request.urlopen(request, timeout=60) as response:
        data = response.read()
    target.write_bytes(data)


def download_asset(repo: str, version: str, asset: str, target: Path) -> str:
    errors: list[str] = []
    for tag in (version, f"v{version}"):
        url = f"https://github.com/{repo}/releases/download/{tag}/{asset}"
        try:
            download(url, target)
            return url
        except urllib.error.URLError as exc:
            errors.append(f"{url}: {exc}")
        except TimeoutError as exc:
            errors.append(f"{url}: {exc}")
    raise RuntimeError("Failed to download asset:\n" + "\n".join(errors))


def install_from_source(plugin_id: str, source_plugins_dir: Path, target_plugins_dir: Path) -> Path:
    source = source_plugins_dir / plugin_id
    if not source.exists():
        raise SystemExit(f"Plugin source does not exist: {source}")
    target = target_plugins_dir / plugin_id
    if target.exists():
        shutil.rmtree(target)
    shutil.copytree(source, target)
    return target


def install_from_release(plugin_id: str, repo: str, version: str, target_plugins_dir: Path) -> Path:
    target = target_plugins_dir / plugin_id
    target.mkdir(parents=True, exist_ok=True)
    for asset in ASSETS:
        url = download_asset(repo, version, asset, target / asset)
        print(f"Downloaded {asset} from {url}")

    marker = target / "PLUGIN_RUNTIME_REQUIRED.txt"
    if marker.exists():
        marker.unlink()
    return target


def main() -> int:
    parser = argparse.ArgumentParser(description="Install real plugin runtime into the local Obsidian oracle vault.")
    parser.add_argument("plugin", nargs="?", default="advanced-canvas")
    parser.add_argument("--source-plugins-dir", type=Path, help="Copy plugin runtime from an existing .obsidian/plugins dir.")
    parser.add_argument("--repo", help="GitHub repo owner/name for release downloads.")
    parser.add_argument("--version", help="Release version. Defaults to oracle_config required_plugins version.")
    args = parser.parse_args()

    config = load_config()
    plugin_id = args.plugin
    version = args.version or str(config.get("required_plugins", {}).get(plugin_id, ""))
    if not version and not args.source_plugins_dir:
        raise SystemExit(f"No version configured for {plugin_id}; pass --version")

    plugins_dir = obsidian_dir(config) / "plugins"
    plugins_dir.mkdir(parents=True, exist_ok=True)

    if args.source_plugins_dir:
        target = install_from_source(plugin_id, args.source_plugins_dir, plugins_dir)
    else:
        repo = args.repo or DEFAULT_REPOS.get(plugin_id)
        if not repo:
            raise SystemExit(f"No default GitHub repo for {plugin_id}; pass --repo")
        target = install_from_release(plugin_id, repo, version, plugins_dir)

    print(f"OK: installed {plugin_id} runtime at {target}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

