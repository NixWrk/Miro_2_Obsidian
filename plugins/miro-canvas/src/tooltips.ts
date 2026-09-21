/**
 * How long a pointer rests on one of the board's controls before its hover
 * text shows, in milliseconds, as Obsidian's `data-tooltip-delay` reads it.
 *
 * Obsidian waits a second.  The board's controls are learned by hovering
 * over them, so they answer in half of it; the bars used all the time and
 * the pictures, whose only words are their hover text, answer sooner still.
 */
export const TOOLTIP_DELAY = "500";
/** The selection toolbar and the corner dock, used all the time. */
export const BAR_TOOLTIP_DELAY = "200";
/** A picture - a shape, an end, a colour - whose name is its hover text. */
export const PICTURE_TOOLTIP_DELAY = "75";
