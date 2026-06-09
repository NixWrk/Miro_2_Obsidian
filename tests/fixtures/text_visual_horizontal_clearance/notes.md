# Text Visual Horizontal Clearance

This fixture protects the rule from `CONV-009`: transparent multiline text may have a Miro bbox that slightly overlaps a neighboring image even though the board is visually arranged as side-by-side content.

The converter should trim the text node width on the conflicting side and re-fit the font inside the narrower box instead of letting the text draw under the image preview in Obsidian.
