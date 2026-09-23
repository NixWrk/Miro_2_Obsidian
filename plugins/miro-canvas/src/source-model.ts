/** Pure, bounded read-only projection of canonical Miro source metadata. */

import { isSafeColor, isSafeFontFamily, normalizeColor } from "./appearance";
import { MAX_WAYPOINTS } from "./connector-route";
import { stickyFill } from "./miro-palette";
import { listCommentThreads } from "./local-comments";
import { threadMessages, type ThreadMessage } from "./comment-thread";
import { readLocalItem, type LocalItemType, type LocalLine, type LocalStroke } from "./local-items";

export type SourceItemKind = "shape" | "text" | "sticky" | "connector" | "frame" | "media" | "code" | "group";

export interface SourceCodeDescriptor {
  readonly title?: string;
  readonly language?: string;
  readonly lineNumbersVisible?: boolean;
  readonly text?: string;
}

export interface SourceAppCardDescriptor {
  readonly kind: "app_card";
  readonly hasTitle: boolean;
  readonly hasDescription: boolean;
  readonly fieldCount: number;
}

export interface SourcePreviewDescriptor {
  readonly title?: string;
  readonly description?: string;
  readonly provider?: string;
  readonly hasTargetUrl: boolean;
  readonly hasPreviewAsset: boolean;
}

/** A document card: what Miro shows of a file, never where it came from. */
export interface SourceDocumentDescriptor {
  readonly kind: "document" | "doc_format";
  readonly title?: string;
  /** Upper-case file type, such as PDF, when the title or source names one. */
  readonly extension?: string;
  /** The opening words of a Miro doc, as plain text. */
  readonly excerpt?: string;
}

/** A Miro comment thread a converter placed on the board as a text node. */
export interface SourceCommentDescriptor {
  readonly resolved: boolean;
  readonly messages: readonly ThreadMessage[];
}

/** A Miro presentation: a container holding its slides, in showing order. */
export interface SourceDeckDescriptor {
  readonly title?: string;
  readonly slides: readonly string[];
}

/** A frame that is one slide of a presentation. */
export interface SourceSlideDescriptor {
  readonly deckId: string;
  /** Zero-based place in the deck's showing order. */
  readonly index: number;
}

/** A grid made with the table tool: Markdown a person edits, with a name. */
export interface SourceTableDescriptor {
  readonly title?: string;
}

export interface SourceEmbedDescriptor {
  readonly provider?: string;
  readonly title?: string;
}

export interface SourceTagDescriptor {
  readonly id: string;
  readonly title: string;
  readonly color?: string;
}

export interface SourceCardDescriptor {
  readonly kind: "card";
  readonly hasTitle: boolean;
  readonly hasDescription: boolean;
  readonly hasUrl: boolean;
  readonly hasDueDate: boolean;
  readonly hasAssignee: boolean;
  readonly fieldCount: number;
}

export interface SourceMindmapNodeDescriptor {
  readonly isRoot: boolean;
  readonly hasContent: boolean;
  readonly parentId?: string;
  readonly shape?: string;
  readonly branchColor?: string;
}

export interface SourceMindmapEdgeDescriptor {
  readonly parentId: string;
  readonly childId: string;
  readonly branchColor?: string;
}

export interface SourceStructuredDescriptor {
  readonly code?: SourceCodeDescriptor;
  readonly appCard?: SourceAppCardDescriptor;
  readonly preview?: SourcePreviewDescriptor;
  readonly document?: SourceDocumentDescriptor;
  readonly embed?: SourceEmbedDescriptor;
  readonly table?: SourceTableDescriptor;
  /** The stroke a drawing shows. */
  readonly stroke?: LocalStroke;
  /** The course of a line drawn on its own. */
  readonly line?: LocalLine;
  readonly deck?: SourceDeckDescriptor;
  readonly slide?: SourceSlideDescriptor;
  readonly comment?: SourceCommentDescriptor;
  /** The fill of the frame an item sits in, which its text is read against. */
  readonly backdrop?: string;
  readonly card?: SourceCardDescriptor;
  readonly tags?: readonly SourceTagDescriptor[];
  readonly mindmapNode?: SourceMindmapNodeDescriptor;
  readonly mindmapEdge?: SourceMindmapEdgeDescriptor;
}

export interface SourceConnectorStyle {
  readonly headSize?: number;
  readonly labelT?: number;
  readonly shape?: "straight" | "elbowed" | "curved";
  readonly startCap?: string;
  readonly endCap?: string;
  readonly strokeStyle?: "solid" | "dashed" | "dotted";
  /** Board points a person bent the route through; bends for an elbowed route. */
  readonly waypoints?: readonly { readonly x: number; readonly y: number }[];
}

/** Stored waypoints, or undefined when the value is not a short list of finite points. */
export function readWaypoints(value: unknown): readonly { readonly x: number; readonly y: number }[] | undefined {
  if (!Array.isArray(value) || value.length > MAX_WAYPOINTS) return undefined;
  const points: { readonly x: number; readonly y: number }[] = [];
  for (const item of value as readonly unknown[]) {
    const x = isRecord(item) ? item.x : undefined;
    const y = isRecord(item) ? item.y : undefined;
    if (typeof x !== "number" || typeof y !== "number" || !Number.isFinite(x) || !Number.isFinite(y)) return undefined;
    points.push(Object.freeze({ x, y }));
  }
  return Object.freeze(points);
}

export interface SourceItemDescriptor {
  readonly sourceId?: string;
  readonly kind: SourceItemKind;
  readonly shape?: string;
  readonly rotation: number;
  readonly zIndex?: number;
  readonly css: Readonly<Record<string, string>>;
  readonly connector?: SourceConnectorStyle;
  readonly structured?: SourceStructuredDescriptor;
  /** The Miro item a node made with the plugin's tools stands for. */
  readonly localItem?: LocalItemType;
}

export interface SourceScene {
  readonly items: ReadonlyMap<string, SourceItemDescriptor>;
  readonly order: readonly string[];
  readonly diagnostics: readonly string[];
}

export interface Point {
  readonly x: number;
  readonly y: number;
}

export interface Rect extends Point {
  readonly width: number;
  readonly height: number;
}

type UnknownRecord = Record<PropertyKey, unknown>;
type ReadResult = { readonly state: "absent" } | { readonly state: "present"; readonly value: unknown } | { readonly state: "error" };

const MAX_SOURCE_ITEMS = 100_000;
const MAX_ORDER_ENTRIES = 200_000;
const MAX_BINDINGS = 100_000;
const MAX_CODE_TITLE_LENGTH = 256;
const MAX_CODE_LANGUAGE_LENGTH = 64;
const MAX_CODE_TEXT_LENGTH = 100_000;
const MAX_APP_CARD_FIELDS = 64;
const MAX_PREVIEW_TITLE_LENGTH = 256;
const MAX_PREVIEW_DESCRIPTION_LENGTH = 2_048;
const MAX_PREVIEW_PROVIDER_LENGTH = 128;
const MAX_CARD_FIELDS = 64;
const MAX_ITEM_TAGS = 32;
const MAX_TAG_DEFINITIONS = 10_000;
const MAX_TAG_TITLE_LENGTH = 128;
const SAFE_TOKEN = /^[a-z0-9][a-z0-9_-]{0,63}$/iu;
const NUMERIC_STRING = /^-?(?:\d+(?:\.\d*)?|\.\d+)$/u;
/** Subtypes already recognized from Miro source; keep legacy local aliases too. */
export const MIRO_SHAPE_KINDS = [
  "rectangle", "round_rectangle", "circle", "triangle", "rhombus", "parallelogram", "trapezoid", "pentagon",
  "hexagon", "octagon", "wedge_round_rectangle_callout", "star", "cloud", "cross", "can", "right_arrow",
  "left_arrow", "left_right_arrow", "left_brace", "right_brace", "flow_chart_connector", "flow_chart_magnetic_disk",
  "flow_chart_input_output", "flow_chart_decision", "flow_chart_delay", "flow_chart_display", "flow_chart_document",
  "flow_chart_magnetic_drum", "flow_chart_internal_storage", "flow_chart_manual_input", "flow_chart_manual_operation",
  "flow_chart_merge", "flow_chart_multidocuments", "flow_chart_note_curly_left", "flow_chart_note_curly_right",
  "flow_chart_note_square", "flow_chart_offpage_connector", "flow_chart_or", "flow_chart_predefined_process",
  "flow_chart_predefined_process_2", "flow_chart_preparation", "flow_chart_process", "flow_chart_online_storage",
  "flow_chart_summing_junction", "flow_chart_terminator",
] as const;
export const LOCAL_SHAPE_KINDS = [...MIRO_SHAPE_KINDS, "ellipse", "diamond"] as const;
const LOCAL_SHAPES = new Set<string>(LOCAL_SHAPE_KINDS);
const KNOWN_MIRO_SHAPES = new Set<string>(MIRO_SHAPE_KINDS);
export const CONNECTOR_ROUTES = ["straight", "elbowed", "curved"] as const;
export const CONNECTOR_STROKES = ["solid", "dashed", "dotted"] as const;
export const CONNECTOR_CAPS = [
  "none", "stealth", "rounded_stealth", "arrow", "filled_triangle", "triangle", "filled_diamond",
  "diamond", "filled_oval", "oval", "erd_one", "erd_many", "erd_one_or_many", "erd_only_one",
  "erd_zero_or_many", "erd_zero_or_one",
] as const;

/** Local settings are partial: absent fields continue to use source/native values. */
export interface LocalConnectorSettings {
  readonly headSize?: number;
  readonly labelT?: number;
  readonly route?: (typeof CONNECTOR_ROUTES)[number];
  readonly strokeStyle?: (typeof CONNECTOR_STROKES)[number];
  readonly startCap?: (typeof CONNECTOR_CAPS)[number];
  readonly endCap?: (typeof CONNECTOR_CAPS)[number];
  readonly width?: number;
  readonly color?: string | null;
  /** Board points the route is bent through; bends for an elbowed route. */
  readonly waypoints?: readonly { readonly x: number; readonly y: number }[];
}
const TAG_COLORS: Readonly<Record<string, string>> = Object.freeze({
  red: "#f24726", orange: "#ff9d48", yellow: "#ffd02f", green: "#67c6a0",
  blue: "#4262ff", violet: "#9b51e0", magenta: "#ea94bb", gray: "#c3c4c7",
  grey: "#c3c4c7", black: "#1e1e1e", white: "#ffffff",
});

function isRecord(value: unknown): value is UnknownRecord {
  return value !== null && (typeof value === "object" || typeof value === "function");
}

function readOwn(value: unknown, key: PropertyKey): ReadResult {
  if (!isRecord(value)) return { state: "absent" };
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined) return { state: "absent" };
    return Object.prototype.hasOwnProperty.call(descriptor, "value")
      ? { state: "present", value: descriptor.value }
      : { state: "error" };
  } catch {
    return { state: "error" };
  }
}

function valueOf(value: unknown, key: PropertyKey): unknown {
  const result = readOwn(value, key);
  return result.state === "present" ? result.value : undefined;
}

function ownNames(value: unknown): readonly string[] {
  if (!isRecord(value)) return [];
  try { return Object.getOwnPropertyNames(value); } catch { return []; }
}

function arrayValue(value: unknown): readonly unknown[] | undefined {
  try { return Array.isArray(value) ? value : undefined; } catch { return undefined; }
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function numericCss(value: unknown): string | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : undefined;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return NUMERIC_STRING.test(trimmed) && Number.isFinite(Number(trimmed)) ? trimmed : undefined;
}

function safeColor(value: unknown, sticky = false): string | undefined {
  if (sticky && typeof value === "string") {
    const mapped = stickyFill(value);
    if (mapped !== undefined) return mapped;
  }
  if (!isSafeColor(value)) return undefined;
  return normalizeColor(value) ?? "transparent";
}

function safeLength(value: unknown): string | undefined {
  const numeric = numericCss(value);
  return numeric === undefined ? undefined : `${numeric}px`;
}

function safeFontWeight(value: unknown): string | undefined {
  if (value === "normal" || value === "bold") return value;
  const numeric = numericCss(value);
  if (numeric === undefined) return undefined;
  const weight = Number(numeric);
  return weight >= 100 && weight <= 900 ? numeric : undefined;
}

function boundedSourceString(
  value: unknown,
  maxLength: number,
  diagnostics: string[],
  sourceId: string,
  field: string,
  trim: boolean,
): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = trim ? value.trim() : value;
  const bounded = normalized.length > maxLength ? normalized.slice(0, maxLength) : normalized;
  if (normalized.length > maxLength) diagnostics.push(`source-code-field-truncated: ${sourceId}.${field}.`);
  return bounded.length > 0 ? bounded : undefined;
}

function hasSourceText(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function sourceCodeDescriptor(source: UnknownRecord, diagnostics: string[], sourceId: string): SourceCodeDescriptor {
  const data = valueOf(source, "data");
  if (!isRecord(data)) return Object.freeze({});
  const title = boundedSourceString(valueOf(data, "title"), MAX_CODE_TITLE_LENGTH, diagnostics, sourceId, "data.title", true);
  const language = boundedSourceString(valueOf(data, "language"), MAX_CODE_LANGUAGE_LENGTH, diagnostics, sourceId, "data.language", true);
  const text = boundedSourceString(valueOf(data, "code"), MAX_CODE_TEXT_LENGTH, diagnostics, sourceId, "data.code", false);
  const lineNumbersVisible = valueOf(data, "lineNumbersVisible");
  return Object.freeze({
    ...(title === undefined ? {} : { title }),
    ...(language === undefined ? {} : { language }),
    ...(typeof lineNumbersVisible === "boolean" ? { lineNumbersVisible } : {}),
    ...(text === undefined ? {} : { text }),
  });
}

function sourceAppCardDescriptor(source: UnknownRecord, diagnostics: string[], sourceId: string): SourceAppCardDescriptor {
  const data = valueOf(source, "data");
  const fields = isRecord(data) ? arrayValue(valueOf(data, "fields")) : undefined;
  const fieldCount = Math.min(fields?.length ?? 0, MAX_APP_CARD_FIELDS);
  if (fields !== undefined && fields.length > MAX_APP_CARD_FIELDS) {
    diagnostics.push(`source-app-card-fields-truncated: ${sourceId}.data.fields.`);
  }
  return Object.freeze({
    kind: "app_card",
    hasTitle: isRecord(data) && hasSourceText(valueOf(data, "title")),
    hasDescription: isRecord(data) && hasSourceText(valueOf(data, "description")),
    fieldCount,
  });
}

function sourcePreviewDescriptor(source: UnknownRecord): SourcePreviewDescriptor {
  const data = valueOf(source, "data");
  const rawProvider = isRecord(data) ? valueOf(data, "provider") ?? valueOf(data, "providerName") : undefined;
  const provider = isRecord(rawProvider)
    ? valueOf(rawProvider, "name") ?? valueOf(rawProvider, "displayName") ?? valueOf(rawProvider, "title")
    : rawProvider;
  const bounded = (value: unknown, maxLength: number): string | undefined => {
    if (typeof value !== "string") return undefined;
    const normalized = value.trim();
    return normalized.length === 0 ? undefined : normalized.slice(0, maxLength);
  };
  const title = isRecord(data) ? bounded(valueOf(data, "title"), MAX_PREVIEW_TITLE_LENGTH) : undefined;
  const description = isRecord(data) ? bounded(valueOf(data, "description"), MAX_PREVIEW_DESCRIPTION_LENGTH) : undefined;
  const providerText = bounded(provider, MAX_PREVIEW_PROVIDER_LENGTH);
  return Object.freeze({
    ...(title === undefined ? {} : { title }),
    ...(description === undefined ? {} : { description }),
    ...(providerText === undefined ? {} : { provider: providerText }),
    hasTargetUrl: isRecord(data) && hasSourceText(valueOf(data, "url")),
    hasPreviewAsset: isRecord(data) && hasSourceText(valueOf(data, "previewUrl")),
  });
}

const MAX_DOCUMENT_EXCERPT_LENGTH = 280;
const EXTENSION = /\.([a-z0-9]{1,8})(?:[?#].*)?$/iu;

function boundedText(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.replace(/\s+/gu, " ").trim();
  return normalized.length === 0 ? undefined : normalized.slice(0, maxLength);
}

/** Visible words of an HTML fragment; script and style bodies are not words. */
function htmlExcerpt(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.slice(0, 20_000)
    .replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/giu, " ")
    .replace(/<[^>]*>/gu, " ")
    .replace(/&nbsp;/giu, " ").replace(/&lt;/giu, "<").replace(/&gt;/giu, ">").replace(/&quot;/giu, "\"")
    .replace(/&#39;/gu, "'").replace(/&amp;/giu, "&");
  return boundedText(text, MAX_DOCUMENT_EXCERPT_LENGTH);
}

function sourceDocumentDescriptor(source: UnknownRecord, kind: "document" | "doc_format"): SourceDocumentDescriptor {
  const data = valueOf(source, "data");
  const title = boundedText(isRecord(data) ? valueOf(data, "title") ?? valueOf(data, "name") : undefined, MAX_PREVIEW_TITLE_LENGTH);
  // Only the type is read from a location: the location itself stays out.
  const named = [title, valueOf(source, "local_name"), isRecord(data) ? valueOf(data, "documentUrl") : undefined]
    .find((candidate): candidate is string => typeof candidate === "string" && EXTENSION.test(candidate));
  const extension = named === undefined ? undefined : EXTENSION.exec(named)?.[1]?.toUpperCase();
  const excerpt = kind === "doc_format" && isRecord(data) ? htmlExcerpt(valueOf(data, "html")) : undefined;
  return Object.freeze({
    kind,
    ...(title === undefined ? {} : { title }),
    ...(extension === undefined ? {} : { extension }),
    ...(excerpt === undefined ? {} : { excerpt }),
  });
}

function sourceEmbedDescriptor(source: UnknownRecord): SourceEmbedDescriptor {
  const data = valueOf(source, "data");
  const provider = boundedText(isRecord(data) ? valueOf(data, "providerName") : undefined, MAX_PREVIEW_PROVIDER_LENGTH);
  const title = boundedText(isRecord(data) ? valueOf(data, "title") : undefined, MAX_PREVIEW_TITLE_LENGTH);
  return Object.freeze({
    ...(provider === undefined ? {} : { provider }),
    ...(title === undefined ? {} : { title }),
  });
}

function sourceCardDescriptor(source: UnknownRecord, diagnostics: string[], sourceId: string): SourceCardDescriptor {
  const data = valueOf(source, "data");
  const fields = isRecord(data) ? arrayValue(valueOf(data, "fields")) : undefined;
  const fieldCount = Math.min(fields?.length ?? 0, MAX_CARD_FIELDS);
  if (fields !== undefined && fields.length > MAX_CARD_FIELDS) {
    diagnostics.push(`source-card-fields-truncated: ${sourceId}.data.fields.`);
  }
  return Object.freeze({
    kind: "card",
    hasTitle: isRecord(data) && hasSourceText(valueOf(data, "title")),
    hasDescription: isRecord(data) && hasSourceText(valueOf(data, "description")),
    hasUrl: isRecord(data) && hasSourceText(valueOf(data, "url")),
    hasDueDate: isRecord(data) && hasSourceText(valueOf(data, "dueDate")),
    hasAssignee: isRecord(data) && hasSourceText(valueOf(data, "assigneeId")),
    fieldCount,
  });
}

function sourceTagDefinition(item: UnknownRecord, diagnostics: string[], sourceId: string): SourceTagDescriptor | undefined {
  const data = valueOf(item, "data");
  const rawTitle = valueOf(item, "title") ?? valueOf(data, "title");
  if (!hasSourceText(rawTitle)) return undefined;
  const normalizedTitle = (rawTitle as string).trim();
  const title = normalizedTitle.slice(0, MAX_TAG_TITLE_LENGTH);
  if (normalizedTitle.length > MAX_TAG_TITLE_LENGTH) diagnostics.push(`source-tag-title-truncated: ${sourceId}.`);
  const style = valueOf(item, "style");
  const rawColor = valueOf(item, "color") ?? valueOf(data, "color") ?? valueOf(style, "fillColor");
  const token = typeof rawColor === "string" ? rawColor.trim().toLowerCase() : "";
  const color = safeColor(rawColor) ?? TAG_COLORS[token];
  return Object.freeze({ id: sourceId, title, ...(color === undefined ? {} : { color }) });
}

function sourceTagsForItem(
  source: UnknownRecord,
  tagDefinitions: ReadonlyMap<string, SourceTagDescriptor>,
  diagnostics: string[],
  sourceId: string,
): readonly SourceTagDescriptor[] | undefined {
  const data = valueOf(source, "data");
  const raw = valueOf(source, "tagIds") ?? valueOf(data, "tagIds");
  if (raw === undefined) return undefined;
  const ids = arrayValue(raw);
  if (ids === undefined) { diagnostics.push(`source-tag-ids-malformed: ${sourceId}.`); return undefined; }
  const result: SourceTagDescriptor[] = [];
  const seen = new Set<string>();
  const limit = Math.min(ids.length, MAX_ITEM_TAGS);
  for (let index = 0; index < limit; index += 1) {
    const id = ids[index];
    if (typeof id !== "string" || id.length === 0 || seen.has(id)) continue;
    seen.add(id);
    const tag = tagDefinitions.get(id);
    if (tag === undefined) diagnostics.push(`source-tag-dangling: ${sourceId} -> ${id}.`);
    else result.push(tag);
  }
  if (ids.length > limit) diagnostics.push(`source-item-tags-truncated: ${sourceId}.`);
  return result.length === 0 ? undefined : Object.freeze(result);
}

function sourceMindmapNodeDescriptor(source: UnknownRecord): SourceMindmapNodeDescriptor {
  const data = valueOf(source, "data");
  const nodeView = isRecord(data) ? valueOf(data, "nodeView") : valueOf(source, "nodeView");
  const nodeViewData = valueOf(nodeView, "data");
  const parent = valueOf(source, "parent");
  const rawParentId = valueOf(parent, "id");
  const parentId = typeof rawParentId === "string" && rawParentId.length > 0 ? rawParentId.slice(0, 512) : undefined;
  const styleCandidates = [valueOf(nodeView, "style"), isRecord(data) ? valueOf(data, "style") : undefined, valueOf(source, "style")];
  const styleValue = (key: string): unknown => {
    for (const style of styleCandidates) {
      const candidate = valueOf(style, key);
      if (candidate !== undefined) return candidate;
    }
    return undefined;
  };
  const rawShape = styleValue("shape");
  const shapeToken = typeof rawShape === "string" ? rawShape.trim().toLowerCase() : "";
  const shape = shapeToken === "rounded_rectangle" ? "round_rectangle"
    : shapeToken.length > 0 && shapeToken !== "none" && SAFE_TOKEN.test(shapeToken) ? shapeToken : undefined;
  const branchColor = safeColor(styleValue("nodeColor") ?? styleValue("fillColor") ?? styleValue("color"));
  const contentCandidates = [
    valueOf(nodeViewData, "content"), valueOf(nodeView, "content"), isRecord(data) ? valueOf(data, "content") : undefined,
    isRecord(data) ? valueOf(data, "title") : undefined, valueOf(source, "plain_text"), valueOf(source, "title"),
  ];
  return Object.freeze({
    isRoot: (isRecord(data) && valueOf(data, "isRoot") === true) || parentId === undefined,
    hasContent: contentCandidates.some(hasSourceText),
    ...(parentId === undefined ? {} : { parentId }),
    ...(shape === undefined ? {} : { shape }),
    ...(branchColor === undefined ? {} : { branchColor }),
  });
}

function sourceStructuredDescriptor(
  source: UnknownRecord,
  kind: SourceItemKind,
  diagnostics: string[],
  sourceId: string,
  tagDefinitions: ReadonlyMap<string, SourceTagDescriptor>,
): SourceStructuredDescriptor | undefined {
  const result: { code?: SourceCodeDescriptor; appCard?: SourceAppCardDescriptor; preview?: SourcePreviewDescriptor; document?: SourceDocumentDescriptor; embed?: SourceEmbedDescriptor; card?: SourceCardDescriptor; tags?: readonly SourceTagDescriptor[]; mindmapNode?: SourceMindmapNodeDescriptor } = {};
  if (kind === "code") result.code = sourceCodeDescriptor(source, diagnostics, sourceId);
  const rawType = valueOf(source, "type");
  const type = typeof rawType === "string" ? rawType.toLowerCase() : "";
  if (type === "app_card") result.appCard = sourceAppCardDescriptor(source, diagnostics, sourceId);
  if (type === "preview") result.preview = sourcePreviewDescriptor(source);
  if (type === "document" || type === "doc_format") result.document = sourceDocumentDescriptor(source, type);
  if (type === "embed") result.embed = sourceEmbedDescriptor(source);
  if (type === "card") result.card = sourceCardDescriptor(source, diagnostics, sourceId);
  if (type === "mindmap_node") result.mindmapNode = sourceMindmapNodeDescriptor(source);
  const tags = sourceTagsForItem(source, tagDefinitions, diagnostics, sourceId);
  if (tags !== undefined) result.tags = tags;
  return Object.keys(result).length === 0 ? undefined : Object.freeze(result);
}

function sourceKind(item: UnknownRecord, forcedConnector: boolean): SourceItemKind | undefined {
  if (forcedConnector) return "connector";
  const raw = valueOf(item, "type");
  if (typeof raw !== "string") return undefined;
  switch (raw.toLowerCase()) {
    case "shape": return "shape";
    case "text": return "text";
    case "sticky_note": return "sticky";
    case "connector": return "connector";
    case "frame": return "frame";
    // A presentation holds its slides as a frame holds its items.
    case "slide_container": return "frame";
    case "group": return "group";
    case "image": case "document": case "doc_format": case "embed": case "preview": return "media";
    case "code": return "code";
    case "app_card": return "text";
    case "card": return "text";
    case "mindmap_node": return "text";
    default: return undefined;
  }
}

function sourceSubtype(item: UnknownRecord): string | undefined {
  const candidates: unknown[] = [valueOf(item, "subtype")];
  const shape = valueOf(item, "shape");
  candidates.push(typeof shape === "string" ? shape : valueOf(shape, "shape"));
  const data = valueOf(item, "data");
  candidates.push(valueOf(data, "shape"), valueOf(data, "subtype"), valueOf(data, "type"));
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.length > 0) return candidate.toLowerCase();
  }
  return undefined;
}

function sourceRotation(item: UnknownRecord): number {
  const geometry = valueOf(item, "geometry");
  return finiteNumber(valueOf(geometry, "rotation")) ?? finiteNumber(valueOf(item, "rotation")) ?? 0;
}

function localOverride(document: unknown, canvasId: string): UnknownRecord | undefined {
  const metadata = valueOf(document, "miroCanvas");
  const overrides = valueOf(metadata, "localOverrides");
  const override = valueOf(overrides, canvasId);
  return isRecord(override) ? override : undefined;
}

function effectiveRotationFor(document: unknown, canvasId: string, source?: UnknownRecord): number {
  const local = finiteNumber(valueOf(localOverride(document, canvasId), "rotation"));
  return local ?? (source === undefined ? 0 : sourceRotation(source));
}

function sourceCss(item: UnknownRecord, kind: SourceItemKind): Record<string, string> {
  const css: Record<string, string> = {};
  const style = valueOf(item, "style");
  if (!isRecord(style)) return css;
  const setColor = (cssKey: string, sourceKey: string, sticky = false): void => {
    const color = safeColor(valueOf(style, sourceKey), sticky);
    if (color !== undefined) css[cssKey] = color;
  };
  setColor("color", "color");
  if (css.color === undefined) setColor("color", "textColor");
  setColor("background-color", "fillColor", kind === "sticky");
  if (css["background-color"] === undefined) setColor("background-color", "backgroundColor", kind === "sticky");
  if (css["background-color"] === undefined) setColor("background-color", "cardTheme");
  setColor("border-color", "borderColor");
  setColor("stroke", "strokeColor");
  const lengthFields: readonly [string, string][] = [["border-width", "borderWidth"], ["font-size", "fontSize"]];
  for (const [cssKey, sourceKey] of lengthFields) {
    const value = safeLength(valueOf(style, sourceKey));
    if (value !== undefined) css[cssKey] = value;
  }
  const strokeWidth = numericCss(valueOf(style, "strokeWidth"));
  if (strokeWidth !== undefined) css["stroke-width"] = strokeWidth;
  for (const [cssKey, sourceKey] of [["opacity", "opacity"], ["--miro-fill-opacity", "fillOpacity"], ["--miro-border-opacity", "borderOpacity"], ["stroke-opacity", "strokeOpacity"], ["line-height", "lineHeight"]] as const) {
    const value = numericCss(valueOf(style, sourceKey));
    if (value !== undefined) css[cssKey] = value;
  }
  const fontFamily = valueOf(style, "fontFamily");
  if (isSafeFontFamily(fontFamily)) css["font-family"] = fontFamily.trim();
  const fontWeight = safeFontWeight(valueOf(style, "fontWeight"));
  if (fontWeight !== undefined) css["font-weight"] = fontWeight;
  const fontStyle = valueOf(style, "fontStyle");
  if (fontStyle === "normal" || fontStyle === "italic") css["font-style"] = fontStyle;
  const textAlign = valueOf(style, "textAlign");
  if (["left", "center", "right", "justify", "start", "end"].includes(String(textAlign))) css["text-align"] = String(textAlign);
  // Miro's own name for it is textAlignVertical.
  const verticalAlign = valueOf(style, "verticalAlign") ?? valueOf(style, "textAlignVertical");
  if (["top", "middle", "bottom"].includes(String(verticalAlign))) css["vertical-align"] = String(verticalAlign);
  const borderStyle = valueOf(style, "borderStyle");
  if (["normal", "solid", "dashed", "dotted", "none"].includes(String(borderStyle))) css["border-style"] = borderStyle === "normal" ? "solid" : String(borderStyle);
  return css;
}

function applyLocalCss(css: Record<string, string>, override: UnknownRecord | undefined): void {
  if (override === undefined) return;
  const borderStyle = valueOf(override, "borderStyle");
  if (typeof borderStyle === "string" && ["solid", "dashed", "dotted", "none"].includes(borderStyle)) css["border-style"] = borderStyle;
  const borderWidth = finiteNumber(valueOf(override, "borderWidth"));
  if (borderWidth !== undefined && borderWidth >= 0 && borderWidth <= 100) css["border-width"] = `${borderWidth}px`;
  const colors = valueOf(override, "colors");
  if (isRecord(colors)) {
    for (const [slot, cssKey] of [["text", "color"], ["fill", "background-color"], ["border", "border-color"], ["edge", "stroke"], ["highlight", "--miro-highlight"]] as const) {
      const read = readOwn(colors, slot);
      if (read.state === "present" && isSafeColor(read.value)) css[cssKey] = normalizeColor(read.value) ?? "transparent";
    }
  }
  const typography = valueOf(override, "typography");
  if (!isRecord(typography)) return;
  const family = valueOf(typography, "fontFamily");
  if (isSafeFontFamily(family)) css["font-family"] = family.trim();
  const size = finiteNumber(valueOf(typography, "fontSize"));
  if (size !== undefined && size >= 1 && size <= 512) css["font-size"] = `${size}px`;
  const weight = safeFontWeight(valueOf(typography, "fontWeight"));
  if (weight !== undefined) css["font-weight"] = weight;
  const style = valueOf(typography, "fontStyle");
  if (style === "normal" || style === "italic") css["font-style"] = style;
  const alignment = valueOf(typography, "alignment") ?? valueOf(typography, "textAlign");
  if (["left", "center", "right", "justify", "start", "end", "centre"].includes(String(alignment))) {
    css["text-align"] = alignment === "centre" ? "center" : String(alignment);
  }
  const lineHeight = finiteNumber(valueOf(typography, "lineHeight"));
  if (lineHeight !== undefined && lineHeight > 0 && lineHeight <= 10) css["line-height"] = String(lineHeight);
  const format = valueOf(typography, "format");
  const verticalAlign = valueOf(typography, "verticalAlign");
  if (typeof verticalAlign === "string" && ["top", "center", "middle", "bottom"].includes(verticalAlign)) css["vertical-align"] = verticalAlign === "center" ? "middle" : verticalAlign;
  const textDecoration = valueOf(typography, "textDecoration");
  if (typeof textDecoration === "string" && ["none", "underline", "line-through", "underline line-through", "line-through underline"].includes(textDecoration)) css["text-decoration"] = textDecoration;
  if (isRecord(format)) {
    const bold = valueOf(format, "bold");
    const italic = valueOf(format, "italic");
    if (typeof bold === "boolean") css["font-weight"] = bold ? "bold" : "normal";
    if (typeof italic === "boolean") css["font-style"] = italic ? "italic" : "normal";
    const decoration = new Set((css["text-decoration"] ?? "").split(" ").filter((token) => token && token !== "none"));
    let changed = false;
    for (const [key, token] of [["underline", "underline"], ["strike", "line-through"]] as const) {
      const flag = valueOf(format, key);
      if (typeof flag !== "boolean") continue;
      changed = true;
      if (flag) decoration.add(token); else decoration.delete(token);
    }
    if (changed) css["text-decoration"] = [...decoration].join(" ") || "none";
  }
}

function applyLocalConnector(
  base: SourceConnectorStyle | undefined, override: UnknownRecord | undefined, css: Record<string, string>,
): SourceConnectorStyle {
  const local = valueOf(override, "connector");
  const result = { ...base };
  const route = valueOf(local, "route");
  if (typeof route === "string" && (CONNECTOR_ROUTES as readonly string[]).includes(route)) result.shape = route as LocalConnectorSettings["route"];
  const stroke = valueOf(local, "strokeStyle");
  if (typeof stroke === "string" && (CONNECTOR_STROKES as readonly string[]).includes(stroke)) result.strokeStyle = stroke as LocalConnectorSettings["strokeStyle"];
  for (const key of ["startCap", "endCap"] as const) {
    const cap = valueOf(local, key);
    if (typeof cap === "string" && (CONNECTOR_CAPS as readonly string[]).includes(cap)) result[key] = cap;
  }
  const waypoints = readWaypoints(valueOf(local, "waypoints"));
  if (waypoints !== undefined) result.waypoints = waypoints;
  const width = finiteNumber(valueOf(local, "width"));
  const headSize = finiteNumber(valueOf(local, "headSize"));
  const labelT = finiteNumber(valueOf(local, "labelT"));
  if (headSize !== undefined && headSize >= 1 && headSize <= 1000) result.headSize = headSize;
  if (labelT !== undefined && labelT >= 0 && labelT <= 1) result.labelT = labelT;
  if (width !== undefined && width > 0 && width <= 100) css["stroke-width"] = String(width);
  const color = readOwn(local, "color");
  if (color.state === "present" && isSafeColor(color.value)) css.stroke = normalizeColor(color.value) ?? "transparent";
  return Object.freeze(result);
}

/** A line's end as a connector names it; one it does not know is drawn plain. */
function knownCap(cap: string | undefined): string {
  return cap !== undefined && (CONNECTOR_CAPS as readonly string[]).includes(cap) ? cap : "none";
}

function connectorStyle(item: UnknownRecord, diagnostics: string[], sourceId: string): SourceConnectorStyle | undefined {
  const style = valueOf(item, "style");
  const rawShape = valueOf(item, "shape");
  const shapeCandidate = typeof rawShape === "string" ? rawShape : valueOf(rawShape, "shape") ?? valueOf(rawShape, "type") ?? valueOf(rawShape, "path");
  const connector: { shape?: "straight" | "elbowed" | "curved"; startCap?: string; endCap?: string; strokeStyle?: "solid" | "dashed" | "dotted" } = {};
  if (shapeCandidate === "straight" || shapeCandidate === "elbowed" || shapeCandidate === "curved") connector.shape = shapeCandidate;
  else if (shapeCandidate !== undefined) diagnostics.push(`connector-shape-unknown: ${sourceId}.`);
  if (isRecord(style)) {
    for (const [sourceKey, targetKey] of [["startStrokeCap", "startCap"], ["endStrokeCap", "endCap"]] as const) {
      const value = valueOf(style, sourceKey);
      if (typeof value === "string" && SAFE_TOKEN.test(value)) connector[targetKey] = value.toLowerCase();
      else if (value !== undefined) diagnostics.push(`connector-endcap-unsafe: ${sourceId}.${sourceKey}.`);
    }
    const strokeStyle = valueOf(style, "strokeStyle");
    if (strokeStyle === "normal" || strokeStyle === "solid") connector.strokeStyle = "solid";
    else if (strokeStyle === "dashed" || strokeStyle === "dotted") connector.strokeStyle = strokeStyle;
    else if (strokeStyle !== undefined) diagnostics.push(`connector-stroke-style-unknown: ${sourceId}.`);
  }
  return Object.keys(connector).length > 0 ? Object.freeze(connector) : undefined;
}

interface IndexedSource {
  readonly byId: Map<string, UnknownRecord>;
  readonly insertion: readonly string[];
  readonly connectorIds: ReadonlySet<string>;
  readonly canvasForSource: Map<string, string>;
  readonly sourceForCanvas: Map<string, string>;
  /** Nodes pasted from another that show the same Miro item: node id to source id. */
  readonly copies: ReadonlyMap<string, string>;
  readonly tagDefinitions: ReadonlyMap<string, SourceTagDescriptor>;
}

function mindmapEdgeDescriptor(edge: UnknownRecord, index: IndexedSource): SourceMindmapEdgeDescriptor | undefined {
  const fromCanvas = valueOf(edge, "fromNode");
  const toCanvas = valueOf(edge, "toNode");
  if (typeof fromCanvas !== "string" || typeof toCanvas !== "string") return undefined;
  const fromSource = index.sourceForCanvas.get(fromCanvas) ?? fromCanvas;
  const toSource = index.sourceForCanvas.get(toCanvas) ?? toCanvas;
  const child = index.byId.get(toSource);
  if (child === undefined) return undefined;
  const rawType = valueOf(child, "type");
  if (typeof rawType !== "string" || rawType.toLowerCase() !== "mindmap_node") return undefined;
  const descriptor = sourceMindmapNodeDescriptor(child);
  if (descriptor.parentId !== fromSource) return undefined;
  return Object.freeze({
    parentId: fromCanvas,
    childId: toCanvas,
    ...(descriptor.branchColor === undefined ? {} : { branchColor: descriptor.branchColor }),
  });
}

function indexSource(document: unknown, diagnostics: string[]): IndexedSource {
  const byId = new Map<string, UnknownRecord>();
  const insertion: string[] = [];
  const connectorIds = new Set<string>();
  const tagDefinitions = new Map<string, SourceTagDescriptor>();
  const rootRead = readOwn(document, "miroSource");
  if (rootRead.state === "error") diagnostics.push("miro-source-read-failed: miroSource could not be read safely.");
  const source = rootRead.state === "present" && isRecord(rootRead.value) ? rootRead.value : undefined;
  if (rootRead.state === "present" && source === undefined) diagnostics.push("miro-source-malformed: miroSource must be an object.");
  const addArray = (field: "items" | "connectors", forcedConnector: boolean): void => {
    if (source === undefined) return;
    const read = readOwn(source, field);
    if (read.state === "error") { diagnostics.push(`source-array-read-failed: miroSource.${field}.`); return; }
    if (read.state === "absent") return;
    const values = arrayValue(read.value);
    if (values === undefined) { diagnostics.push(`source-array-malformed: miroSource.${field} must be an array.`); return; }
    const limit = Math.min(values.length, MAX_SOURCE_ITEMS - insertion.length);
    for (let index = 0; index < limit; index += 1) {
      const item = values[index];
      if (!isRecord(item)) { diagnostics.push(`source-item-malformed: miroSource.${field}[${index}].`); continue; }
      const id = valueOf(item, "id");
      if (typeof id !== "string" || id.length === 0) { diagnostics.push(`source-id-malformed: miroSource.${field}[${index}].`); continue; }
      const rawType = valueOf(item, "type");
      if (!forcedConnector && typeof rawType === "string" && rawType.toLowerCase() === "tag") {
        if (tagDefinitions.size >= MAX_TAG_DEFINITIONS) { diagnostics.push(`source-tag-definition-limit-reached: ${id}.`); continue; }
        const tag = sourceTagDefinition(item, diagnostics, id);
        if (tag !== undefined && !tagDefinitions.has(id)) tagDefinitions.set(id, tag);
        continue;
      }
      if (byId.has(id)) { diagnostics.push(`source-id-duplicate: ${id}.`); continue; }
      byId.set(id, item);
      insertion.push(id);
      if (forcedConnector) connectorIds.add(id);
    }
    if (values.length > limit) diagnostics.push(`source-limit-reached: at most ${MAX_SOURCE_ITEMS} source items are projected.`);
  };
  addArray("items", false);
  addArray("connectors", true);

  if (source !== undefined) {
    const tagsRead = readOwn(source, "tags");
    if (tagsRead.state === "error") diagnostics.push("source-array-read-failed: miroSource.tags.");
    else if (tagsRead.state === "present") {
      const tags = arrayValue(tagsRead.value);
      if (tags === undefined) diagnostics.push("source-array-malformed: miroSource.tags must be an array.");
      else {
        const limit = Math.min(tags.length, MAX_TAG_DEFINITIONS);
        for (let index = 0; index < limit; index += 1) {
          const item = tags[index];
          if (!isRecord(item)) continue;
          const id = valueOf(item, "id");
          if (typeof id !== "string" || id.length === 0 || tagDefinitions.has(id)) continue;
          const tag = sourceTagDefinition(item, diagnostics, id);
          if (tag !== undefined) tagDefinitions.set(id, tag);
        }
        if (tags.length > limit) diagnostics.push(`source-tag-definition-limit-reached: at most ${MAX_TAG_DEFINITIONS} tags are projected.`);
      }
    }
  }

  const sourceForCanvas = new Map<string, string>();
  const canvasForSource = new Map<string, string>();
  const copies = new Map<string, string>();
  const metadata = valueOf(document, "miroCanvas");
  const bindings = valueOf(metadata, "bindings");
  if (bindings !== undefined && !isRecord(bindings)) diagnostics.push("bindings-malformed: miroCanvas.bindings must be an object map.");
  if (isRecord(bindings)) {
    const keys = ownNames(bindings);
    const limit = Math.min(keys.length, MAX_BINDINGS);
    for (let index = 0; index < limit; index += 1) {
      const canvasId = keys[index]!;
      const binding = valueOf(bindings, canvasId);
      const sourceId = valueOf(binding, "sourceId");
      if (!isRecord(binding) || typeof sourceId !== "string" || sourceId.length === 0) {
        diagnostics.push(`binding-malformed: ${canvasId}.`);
        continue;
      }
      sourceForCanvas.set(canvasId, sourceId);
      // A copy shows the item its original shows, without taking its place:
      // the item is kept once, however many nodes show it.
      if (valueOf(binding, "role") === "copy") {
        copies.set(canvasId, sourceId);
        if (!byId.has(sourceId)) diagnostics.push(`binding-dangling: ${canvasId} -> ${sourceId}.`);
        continue;
      }
      const prior = canvasForSource.get(sourceId);
      if (prior !== undefined && prior !== canvasId) diagnostics.push(`binding-ambiguous: source ${sourceId} is bound to ${prior} and ${canvasId}.`);
      else canvasForSource.set(sourceId, canvasId);
      if (!byId.has(sourceId)) diagnostics.push(`binding-dangling: ${canvasId} -> ${sourceId}.`);
    }
    if (keys.length > limit) diagnostics.push(`binding-limit-reached: at most ${MAX_BINDINGS} bindings are projected.`);
  }
  return { byId, insertion: Object.freeze(insertion), connectorIds, canvasForSource, sourceForCanvas, copies, tagDefinitions };
}

function localShapeKind(document: unknown, canvasId: string): string | undefined {
  const shape = valueOf(localOverride(document, canvasId), "shape");
  const kind = valueOf(shape, "kind");
  return typeof kind === "string" && LOCAL_SHAPES.has(kind) ? kind : undefined;
}

function descriptorFor(document: unknown, canvasId: string, sourceId: string, source: UnknownRecord, forcedConnector: boolean, diagnostics: string[], tagDefinitions: ReadonlyMap<string, SourceTagDescriptor>): SourceItemDescriptor | undefined {
  const sourced = sourceKind(source, forcedConnector);
  if (sourced === undefined) {
    const rawType = valueOf(source, "type");
    diagnostics.push(typeof rawType === "string" && rawType.toLowerCase() === "mindmap"
      ? `source-mindmap-legacy-limited: ${sourceId}.`
      : `source-type-unsupported: ${sourceId}.`);
    return undefined;
  }
  const localShape = localShapeKind(document, canvasId);
  // A text item given a shape on this board is drawn as that shape.
  const kind: SourceItemKind = sourced === "text" && localShape !== undefined ? "shape" : sourced;
  let shape: string | undefined;
  if (sourced === "shape") {
    const subtype = sourceSubtype(source);
    if (subtype !== undefined && KNOWN_MIRO_SHAPES.has(subtype)) shape = subtype;
    else if (subtype !== undefined) diagnostics.push(`shape-subtype-unknown: ${sourceId} (${subtype}).`);
  }
  if (kind === "shape" && localShape !== undefined) shape = localShape;
  const css = sourceCss(source, kind);
  applyLocalCss(css, localOverride(document, canvasId));
  const connector = kind === "connector" ? applyLocalConnector(connectorStyle(source, diagnostics, sourceId), localOverride(document, canvasId), css) : undefined;
  const structured = sourceStructuredDescriptor(source, kind, diagnostics, sourceId, tagDefinitions);
  const zIndex = finiteNumber(valueOf(source, "zIndex"));
  return Object.freeze({
    sourceId,
    kind,
    ...(shape === undefined ? {} : { shape }),
    rotation: effectiveRotationFor(document, canvasId, source),
    ...(zIndex === undefined ? {} : { zIndex }),
    css: Object.freeze(css),
    ...(connector === undefined ? {} : { connector }),
    ...(structured === undefined ? {} : { structured }),
  });
}

function mapOrderEntry(entry: string, scene: ReadonlyMap<string, SourceItemDescriptor>, index: IndexedSource): string {
  if (scene.has(entry)) return entry;
  return index.canvasForSource.get(entry) ?? entry;
}

function explicitOrder(value: unknown, scene: ReadonlyMap<string, SourceItemDescriptor>, index: IndexedSource, diagnostics: string[], label: string): string[] | undefined {
  if (value === undefined) return undefined;
  const entries = arrayValue(value);
  if (entries === undefined) { diagnostics.push(`${label}-malformed: order must be an array.`); return undefined; }
  const result: string[] = [];
  const seen = new Set<string>();
  const limit = Math.min(entries.length, MAX_ORDER_ENTRIES);
  for (let i = 0; i < limit; i += 1) {
    const raw = entries[i];
    if (typeof raw !== "string") { diagnostics.push(`${label}-entry-malformed: index ${i}.`); continue; }
    const mapped = mapOrderEntry(raw, scene, index);
    if (seen.has(mapped)) { diagnostics.push(`${label}-duplicate: ${mapped}.`); continue; }
    seen.add(mapped);
    result.push(mapped);
  }
  if (entries.length > limit) diagnostics.push(`${label}-limit-reached: at most ${MAX_ORDER_ENTRIES} order entries are projected.`);
  for (const id of scene.keys()) if (!seen.has(id)) result.push(id);
  if ([...scene.keys()].some((id) => !seen.has(id))) diagnostics.push(`${label}-partial: unranked projected items keep deterministic source order.`);
  return result;
}

/**
 * Whether a node can be given a shape: a shape already, or a card that only
 * holds text - a Miro text item, a plain Canvas card, or text the tools made.
 * A sticky, code block, grid or drawing keeps the form it has.
 */
export function takesShape(descriptor: SourceItemDescriptor | undefined, nodeType: unknown): boolean {
  if (nodeType !== "text") return false;
  if (descriptor === undefined || descriptor.kind === "shape") return true;
  return descriptor.kind === "text" && (descriptor.localItem === undefined || descriptor.localItem === "text");
}

/** Build a renderer-facing scene without mutating or freezing any caller-owned input. */
export function buildSourceScene(document: unknown): SourceScene {
  const diagnostics: string[] = [];
  const index = indexSource(document, diagnostics);
  const items = new Map<string, SourceItemDescriptor>();
  for (const sourceId of index.insertion) {
    const source = index.byId.get(sourceId)!;
    const explicitCanvas = index.canvasForSource.get(sourceId);
    if (explicitCanvas === undefined && index.sourceForCanvas.has(sourceId) && index.sourceForCanvas.get(sourceId) !== sourceId) continue;
    const canvasId = explicitCanvas ?? sourceId;
    const descriptor = descriptorFor(document, canvasId, sourceId, source, index.connectorIds.has(sourceId), diagnostics, index.tagDefinitions);
    if (descriptor !== undefined) {
      if (items.has(canvasId)) diagnostics.push(`canvas-id-duplicate: ${canvasId}.`);
      else items.set(canvasId, descriptor);
    }
  }
  for (const [canvasId, sourceId] of index.copies) {
    const source = index.byId.get(sourceId);
    if (source === undefined || items.has(canvasId)) continue;
    const descriptor = descriptorFor(document, canvasId, sourceId, source, index.connectorIds.has(sourceId), diagnostics, index.tagDefinitions);
    if (descriptor !== undefined) items.set(canvasId, descriptor);
  }
  // Ordinary Canvas edges have native style defaults even without source evidence.
  const edges = arrayValue(valueOf(document, "edges")) ?? [];
  for (const edge of edges.slice(0, MAX_SOURCE_ITEMS)) {
    const id = valueOf(edge, "id");
    if (typeof id !== "string" || !id || items.has(id)) continue;
    const css: Record<string, string> = {};
    const color = safeColor(valueOf(edge, "color"));
    if (color !== undefined) css.stroke = color;
    const override = localOverride(document, id);
    applyLocalCss(css, override);
    const mindmapEdge = isRecord(edge) ? mindmapEdgeDescriptor(edge, index) : undefined;
    if (mindmapEdge?.branchColor !== undefined && css.stroke === undefined) css.stroke = mindmapEdge.branchColor;
    // Obsidian's own arrowhead is a filled triangle, not Miro's open arrow.
    const connector = applyLocalConnector({
      shape: "curved", strokeStyle: "solid",
      startCap: mindmapEdge === undefined && valueOf(edge, "fromEnd") === "arrow" ? "filled_triangle" : "none",
      endCap: mindmapEdge !== undefined || valueOf(edge, "toEnd") === "none" ? "none" : "filled_triangle",
    }, override, css);
    items.set(id, Object.freeze({
      kind: "connector", rotation: effectiveRotationFor(document, id), css: Object.freeze(css), connector,
      ...(mindmapEdge === undefined ? {} : { structured: Object.freeze({ mindmapEdge }) }),
    }));
  }
  const metadata = valueOf(document, "miroCanvas");
  const overrides = valueOf(metadata, "localOverrides");
  if (isRecord(overrides)) {
    const edgeIds = new Set(edges.map((edge) => valueOf(edge, "id")).filter((id): id is string => typeof id === "string"));
    for (const canvasId of ownNames(overrides)) {
      if (items.has(canvasId) || edgeIds.has(canvasId)) continue;
      const shape = localShapeKind(document, canvasId);
      const css: Record<string, string> = {};
      const item = shape === undefined ? readLocalItem(valueOf(localOverride(document, canvasId), "item")) : undefined;
      if (item?.type === "sticky_note") css["background-color"] = stickyFill(item.color ?? "light_yellow")!;
      if (item?.line !== undefined) {
        css.stroke = item.line.color;
        css["stroke-width"] = String(item.line.width);
      }
      applyLocalCss(css, localOverride(document, canvasId));
      const rotation = effectiveRotationFor(document, canvasId);
      if (item !== undefined) {
        const kind = item.type === "sticky_note" ? "sticky"
          : item.type === "table" || item.type === "drawing" || item.type === "line" ? "text" : item.type;
        // A line looks the way a connector does, and takes a connector's
        // settings: the toolbar restyles both the same way.
        const connector = item.line === undefined ? undefined : applyLocalConnector(Object.freeze({
          shape: item.line.route,
          ...(item.line.headSize === undefined ? {} : {headSize: item.line.headSize}),
          strokeStyle: item.line.strokeStyle ?? "solid",
          startCap: knownCap(item.line.startCap),
          endCap: knownCap(item.line.endCap),
        }), localOverride(document, canvasId), css);
        items.set(canvasId, Object.freeze({
          kind, rotation, css: Object.freeze(css), localItem: item.type,
          ...(connector === undefined ? {} : { connector }),
          ...(item.type === "code" ? {
            structured: Object.freeze({ code: Object.freeze({ lineNumbersVisible: true, ...(item.title === undefined ? {} : { title: item.title }) }) }),
          } : {}),
          ...(item.type === "table" ? {
            structured: Object.freeze({ table: Object.freeze(item.title === undefined ? {} : { title: item.title }) }),
          } : {}),
          ...(item.type === "drawing" && item.stroke !== undefined ? {
            structured: Object.freeze({ stroke: item.stroke }),
          } : {}),
          ...(item.type === "line" && item.line !== undefined ? {
            structured: Object.freeze({ line: item.line }),
          } : {}),
        }));
        continue;
      }
      // A node can be rotated or restyled locally without becoming a shape.
      // Without an entry here it would reach neither the renderer nor the
      // anchor geometry, so it would stay upright and its connectors would end
      // on the border it no longer has.
      if (shape === undefined && rotation === 0 && Object.keys(css).length === 0) continue;
      items.set(canvasId, Object.freeze(shape === undefined
        ? { kind: "text", rotation, css: Object.freeze(css) }
        : { kind: "shape", shape, rotation, css: Object.freeze(css) }));
    }
  }

  linkSlides(document, items, index);
  linkBackdrops(items, index);
  linkCommentNodes(document, items);

  const localOrder = explicitOrder(valueOf(metadata, "zOrder"), items, index, diagnostics, "miro-canvas-z-order");
  const sourceRoot = valueOf(document, "miroSource");
  const sourceOrder = localOrder ?? explicitOrder(valueOf(sourceRoot, "zOrder"), items, index, diagnostics, "miro-source-z-order");
  let order: string[];
  if (sourceOrder !== undefined) order = sourceOrder;
  else {
    const entries = [...items.entries()];
    const ranked = entries.filter(([, item]) => item.zIndex !== undefined);
    if (ranked.length > 0) {
      ranked.sort((a, b) => (a[1].zIndex! - b[1].zIndex!) || entries.findIndex(([id]) => id === a[0]) - entries.findIndex(([id]) => id === b[0]));
      const rankedIds = new Set(ranked.map(([id]) => id));
      order = [...ranked.map(([id]) => id), ...entries.filter(([id]) => !rankedIds.has(id)).map(([id]) => id)];
      if (ranked.length !== entries.length) diagnostics.push("source-order-partial: zIndex is missing for some projected items; unranked items keep deterministic source order.");
    } else {
      order = entries.map(([id]) => id);
      if (entries.length > 0) diagnostics.push("source-order-limited: no explicit z-order or zIndex is available; deterministic source order is not claimed as Miro layer order.");
    }
  }
  return Object.freeze({ items, order: Object.freeze(order), diagnostics: Object.freeze(diagnostics) });
}

/**
 * Ties each presentation to its slides: the frames whose parent is a slide
 * container.  Miro shows them row by row as the board lays them out, so that
 * is their order here too, taken from where the Canvas nodes sit.
 */
function linkSlides(document: unknown, items: Map<string, SourceItemDescriptor>, index: IndexedSource): void {
  const positions = new Map<string, Point>();
  for (const node of arrayValue(valueOf(document, "nodes")) ?? []) {
    const id = valueOf(node, "id"), x = finiteNumber(valueOf(node, "x")), y = finiteNumber(valueOf(node, "y"));
    if (typeof id === "string" && x !== undefined && y !== undefined) positions.set(id, { x, y });
  }
  const decks = new Map<string, string[]>();
  for (const [canvasId, item] of items) {
    if (item.kind !== "frame" || item.sourceId === undefined) continue;
    const source = index.byId.get(item.sourceId);
    if (String(valueOf(source, "type")).toLowerCase() === "slide_container" && !decks.has(canvasId)) {
      decks.set(canvasId, []);
    }
    const parentId = valueOf(valueOf(source, "parent"), "id");
    const parent = typeof parentId === "string" ? index.byId.get(parentId) : undefined;
    if (String(valueOf(parent, "type")).toLowerCase() !== "slide_container") continue;
    const deckId = index.canvasForSource.get(parentId as string) ?? (parentId as string);
    if (!items.has(deckId)) continue;
    decks.set(deckId, [...(decks.get(deckId) ?? []), canvasId]);
  }
  for (const [deckId, slides] of decks) {
    const at = (id: string): Point => positions.get(id) ?? { x: 0, y: 0 };
    // A row is whatever starts within a few units of the same height.
    slides.sort((a, b) => (Math.abs(at(a).y - at(b).y) > 8 ? at(a).y - at(b).y : at(a).x - at(b).x));
    const deck = items.get(deckId)!;
    const source = deck.sourceId === undefined ? undefined : index.byId.get(deck.sourceId);
    const rawTitle = valueOf(valueOf(source, "data"), "title");
    const title = typeof rawTitle === "string" && rawTitle.trim().length > 0 ? rawTitle.trim().slice(0, MAX_PREVIEW_TITLE_LENGTH) : undefined;
    items.set(deckId, withStructured(deck, { deck: Object.freeze({ ...(title === undefined ? {} : { title }), slides: Object.freeze(slides) }) }));
    slides.forEach((slideId, position) => {
      items.set(slideId, withStructured(items.get(slideId)!, { slide: Object.freeze({ deckId, index: position }) }));
    });
  }
}

const MAX_COMMENT_MESSAGES = 50;
const MAX_COMMENT_TEXT_LENGTH = 1_000;
const MAX_COMMENT_AUTHOR_LENGTH = 128;

/**
 * An exported comment has no board item, but a converter may still place its
 * thread on the board as a text node under the comment's id.  That node is
 * shown as the thread.
 */
function linkCommentNodes(document: unknown, items: Map<string, SourceItemDescriptor>): void {
  const nodeIds = new Set((arrayValue(valueOf(document, "nodes")) ?? [])
    .map((node) => valueOf(node, "id")).filter((id): id is string => typeof id === "string"));
  for (const thread of listCommentThreads(document, { includeResolved: true })) {
    if (thread.origin !== "imported" || !nodeIds.has(thread.id) || items.has(thread.id)) continue;
    const messages = threadMessages(thread).slice(0, MAX_COMMENT_MESSAGES).map((message) => Object.freeze({
      id: message.id,
      author: message.author.slice(0, MAX_COMMENT_AUTHOR_LENGTH),
      text: message.text.slice(0, MAX_COMMENT_TEXT_LENGTH),
      ...(message.createdAt === undefined ? {} : { createdAt: message.createdAt.slice(0, 64) }),
    }));
    items.set(thread.id, Object.freeze({
      sourceId: thread.id,
      kind: "text",
      rotation: 0,
      css: Object.freeze({}),
      structured: Object.freeze({ comment: Object.freeze({ resolved: thread.resolved, messages: Object.freeze(messages) }) }),
    }));
  }
}

/** Records the fill of each item's frame, for text that has no colour of its own. */
function linkBackdrops(items: Map<string, SourceItemDescriptor>, index: IndexedSource): void {
  for (const [canvasId, item] of items) {
    if (item.sourceId === undefined || item.kind === "connector") continue;
    const parentId = valueOf(valueOf(index.byId.get(item.sourceId), "parent"), "id");
    const parent = typeof parentId === "string" ? index.byId.get(parentId) : undefined;
    if (String(valueOf(parent, "type")).toLowerCase() !== "frame") continue;
    const fill = safeColor(valueOf(valueOf(parent, "style"), "fillColor"));
    if (fill !== undefined && /^#[0-9a-f]{6}$/iu.test(fill)) items.set(canvasId, withStructured(item, { backdrop: fill }));
  }
}

function withStructured(item: SourceItemDescriptor, extra: SourceStructuredDescriptor): SourceItemDescriptor {
  return Object.freeze({ ...item, structured: Object.freeze({ ...item.structured, ...extra }) });
}

/** Resolve rotation for one Canvas ID using local -> source geometry -> source fallback precedence. */
export function effectiveRotation(document: unknown, canvasId: string): number {
  const diagnostics: string[] = [];
  const index = indexSource(document, diagnostics);
  const sourceId = index.sourceForCanvas.get(canvasId) ?? canvasId;
  return effectiveRotationFor(document, canvasId, index.byId.get(sourceId));
}

export function rotatePoint(point: Point, center: Point, degrees: number): Point {
  const radians = degrees * Math.PI / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  const dx = point.x - center.x;
  const dy = point.y - center.y;
  return { x: center.x + dx * cosine - dy * sine, y: center.y + dx * sine + dy * cosine };
}

export function rotatedBounds(rect: Rect, degrees: number): Rect {
  const center = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  const corners = [
    rotatePoint({ x: rect.x, y: rect.y }, center, degrees),
    rotatePoint({ x: rect.x + rect.width, y: rect.y }, center, degrees),
    rotatePoint({ x: rect.x + rect.width, y: rect.y + rect.height }, center, degrees),
    rotatePoint({ x: rect.x, y: rect.y + rect.height }, center, degrees),
  ];
  const xs = corners.map((point) => point.x);
  const ys = corners.map((point) => point.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}
