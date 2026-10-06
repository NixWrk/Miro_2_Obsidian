"""Local result actions; external applications open only on a button press."""

import os
from pathlib import Path
import subprocess
import sys
from urllib.parse import urlencode


def obsidian_uri(path: Path) -> str:
    return "obsidian://open?" + urlencode({"path": str(path.resolve()), "paneType": "tab"})


def open_output_folder(path: Path) -> None:
    folder = path.resolve(strict=True)
    if not folder.is_dir():
        raise ValueError("The export folder does not exist.")
    if sys.platform == "win32":
        os.startfile(str(folder))
    else:
        subprocess.Popen(["open" if sys.platform == "darwin" else "xdg-open", str(folder)])
