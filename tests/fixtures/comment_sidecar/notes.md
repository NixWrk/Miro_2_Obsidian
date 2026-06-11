Comment sidecar fixture observed through `v2-experimental/boards/{board_id}/comments`.

Problem: `CONV-024` - non-empty comments are a separate source family, not board items. Once available, they should not be silently lost.

Expected: each comment becomes a readable Canvas text annotation at its canvas position.
