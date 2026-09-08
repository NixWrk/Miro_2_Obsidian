/** Pure, bounded read-only projection of canonical Miro source metadata. */

import { isSafeColor, isSafeFontFamily, normalizeColor } from "./appearance";

export type SourceItemKind = "shape" | "text" | "sticky" | "connector" | "frame" | "media";

export interface SourceConnectorStyle {
  readonly shape?: "straight" | "elbowed" | "curved";
  readonly startCap?: string;
  readonly endCap?: string;
  readonly strokeStyle?: "solid" | "dashed" | "dotted";
}

export interface SourceItemDescriptor {
  readonly sourceId?: string;
  readonly kind: SourceItemKind;
  readonly shape?: string;
  readonly rotation: number;
  readonly zIndex?: number;
  readonly css: Readonly<Record<string, string>>;
  readonly connector?: SourceConnectorStyle;
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
const SAFE_TOKEN = /^[a-z0-9][a-z0-9_-]{0,63}$/iu;
const NUMERIC_STRING = /^-?(?:\d+(?:\.\d*)?|\.\d+)$/u;
const LOCAL_SHAPES = new Set(["rectangle", "round_rectangle", "ellipse", "triangle", "diamond", "star"]);
const KNOWN_MIRO_SHAPES = new Set([
  "rectangle", "round_rectangle", "circle", "triangle", "rhombus", "parallelogram", "trapezoid", "pentagon",
  "hexagon", "octagon", "wedge_round_rectangle_callout", "star", "cloud", "cross", "can", "right_arrow",
  "left_arrow", "left_right_arrow", "left_brace", "right_brace", "flow_chart_connector", "flow_chart_magnetic_disk",
  "flow_chart_input_output", "flow_chart_decision", "flow_chart_delay", "flow_chart_display", "flow_chart_document",
  "flow_chart_magnetic_drum", "flow_chart_internal_storage", "flow_chart_manual_input", "flow_chart_manual_operation",
  "flow_chart_merge", "flow_chart_multidocuments", "flow_chart_note_curly_left", "flow_chart_note_curly_right",
  "flow_chart_note_square", "flow_chart_offpage_connector", "flow_chart_or", "flow_chart_predefined_process",
  "flow_chart_predefined_process_2", "flow_chart_preparation", "flow_chart_process", "flow_chart_online_storage",
  "flow_chart_summing_junction", "flow_chart_terminator",
]);
const STICKY_COLORS: Readonly<Record<string, string>> = Object.freeze({
  light_yellow: "#fff59d", yellow: "#ffd54f", orange: "#ff8a65", red: "#ff0000", light_pink: "#f48fb1",
  pink: "#f06292", light_blue: "#7986cb", violet: "#9fa8da", blue: "#4fc3f7", dark_blue: "#42a5f5",
  cyan: "#26a69a", dark_green: "#66bb6a", light_green: "#c5e1a5", green: "#aed581", white: "#ffffff", black: "#000000",
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
    const mapped = STICKY_COLORS[value.toLowerCase()];
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
    case "image": case "document": case "doc_format": case "embed": case "preview": return "media";
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
  const verticalAlign = valueOf(style, "verticalAlign");
  if (["top", "middle", "bottom"].includes(String(verticalAlign))) css["vertical-align"] = String(verticalAlign);
  const borderStyle = valueOf(style, "borderStyle");
  if (["normal", "solid", "dashed", "dotted", "none"].includes(String(borderStyle))) css["border-style"] = borderStyle === "normal" ? "solid" : String(borderStyle);
  return css;
}

function applyLocalCss(css: Record<string, string>, override: UnknownRecord | undefined): void {
  if (override === undefined) return;
  const colors = valueOf(override, "colors");
  if (isRecord(colors)) {
    for (const [slot, cssKey] of [["text", "color"], ["fill", "background-color"], ["border", "border-color"], ["edge", "stroke"]] as const) {
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
  if (isRecord(format)) {
    if (valueOf(format, "bold") === true) css["font-weight"] = "bold";
    if (valueOf(format, "italic") === true) css["font-style"] = "italic";
    const decoration: string[] = [];
    if (valueOf(format, "underline") === true) decoration.push("underline");
    if (valueOf(format, "strike") === true) decoration.push("line-through");
    if (decoration.length > 0) css["text-decoration"] = decoration.join(" ");
  }
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
}

function indexSource(document: unknown, diagnostics: string[]): IndexedSource {
  const byId = new Map<string, UnknownRecord>();
  const insertion: string[] = [];
  const connectorIds = new Set<string>();
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
      if (byId.has(id)) { diagnostics.push(`source-id-duplicate: ${id}.`); continue; }
      byId.set(id, item);
      insertion.push(id);
      if (forcedConnector) connectorIds.add(id);
    }
    if (values.length > limit) diagnostics.push(`source-limit-reached: at most ${MAX_SOURCE_ITEMS} source items are projected.`);
  };
  addArray("items", false);
  addArray("connectors", true);

  const sourceForCanvas = new Map<string, string>();
  const canvasForSource = new Map<string, string>();
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
      const prior = canvasForSource.get(sourceId);
      if (prior !== undefined && prior !== canvasId) diagnostics.push(`binding-ambiguous: source ${sourceId} is bound to ${prior} and ${canvasId}.`);
      else canvasForSource.set(sourceId, canvasId);
      if (!byId.has(sourceId)) diagnostics.push(`binding-dangling: ${canvasId} -> ${sourceId}.`);
    }
    if (keys.length > limit) diagnostics.push(`binding-limit-reached: at most ${MAX_BINDINGS} bindings are projected.`);
  }
  return { byId, insertion: Object.freeze(insertion), connectorIds, canvasForSource, sourceForCanvas };
}

function localShapeKind(document: unknown, canvasId: string): string | undefined {
  const shape = valueOf(localOverride(document, canvasId), "shape");
  const kind = valueOf(shape, "kind");
  return typeof kind === "string" && LOCAL_SHAPES.has(kind) ? kind : undefined;
}

function descriptorFor(document: unknown, canvasId: string, sourceId: string, source: UnknownRecord, forcedConnector: boolean, diagnostics: string[]): SourceItemDescriptor | undefined {
  const kind = sourceKind(source, forcedConnector);
  if (kind === undefined) { diagnostics.push(`source-type-unsupported: ${sourceId}.`); return undefined; }
  let shape: string | undefined;
  if (kind === "shape") {
    const subtype = sourceSubtype(source);
    if (subtype !== undefined && KNOWN_MIRO_SHAPES.has(subtype)) shape = subtype;
    else if (subtype !== undefined) diagnostics.push(`shape-subtype-unknown: ${sourceId} (${subtype}).`);
  }
  const localShape = localShapeKind(document, canvasId);
  if (kind === "shape" && localShape !== undefined) shape = localShape;
  const css = sourceCss(source, kind);
  applyLocalCss(css, localOverride(document, canvasId));
  const zIndex = finiteNumber(valueOf(source, "zIndex"));
  return Object.freeze({
    sourceId,
    kind,
    ...(shape === undefined ? {} : { shape }),
    rotation: effectiveRotationFor(document, canvasId, source),
    ...(zIndex === undefined ? {} : { zIndex }),
    css: Object.freeze(css),
    ...(kind === "connector" ? { connector: connectorStyle(source, diagnostics, sourceId) } : {}),
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
    const descriptor = descriptorFor(document, canvasId, sourceId, source, index.connectorIds.has(sourceId), diagnostics);
    if (descriptor !== undefined) {
      if (items.has(canvasId)) diagnostics.push(`canvas-id-duplicate: ${canvasId}.`);
      else items.set(canvasId, descriptor);
    }
  }
  const metadata = valueOf(document, "miroCanvas");
  const overrides = valueOf(metadata, "localOverrides");
  if (isRecord(overrides)) {
    for (const canvasId of ownNames(overrides)) {
      const shape = localShapeKind(document, canvasId);
      if (shape === undefined || items.has(canvasId)) continue;
      const css: Record<string, string> = {};
      applyLocalCss(css, localOverride(document, canvasId));
      items.set(canvasId, Object.freeze({ kind: "shape", shape, rotation: effectiveRotationFor(document, canvasId), css: Object.freeze(css) }));
    }
  }

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
