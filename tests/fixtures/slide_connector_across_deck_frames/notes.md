# Slide Connector Across Deck Frames

Miro REST exposes visible connectors between items that belong to different
slide frames with normal `startItem.id` and `endItem.id` fields. The converter
must preserve that source connector as a visible Canvas edge.

The generated `slide-sequence-*` edge is separate: it is an invisible Advanced
Canvas presentation link between slide frame groups.
