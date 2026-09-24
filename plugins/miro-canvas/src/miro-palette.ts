/** Colours Miro paints its own items with, as its web board shows them. */

import { words } from "./i18n";

export interface MiroColor {
  /** The name Miro's REST API uses for the colour. */
  readonly token: string;
  readonly label: string;
  readonly color: string;
}

/** Token and colour only; `miroStickyColors()` adds the name in the language in use. */
const STICKY_SWATCHES: readonly { readonly token: string; readonly color: string; readonly key: keyof ReturnType<typeof words>["palette"]["sticky"] }[] = [
  { token: "light_yellow", color: "#fff7a1", key: "lightYellow" },
  { token: "yellow", color: "#ffe86d", key: "yellow" },
  { token: "orange", color: "#ffb575", key: "orange" },
  { token: "red", color: "#ff9f9f", key: "red" },
  { token: "light_pink", color: "#ffd4f2", key: "lightPink" },
  { token: "pink", color: "#fd9ae7", key: "pink" },
  { token: "light_blue", color: "#b6d3fe", key: "lightBlue" },
  { token: "violet", color: "#beb3fb", key: "violet" },
  { token: "blue", color: "#9ce6ff", key: "blue" },
  { token: "dark_blue", color: "#8bb7f9", key: "darkBlue" },
  { token: "cyan", color: "#8ae9e0", key: "cyan" },
  { token: "dark_green", color: "#72e293", key: "darkGreen" },
  { token: "light_green", color: "#d5f1a8", key: "lightGreen" },
  { token: "green", color: "#b7e768", key: "green" },
  { token: "gray", color: "#f4f6f8", key: "gray" },
  { token: "black", color: "#1a1a1a", key: "black" },
  { token: "white", color: "#ffffff", key: "white" },
];

/**
 * Sticky-note fills as Miro's board draws them, named in the language in use.
 * The REST API names a sticky colour but never gives its value, so these are
 * taken from the board itself.  The converter keeps its own table, tuned for
 * Advanced Canvas, which recolours nodes on its own; this plugin paints the
 * note directly.
 */
export function miroStickyColors(): readonly MiroColor[] {
  const names = words().palette.sticky;
  return Object.freeze(STICKY_SWATCHES.map(({ token, color, key }) => Object.freeze({ token, label: names[key], color })));
}

/** Token and colour only; `frameColors()` adds the name in the language in use. */
const FRAME_SWATCHES: readonly { readonly token: string; readonly color: string; readonly key: keyof ReturnType<typeof words>["palette"]["frame"] }[] = [
  { token: "frame_gray", color: "#8f959e38", key: "gray" },
  { token: "frame_red", color: "#e5737338", key: "red" },
  { token: "frame_orange", color: "#f0a35e38", key: "orange" },
  { token: "frame_yellow", color: "#e6c84f38", key: "yellow" },
  { token: "frame_lime", color: "#a3c96238", key: "lime" },
  { token: "frame_green", color: "#6cbf8f38", key: "green" },
  { token: "frame_teal", color: "#5fb8b038", key: "teal" },
  { token: "frame_cyan", color: "#62b3d938", key: "cyan" },
  { token: "frame_blue", color: "#7c9ce638", key: "blue" },
  { token: "frame_violet", color: "#a58be038", key: "violet" },
  { token: "frame_pink", color: "#e08fbd38", key: "pink" },
  { token: "frame_brown", color: "#b3947938", key: "brown" },
];

/**
 * Fills for a frame, named in the language in use.  A frame is the ground its
 * items stand on, so it takes a quieter colour than they do: a muted tone, a
 * fifth opaque, which tints a light board and a dark one alike without
 * drowning what lies on it.
 */
export function frameColors(): readonly MiroColor[] {
  const names = words().palette.frame;
  return Object.freeze(FRAME_SWATCHES.map(({ token, color, key }) => Object.freeze({ token, label: names[key], color })));
}

const STICKY_BY_TOKEN = new Map(STICKY_SWATCHES.map((entry) => [entry.token, entry.color] as const));

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
