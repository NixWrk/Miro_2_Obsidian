/**
 * Items made on the board with the plugin's tools.  Canvas has no sticky
 * note, Miro text or code block of its own, so a node remembers which Miro
 * item it stands for in its local override; with the plugin off it is an
 * ordinary Canvas card or group.
 */
import { MIRO_STICKY_COLORS } from "./miro-palette";

export const LOCAL_ITEM_TYPES = ["text", "sticky_note", "code", "frame", "table", "drawing", "line"] as const;
export type LocalItemType = (typeof LOCAL_ITEM_TYPES)[number];

/**
 * One freehand stroke, as the pen drew it.
 *
 * The points live in the box the stroke was drawn in, so the drawing keeps
 * its shape when the node is resized: the renderer maps that box onto
 * whatever the node is now.
 */
export interface LocalStroke {
  readonly color: string;
  readonly width: number;
  /** Below one for a highlighter, which Miro draws to see through. */
  readonly opacity?: number;
  readonly box: { readonly width: number; readonly height: number };
  /** x and y in turn, inside the box. */
  readonly points: readonly number[];
  /** Where a new piece of the same stroke starts, in points, after an erase. */
  readonly breaks?: readonly number[];
}

/**
 * A line drawn on its own, as the shape tool's lines are: a connector whose
 * ends hold on to nothing.  Its start, the points it bends through and its
 * end live in the box it was drawn in, as a stroke's points do, so the line
 * follows the node when the node is moved or resized.
 */
export interface LocalLine {
  readonly headSize?: number;
  readonly route: LineRoute;
  readonly color: string;
  readonly width: number;
  readonly strokeStyle?: "dashed" | "dotted";
  /** How each end is drawn, by the connector's name for it; no end is left out. */
  readonly startCap?: string;
  readonly endCap?: string;
  /** Drawn as Miro's block arrow: a filled arrow from start to end, `width` thick. */
  readonly block?: true;
  readonly box: { readonly width: number; readonly height: number };
  /** x and y in turn: the start, every bend, the end. */
  readonly points: readonly number[];
}

export type LineRoute = "straight" | "elbowed" | "curved";

export interface LocalItem {
  readonly type: LocalItemType;
  /** A sticky note's colour, by Miro's name for it. */
  readonly color?: string;
  /** A code block's or a grid's title. */
  readonly title?: string;
  /** What the pen drew, for a drawing. */
  readonly stroke?: LocalStroke;
  /** Where a line runs and how it looks, for a line. */
  readonly line?: LocalLine;
}

const MAX_TITLE_LENGTH = 256;
const STICKY_TOKENS = new Set(MIRO_STICKY_COLORS.map((entry) => entry.token));

/** Where a new item is made, and how big it starts, as Miro sizes them. */
export const LOCAL_ITEM_SIZES: Readonly<Record<LocalItemType, { readonly width: number; readonly height: number }>> = Object.freeze({
  text: { width: 240, height: 60 },
  sticky_note: { width: 200, height: 200 },
  code: { width: 480, height: 120 },
  frame: { width: 640, height: 400 },
  table: { width: 720, height: 200 },
  drawing: { width: 200, height: 200 },
  line: { width: 200, height: 24 },
});

/** The most points a stored stroke may hold. */
export const MAX_STROKE_POINTS = 4_096;
const MAX_STROKE_SIZE = 100_000;
const HEX_COLOR = /^#[0-9a-f]{6}$/iu;

/** A stroke this plugin can draw again, or undefined when the record is not one. */
export function readLocalStroke(value: unknown): LocalStroke | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const color = own(value, "color");
  const width = own(value, "width");
  const opacity = own(value, "opacity");
  const box = own(value, "box");
  const points = own(value, "points");
  if (typeof color !== "string" || !HEX_COLOR.test(color)) return undefined;
  if (typeof width !== "number" || !Number.isFinite(width) || width <= 0 || width > 1_000) return undefined;
  if (opacity !== undefined && (typeof opacity !== "number" || !(opacity > 0) || opacity > 1)) return undefined;
  if (box === null || typeof box !== "object") return undefined;
  const boxWidth = own(box, "width"), boxHeight = own(box, "height");
  const positive = (side: unknown): side is number => typeof side === "number" && Number.isFinite(side) && side > 0 && side <= MAX_STROKE_SIZE;
  if (!positive(boxWidth) || !positive(boxHeight)) return undefined;
  if (!Array.isArray(points) || points.length < 4 || points.length > MAX_STROKE_POINTS * 2 || points.length % 2 !== 0) return undefined;
  if (points.some((point) => typeof point !== "number" || !Number.isFinite(point) || Math.abs(point) > MAX_STROKE_SIZE)) return undefined;
  const breaks = own(value, "breaks");
  if (breaks !== undefined && (!Array.isArray(breaks) || breaks.length > MAX_STROKE_POINTS
    || breaks.some((at) => typeof at !== "number" || !Number.isInteger(at) || at <= 0 || at >= points.length / 2))) return undefined;
  return Object.freeze({
    color: color.toLowerCase(),
    width,
    ...(opacity === undefined ? {} : { opacity }),
    box: Object.freeze({ width: boxWidth, height: boxHeight }),
    points: Object.freeze([...points as readonly number[]]),
    ...(breaks === undefined ? {} : { breaks: Object.freeze([...breaks as readonly number[]]) }),
  });
}

/** The most points a line bends through, with its two ends. */
export const MAX_LINE_POINTS = 66;
const LINE_ROUTES = new Set<string>(["straight", "elbowed", "curved"]);
const CAP_NAME = /^[a-z_]{1,32}$/u;

/** A line this plugin can draw again, or undefined when the record is not one. */
export function readLocalLine(value: unknown): LocalLine | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const route = own(value, "route"), color = own(value, "color"), width = own(value, "width");
  const headSize = own(value, "headSize");
  if (headSize !== undefined && (typeof headSize !== "number" || !Number.isFinite(headSize) || headSize < 1 || headSize > 1000)) return undefined;
  const strokeStyle = own(value, "strokeStyle"), startCap = own(value, "startCap"), endCap = own(value, "endCap");
  const box = own(value, "box"), points = own(value, "points"), block = own(value, "block");
  if (typeof route !== "string" || !LINE_ROUTES.has(route)) return undefined;
  if (block !== undefined && block !== true) return undefined;
  if (typeof color !== "string" || !HEX_COLOR.test(color)) return undefined;
  if (typeof width !== "number" || !Number.isFinite(width) || width <= 0 || width > 100) return undefined;
  if (strokeStyle !== undefined && strokeStyle !== "dashed" && strokeStyle !== "dotted") return undefined;
  for (const cap of [startCap, endCap]) if (cap !== undefined && (typeof cap !== "string" || !CAP_NAME.test(cap))) return undefined;
  if (box === null || typeof box !== "object") return undefined;
  const boxWidth = own(box, "width"), boxHeight = own(box, "height");
  const positive = (side: unknown): side is number => typeof side === "number" && Number.isFinite(side) && side > 0 && side <= MAX_STROKE_SIZE;
  if (!positive(boxWidth) || !positive(boxHeight)) return undefined;
  if (!Array.isArray(points) || points.length < 4 || points.length > MAX_LINE_POINTS * 2 || points.length % 2 !== 0) return undefined;
  if (points.some((point) => typeof point !== "number" || !Number.isFinite(point) || Math.abs(point) > MAX_STROKE_SIZE)) return undefined;
  return Object.freeze({
    route: route as LineRoute,
    color: color.toLowerCase(),
    width,
    ...(headSize === undefined ? {} : {headSize: headSize as number}),
    ...(strokeStyle === undefined ? {} : { strokeStyle: strokeStyle as "dashed" | "dotted" }),
    ...(startCap === undefined || startCap === "none" ? {} : { startCap: startCap as string }),
    ...(endCap === undefined || endCap === "none" ? {} : { endCap: endCap as string }),
    ...(block === true ? { block: true as const } : {}),
    box: Object.freeze({ width: boxWidth, height: boxHeight }),
    points: Object.freeze([...points as readonly number[]]),
  });
}

/**
 * The grid a new table starts as: an ordinary Markdown table, which Canvas
 * renders and edits on its own.  Miro's grid opens with three columns and two
 * rows, and none of its cells is a heading, which the stylesheet takes care
 * of; Markdown needs the first row to be one.
 */
export const TABLE_TEMPLATE = ["|  |  |  |", "| --- | --- | --- |", "|  |  |  |"].join("\n");

function own(record: object, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(record, key) ? (record as Record<string, unknown>)[key] : undefined;
}

/** A stored item, or undefined when the value is not one this plugin wrote. */
export function readLocalItem(value: unknown): LocalItem | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const type = own(value, "type");
  if (typeof type !== "string" || !(LOCAL_ITEM_TYPES as readonly string[]).includes(type)) return undefined;
  const color = own(value, "color");
  const title = own(value, "title");
  if (color !== undefined && (typeof color !== "string" || !STICKY_TOKENS.has(color))) return undefined;
  if (title !== undefined && (typeof title !== "string" || title.length > MAX_TITLE_LENGTH)) return undefined;
  const rawStroke = own(value, "stroke");
  const stroke = rawStroke === undefined ? undefined : readLocalStroke(rawStroke);
  // A drawing is nothing without its stroke, and nothing else carries one.
  if (type === "drawing" ? stroke === undefined : rawStroke !== undefined) return undefined;
  const rawLine = own(value, "line");
  const line = rawLine === undefined ? undefined : readLocalLine(rawLine);
  // Nor is a line without its course.
  if (type === "line" ? line === undefined : rawLine !== undefined) return undefined;
  return Object.freeze({
    type: type as LocalItemType,
    ...(color === undefined ? {} : { color }),
    ...(title === undefined ? {} : { title }),
    ...(stroke === undefined ? {} : { stroke }),
    ...(line === undefined ? {} : { line }),
  });
}
