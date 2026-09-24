# PyInstaller build of miro2obsidian: a command-line tool and a desktop window.
#
#   pyinstaller release/miro2obsidian.spec
#
# Both land in dist/ as single files. The modules find their data next to
# their own source files, so the data goes into the bundle under the same
# relative paths it has in the repository.

from pathlib import Path

from PyInstaller.utils.hooks import collect_data_files

ROOT = Path(SPECPATH).resolve().parent

datas = [
    (str(ROOT / "miro2obsidian" / "schemas"), "miro2obsidian/schemas"),
    (str(ROOT / "tools" / "obsidian_plugins" / "canvas-zoom-unlock"), "tools/obsidian_plugins/canvas-zoom-unlock"),
    *collect_data_files("customtkinter"),
]


def analysis(entry: str) -> Analysis:
    return Analysis(
        [str(ROOT / "release" / entry)],
        pathex=[str(ROOT), str(ROOT / "release")],
        datas=datas,
        hiddenimports=["miro2obsidian.validate"],
        excludes=["pytest", "playwright"],
    )


cli = analysis("cli_entry.py")
cli_exe = EXE(
    PYZ(cli.pure),
    cli.scripts,
    cli.binaries,
    cli.datas,
    name="miro2obsidian",
    console=True,
    upx=False,
)

gui = analysis("gui_entry.py")
gui_exe = EXE(
    PYZ(gui.pure),
    gui.scripts,
    gui.binaries,
    gui.datas,
    name="miro2obsidian-gui",
    # The desktop build has no console window; `--self-test` still reports
    # through its exit code.
    console=False,
    upx=False,
)

# On macOS a window belongs in an .app, which Finder opens with a double
# click; a bare executable would open Terminal first.
import sys

if sys.platform == "darwin":
    app = BUNDLE(
        gui_exe,
        name="Miro 2 Obsidian.app",
        bundle_identifier="io.github.nixwrk.miro2obsidian",
    )
