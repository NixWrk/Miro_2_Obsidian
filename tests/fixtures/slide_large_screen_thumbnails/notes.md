# Large Synthetic Slide Thumbnails

Problem: Miro can expose every slide frame in a deck at the same local
`parent_top_left` position while still reporting full screen geometry such as
`1920x1080`. If the converter uses that full frame size as the synthesized
thumbnail size, the board overview becomes a huge row of full-size slides.

Rule: only for synthetic slide frame layout, cap each generated thumbnail to a
compact max side while preserving the source aspect ratio. The slide contents
are then fitted into that thumbnail by the existing slide child fitting step.
