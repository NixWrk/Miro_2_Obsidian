"""Entry point of the frozen command-line build (`miro2obsidian`)."""

from __future__ import annotations

import sys

from release_self_test import run_self_test_if_asked

if __name__ == "__main__":
    run_self_test_if_asked()
    from scripts.miro_pipeline import main

    sys.exit(main())
