# slide_container deck membership

Minimized source evidence from a dedicated slide test board
contains `slide_container` items whose child frames have `parent.id` set to the
owning deck. The converter must preserve that membership.

Regression guarded here: each Canvas deck group must contain only the frame
groups that belong to that deck. A slide frame from another deck must not be
inserted into every deck group.

Slide frame contents must also survive conversion. Text, images, shapes, and
other supported children under a slide frame are normal Canvas nodes grouped by
that frame; only the deck itself is structural.

For slide frames, `parent.id` is authoritative for group membership. Geometry
filters may still be useful for ordinary frames, but they must not eject a
parent-linked slide child from the slide group.

Miro may expose every frame in a deck at the same local `0,0` position. In that
case the converter must synthesize a deterministic deck layout, then fit each
slide's child nodes into the computed slide frame rectangle.
