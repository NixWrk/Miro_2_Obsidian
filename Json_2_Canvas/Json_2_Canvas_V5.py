"""Compatibility launcher for the unified Miro to Obsidian GUI."""

from Miro_2_Obsidian_GUI import MiroPipelineApp as App
from Miro_2_Obsidian_GUI import main

__all__ = ["App", "main"]

if __name__ == "__main__":
    main()
