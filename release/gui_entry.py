"""Entry point of the frozen desktop build (`miro2obsidian-gui`)."""

from __future__ import annotations

from release_self_test import run_self_test_if_asked

if __name__ == "__main__":
    run_self_test_if_asked()
    from Miro_2_Obsidian_GUI import main

    main()
