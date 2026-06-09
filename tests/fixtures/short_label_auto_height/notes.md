Regression fixture for `CONV-007`.

Miro text labels sometimes omit `geometry.height` and include leading/trailing
empty paragraphs. At fit scale those labels should not render as tiny scrolling
text nodes. Edge-empty paragraphs are stripped, and short labels/headings get
enough height for the target font.
