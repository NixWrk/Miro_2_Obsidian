Mind map nodes observed in a dedicated REST/Web SDK probe board.

Problem: `CONV-023` - `mindmap_node` content lived under `data.nodeView.data.content`, and child nodes used `position.relativeTo = parent_top_left`.

Expected: each recoverable `mindmap_node` becomes a Canvas text node, and parent-child mind map relationships become Canvas edges.
