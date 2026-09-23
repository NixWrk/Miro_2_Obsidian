/**
 * Copy and paste of board items with what the plugin knows of them.
 *
 * Native Canvas copies nodes and connectors as `obsidian/canvas` and pastes
 * them under new ids, which cuts them off from the plugin's record of each -
 * a sticky note, a shape, a drawing, a colour, a turn.  A copy therefore
 * also carries that record, under its own clipboard type, and a paste lays
 * both down together.
 *
 * Nothing is duplicated that can be shared: a file node still points at the
 * same file, and a Miro item pasted on the board it came from shows the one
 * item both nodes stand for, through a binding, instead of a copy of it.
 */

export const CLIPBOARD_TYPE = "obsidian/miro-canvas";
import { readBoardConnector, type BoardConnector } from "./board-connectors";
export const CANVAS_CLIPBOARD_TYPE = "obsidian/canvas";

type Record_ = Readonly<Record<string, unknown>>;

export interface ClipboardItem {
  /** The plugin's record of the node or connector, as it was copied. */
  readonly override?: Record_;
  /** The Miro item it shows, when it shows one. */
  readonly sourceId?: string;
}

export interface ClipboardRecord {
  readonly version: 1;
  /** The board it was copied from, by its path in the vault. */
  readonly board: string;
  readonly items: Readonly<Record<string, ClipboardItem>>;
}

export interface CanvasClipboard {
  readonly connectors?: readonly BoardConnector[];
  readonly nodes: readonly Record_[];
  readonly edges: readonly Record_[];
  readonly center?: { readonly x: number; readonly y: number };
}

export interface PastePlan {
  readonly connectors?: readonly BoardConnector[];
  readonly nodes: Record<string, unknown>[];
  readonly edges: Record<string, unknown>[];
  readonly overrides: Record<string, Record<string, unknown>>;
  readonly bindings: Record<string, { readonly sourceId: string; readonly role: string }>;
  /** The id each copied node and connector was given. */
  readonly ids: ReadonlyMap<string, string>;
}

const isRecord = (value: unknown): value is Record_ => value !== null && typeof value === "object" && !Array.isArray(value);

/** Read a copy of the plugin's record from the clipboard, or undefined when it is not one. */
export function readClipboardRecord(text: string | undefined): ClipboardRecord | undefined {
  if (text === undefined || text === "") return undefined;
  try {
    const value: unknown = JSON.parse(text);
    if (!isRecord(value) || value.version !== 1 || typeof value.board !== "string" || !isRecord(value.items)) return undefined;
    return value as unknown as ClipboardRecord;
  } catch {
    return undefined;
  }
}

/** Read native Canvas's own clipboard, or undefined when it is not its shape. */
export function readCanvasClipboard(text: string | undefined): CanvasClipboard | undefined {
  if (text === undefined || text === "") return undefined;
  try {
    const value: unknown = JSON.parse(text);
    if (!isRecord(value) || !Array.isArray(value.nodes) || !Array.isArray(value.edges)) return undefined;
    if (!value.nodes.every(isRecord) || !value.edges.every(isRecord)) return undefined;
    const connectors = value.connectors;
    if (connectors !== undefined
      && (!Array.isArray(connectors) || !connectors.every((connector) => readBoardConnector(connector) !== undefined))) return undefined;
    return value as unknown as CanvasClipboard;
  } catch {
    return undefined;
  }
}

/**
 * Lay a copy down on the board: new ids, moved by `offset`, each with a copy
 * of its record.  What the record says about other items - the node an
 * anchor holds, a bend's place on the board - follows them.  A Miro item is
 * shown again, not copied, when `sourceExists` finds it on this board.
 */
export function planPaste(
  canvas: CanvasClipboard,
  record: ClipboardRecord | undefined,
  options: {
    readonly offset: { readonly x: number; readonly y: number };
    readonly newId: () => string;
    readonly sourceExists: (sourceId: string) => boolean;
  },
): PastePlan {
  const ids = new Map<string, string>();
  for (const item of [...canvas.nodes, ...canvas.edges, ...(canvas.connectors??[])]) {
    if (typeof item.id === "string") ids.set(item.id, options.newId());
  }
  const { x: dx, y: dy } = options.offset;
  const nodes = canvas.nodes.filter((node) => typeof node.id === "string").map((node) => ({
    ...node,
    id: ids.get(node.id as string)!,
    ...(typeof node.x === "number" ? { x: Math.round(node.x + dx) } : {}),
    ...(typeof node.y === "number" ? { y: Math.round(node.y + dy) } : {}),
  }));
  const edges = canvas.edges
    .filter((edge) => typeof edge.id === "string" && ids.has(edge.fromNode as string) && ids.has(edge.toNode as string))
    .map((edge) => ({
      ...edge,
      id: ids.get(edge.id as string)!,
      fromNode: ids.get(edge.fromNode as string)!,
      toNode: ids.get(edge.toNode as string)!,
    }));
  const overrides: Record<string, Record<string, unknown>> = {};
  const bindings: Record<string, { readonly sourceId: string; readonly role: string }> = {};
  for (const [oldId, newId] of ids) {
    const item = record?.items[oldId];
    if (item === undefined) continue;
    if (isRecord(item.override)) overrides[newId] = follow(item.override, ids, dx, dy) as Record<string, unknown>;
    if (typeof item.sourceId === "string" && options.sourceExists(item.sourceId)) bindings[newId] = { sourceId: item.sourceId, role: "copy" };
  }
  const connectors=canvas.connectors?.map(c=>({...follow(c,ids,dx,dy) as BoardConnector,id:ids.get(c.id)!}));
  return { nodes, edges, overrides, bindings, ids, ...(connectors?.length?{connectors}:{}) };
}

/**
 * A record copied for pasted items: an id of another pasted item becomes its
 * new one, and a place on the board moves with the paste.  A lock stays
 * behind - the copy is the pasting person's to change.
 */
function follow(value: unknown, ids: ReadonlyMap<string, string>, dx: number, dy: number, key = ""): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => follow(entry, ids, dx, dy, key === "waypoints" ? "point" : key));
  }
  if (!isRecord(value)) return value;
  const board = key === "point" || value.type === "free";
  const result: Record<string, unknown> = {};
  for (const [name, entry] of Object.entries(value)) {
    if (name === "locked" && key === "") continue;
    if ((name === "nodeId" || name === "edgeId") && typeof entry === "string") result[name] = ids.get(entry) ?? entry;
    else if (board && name === "x" && typeof entry === "number") result[name] = entry + dx;
    else if (board && name === "y" && typeof entry === "number") result[name] = entry + dy;
    else result[name] = follow(entry, ids, dx, dy, name);
  }
  return result;
}

/**
 * The vault files a clipboard names without holding them: files copied in
 * Obsidian's file explorer, a wikilink, or an obsidian:// link.  Such a file
 * is pasted as a node that points at it, never as a second copy of it.
 */
export function linkedFilePaths(data: { readonly files?: string; readonly text?: string }): string[] {
  if (data.files !== undefined && data.files !== "") {
    try {
      const value: unknown = JSON.parse(data.files);
      if (isRecord(value) && Array.isArray(value.paths)) return value.paths.filter((path): path is string => typeof path === "string" && path !== "");
    } catch {
      // Not the explorer's copy; the text may still name a file.
    }
  }
  const text = (data.text ?? "").trim();
  if (text === "" || text.includes("\n")) return [];
  const link = /^!?\[\[([^\]|#^]+)(?:[#^][^\]|]*)?(?:\|[^\]]*)?\]\]$/u.exec(text);
  if (link !== null) return [link[1]!.trim()];
  if (text.startsWith("obsidian://")) {
    try {
      const file = new URL(text).searchParams.get("file");
      return file === null || file === "" ? [] : [file];
    } catch {
      return [];
    }
  }
  return [];
}
