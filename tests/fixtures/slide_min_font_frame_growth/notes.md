# Slide Min Font Frame Growth

Problem: synthetic slide frames can be normalized to Obsidian's manual slide
size while their text content is still too small to read. Raising text to the
readable minimum (`min_font_px=8`) can make the text box wider or taller than
the normalized slide.

Rule: for frames inside a synthetic `slide_container`, keep the 8px minimum
font and grow the slide frame, preserving its aspect ratio, when the resized
children no longer fit. After growth, re-layout the synthetic deck so sibling
slides move with their descendants instead of overlapping the enlarged slide.

This fixture protects the rule with a tiny Miro slide (`234.58x131.95`) whose
edge text grows to 8px and forces the slide beyond the normal `1200x675` target.
