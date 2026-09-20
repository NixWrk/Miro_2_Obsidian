/**
 * Items made on the board with the plugin's tools.  Canvas has no sticky
 * note, Miro text or code block of its own, so a node remembers which Miro
 * item it stands for in its local override; with the plugin off it is an
 * ordinary Canvas card or group.
 */
import { MIRO_STICKY_COLORS } from "./miro-palette";

export const LOCAL_ITEM_TYPES = ["text", "sticky_note", "code", "frame", "table"] as const;
export type LocalItemType = (typeof LOCAL_ITEM_TYPES)[number];

export interface LocalItem {
  readonly type: LocalItemType;
  /** A sticky note's colour, by Miro's name for it. */
  readonly color?: string;
  /** A code block's or a grid's title. */
  readonly title?: string;
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
});

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
  return Object.freeze({
    type: type as LocalItemType,
    ...(color === undefined ? {} : { color }),
    ...(title === undefined ? {} : { title }),
  });
}
