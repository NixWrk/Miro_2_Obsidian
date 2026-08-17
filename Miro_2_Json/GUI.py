"""Compatibility launcher for the unified Miro to Obsidian GUI."""

from Miro_2_Obsidian_GUI import (
    MiroPipelineApp as MiroDownloaderApp,
    authorize_gui_token as resolve_gui_token,
    board_label as board_choice_label,
    main,
)

__all__ = [
    "MiroDownloaderApp",
    "board_choice_label",
    "main",
    "resolve_gui_token",
]

if __name__ == "__main__":
    main()
