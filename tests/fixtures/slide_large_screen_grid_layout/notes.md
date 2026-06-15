# Large Screen Slide Grid Layout

Miro REST currently exposes slide frames inside a `slide_container` with the
same local position, so exact thumbnail positions are not available from the
source JSON. For large screen-like frames, the converter reconstructs a compact
Miro-like deck overview: the first four thumbnails form the top row and any
remaining thumbnails continue below the left column.
