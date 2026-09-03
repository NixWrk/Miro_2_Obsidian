"""Open only a registered oracle vault; never edit Obsidian's vault registry."""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Callable
from urllib.parse import urlencode, quote

try:
    from .common import load_config, require_oracle_vault, work_dir
    from .compatibility import get_profile
except ImportError:  # pragma: no cover - direct script entry point
    from common import load_config, require_oracle_vault, work_dir
    from compatibility import get_profile


VAULT_MANAGER_URI = "obsidian://choose-vault"
VAULT_ID = re.compile(r"^[0-9a-fA-F]{16}$")
MAX_REGISTRY_BYTES = 2 * 1024 * 1024


@dataclass(frozen=True)
class VaultRegistration:
    status: str
    vault_id: str | None = None


def default_registry_path() -> Path | None:
    if sys.platform == "win32":
        appdata = os.environ.get("APPDATA")
        return Path(appdata) / "obsidian" / "obsidian.json" if appdata else None
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / "obsidian" / "obsidian.json"
    config = Path(os.environ.get("XDG_CONFIG_HOME", str(Path.home() / ".config")))
    return config / "obsidian" / "obsidian.json"


def inspect_registration(vault: Path, registry_path: Path | None = None) -> VaultRegistration:
    """Read only the target registration; never print unrelated vault entries."""

    registry = registry_path if registry_path is not None else default_registry_path()
    if registry is None or not registry.is_file():
        return VaultRegistration("unknown")
    try:
        if registry.stat().st_size > MAX_REGISTRY_BYTES:
            return VaultRegistration("unknown")
        payload = json.loads(registry.read_text(encoding="utf-8-sig"))
        entries = payload.get("vaults") if isinstance(payload, dict) else None
        if not isinstance(entries, dict):
            return VaultRegistration("unknown")
        target = os.path.normcase(str(vault.resolve()))
        matches: list[str] = []
        for identifier, entry in entries.items():
            if not isinstance(entry, dict) or not isinstance(entry.get("path"), str):
                continue
            if os.path.normcase(str(Path(entry["path"]).resolve())) == target:
                if not isinstance(identifier, str) or not VAULT_ID.fullmatch(identifier):
                    return VaultRegistration("unknown")
                matches.append(identifier)
        if len(matches) > 1:
            return VaultRegistration("ambiguous")
        return VaultRegistration("registered", matches[0]) if matches else VaultRegistration("unregistered")
    except (OSError, ValueError, RuntimeError):
        return VaultRegistration("unknown")


def registration_instructions(vault: Path) -> str:
    return (
        'In Obsidian choose "Open another vault" > "Open folder as vault" '
        'and select this exact folder:\n'
        f"{vault}\n"
        "Do not select its MIRO2OBSIDIAN subfolder. Creating the folder does not register it.\n"
        "Then rerun: python -m tools.obsidian_oracle.open_local_vault --open\n"
        "Or open the vault manager: python -m tools.obsidian_oracle.open_local_vault --choose-vault"
    )


def build_open_uri(vault: Path, registration: VaultRegistration, canvas: Path | None = None) -> str:
    if registration.status != "registered" or not VAULT_ID.fullmatch(registration.vault_id or ""):
        raise ValueError("Oracle vault is not unambiguously registered in Obsidian")
    params = {"vault": registration.vault_id or ""}
    if canvas is not None:
        try:
            relative = canvas.resolve().relative_to(vault.resolve())
        except ValueError as exc:
            raise ValueError("Canvas path escapes the oracle vault") from exc
        if not canvas.is_file() or canvas.suffix != ".canvas":
            raise ValueError("The staged Canvas file does not exist")
        params["file"] = relative.as_posix()
    return "obsidian://open?" + urlencode(params, quote_via=quote)


def launch_uri(uri: str) -> None:
    if sys.platform != "win32":
        raise RuntimeError("Automatic launch is supported on Windows; open the printed URI manually")
    os.startfile(uri)  # type: ignore[attr-defined]  # explicitly requested OS protocol dispatch


def open_registered_vault(
    vault: Path,
    registration: VaultRegistration,
    canvas: Path | None = None,
    *,
    launcher: Callable[[str], None] = launch_uri,
) -> str:
    uri = build_open_uri(vault, registration, canvas)
    launcher(uri)
    return uri


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    group = parser.add_mutually_exclusive_group()
    group.add_argument("--open", action="store_true", help="Open the already registered oracle vault")
    group.add_argument("--choose-vault", action="store_true", help="Open Obsidian's vault manager for registration")
    parser.add_argument("--profile", help="Optional previously staged compatibility profile to open")
    args = parser.parse_args()
    config = load_config()
    vault = require_oracle_vault(None, config)
    if not vault.is_dir() or not (vault / ".obsidian").is_dir():
        print("FAIL: Oracle vault is missing. Run python -m tools.obsidian_oracle.setup_m0_vault first.")
        return 1
    registration = inspect_registration(vault)
    print(f"vault={vault}\nregistration={registration.status}")
    if args.choose_vault:
        print(registration_instructions(vault))
        launch_uri(VAULT_MANAGER_URI)
        return 0
    if registration.status != "registered":
        print(registration_instructions(vault))
        return 2
    canvas = None
    if args.profile:
        profile = get_profile(args.profile)
        canvas = work_dir(config) / str(config.get("oracle_subfolder", "_oracle")) / "m0-compatibility" / f"{profile.id}.canvas"
    uri = build_open_uri(vault, registration, canvas)
    print(f"uri={uri}")
    if args.open:
        open_registered_vault(vault, registration, canvas)
        print("Dispatched to Obsidian. This does not certify a visual or interaction test.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
