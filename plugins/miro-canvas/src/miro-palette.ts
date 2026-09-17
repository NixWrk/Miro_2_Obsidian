/** Colours Miro paints its own items with, as its web board shows them. */

export interface MiroColor {
  /** The name Miro's REST API uses for the colour. */
  readonly token: string;
  readonly label: string;
  readonly color: string;
}

/**
 * Sticky-note fills as Miro's board draws them.  The REST API names a sticky
 * colour but never gives its value, so these are taken from the board itself.
 * The converter keeps its own table, tuned for Advanced Canvas, which recolours
 * nodes on its own; this plugin paints the note directly.
 */
export const MIRO_STICKY_COLORS: readonly MiroColor[] = Object.freeze([
  { token: "light_yellow", label: "Light yellow", color: "#fff7a1" },
  { token: "yellow", label: "Yellow", color: "#ffe86d" },
  { token: "orange", label: "Orange", color: "#ffb575" },
  { token: "red", label: "Red", color: "#ff9f9f" },
  { token: "light_pink", label: "Light pink", color: "#ffd4f2" },
  { token: "pink", label: "Pink", color: "#fd9ae7" },
  { token: "light_blue", label: "Light blue", color: "#b6d3fe" },
  { token: "violet", label: "Violet", color: "#beb3fb" },
  { token: "blue", label: "Blue", color: "#9ce6ff" },
  { token: "dark_blue", label: "Dark blue", color: "#8bb7f9" },
  { token: "cyan", label: "Cyan", color: "#8ae9e0" },
  { token: "dark_green", label: "Dark green", color: "#72e293" },
  { token: "light_green", label: "Light green", color: "#d5f1a8" },
  { token: "green", label: "Green", color: "#b7e768" },
  { token: "gray", label: "Gray", color: "#f4f6f8" },
  { token: "black", label: "Black", color: "#1a1a1a" },
  { token: "white", label: "White", color: "#ffffff" },
].map((entry) => Object.freeze(entry)));

const STICKY_BY_TOKEN = new Map(MIRO_STICKY_COLORS.map((entry) => [entry.token, entry.color] as const));

/** The fill Miro shows for a named sticky colour; "grey" is read as "gray". */
export function stickyFill(token: string): string | undefined {
  const key = token.trim().toLowerCase();
  return STICKY_BY_TOKEN.get(key === "grey" ? "gray" : key);
}

/** Miro's text colour on a fill: its near-black ink, or white on a dark fill. */
export function readableInk(fill: string): string {
  const match = /^#([0-9a-f]{6})$/iu.exec(fill.trim());
  if (match === null) return "#1a1a1a";
  const value = Number.parseInt(match[1]!, 16);
  const channel = (shift: number): number => {
    const c = ((value >> shift) & 0xff) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const luminance = 0.2126 * channel(16) + 0.7152 * channel(8) + 0.0722 * channel(0);
  return luminance < 0.18 ? "#ffffff" : "#1a1a1a";
}
