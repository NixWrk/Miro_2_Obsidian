# Large Screen Slide Grid Layout

Miro REST currently exposes slide frames inside a `slide_container` with the
same local position, so exact thumbnail positions are not available from the
source JSON. For large screen-like frames, the converter reconstructs a deck
overview using Obsidian/Advanced Canvas's manual slide default size: the first
four slides form the top row and any remaining slides continue below the left
column. A neighboring frame is included to verify that the enlarged synthetic
deck moves to free space instead of covering existing source geometry.
