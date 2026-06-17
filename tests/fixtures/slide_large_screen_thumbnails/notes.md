# Large Synthetic Slide Screens

Problem: Miro can expose every slide frame in a deck at the same local
`parent_top_left` position while still reporting full screen geometry such as
`1920x1080`. If the converter uses that full frame size as the synthesized
slide size, the board overview becomes a huge row of full-size exported frames.

Rule: only for synthetic slide frame layout, resize each generated slide frame
to Obsidian/Advanced Canvas's manual slide default size: `1200x675` for 16:9.
The slide contents are then fitted into that generated slide by the existing
slide child fitting step.
