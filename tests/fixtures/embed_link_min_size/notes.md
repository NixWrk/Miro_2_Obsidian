# Embed Link Min Size

Protects `CONV-013`: a YouTube embed can have a tiny Miro geometry relative to a huge board. After fit scaling, using that geometry directly makes the native Obsidian link node almost invisible.

The converter should keep a visible 16:9 Canvas link card for embed URLs even when the source geometry scales down to only a few pixels.
