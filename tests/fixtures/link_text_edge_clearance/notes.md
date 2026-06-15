This fixture protects the rule from CONV-039: a source text item containing
only one URL can become a larger Obsidian link card. If the source item had no
height and sat close to a sticky note, the generated card can create a tiny
edge overlap even though the Miro layout was only adjacent.

The converter should move the generated link card just far enough to restore a
stable clearance. Deep overlaps are left untouched by the unit test because
they are likely intentional source composition rather than min-size growth.
