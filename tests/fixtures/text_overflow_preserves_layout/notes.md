Regression fixture for `CONV-006`.

Miro text exports can omit `geometry.height`. At very small fit scales the
converter clamps the font to `min_font_px`, so the text may no longer fit inside
the scaled source box. The converter must preserve the source layout by default
instead of expanding generic text nodes over neighboring nodes.
