# Short Inline Label Width Expansion

This fixture protects the rule from `CONV-011`: short inline labels such as `Приоритезация через метрики` can be narrow enough to wrap in Obsidian even after paragraph wrappers are removed.

The converter may expand any short inline label to its estimated single-line width when the candidate rectangle does not visibly collide with neighboring nodes. The rule is not tied to image/file nodes.
