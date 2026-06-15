Table source-limit fixture from observed Miro REST/Web exports.

Problem: empty unsupported `table_text` cells have geometry but no recoverable cell text or reliable layout. Rendering each cell as an unsupported placeholder pollutes Canvas, often near `(0, 0)`.

Expected: drop the table-level item, empty `table_text`, and geometry-less `data_table_format` items from Canvas, then classify them as source-limited in the missing-items audit. A Canvas node would imply recoverable table content that the current Miro exports do not provide.
