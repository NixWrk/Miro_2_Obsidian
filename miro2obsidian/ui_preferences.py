"""Non-sensitive desktop appearance preferences, independent of export options."""

import json
import os
import tempfile
from pathlib import Path


def preferences_path() -> Path:
    override = os.environ.get("MIRO2OBSIDIAN_UI_SETTINGS")
    if override:
        return Path(override)
    base = Path(os.environ.get("LOCALAPPDATA") or Path.home() / ".config")
    return base / "miro2obsidian" / "ui_preferences.json"


def load_preferences() -> dict[str, str]:
    defaults = {"language": "en", "theme": "light"}
    try:
        stored = json.loads(preferences_path().read_text(encoding="utf-8"))
        if isinstance(stored, dict):
            for key, allowed in {"language": {"en", "ru"}, "theme": {"light", "dark"}}.items():
                if stored.get(key) in allowed:
                    defaults[key] = stored[key]
    except (OSError, ValueError, TypeError):
        pass
    return defaults


def save_preferences(preferences: dict[str, str]) -> None:
    # Deliberate allowlist: no paths, board data, or credentials belong here.
    clean = {
        "language": "ru" if preferences.get("language") == "ru" else "en",
        "theme": "dark" if preferences.get("theme") == "dark" else "light",
    }
    path = preferences_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=path.parent, delete=False) as stream:
            temporary = Path(stream.name)
            json.dump(clean, stream)
        os.replace(temporary, path)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)
