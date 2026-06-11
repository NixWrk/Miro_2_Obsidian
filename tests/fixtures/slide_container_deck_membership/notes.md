# slide_container deck membership

Real local source evidence in `work/MIRO2OBSIDIAN/Miro_2_JSON/Dev team_Slides.json`
contains `slide_container` items whose child frames have `parent.id` set to the
owning deck. The converter must preserve that membership.

Regression guarded here: each Canvas deck group must contain only the frame
groups that belong to that deck. A slide frame from another deck must not be
inserted into every deck group.
