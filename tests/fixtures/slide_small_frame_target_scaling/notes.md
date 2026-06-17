# Small Frame Target Scaling

Miro may export slide frames inside a `slide_container` with identical local
positions and small thumbnail-sized geometry. The converter treats those as
synthetic slide layouts, normalizes the slide frame to Obsidian/Advanced
Canvas's manual slide size, and scales child centers, sizes, and text font size
by the same factor.
