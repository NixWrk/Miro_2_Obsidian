"""Entry point of the frozen command-line build (`miro2obsidian`).

`miro2obsidian validate <file.canvas> ...` checks boards against the
versioned schema, as `python -m miro2obsidian.validate` does from source;
anything else runs the export and conversion pipeline.
"""

from __future__ import annotations

import sys

from release_self_test import run_self_test_if_asked

if __name__ == "__main__":
    run_self_test_if_asked()
    if sys.argv[1:2] == ["validate"]:
        from miro2obsidian.validate import main as validate

        sys.exit(validate(sys.argv[2:]))
    from scripts.miro_pipeline import main

    sys.exit(main())
