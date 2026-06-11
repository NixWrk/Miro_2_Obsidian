Table source-limit fixture from observed Miro REST/Web exports.

Problem: empty unsupported `table_text` cells have geometry but no recoverable cell text or reliable layout. Rendering each cell as an unsupported placeholder pollutes Canvas, often near `(0, 0)`.

Expected: keep the table-level diagnostic placeholder, drop empty `table_text` and geometry-less `data_table_format` items, and classify the missing cells as source-limited.
