# unsupported_position_only_placeholder

Problem: some Miro unsupported item families, such as `flip_card`,
`people`, and `widgets_stack`, can be visible on the board while REST export
provides only center position, not geometry or content.

Expected behavior: drop known source-limited position-only items from Canvas and
classify them in the missing-items audit. A placeholder would create false
Canvas content and can overlap real items. Unknown future position-only types
remain actionable until a richer source proves whether they are recoverable.
