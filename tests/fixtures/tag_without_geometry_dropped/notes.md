# tag_without_geometry_dropped

Problem: some Miro exports can include `tag` records with text but without
`position` or `geometry`. The converter used default zero coordinates and
created a text placeholder at the canvas origin, which could stretch the board
bbox and make unrelated content appear shifted.

Expected behavior: drop geometry-less tags as source-limited evidence until a
source surface provides reliable coordinates.
