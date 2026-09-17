import {
  buildCanvasAnchorGeometry, nativeAnchorEnd, nativeEdgeEnd, nativeEdgeRoute, nativeFreeEnd, roundCoordinate,
  type NativeEdgeEnd, type NodeMeasurements,
} from "./connector-endpoints";
import { SHAPE_CLIP_PATHS, inscribedInsets, shapeOutline, shapePath, type ShapePoint } from "./shape-geometry";
import { CAP_PATHS, capFilled, strokeDash } from "./connector-style";
import { planRoute, routePath, type RouteEnd as PlannedEnd, type RouteSegment } from "./connector-route";
import { normalizeAnchor, resolveAnchor, type AnchorEdgeGeometry, type AnchorPoint, type AnchorRect } from "./anchors";
import { readCanvasElementId } from "./canvas-elements";
import { buildSourceScene, type SourceItemDescriptor, type SourceScene } from "./source-model";

type UnknownRecord = Record<PropertyKey, unknown>;

export interface SourceRendererHost {
  getDocument(): unknown | undefined;
  getNodes(): readonly unknown[] | undefined;
  getEdges(): readonly unknown[] | undefined;
  getRotationPreview?(): { readonly id: string; readonly rotation: number } | undefined;
}

interface DomElementLike extends UnknownRecord {
  readonly nodeType?: unknown;
}

interface RenderedItem {
  readonly id: string;
  readonly kind: "node" | "edge";
  readonly element: DomElementLike;
  readonly marker: DomElementLike;
  readonly ownedChildren?: readonly DomElementLike[];
  readonly expectedRotations?: readonly { readonly element: DomElementLike; readonly rotation: number }[];
  readonly descriptor: SourceItemDescriptor;
  /** The host element this item decorates, and the runtime properties that expose it. */
  readonly anchor: { readonly keys: readonly string[]; readonly element: DomElementLike };
  /** Replaces the marker check for an item that puts no marker on the host. */
  readonly intact?: () => boolean;
  /** Draws the item again after the host redrew the element it decorates. */
  readonly follow?: { readonly element: DomElementLike; readonly attribute: string; readonly apply: () => void };
}

type RestorePatch = () => void;

const OWNED_CLASS = "miro-source-rendered";
const DECORATION_CLASS = "miro-source-decoration";
/** Where a runtime node exposes the element this module marks, first match wins. */
const NODE_SHELL_KEYS = ["nodeEl", "containerEl", "contentEl", "el"] as const;
/** Where a runtime edge exposes the element this module marks, first match wins. */
const EDGE_TARGET_KEYS = ["edgeEl", "lineGroupEl", "lineEndGroupEl", "el"] as const;
const MAX_RUNTIME_ITEMS = 100_000;
const MAX_Z_INDEX = 2_147_483_647;

const TYPOGRAPHY_CSS = new Set([
  "color",
  "font-family",
  "font-size",
  "font-style",
  "font-weight",
  "line-height",
  "text-align",
  "text-decoration",
  "vertical-align",
]);

const BOX_CSS = new Set([
  "background-color",
  "border-color",
  "border-style",
  "border-width",
  "opacity",
  "--miro-fill-opacity",
  "--miro-border-opacity",
]);

const CONNECTOR_ATTRIBUTE_CSS: Readonly<Record<string, string>> = Object.freeze({
  stroke: "stroke",
  "stroke-width": "stroke-width",
  "stroke-opacity": "stroke-opacity",
});


const SVG_NS = "http://www.w3.org/2000/svg";
let markerSequence = 0;

function createSvg(document: Document | undefined, tag: string): DomElementLike | undefined {
  const element = safeCall(document, "createElementNS", [SVG_NS, tag]);
  return isElement(element) ? element : undefined;
}

function isObject(value: unknown): value is UnknownRecord {
  return value !== null && (typeof value === "object" || typeof value === "function");
}

function safeGet(value: unknown, key: PropertyKey): unknown {
  if (!isObject(value)) return undefined;
  try {
    return Reflect.get(value, key, value);
  } catch {
    return undefined;
  }
}

function safeCall(value: unknown, method: PropertyKey, args: readonly unknown[] = []): unknown {
  const callback = safeGet(value, method);
  if (typeof callback !== "function") return undefined;
  try {
    return Reflect.apply(callback, value, args);
  } catch {
    return undefined;
  }
}

function isElement(value: unknown): value is DomElementLike {
  if (!isObject(value)) return false;
  const nodeType = safeGet(value, "nodeType");
  if (nodeType !== undefined && nodeType !== 1) return false;
  return typeof safeGet(value, "setAttribute") === "function"
    && typeof safeGet(value, "getAttribute") === "function";
}

function readCollection(host: unknown, method: "getNodes" | "getEdges", diagnostics: string[]): readonly unknown[] {
  const raw = safeCall(host, method);
  if (raw === undefined || raw === null) return [];
  try {
    if (Array.isArray(raw)) return raw.length <= MAX_RUNTIME_ITEMS ? raw : raw.slice(0, MAX_RUNTIME_ITEMS);
    if (raw instanceof Map || raw instanceof Set) {
      if (raw.size > MAX_RUNTIME_ITEMS) diagnostics.push(`${method}-limit-reached: runtime collection was truncated.`);
      const result: unknown[] = [];
      const iterator = raw instanceof Map ? raw.values() : raw.values();
      for (let current = iterator.next(); !current.done && result.length < MAX_RUNTIME_ITEMS; current = iterator.next()) {
        result.push(current.value);
      }
      return result;
    }
  } catch {
    diagnostics.push(`${method}-read-failed: runtime collection could not be read safely.`);
    return [];
  }
  diagnostics.push(`${method}-unsupported: runtime collection is not an array, Map, or Set.`);
  return [];
}

function elementFor(runtime: unknown, keys: readonly string[]): DomElementLike | undefined {
  for (const key of keys) {
    const candidate = safeGet(runtime, key);
    if (isElement(candidate)) return candidate;
  }
  return undefined;
}

function allElementsFor(runtime: unknown, keys: readonly string[]): readonly DomElementLike[] {
  const result: DomElementLike[] = [];
  const seen = new Set<DomElementLike>();
  for (const key of keys) {
    const candidate = safeGet(runtime, key);
    if (isElement(candidate) && !seen.has(candidate)) {
      seen.add(candidate);
      result.push(candidate);
    }
  }
  return result;
}

function styleObject(element: DomElementLike): UnknownRecord | undefined {
  const style = safeGet(element, "style");
  return isObject(style) ? style : undefined;
}

function readStyle(element: DomElementLike, property: string): string | undefined {
  const style = styleObject(element);
  if (style === undefined) return undefined;
  const result = safeCall(style, "getPropertyValue", [property]);
  return typeof result === "string" ? result : undefined;
}

function readStylePriority(element: DomElementLike, property: string): string | undefined {
  const style = styleObject(element);
  if (style === undefined) return undefined;
  const result = safeCall(style, "getPropertyPriority", [property]);
  return typeof result === "string" ? result : undefined;
}

/**
 * Write one declaration and return the value the engine stored for it.
 *
 * Chromium keeps a declaration in its own spelling - numbers cut to six
 * significant digits, colours as rgb(), shorthands compressed - so the stored
 * value is often not the string written.  Requiring the two to be equal
 * reported ordinary writes as refused: the style still landed, but no restore
 * was recorded for it, and it outlived dispose.  Callers compare against the
 * stored value instead, which is what a later restore must recognise.
 */
function setStyleRaw(element: DomElementLike, property: string, value: string, priority = ""): string | undefined {
  const style = styleObject(element);
  if (style === undefined || typeof safeGet(style, "setProperty") !== "function") return undefined;
  safeCall(style, "setProperty", [property, value, priority]);
  return readStyle(element, property);
}

function patchStyle(
  element: DomElementLike,
  property: string,
  value: string,
  patches: RestorePatch[],
  restoreValue?: string,
): boolean {
  const before = readStyle(element, property);
  if (before === undefined) return false;
  const beforePriority = readStylePriority(element, property) ?? "";
  const restored = restoreValue ?? before;
  const restoredPriority = restoreValue === undefined ? beforePriority : "";
  if (before === value && beforePriority === "" && restored === before) return true;
  let owned = before;
  if (before !== value || beforePriority !== "") {
    const stored = setStyleRaw(element, property, value);
    if (stored === undefined) return false;
    owned = stored;
  }
  patches.push(() => {
    // A value the host wrote since is the host's, and stays.
    if (readStyle(element, property) !== owned || (readStylePriority(element, property) ?? "") !== "") return;
    if (restored.length === 0) {
      const currentStyle = styleObject(element);
      if (currentStyle !== undefined) safeCall(currentStyle, "removeProperty", [property]);
    } else {
      setStyleRaw(element, property, restored, restoredPriority);
    }
  });
  return true;
}

function readAttribute(element: DomElementLike, name: string): string | null | undefined {
  const value = safeCall(element, "getAttribute", [name]);
  return value === null || typeof value === "string" ? value : undefined;
}

function patchAttribute(element: DomElementLike, name: string, value: string, patches: RestorePatch[]): boolean {
  const before = readAttribute(element, name);
  if (before === undefined) return false;
  if (before === value) return true;
  safeCall(element, "setAttribute", [name, value]);
  if (readAttribute(element, name) !== value) return false;
  patches.push(() => {
    if (readAttribute(element, name) !== value) return;
    if (before === null) safeCall(element, "removeAttribute", [name]);
    else safeCall(element, "setAttribute", [name, before]);
  });
  return true;
}

function patchClass(element: DomElementLike, className: string, patches: RestorePatch[]): boolean {
  const classList = safeGet(element, "classList");
  if (!isObject(classList)) return false;
  const present = safeCall(classList, "contains", [className]);
  if (present === true) return true;
  if (present !== false) return false;
  safeCall(classList, "add", [className]);
  if (safeCall(classList, "contains", [className]) !== true) return false;
  patches.push(() => {
    if (safeCall(classList, "contains", [className]) === true) safeCall(classList, "remove", [className]);
  });
  return true;
}

function createElement(document: Document, tagName: string): DomElementLike | undefined {
  const element = safeCall(document, "createElement", [tagName]);
  return isElement(element) ? element : undefined;
}

function defaultDocument(): Document | undefined {
  const candidate = safeGet(globalThis, "document");
  return isObject(candidate) && typeof safeGet(candidate, "createElement") === "function"
    ? candidate as unknown as Document
    : undefined;
}

function appendOwnedChild(parent: DomElementLike, child: DomElementLike, patches: RestorePatch[]): boolean {
  if (typeof safeGet(parent, "appendChild") !== "function") return false;
  safeCall(parent, "appendChild", [child]);
  if (safeGet(child, "parentNode") !== parent) return false;
  patches.push(() => {
    if (safeGet(child, "parentNode") !== parent) return;
    if (typeof safeGet(parent, "removeChild") === "function") safeCall(parent, "removeChild", [child]);
    else safeCall(child, "remove", []);
  });
  return true;
}

function setOwnedElementStyle(element: DomElementLike, property: string, value: string): void {
  const style = styleObject(element);
  if (style !== undefined) safeCall(style, "setProperty", [property, value]);
}

function setOwnedElementAttribute(element: DomElementLike, name: string, value: string): void {
  safeCall(element, "setAttribute", [name, value]);
}

function addOwnedElementClass(element: DomElementLike, className: string): void {
  const classList = safeGet(element, "classList");
  if (isObject(classList)) safeCall(classList, "add", [className]);
}

function setOwnedElementText(element: DomElementLike, value: string): void {
  try { Reflect.set(element, "textContent", value, element); } catch { /* owned optional decoration */ }
}

function decoratePreview(document: Document | undefined, layer: DomElementLike, descriptor: SourceItemDescriptor): boolean {
  const preview = descriptor.structured?.preview;
  if (document === undefined || preview === undefined) return false;
  const metadata = createElement(document, "div");
  if (metadata === undefined) return false;
  addOwnedElementClass(metadata, "miro-source-preview-meta");
  const add = (className: string, value: string | undefined): void => {
    if (value === undefined) return;
    const item = createElement(document, "div");
    if (item === undefined) return;
    addOwnedElementClass(item, className);
    setOwnedElementText(item, value);
    safeCall(metadata, "appendChild", [item]);
  };
  add("miro-source-preview-provider", preview.provider);
  add("miro-source-preview-title", preview.title);
  add("miro-source-preview-description", preview.description);
  if (safeGet(metadata, "children") !== undefined && safeCall(layer, "appendChild", [metadata]) !== undefined) {
    return safeGet(metadata, "parentNode") === layer;
  }
  return false;
}

function decorateTags(
  document: Document | undefined,
  shell: DomElementLike,
  descriptor: SourceItemDescriptor,
  patches: RestorePatch[],
): DomElementLike | undefined {
  const tags = descriptor.structured?.tags;
  if (document === undefined || tags === undefined || tags.length === 0) return undefined;
  const list = createElement(document, "div");
  if (list === undefined) return undefined;
  addOwnedElementClass(list, "miro-source-tag-list");
  setOwnedElementAttribute(list, "aria-hidden", "true");
  setOwnedElementAttribute(list, "data-miro-source-tags", String(tags.length));
  setOwnedElementStyle(list, "pointer-events", "none");
  setOwnedElementStyle(list, "z-index", "3");
  for (const tag of tags) {
    const chip = createElement(document, "span");
    if (chip === undefined) continue;
    addOwnedElementClass(chip, "miro-source-tag-chip");
    setOwnedElementText(chip, tag.title);
    if (tag.color !== undefined) setOwnedElementStyle(chip, "background-color", tag.color);
    safeCall(list, "appendChild", [chip]);
  }
  return appendOwnedChild(shell, list, patches) ? list : undefined;
}

function decorateShape(document: Document | undefined, layer: DomElementLike, descriptor: SourceItemDescriptor): boolean {
  const d = shapePath(descriptor.shape);
  if (d === undefined) return false;
  const svg = createSvg(document, "svg"), path = createSvg(document, "path");
  if (svg === undefined || path === undefined) return false;
  for (const [name, value] of Object.entries({ viewBox: "0 0 100 100", preserveAspectRatio: "none", width: "100%", height: "100%" })) {
    setOwnedElementAttribute(svg, name, value);
  }
  setOwnedElementStyle(svg, "overflow", "visible");
  setOwnedElementStyle(svg, "position", "absolute");
  setOwnedElementStyle(svg, "inset", "0");
  const css = descriptor.css;
  const open = /brace|note_curly|note_square/.test(descriptor.shape ?? "");
  for (const [name, value] of Object.entries({
    d, fill: open ? "none" : css["background-color"] ?? "var(--canvas-background, var(--background-primary))",
    stroke: css["border-color"] ?? "var(--canvas-border, var(--text-normal))",
    "stroke-width": css["border-width"]?.replace(/px$/, "") ?? "1",
    "fill-opacity": css["--miro-fill-opacity"] ?? "1", "stroke-opacity": css["--miro-border-opacity"] ?? "1",
    "stroke-dasharray": css["border-style"] === "dashed" ? "8 6" : css["border-style"] === "dotted" ? "2 5" : "none",
    "vector-effect": "non-scaling-stroke", "stroke-linejoin": "round",
  })) setOwnedElementAttribute(path, name, value);
  if (css["border-style"] === "none") setOwnedElementAttribute(path, "stroke", "none");
  safeCall(svg, "appendChild", [path]);
  safeCall(layer, "appendChild", [svg]);
  return safeGet(svg, "parentNode") === layer && safeGet(path, "parentNode") === svg;
}

function applyNodeCss(
  descriptor: SourceItemDescriptor,
  shell: DomElementLike,
  content: DomElementLike,
  layer: DomElementLike | undefined,
  patches: RestorePatch[],
): void {
  for (const [property, value] of Object.entries(descriptor.css)) {
    if (TYPOGRAPHY_CSS.has(property)) {
      patchStyle(content, property, value, patches);
    } else if (BOX_CSS.has(property)) {
      if (layer !== undefined) {
        if (descriptor.kind !== "shape" || property === "opacity") setOwnedElementStyle(layer, property, value);
      }
      else patchStyle(shell, property, value, patches);
    }
  }
}

function isContained(outer: DomElementLike, inner: DomElementLike): boolean {
  const result = safeCall(outer, "contains", [inner]);
  return result === true;
}

const OWNED_ROTATION_ATTRIBUTE = "data-miro-source-owned-rotation";

/**
 * The angle as written to the DOM.
 *
 * Three decimals keep any angle in [-180, 180) within the six significant
 * digits Chromium stores, so the transform read back carries exactly the
 * rotation written and stays recognisable as this module's own.  A thousandth
 * of a degree moves the corner of even a very large node by a fraction of a
 * pixel.
 */
function cssAngle(rotation: number): number {
  if (!Number.isFinite(rotation)) return 0;
  const rounded = Math.round(rotation * 1000) / 1000;
  return Object.is(rounded, -0) ? 0 : rounded;
}

function rotationStyle(angle: number): string {
  return `rotate(${angle}deg)`;
}

const TRAILING_ROTATION = /(?:^|\s)rotate\(\s*(-?(?:\d+(?:\.\d*)?|\.\d+)(?:e[-+]?\d+)?)deg\s*\)$/iu;

/** The rotate() a transform ends with, in degrees. */
function trailingRotation(transform: string): number | undefined {
  const match = TRAILING_ROTATION.exec(transform.trim());
  const angle = match === null ? Number.NaN : Number(match[1]);
  return Number.isFinite(angle) ? angle : undefined;
}

function endsWithRotation(transform: string, angle: number): boolean {
  const trailing = trailingRotation(transform);
  return trailing !== undefined && Math.abs(trailing - angle) < 0.0005;
}

/** The transform with this module's rotation as its last function, once. */
function withRotation(transform: string, angle: number): string {
  const trimmed = transform.trim();
  if (endsWithRotation(trimmed, angle)) return trimmed;
  const base = trimmed === "none" ? "" : trimmed;
  return base.length === 0 ? rotationStyle(angle) : `${base} ${rotationStyle(angle)}`;
}

/** The transform without this module's trailing rotation, when it has one. */
function withoutRotation(transform: string, angle: number): string {
  const trimmed = transform.trim();
  return endsWithRotation(trimmed, angle) ? trimmed.replace(/\s*rotate\([^()]*\)$/u, "").trim() : trimmed;
}

function writeTransform(element: DomElementLike, value: string): void {
  if (value.length > 0) {
    setStyleRaw(element, "transform", value);
    return;
  }
  const style = styleObject(element);
  if (style !== undefined) safeCall(style, "removeProperty", ["transform"]);
}

/** Put the rotation back after the host rewrote the transform it owns. */
function keepRotation(element: DomElementLike, angle: number): void {
  const current = readStyle(element, "transform");
  if (current === undefined || endsWithRotation(current, angle)) return;
  setStyleRaw(element, "transform", withRotation(current, angle));
}

/**
 * Clear an independent `rotate` an earlier build of this plugin left behind.
 *
 * Those builds turned a node with that property and checked the write by
 * string equality.  Chromium stores the angle to six significant digits, so
 * most gesture angles failed the check: the property stayed on the node with
 * no restore recorded, and the failure let a transform fallback turn the node
 * a second time.  Neither Obsidian nor this build writes the property, so a
 * bare angle on a node's own elements is that leftover.  It goes, together
 * with the matching rotation at the end of the transform.
 */
function clearLeakedRotateProperty(element: DomElementLike): void {
  const leaked = readStyle(element, "rotate")?.trim() ?? "";
  if (!/^-?(?:\d+(?:\.\d*)?|\.\d+)(?:e[-+]?\d+)?deg$/iu.test(leaked)) return;
  const style = styleObject(element);
  if (style === undefined) return;
  safeCall(style, "removeProperty", ["rotate"]);
  const transform = readStyle(element, "transform");
  if (transform === undefined) return;
  const repaired = withoutRotation(transform, Number(leaked.slice(0, -3)));
  if (repaired !== transform.trim()) writeTransform(element, repaired);
}

/** Repair a transform suffix left by a previous plugin build, when ownership is proven. */
function clearLegacyOwnedTransformRotation(element: DomElementLike, patches: RestorePatch[]): void {
  const owned = readAttribute(element, OWNED_ROTATION_ATTRIBUTE);
  const before = readStyle(element, "transform");
  if (owned === null || owned === undefined || before === undefined) return;
  const suffix = `rotate(${owned}deg)`;
  const marker = ` ${suffix}`;
  let base = before.trim();
  while (base === suffix || base.endsWith(marker)) {
    base = base === suffix ? "" : base.slice(0, -marker.length).trim();
  }
  if (base !== before.trim()) patchStyle(element, "transform", base, patches, base);
  safeCall(element, "removeAttribute", [OWNED_ROTATION_ATTRIBUTE]);
}

/**
 * Write a declaration that must win over the host's own rule.
 *
 * An ordinary inline write loses to a host stylesheet rule marked important,
 * and losing that contest for the rotation centre would turn the node about
 * some other point.  This one declaration therefore carries the same weight,
 * and restores the host's value and priority exactly.
 */
function setStyleWithPriority(
  element: DomElementLike, property: string, value: string, patches: RestorePatch[],
): boolean {
  const before = readStyle(element, property);
  const beforePriority = readStylePriority(element, property) ?? "";
  if (before === undefined) return false;
  if (before === value && beforePriority === "important") return true;
  const stored = setStyleRaw(element, property, value, "important");
  if (stored === undefined || readStylePriority(element, property) !== "important") return false;
  patches.push(() => {
    if (readStyle(element, property) !== stored) return;
    if (before.length === 0) {
      const style = styleObject(element);
      if (style !== undefined) safeCall(style, "removeProperty", [property]);
      return;
    }
    setStyleRaw(element, property, before, beforePriority);
  });
  return true;
}

/**
 * Turn one element about its own centre.
 *
 * The rotation is the last function of the element's `transform`, after the
 * translate native Canvas positions every node with.  The independent `rotate`
 * property looks cleaner but composes the other way round: CSS applies it on
 * top of the whole transform, so it turned the node's translate too and swung
 * the node about the canvas origin.  The further a node sat from that origin,
 * the further it landed from its own geometry, while the handles and every
 * connector stayed at its real centre.
 */
function applyElementRotation(
  element: DomElementLike,
  angle: number,
  patches: RestorePatch[],
  /** Collects elements whose rotation centre the host would not let go of. */
  originRefused: DomElementLike[] = [],
): boolean {
  if (!Number.isFinite(angle) || angle === 0) return false;
  clearLegacyOwnedTransformRotation(element, patches);
  clearLeakedRotateProperty(element);
  const before = readStyle(element, "transform");
  if (before === undefined) return false;
  const stored = setStyleRaw(element, "transform", withRotation(before, angle));
  if (stored === undefined) return false;
  // The restore re-derives from the transform it finds instead of writing
  // back the one captured here.  Native Canvas rewrites the transform as it
  // moves a node, so replaying a captured value pinned the node where it was
  // first turned: it stayed put while the document, the handles and every
  // connector moved on.
  patches.push(() => {
    const current = readStyle(element, "transform");
    if (current === undefined) return;
    const restored = withoutRotation(current, angle);
    if (restored !== current.trim()) writeTransform(element, restored);
  });
  if (!endsWithRotation(stored, angle)) return false;
  // Composed after the translate, the rotation pivots on the transform origin
  // of the node's own box, so that origin has to be the box's centre.  It is
  // asserted with the priority an author rule carries, and a host that still
  // refuses it is named rather than left to turn the node about another point.
  if (!setStyleWithPriority(element, "transform-origin", "50% 50%", patches)) originRefused.push(element);
  patchAttribute(element, OWNED_ROTATION_ATTRIBUTE, String(angle), patches);
  return true;
}

function applyInteractionRotation(runtime: unknown, primary: DomElementLike, angle: number, patches: RestorePatch[]): DomElementLike[] {
  const rotated: DomElementLike[] = [];
  const interactionElements = allElementsFor(runtime, ["hitboxEl", "interactionEl", "resizerEl", "resizeEl", "selectionEl", "bboxEl"]);
  for (const element of interactionElements) {
    if (element === primary || isContained(primary, element) || isContained(element, primary)) continue;
    if (applyElementRotation(element, angle, patches)) rotated.push(element);
  }
  return rotated;
}

/** Rotates the node and returns every element now carrying the rotation. */
function applyRotation(runtime: unknown, primary: DomElementLike, angle: number, patches: RestorePatch[], diagnostics: string[], id: string): DomElementLike[] {
  if (!Number.isFinite(angle) || angle === 0) return [];
  const originRefused: DomElementLike[] = [];
  if (!applyElementRotation(primary, angle, patches, originRefused)) {
    diagnostics.push(`rotation-dom-inaccessible: ${id}.`);
    return [];
  }
  if (originRefused.includes(primary)) {
    diagnostics.push(`rotation-centre-unavailable: ${id} turns about the point its host chose.`);
  }
  return [primary, ...applyInteractionRotation(runtime, primary, angle, patches)];
}

function normalizedZIndex(value: number | undefined): string | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined;
  const integer = Math.trunc(value);
  if (integer > MAX_Z_INDEX || integer < -MAX_Z_INDEX) return undefined;
  return String(integer);
}

function domSize(element: DomElementLike | undefined): { readonly width: number; readonly height: number } | undefined {
  const measure = safeGet(element, "getBoundingClientRect");
  if (typeof measure !== "function") return undefined;
  try {
    const rect = Reflect.apply(measure, element, []);
    const width = safeGet(rect, "width"), height = safeGet(rect, "height");
    return typeof width === "number" && typeof height === "number"
      && Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0
      ? { width, height }
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Report the boxes the host actually drew, in board units.
 *
 * A collapsed group is the case that matters: its state is not in the file, so
 * only the live DOM knows it shrank.  The board scale is derived from the
 * nodes that agree with the document, and a turned node is never measured
 * because its DOM box is the inflated axis-aligned bounds, not its own size.
 * A node counts as turned when the file says so, when it is being turned
 * right now, or when the DOM still carries a turn: a node saved upright but
 * previewed at an angle was measured by its inflated box, and every edge on
 * it ended on a node larger than the one drawn.
 */
function measureNodes(
  document: unknown, runtimeNodes: readonly unknown[], scene: SourceScene, turning: ReadonlySet<string> = new Set(),
): NodeMeasurements {
  const declared = new Map<string, { readonly width: number; readonly height: number }>();
  const nodes = safeGet(document, "nodes");
  if (!Array.isArray(nodes)) return {};
  for (const node of nodes) {
    const id = safeGet(node, "id");
    const width = safeGet(node, "width"), height = safeGet(node, "height");
    if (typeof id === "string" && typeof width === "number" && typeof height === "number" && width > 0 && height > 0) {
      declared.set(id, { width, height });
    }
  }
  const observed = new Map<string, { readonly width: number; readonly height: number }>();
  const ratios: number[] = [];
  for (const runtime of runtimeNodes) {
    const id = readCanvasElementId(runtime);
    const element = elementFor(runtime, ["nodeEl", "containerEl", "el"]);
    const declaredSize = id === undefined ? undefined : declared.get(id);
    if (id === undefined || element === undefined || declaredSize === undefined) continue;
    const shownAngle = trailingRotation(readStyle(element, "transform") ?? "") ?? 0;
    if ((scene.items.get(id)?.rotation ?? 0) !== 0 || turning.has(id) || cssAngle(shownAngle) !== 0) continue;
    const size = domSize(element);
    if (size === undefined) continue;
    observed.set(id, size);
    ratios.push(size.width / declaredSize.width);
  }
  if (ratios.length === 0) return {};
  ratios.sort((left, right) => left - right);
  const scale = ratios[Math.floor(ratios.length / 2)]!;
  if (!Number.isFinite(scale) || scale <= 0) return {};
  const measurements: Record<string, { width: number; height: number }> = Object.create(null);
  for (const [id, size] of observed) {
    const declaredSize = declared.get(id)!;
    const width = size.width / scale, height = size.height / scale;
    // Only a real disagreement is reported; rounding noise is not a measurement.
    if (Math.abs(width - declaredSize.width) > 1 || Math.abs(height - declaredSize.height) > 1) {
      measurements[id] = { width, height };
    }
  }
  return measurements;
}

function safeSignature(value: unknown): string | undefined {
  try {
    return JSON.stringify(value, (_key, item: unknown) =>
      typeof item === "number" && Number.isFinite(item) ? Math.round(item * 100) / 100 : item);
  } catch {
    return undefined;
  }
}

function queryAll(element: DomElementLike, selector: string): DomElementLike[] {
  const values = safeCall(element, "querySelectorAll", [selector]);
  if (!isObject(values)) return [];
  const length = safeGet(values, "length");
  if (typeof length !== "number" || length > 10000) return [];
  const result: DomElementLike[] = [];
  for (let i = 0; i < length; i++) {
    const value = safeGet(values, i);
    if (isElement(value)) result.push(value);
  }
  return result;
}

/**
 * Caps are drawn at Miro's size on imported connectors and at Obsidian's on
 * local ones, where the filled triangle matches Obsidian's own arrowhead.
 */
const LOCAL_CAP_SCALE = 0.6;

function marker(
  document: Document | undefined, cap: string, color: string, patches: RestorePatch[], parent: DomElementLike, scale = 1,
): string | undefined {
  if (cap === "none") return "none";
  const d = CAP_PATHS[cap];
  if (d === undefined) return undefined;
  const defs = createSvg(document, "defs"), mark = createSvg(document, "marker"), path = createSvg(document, "path");
  if (defs === undefined || mark === undefined || path === undefined) return undefined;
  const id = `miro-cap-${++markerSequence}`;
  for (const [key, value] of Object.entries({ id, viewBox: "-16 -8 18 16", refX: "0", refY: "0", markerWidth: String(18 * scale), markerHeight: String(16 * scale), markerUnits: "strokeWidth", orient: "auto-start-reverse" })) {
    setOwnedElementAttribute(mark, key, value);
  }
  const filled = capFilled(cap);
  for (const [key, value] of Object.entries({ d, fill: filled ? color : "none", stroke: color, "stroke-width": "1", "stroke-linejoin": "round" })) setOwnedElementAttribute(path, key, value);
  safeCall(mark, "appendChild", [path]);
  safeCall(defs, "appendChild", [mark]);
  return appendOwnedChild(parent, defs, patches) ? `url(#${id})` : undefined;
}

/** Map board coordinates into a native path's SVG user space, preserving local transforms. */
function localRoute(path: DomElementLike, geometry: AnchorEdgeGeometry): string | undefined {
  const start = geometry.start, end = geometry.end;
  if (start === undefined || end === undefined) return undefined;
  let map = (point: AnchorPoint): AnchorPoint => point;
  const svg = safeGet(path, "ownerSVGElement");
  const local = safeCall(path, "getCTM"), board = safeCall(svg, "getCTM");
  if (local !== undefined && local !== null && board !== undefined && board !== null) {
    const inverse = safeCall(local, "inverse");
    const matrix = safeCall(inverse, "multiply", [board]);
    const values = ["a", "b", "c", "d", "e", "f"].map(key => safeGet(matrix, key));
    if (!values.every(value => typeof value === "number" && Number.isFinite(value))) return undefined;
    const [a, b, c, d, e, f] = values as number[];
    map = point => ({ x: a! * point.x + c! * point.y + e!, y: b! * point.x + d! * point.y + f! });
  }
  const segments = geometry.segments as readonly RouteSegment[] | undefined;
  if (Array.isArray(segments)) return routePath(start, segments, map);
  const p = (point: AnchorPoint): string => { const q = map(point); return `${q.x} ${q.y}`; };
  const controls = geometry.controls;
  if (Array.isArray(controls) && controls.length === 2) return `M ${p(start)} C ${p(controls[0])} ${p(controls[1])} ${p(end)}`;
  return `M ${p(start)}` + (geometry.points ?? [start, end]).slice(1).map(point => ` L ${p(point)}`).join("");
}

/** Draws the connector's route and returns each path with the route it now carries. */
function renderConnectorGeometry(document: Document | undefined, runtime: unknown, descriptor: SourceItemDescriptor,
  geometry: AnchorEdgeGeometry | undefined, native: unknown, patches: RestorePatch[], diagnostics: string[], id: string,
): readonly { readonly path: DomElementLike; readonly d: string }[] | undefined {
  const group = elementFor(runtime, ["lineGroupEl", "edgeEl", "el"]);
  const direct = elementFor(runtime, ["pathEl", "lineEl"]);
  const paths = group === undefined ? [] : queryAll(group, "path").filter(path => !safeCall(path, "closest", ["defs, marker"]));
  if (direct !== undefined && !paths.includes(direct)) paths.push(direct);
  const routes = geometry === undefined ? [] : paths.map(path => ({ path, d: localRoute(path, geometry) }));
  if (group === undefined || routes.length === 0 || routes.some(route => route.d === undefined)) {
    diagnostics.push(`connector-geometry-fallback: ${id}.`);
    return undefined;
  }
  // A local connector without its own ends keeps Obsidian's filled arrowhead.
  const local = descriptor.sourceId === undefined;
  const nativeArrow = local ? "filled_triangle" : "arrow";
  const caps = [descriptor.connector?.startCap ?? (safeGet(native, "fromEnd") === "arrow" ? nativeArrow : "none"),
    descriptor.connector?.endCap ?? (safeGet(native, "toEnd") === "none" ? "none" : nativeArrow)];
  if (caps.some(cap => cap !== "none" && CAP_PATHS[cap] === undefined)) {
    diagnostics.push(`connector-endcap-fallback: ${id}.`);
    return undefined;
  }
  const color = descriptor.css.stroke ?? "var(--canvas-color, currentColor)";
  const scale = local ? LOCAL_CAP_SCALE : 1;
  const startMarker = marker(document, caps[0]!, color, patches, group, scale);
  const endMarker = marker(document, caps[1]!, color, patches, group, scale);
  if (startMarker === undefined || endMarker === undefined) {
    diagnostics.push(`connector-marker-fallback: ${id}.`);
    return undefined;
  }
  for (const { path, d } of routes) {
    patchAttribute(path, "d", d!, patches);
    // Native hit paths follow the visible route but keep their generous hit width.
    if (safeCall(safeGet(path, "classList"), "contains", ["canvas-interaction-path"]) === true) continue;
    const values = { fill: "none", stroke: color, "stroke-width": descriptor.css["stroke-width"] ?? "2",
      "stroke-opacity": descriptor.css["stroke-opacity"] ?? "1",
      "stroke-dasharray": strokeDash(descriptor.connector?.strokeStyle),
      "stroke-linecap": descriptor.connector?.strokeStyle === "dotted" ? "round" : "butt",
      "marker-start": startMarker, "marker-end": endMarker };
    for (const [key, value] of Object.entries(values)) {
      patchAttribute(path, key, value, patches);
      patchStyle(path, key, value, patches);
    }
  }
  const ends = elementFor(runtime, ["lineEndGroupEl"]);
  if (ends !== undefined && ends !== group && !isContained(ends, group)) patchStyle(ends, "display", "none", patches);
  return routes as readonly { readonly path: DomElementLike; readonly d: string }[];
}

/**
 * Keep a connector this module routes on its route while the host redraws it.
 *
 * Native Canvas redraws every edge of a node that moves, back to the middle
 * of a side; `apply` routes it again from the live node positions.  Once it
 * has, the path no longer matches the native route captured at render time,
 * so a restore asks the host to redraw its own edge instead.
 */
function connectorFollow(
  runtime: unknown,
  routes: readonly { readonly path: DomElementLike; readonly d: string }[],
  live: () => AnchorEdgeGeometry | undefined,
  patches: RestorePatch[],
): NonNullable<RenderedItem["follow"]> {
  const display = routes.find(({ path }) => safeCall(safeGet(path, "classList"), "contains", ["canvas-interaction-path"]) !== true)?.path
    ?? routes[0]!.path;
  let written: string | undefined;
  patches.push(() => {
    if (written !== undefined && readAttribute(display, "d") === written) safeCall(runtime, "updatePath");
  });
  return {
    element: display,
    attribute: "d",
    apply: () => {
      const geometry = live();
      if (geometry === undefined) return;
      for (const { path } of routes) {
        const d = localRoute(path, geometry);
        if (d === undefined) continue;
        if (readAttribute(path, "d") !== d) safeCall(path, "setAttribute", ["d", d]);
        if (path === display) written = d;
      }
    },
  };
}

/**
 * The route of a connector from where its nodes are right now.
 *
 * Each end is recomputed from the host's live node box: a precise anchor on
 * the node, or the middle of a native side on its contour, turned with the
 * node.  An end anchored to another connector or to an image crop has no live
 * form, and such a connector waits for the next refresh instead.
 */
function liveConnectorGeometry(
  document: unknown,
  id: string,
  runtime: unknown,
  native: unknown,
  nodeOf: (nodeId: unknown) => RouteNode | undefined,
  descriptor: SourceItemDescriptor,
): (() => AnchorEdgeGeometry | undefined) | undefined {
  const anchors = safeGet(safeGet(safeGet(safeGet(document, "miroCanvas"), "localOverrides"), id), "connectorAnchors");
  // Imported Miro connectors keep the route they were drawn with; a local
  // connector leaves each outline square to it, the way Obsidian draws.
  const local = descriptor.sourceId === undefined;
  const route = descriptor.connector?.shape ?? (local ? "curved" : "straight");
  const waypoints = descriptor.connector?.waypoints ?? [];
  const facing = (end: NativeEdgeEnd | undefined): PlannedEnd | undefined => (end === undefined
    ? undefined
    : local ? { point: end.point, normal: end.normal } : { point: end.point });
  const endOf = (end: "from" | "to"): (() => PlannedEnd | undefined) | undefined => {
    const live = safeGet(runtime, end);
    const liveNode = safeGet(live, "node");
    const liveId = readCanvasElementId(liveNode);
    const raw = safeGet(anchors, end);
    if (raw === undefined) {
      const known = nodeOf(liveId ?? safeGet(native, `${end}Node`));
      if (known === undefined) return undefined;
      const side = safeGet(live, "side") ?? safeGet(native, `${end}Side`);
      return () => facing(nativeEdgeEnd(liveRect(liveNode, known.rect), side, known.outline));
    }
    const normalized = normalizeAnchor(raw);
    const anchor = normalized.valid ? normalized.anchor : undefined;
    if (anchor?.type === "free") return () => ({ point: { x: anchor.x, y: anchor.y } });
    if (anchor?.type !== "node") return undefined;
    const known = nodeOf(anchor.nodeId);
    if (known === undefined) return undefined;
    const node = anchor.nodeId === liveId ? liveNode : undefined;
    return () => {
      const rect = node === undefined ? known.rect : liveRect(node, known.rect);
      const point = resolveAnchor(anchor, { nodes: { [anchor.nodeId]: rect } }).point;
      if (point === undefined) return undefined;
      const end = facing(nativeAnchorEnd(rect, anchor.u, anchor.v, known.outline));
      return { point: { x: point.x, y: point.y }, ...(end?.normal === undefined ? {} : { normal: end.normal }) };
    };
  };
  const from = endOf("from"), to = endOf("to");
  if (from === undefined || to === undefined) return undefined;
  return () => {
    const start = from(), end = to();
    return start === undefined || end === undefined ? undefined : { ...planRoute(start, end, route, waypoints, { imported: !local }) };
  };
}

/** A node a native edge is drawn to: its box as the document places it, and its silhouette. */
interface RouteNode {
  readonly rect: AnchorRect;
  readonly outline?: readonly ShapePoint[];
}

/** Where a plain connector's ends sit on their nodes; a missing end uses its native side. */
type RouteEnd =
  | { readonly kind: "node"; readonly nodeId: string; readonly u: number; readonly v: number }
  | { readonly kind: "free"; readonly x: number; readonly y: number };

interface RouteAnchors {
  readonly from?: RouteEnd;
  readonly to?: RouteEnd;
}

/**
 * The precise anchors of a connector this plugin can draw the native way.
 *
 * A connector with its own style, or with an end anchored to another
 * connector or an image crop, keeps the styled renderer.  An anchor on a node
 * the edge no longer names - native Canvas reattached that end - is stale,
 * and the end follows its native side instead.
 */
function plainRouteAnchors(override: unknown, edge: unknown): RouteAnchors | undefined {
  if (isObject(safeGet(override, "connector"))) return undefined;
  const stored = safeGet(override, "connectorAnchors");
  const anchors: { from?: RouteEnd; to?: RouteEnd } = {};
  for (const end of ["from", "to"] as const) {
    const raw = safeGet(stored, end);
    if (raw === undefined) continue;
    const normalized = normalizeAnchor(raw);
    const anchor = normalized.valid ? normalized.anchor : undefined;
    if (anchor?.type === "free") {
      anchors[end] = { kind: "free", x: anchor.x, y: anchor.y };
      continue;
    }
    if (anchor?.type !== "node") return undefined;
    if (anchor.nodeId !== safeGet(edge, `${end}Node`)) continue;
    anchors[end] = { kind: "node", nodeId: anchor.nodeId, u: anchor.u, v: anchor.v };
  }
  return anchors;
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** The node's box as the host holds it right now, turned as the document turns it. */
function liveRect(node: unknown, known: AnchorRect): AnchorRect {
  const x = safeGet(node, "x"), y = safeGet(node, "y");
  const width = safeGet(node, "width"), height = safeGet(node, "height");
  if (!finiteNumber(x) || !finiteNumber(y) || !finiteNumber(width) || !finiteNumber(height)) return known;
  const rotation = known.rotation ?? 0;
  return rotation === 0
    ? { x, y, width, height }
    : { x, y, width, height, rotation, rotationCenterX: x + width / 2, rotationCenterY: y + height / 2 };
}

/**
 * Draw a native edge to where its turned or shaped nodes really are.
 *
 * Native Canvas draws every edge to the middle of a side of the node's
 * upright box: for a turned node that point stays behind while the node
 * turns, and on a shape it lands in empty space.  The edge keeps its native
 * look - Obsidian's curve, arrowheads and styles - and only its path and the
 * placement of its arrowheads move onto the real geometry.  The host redraws
 * the edge whenever a node moves; `follow` draws it again from the live
 * positions, and a restore asks the host to redraw its own edge, which is
 * the only restore that stays right after a node moved.
 */
function applyNativeRoute(
  runtime: unknown,
  id: string,
  native: unknown,
  anchors: RouteAnchors,
  nodeOf: (nodeId: unknown) => RouteNode | undefined,
  patches: RestorePatch[],
  diagnostics: string[],
): RenderedItem | undefined {
  const group = elementFor(runtime, ["lineGroupEl"]);
  const paths = group === undefined ? [] : queryAll(group, "path").filter((path) => !safeCall(path, "closest", ["defs, marker"]));
  const display = paths.find((path) => safeCall(safeGet(path, "classList"), "contains", ["canvas-interaction-path"]) !== true);
  if (group === undefined || display === undefined) {
    diagnostics.push(`connector-geometry-fallback: ${id}.`);
    return undefined;
  }
  // A node end is placed on its own; a free end faces wherever the other end is.
  const end = (which: "from" | "to", other?: AnchorPoint) => {
    const live = safeGet(runtime, which);
    const anchor = anchors[which];
    const kind = safeGet(live, "end") ?? safeGet(native, `${which}End`) ?? (which === "from" ? "none" : "arrow");
    const head = safeGet(safeGet(runtime, `${which}LineEnd`), "el");
    const result = (geometry: NativeEdgeEnd | undefined) =>
      geometry === undefined ? undefined : { geometry, arrow: kind === "arrow", head: isElement(head) ? head : undefined };
    if (anchor?.kind === "free") return result(nativeFreeEnd(anchor, other));
    const liveNode = safeGet(live, "node");
    const liveId = readCanvasElementId(liveNode);
    const nodeId = anchor?.nodeId ?? liveId ?? safeGet(native, `${which}Node`);
    const known = nodeOf(nodeId);
    if (known === undefined) return undefined;
    const rect = liveId === nodeId ? liveRect(liveNode, known.rect) : known.rect;
    return result(anchor === undefined
      ? nativeEdgeEnd(rect, safeGet(live, "side") ?? safeGet(native, `${which}Side`), known.outline)
      : nativeAnchorEnd(rect, anchor.u, anchor.v, known.outline));
  };
  const draw = (): string | undefined => {
    const fixedFrom = anchors.from?.kind === "free" ? undefined : end("from");
    const fixedTo = anchors.to?.kind === "free" ? undefined : end("to");
    const freePoint = (which: "from" | "to") => {
      const anchor = anchors[which];
      return anchor?.kind === "free" ? { x: anchor.x, y: anchor.y } : undefined;
    };
    const from = fixedFrom ?? end("from", fixedTo?.geometry.point ?? freePoint("to"));
    const to = fixedTo ?? end("to", from?.geometry.point);
    if (from === undefined || to === undefined) return undefined;
    const d = nativeEdgeRoute(from.geometry, from.arrow, to.geometry, to.arrow);
    for (const path of paths) {
      if (readAttribute(path, "d") !== d) safeCall(path, "setAttribute", ["d", d]);
    }
    for (const item of [from, to]) {
      if (!item.arrow || item.head === undefined) continue;
      const { point, arrowAngle } = item.geometry;
      const at = `translate(${roundCoordinate(point.x)}px, ${roundCoordinate(point.y)}px)`;
      setStyleRaw(item.head, "transform", `${at} rotate(${roundCoordinate(arrowAngle)}deg)`);
    }
    return d;
  };
  const nativePaths = paths.map((path) => [path, readAttribute(path, "d")] as const);
  const heads = (["from", "to"] as const)
    .map((which) => safeGet(safeGet(runtime, `${which}LineEnd`), "el"))
    .filter(isElement)
    .map((head) => [head, readStyle(head, "transform")] as const);
  let drawn = draw();
  if (drawn === undefined) {
    diagnostics.push(`connector-geometry-fallback: ${id}.`);
    return undefined;
  }
  patches.push(() => {
    if (readAttribute(display, "d") !== drawn) return;
    if (typeof safeGet(runtime, "updatePath") === "function") {
      safeCall(runtime, "updatePath");
      return;
    }
    for (const [path, d] of nativePaths) {
      if (typeof d === "string") safeCall(path, "setAttribute", ["d", d]);
      else safeCall(path, "removeAttribute", ["d"]);
    }
    for (const [head, transform] of heads) {
      if (transform !== undefined) writeTransform(head, transform);
    }
  });
  return {
    id,
    kind: "edge",
    element: display,
    marker: display,
    descriptor: { kind: "connector", rotation: 0, css: {} },
    anchor: { keys: ["lineGroupEl"], element: group },
    intact: () => readAttribute(display, "d") === drawn,
    follow: {
      element: display,
      attribute: "d",
      apply: () => {
        const d = draw();
        if (d !== undefined) drawn = d;
      },
    },
  };
}

function applyConnector(
  document: Document | undefined, geometry: AnchorEdgeGeometry | undefined, native: unknown,
  runtime: unknown,
  id: string,
  descriptor: SourceItemDescriptor,
  patches: RestorePatch[],
  diagnostics: string[],
  live?: () => AnchorEdgeGeometry | undefined,
): RenderedItem | undefined {
  const targets = allElementsFor(runtime, EDGE_TARGET_KEYS);
  if (targets.length === 0) {
    diagnostics.push(`connector-dom-inaccessible: ${id}.`);
    return undefined;
  }
  const primary = targets[0]!;
  const mindmapEdge = descriptor.structured?.mindmapEdge;
  for (const target of targets) {
    patchClass(target, OWNED_CLASS, patches);
    patchClass(target, "miro-source-connector", patches);
    patchAttribute(target, "data-miro-source-kind", "connector", patches);
    if (descriptor.sourceId !== undefined) patchAttribute(target, "data-miro-source-id", descriptor.sourceId, patches);
    if (mindmapEdge !== undefined) {
      patchClass(target, "miro-source-mindmap-edge", patches);
      patchAttribute(target, "data-miro-source-mindmap-edge", "true", patches);
    }
    for (const [property, attribute] of Object.entries(CONNECTOR_ATTRIBUTE_CSS)) {
      const value = descriptor.css[property];
      if (value !== undefined) patchAttribute(target, attribute, value, patches);
    }
    if (descriptor.connector?.shape !== undefined) {
      patchAttribute(target, "data-miro-source-connector-shape", descriptor.connector.shape, patches);
      patchClass(target, `miro-source-connector-${descriptor.connector.shape}`, patches);
    }
    if (descriptor.connector?.strokeStyle !== undefined) {
      const dash = strokeDash(descriptor.connector.strokeStyle);
      patchAttribute(target, "stroke-dasharray", dash, patches);
      patchAttribute(target, "data-miro-source-stroke-style", descriptor.connector.strokeStyle, patches);
    }
    if (descriptor.connector?.startCap !== undefined) patchAttribute(target, "data-miro-source-start-cap", descriptor.connector.startCap, patches);
    if (descriptor.connector?.endCap !== undefined) patchAttribute(target, "data-miro-source-end-cap", descriptor.connector.endCap, patches);
    for (const [property, value] of Object.entries(descriptor.css)) {
      if (TYPOGRAPHY_CSS.has(property)) patchAttribute(target, `data-miro-source-label-${property}`, value, patches);
    }
  }
  const routes = renderConnectorGeometry(document, runtime, descriptor, geometry, native, patches, diagnostics, id);
  const follow = routes === undefined || live === undefined ? undefined : connectorFollow(runtime, routes, live, patches);
  return {
    id, kind: "edge", element: primary, marker: primary, descriptor,
    anchor: { keys: EDGE_TARGET_KEYS, element: primary },
    ...(follow === undefined ? {} : { follow }),
  };
}

function applyNode(
  document: Document | undefined,
  runtime: unknown,
  id: string,
  descriptor: SourceItemDescriptor,
  patches: RestorePatch[],
  diagnostics: string[],
  size?: { readonly width: number; readonly height: number },
  previewRotation?: number,
): RenderedItem | undefined {
  const nodeEl = elementFor(runtime, ["nodeEl"]);
  const containerEl = elementFor(runtime, ["containerEl"]);
  const contentEl = elementFor(runtime, ["contentEl"]);
  const primary = containerEl ?? nodeEl ?? contentEl ?? elementFor(runtime, ["el"]);
  if (primary === undefined) {
    diagnostics.push(`node-dom-inaccessible: ${id}.`);
    return undefined;
  }
  const shell = nodeEl ?? containerEl ?? primary;
  const content = contentEl ?? shell;
  patchClass(shell, OWNED_CLASS, patches);
  patchClass(shell, `miro-source-${descriptor.kind}`, patches);
  patchAttribute(shell, "data-miro-source-kind", descriptor.kind, patches);
  if (descriptor.sourceId !== undefined) patchAttribute(shell, "data-miro-source-id", descriptor.sourceId, patches);
  else patchAttribute(shell, "data-miro-local-source", "true", patches);
  if (descriptor.shape !== undefined) patchAttribute(shell, "data-miro-source-shape", descriptor.shape, patches);
  const sourceCode = descriptor.structured?.code;
  const sourceAppCard = descriptor.structured?.appCard;
  const sourceCard = descriptor.structured?.card;
  const sourcePreview = descriptor.structured?.preview;
  const sourceMindmap = descriptor.structured?.mindmapNode;
  if (sourceCode?.title !== undefined) patchAttribute(shell, "data-miro-source-code-title", sourceCode.title, patches);
  if (sourceCode?.language !== undefined) patchAttribute(shell, "data-miro-source-code-language", sourceCode.language, patches);
  if (sourceCode?.lineNumbersVisible !== undefined) {
    patchAttribute(shell, "data-miro-source-code-line-numbers", String(sourceCode.lineNumbersVisible), patches);
  }
  if (sourceAppCard !== undefined) {
    patchClass(shell, "miro-source-app-card", patches);
    patchAttribute(shell, "data-miro-source-card-kind", sourceAppCard.kind, patches);
    patchAttribute(shell, "data-miro-source-card-fields", String(sourceAppCard.fieldCount), patches);
    patchAttribute(shell, "data-miro-source-card-title", String(sourceAppCard.hasTitle), patches);
    patchAttribute(shell, "data-miro-source-card-description", String(sourceAppCard.hasDescription), patches);
  }
  if (sourceCard !== undefined) {
    patchClass(shell, "miro-source-card", patches);
    patchAttribute(shell, "data-miro-source-card-kind", sourceCard.kind, patches);
    patchAttribute(shell, "data-miro-source-card-fields", String(sourceCard.fieldCount), patches);
    patchAttribute(shell, "data-miro-source-card-title", String(sourceCard.hasTitle), patches);
    patchAttribute(shell, "data-miro-source-card-description", String(sourceCard.hasDescription), patches);
    patchAttribute(shell, "data-miro-source-card-url", String(sourceCard.hasUrl), patches);
    patchAttribute(shell, "data-miro-source-card-due-date", String(sourceCard.hasDueDate), patches);
    patchAttribute(shell, "data-miro-source-card-assignee", String(sourceCard.hasAssignee), patches);
  }
  if (sourcePreview !== undefined) {
    patchClass(shell, "miro-source-preview", patches);
    patchAttribute(shell, "data-miro-source-preview-title", String(sourcePreview.title !== undefined), patches);
    patchAttribute(shell, "data-miro-source-preview-description", String(sourcePreview.description !== undefined), patches);
    patchAttribute(shell, "data-miro-source-preview-provider", String(sourcePreview.provider !== undefined), patches);
    patchAttribute(shell, "data-miro-source-preview-target", String(sourcePreview.hasTargetUrl), patches);
    patchAttribute(shell, "data-miro-source-preview-asset", String(sourcePreview.hasPreviewAsset), patches);
  }
  if (sourceMindmap !== undefined) {
    patchClass(shell, "miro-source-mindmap-node", patches);
    patchAttribute(shell, "data-miro-source-mindmap-root", String(sourceMindmap.isRoot), patches);
    patchAttribute(shell, "data-miro-source-mindmap-content", String(sourceMindmap.hasContent), patches);
    if (sourceMindmap.shape !== undefined) patchAttribute(shell, "data-miro-source-mindmap-shape", sourceMindmap.shape, patches);
  }

  let layer: DomElementLike | undefined;
  if (descriptor.kind === "shape" || descriptor.kind === "sticky" || descriptor.kind === "frame" || descriptor.kind === "media" || descriptor.kind === "code" || sourceAppCard !== undefined || sourceCard !== undefined || sourcePreview !== undefined || sourceMindmap !== undefined) {
    const created = document === undefined ? undefined : createElement(document, "div");
    if (created !== undefined) {
      const decorationKind = sourceAppCard !== undefined ? "app-card" : sourceCard !== undefined ? "card" : sourcePreview !== undefined ? "preview" : sourceMindmap !== undefined ? "mindmap-node" : descriptor.kind;
      addOwnedElementClass(created, DECORATION_CLASS);
      addOwnedElementClass(created, `miro-source-decoration-${decorationKind}`);
      setOwnedElementAttribute(created, "aria-hidden", "true");
      setOwnedElementAttribute(created, "data-miro-source-decoration", decorationKind);
      setOwnedElementStyle(created, "position", "absolute");
      setOwnedElementStyle(created, "inset", "0");
      setOwnedElementStyle(created, "box-sizing", "border-box");
      setOwnedElementStyle(created, "pointer-events", "none");
      setOwnedElementStyle(created, "z-index", sourcePreview === undefined ? "0" : "2");
      if (sourceMindmap?.branchColor !== undefined) setOwnedElementStyle(created, "--miro-mindmap-color", sourceMindmap.branchColor);
      const drawable = descriptor.kind === "shape"
        ? decorateShape(document, created, descriptor)
        : sourcePreview === undefined || decoratePreview(document, created, descriptor);
      if (!drawable) diagnostics.push(`shape-renderer-fallback: ${id} (${descriptor.shape ?? "unknown"}).`);
      if (drawable && appendOwnedChild(shell, created, patches)) layer = created;
    }
    if (layer === undefined) diagnostics.push(`decoration-dom-inaccessible: ${id}.`);
  }

  const tagLayer = decorateTags(document, shell, descriptor, patches);
  if (descriptor.structured?.tags !== undefined && tagLayer === undefined) diagnostics.push(`tag-decoration-dom-inaccessible: ${id}.`);

  if (layer !== undefined) {
    for (const foreground of allElementsFor(runtime, ["contentEl", "labelEl", "fileEl", "embedEl"])) {
      if (foreground === layer || !isContained(shell, foreground)) continue;
      patchStyle(foreground, "position", "relative", patches);
      patchStyle(foreground, "z-index", "1", patches);
    }
  }

  // Reserve the room the contour takes away, so the text stays inside it.
  if (descriptor.kind === "shape" && descriptor.shape !== undefined && layer !== undefined) {
    // Measured from the silhouette the contour encloses, so a new shape needs
    // no hand-tuned table and the text can never sit outside what is drawn.
    const inset = inscribedInsets(shapeOutline(descriptor.shape));
    // In pixels, not percentages: a percentage padding resolves against the
    // width on every side, so a reserve meant for the height would be wrong on
    // any node that is not square.
    const reserve = inset === undefined || size === undefined
      ? undefined
      : [
        (inset[0] / 100) * size.height, (inset[1] / 100) * size.width,
        (inset[2] / 100) * size.height, (inset[3] / 100) * size.width,
      ] as const;
    if (reserve !== undefined && reserve.some((value) => value > 0)) {
      // The box is pinned first: padding on an auto-height content element
      // grows the node instead of insetting its text, which turns a modest
      // reserve into a shape several times the size the user drew.
      patchStyle(content, "box-sizing", "border-box", patches);
      patchStyle(content, "width", "100%", patches);
      patchStyle(content, "height", "100%", patches);
      patchStyle(content, "overflow", "hidden", patches);
      patchStyle(content, "padding", reserve.map((value) => `${Math.round(value * 10) / 10}px`).join(" "), patches);
    }
  }
  applyNodeCss(descriptor, shell, content, layer, patches);
  if (layer !== undefined && descriptor.kind === "shape") {
    // Remove the native rectangular paint only after a real contour exists.
    // The node shell is not the only painted surface: native Canvas fills and
    // borders its inner container, which is a later sibling of the decoration
    // layer and would otherwise cover the contour completely.
    const painted = [shell, containerEl, contentEl, content].filter(
      (element, index, all): element is DomElementLike => element !== undefined && all.indexOf(element) === index,
    );
    for (const element of painted) {
      patchStyle(element, "background-color", "transparent", patches);
      patchStyle(element, "border-color", "transparent", patches);
      patchStyle(element, "box-shadow", "none", patches);
    }
  }
  const rotation = cssAngle(previewRotation ?? descriptor.rotation);
  for (const element of [shell, containerEl, contentEl, content].filter(
    (item, index, all): item is DomElementLike => item !== undefined && all.indexOf(item) === index,
  )) {
    clearLegacyOwnedTransformRotation(element, patches);
    clearLeakedRotateProperty(element);
  }
  if (rotation !== 0) {
    // Marks the node for the stylesheet: which descendant actually paints the
    // native rectangle differs between Obsidian builds, so clearing the few
    // elements this module can name is not enough on its own.
    patchAttribute(shell, "data-miro-source-rotated", "true", patches);
  }
  if (descriptor.kind === "shape" && layer !== undefined && rotation !== 0) {
    // A stacking context forces Chromium to rasterize the subtree before it is
    // rotated. Keep the contour and text as ordinary descendants so both stay
    // sharp while the one native node shell supplies the rotation.
    for (const parent of [shell, containerEl].filter(
      (element, index, all): element is DomElementLike => element !== undefined && all.indexOf(element) === index,
    )) patchStyle(parent, "overflow", "visible", patches);
    patchStyle(content, "text-rendering", "geometricPrecision", patches);
  }
  const expectedRotations = applyRotation(runtime, shell, rotation, patches, diagnostics, id)
    .map((element) => ({ element, rotation }));
  const ownedChildren = [layer, tagLayer].filter((item): item is DomElementLike => item !== undefined);
  return {
    id, kind: "node", element: primary, marker: shell, ownedChildren, expectedRotations, descriptor,
    anchor: { keys: NODE_SHELL_KEYS, element: shell },
  };
}

function itemById(values: readonly unknown[]): ReadonlyMap<string, unknown> {
  const result = new Map<string, unknown>();
  for (const value of values) {
    const id = readCanvasElementId(value);
    if (id !== undefined && !result.has(id)) result.set(id, value);
  }
  return result;
}

function parentOf(element: DomElementLike): unknown {
  return safeGet(element, "parentNode");
}

function hasSeparateStackingContexts(items: readonly RenderedItem[]): boolean {
  const nodes = items.filter((item) => item.kind === "node");
  const edges = items.filter((item) => item.kind === "edge");
  if (nodes.length === 0 || edges.length === 0) return false;
  const nodeParents = new Set(nodes.map((item) => parentOf(item.element)));
  const edgeParents = new Set(edges.map((item) => parentOf(item.element)));
  for (const parent of nodeParents) if (edgeParents.has(parent)) return false;
  return true;
}

function requiresCrossLayerInterleaving(scene: SourceScene, items: readonly RenderedItem[]): boolean {
  const renderedKinds = new Map(items.map((item) => [item.id, item.kind] as const));
  let previous: RenderedItem["kind"] | undefined;
  let transitions = 0;
  for (const id of scene.order) {
    const kind = renderedKinds.get(id);
    if (kind === undefined) continue;
    if (previous !== undefined && previous !== kind) {
      transitions += 1;
      if (transitions > 1) return true;
    }
    previous = kind;
  }
  return false;
}

function applyOrdering(scene: SourceScene, items: readonly RenderedItem[], patches: RestorePatch[], diagnostics: string[]): void {
  const separateContexts = hasSeparateStackingContexts(items);
  if (separateContexts && requiresCrossLayerInterleaving(scene, items)) {
    diagnostics.push("source-order-cross-layer-interleaving-unsupported: node and connector DOM use separate stacking contexts.");
  }
  const globalRank = new Map(scene.order.map((id, index) => [id, index] as const));
  const nodeRank = new Map(scene.order.filter((id) => scene.items.get(id)?.kind !== "connector").map((id, index) => [id, index] as const));
  const edgeRank = new Map(scene.order.filter((id) => scene.items.get(id)?.kind === "connector").map((id, index) => [id, index] as const));
  for (const item of items) {
    const explicit = normalizedZIndex(item.descriptor.zIndex);
    const rank = separateContexts
      ? (item.kind === "node" ? nodeRank.get(item.id) : edgeRank.get(item.id))
      : globalRank.get(item.id);
    const value = explicit ?? (rank === undefined ? undefined : String(rank));
    if (value !== undefined) patchStyle(item.element, "z-index", value, patches);
    else if (item.descriptor.zIndex !== undefined) diagnostics.push(`z-index-out-of-range: ${item.id}.`);
  }
}

/**
 * DOM-only M3 source renderer. It decorates native Canvas runtime elements and
 * owns only reversible class/attribute/style changes plus inert child layers.
 */
export class SourceRenderer {
  private patches: RestorePatch[] = [];
  private lastSignature: string | undefined;
  private renderedItems: RenderedItem[] = [];
  private diagnosticList: readonly string[] = [];
  private readonly document: Document | undefined;
  /** Observer keeping rotations and redrawn edges in place between refreshes. */
  private liveWatch: unknown;

  public constructor(private readonly host: SourceRendererHost, document?: Document) {
    this.document = document ?? defaultDocument();
  }

  public get diagnostics(): readonly string[] {
    return this.diagnosticList;
  }

  public refresh(): readonly string[] {
    const diagnostics: string[] = [];
    const sourceDocument = safeCall(this.host, "getDocument");
    let scene: SourceScene;
    try {
      scene = buildSourceScene(sourceDocument);
    } catch {
      this.resetRenderedState();
      this.diagnosticList = Object.freeze(["source-scene-build-failed: source metadata could not be projected safely."]);
      return this.diagnosticList;
    }
    diagnostics.push(...scene.diagnostics);
    // Local connector anchors also need rendering when no Miro source exists.
    const descriptors = new Map(scene.items);
    const overrides = safeGet(safeGet(sourceDocument, "miroCanvas"), "localOverrides");
    for (const [id, descriptor] of descriptors) {
      const override = safeGet(overrides, id);
      if (descriptor.kind === "connector" && descriptor.sourceId === undefined
        && descriptor.structured?.mindmapEdge === undefined
        && !isObject(safeGet(override, "connectorAnchors")) && !isObject(safeGet(override, "connector"))) descriptors.delete(id);
    }
    const rawEdges = safeGet(sourceDocument, "edges");
    const nativeEdges = Array.isArray(rawEdges) ? itemById(rawEdges) : new Map<string, unknown>();
    for (const id of nativeEdges.keys()) {
      if (!descriptors.has(id) && isObject(safeGet(safeGet(overrides, id), "connectorAnchors"))) {
        descriptors.set(id, { kind: "connector", rotation: 0, css: {} });
      }
    }
    const previewValue = safeCall(this.host, "getRotationPreview");
    const previewId = safeGet(previewValue, "id");
    const previewAngle = safeGet(previewValue, "rotation");
    const preview = typeof previewId === "string" && typeof previewAngle === "number" && Number.isFinite(previewAngle)
      ? { id: previewId, rotation: previewAngle }
      : undefined;
    if (preview !== undefined && !descriptors.has(preview.id)) {
      descriptors.set(preview.id, { kind: "text", rotation: preview.rotation, css: {} });
    }
    if (descriptors.size === 0) {
      this.resetRenderedState();
      this.diagnosticList = Object.freeze(diagnostics);
      return this.diagnosticList;
    }

    const runtimeNodes = readCollection(this.host, "getNodes", diagnostics);
    const runtimeEdges = readCollection(this.host, "getEdges", diagnostics);
    const documentSizes = new Map<string, { readonly width: number; readonly height: number }>();
    const documentNodes = safeGet(sourceDocument, "nodes");
    if (Array.isArray(documentNodes)) {
      for (const node of documentNodes) {
        const nodeId = safeGet(node, "id");
        const width = safeGet(node, "width"), height = safeGet(node, "height");
        if (typeof nodeId === "string" && typeof width === "number" && typeof height === "number"
          && width > 0 && height > 0) {
          documentSizes.set(nodeId, { width, height });
        }
      }
    }
    // A connector must end on what the host drew, not on what the file says a
    // collapsed group would occupy if it were open - and on a node being
    // turned, at the angle it is shown at, not the one it will be saved with.
    const measured = measureNodes(sourceDocument, runtimeNodes, scene, new Set(preview === undefined ? [] : [preview.id]));
    const geometry = buildCanvasAnchorGeometry(sourceDocument, preview === undefined ? measured : {
      ...measured, [preview.id]: { ...measured[preview.id], rotation: preview.rotation },
    });
    // Native edges on a turned or shaped node, which the host draws to the
    // middle of a side of the upright box.
    const rectangle = shapeOutline("rectangle");
    const routeNode = (nodeId: unknown): RouteNode | undefined => {
      if (typeof nodeId !== "string") return undefined;
      const rect = geometry.nodes?.[nodeId];
      if (rect === undefined) return undefined;
      const outline = shapeOutline(scene.items.get(nodeId)?.shape);
      return { rect, outline: outline === rectangle ? undefined : outline };
    };
    const reshaped = (nodeId: unknown): boolean => {
      const node = routeNode(nodeId);
      return node !== undefined && ((node.rect.rotation ?? 0) !== 0 || node.outline !== undefined);
    };
    // Edges drawn the native way: native edges on a turned or shaped node,
    // which the host draws to the middle of a side of the upright box, and
    // connectors this plugin placed precisely without giving them a style of
    // their own - so an arrow looks the same however it was made.
    const nativeRoutes = new Map<string, { readonly edge: unknown; readonly anchors: RouteAnchors }>();
    for (const [id, edge] of nativeEdges) {
      const descriptor = descriptors.get(id);
      if (descriptor === undefined) {
        if (reshaped(safeGet(edge, "fromNode")) || reshaped(safeGet(edge, "toNode"))) nativeRoutes.set(id, { edge, anchors: {} });
        continue;
      }
      if (descriptor.kind !== "connector" || descriptor.sourceId !== undefined
        || descriptor.structured?.mindmapEdge !== undefined) continue;
      const anchors = plainRouteAnchors(safeGet(overrides, id), edge);
      if (anchors !== undefined) nativeRoutes.set(id, { edge, anchors });
    }
    const nodes = itemById(runtimeNodes);
    const edges = itemById(runtimeEdges);
    const runtimeOf = (kind: "node" | "edge", id: string): unknown => (kind === "edge" ? edges : nodes).get(id);
    // Which items the host can show right now.  A runtime that appears, or
    // builds its content on first view, changes this list and so renders
    // again; one that stays missing does not rebuild everything else on every
    // refresh.
    const ready = [...new Map<string, "node" | "edge">([
      ...[...descriptors].map(([id, descriptor]) => [id, descriptor.kind === "connector" ? "edge" : "node"] as const),
      ...[...nativeRoutes.keys()].map((id) => [id, "edge"] as const),
    ])].flatMap(([id, kind]) => {
      const runtime = runtimeOf(kind, id);
      return runtime === undefined ? [] : [`${id}:${safeGet(runtime, "initialized") === false ? "new" : "ready"}`];
    });
    const signature = safeSignature({
      descriptors: [...descriptors], routes: [...nativeRoutes.keys()], ready, order: scene.order, preview, geometry, diagnostics,
    });
    if (signature !== undefined && signature === this.lastSignature
      && this.decorationsIntact((item) => runtimeOf(item.kind, item.id))) {
      return this.diagnosticList;
    }
    this.restoreOwnedPatches();
    this.renderedItems = [];
    this.lastSignature = signature;
    const nextPatches: RestorePatch[] = [];
    const rendered: RenderedItem[] = [];
    try {
      for (const [id, descriptor] of descriptors) {
        if (nativeRoutes.has(id)) continue;
        if (descriptor.kind === "connector") {
          const runtime = edges.get(id);
          if (runtime === undefined) {
            diagnostics.push(`connector-runtime-missing: ${id}.`);
            continue;
          }
          const live = liveConnectorGeometry(sourceDocument, id, runtime, nativeEdges.get(id), routeNode, descriptor);
          const item = applyConnector(this.document, geometry.edges?.[id], nativeEdges.get(id), runtime, id, descriptor, nextPatches, diagnostics, live);
          if (item !== undefined) rendered.push(item);
        } else {
          const runtime = nodes.get(id);
          if (runtime === undefined) {
            diagnostics.push(`node-runtime-missing: ${id}.`);
            continue;
          }
          const item = applyNode(
            this.document,
            runtime,
            id,
            descriptor,
            nextPatches,
            diagnostics,
            documentSizes.get(id),
            preview?.id === id ? preview.rotation : undefined,
          );
          if (item !== undefined) rendered.push(item);
        }
      }
      applyOrdering(scene, rendered, nextPatches, diagnostics);
      for (const [id, route] of nativeRoutes) {
        const runtime = edges.get(id);
        if (runtime === undefined) {
          diagnostics.push(`connector-runtime-missing: ${id}.`);
          continue;
        }
        const item = applyNativeRoute(runtime, id, route.edge, route.anchors, routeNode, nextPatches, diagnostics);
        if (item !== undefined) rendered.push(item);
      }
      this.patches = nextPatches;
      this.renderedItems = rendered;
      this.watchLive();
    } catch {
      for (let index = nextPatches.length - 1; index >= 0; index -= 1) {
        try { nextPatches[index]!(); } catch { /* fail closed */ }
      }
      diagnostics.push("source-render-failed: DOM decoration aborted safely.");
      this.patches = [];
      this.renderedItems = [];
      this.lastSignature = undefined;
    }
    this.diagnosticList = Object.freeze(diagnostics);
    return this.diagnosticList;
  }

  public dispose(): void {
    this.resetRenderedState();
    this.diagnosticList = Object.freeze([]);
  }

  /**
   * Whether every rendered item still stands on the host.
   *
   * An element native Canvas scrolled out of view is detached, not replaced:
   * it keeps every decoration and comes back with it, so being disconnected
   * is not damage.  Treating it as damage rebuilt the whole projection on
   * every refresh whenever one decorated item was off-screen - rewriting the
   * transform of every turned node each time.  What does count is the host
   * holding a different element, or none, for the item.
   */
  private decorationsIntact(runtimeOf: (item: RenderedItem) => unknown): boolean {
    for (const item of this.renderedItems) {
      const runtime = runtimeOf(item);
      if (runtime === undefined || elementFor(runtime, item.anchor.keys) !== item.anchor.element) return false;
      if (item.intact !== undefined) {
        if (!item.intact()) return false;
        continue;
      }
      const marker = safeCall(item.marker, "getAttribute", ["data-miro-source-kind"]);
      if (typeof marker !== "string") return false;
      for (const expectedRotation of item.expectedRotations ?? []) {
        const transform = readStyle(expectedRotation.element, "transform");
        if (transform === undefined || !endsWithRotation(transform, expectedRotation.rotation)) return false;
      }
      for (const child of item.ownedChildren ?? []) {
        if (safeGet(child, "parentNode") !== item.marker) return false;
      }
    }
    return true;
  }

  /**
   * Keep rotations and redrawn edges in place while the host rewrites them.
   *
   * Native Canvas writes a node's whole transform whenever it moves, resizes
   * or reselects it, which drops the rotation appended to it, and redraws
   * every edge of a node that moves, back to the upright box.  Waiting for the
   * next refresh would leave a dragged node upright and its edges behind for
   * most of the drag.  A mutation callback runs before the frame is painted,
   * so both are back before they could be seen missing.  Without an observer
   * the refresh still restores them, only later.
   */
  private watchLive(): void {
    const keepers = new Map<unknown, { readonly attribute: string; readonly keep: () => void }>();
    for (const item of this.renderedItems) {
      for (const expected of item.expectedRotations ?? []) {
        keepers.set(expected.element, { attribute: "style", keep: () => keepRotation(expected.element, expected.rotation) });
      }
      if (item.follow !== undefined) {
        keepers.set(item.follow.element, { attribute: item.follow.attribute, keep: item.follow.apply });
      }
    }
    if (keepers.size === 0) return;
    const Observer = safeGet(safeGet(this.document, "defaultView"), "MutationObserver");
    if (typeof Observer !== "function") return;
    try {
      const observer: unknown = Reflect.construct(Observer, [(records: unknown) => {
        if (!Array.isArray(records)) return;
        const due = new Set<() => void>();
        for (const record of records) {
          const keeper = keepers.get(safeGet(record, "target"));
          if (keeper !== undefined) due.add(keeper.keep);
        }
        for (const keep of due) keep();
      }]);
      for (const [element, keeper] of keepers) {
        safeCall(observer, "observe", [element, { attributes: true, attributeFilter: [keeper.attribute] }]);
      }
      this.liveWatch = observer;
    } catch {
      this.liveWatch = undefined;
    }
  }

  private resetRenderedState(): void {
    this.restoreOwnedPatches();
    this.renderedItems = [];
    this.lastSignature = undefined;
  }

  private restoreOwnedPatches(): void {
    // Stop watching first: the restores below must not be answered by
    // putting a rotation or an edge straight back.
    safeCall(this.liveWatch, "disconnect");
    this.liveWatch = undefined;
    const current = this.patches;
    this.patches = [];
    for (let index = current.length - 1; index >= 0; index -= 1) {
      try { current[index]!(); } catch { /* exact-owned restoration is best-effort */ }
    }
  }
}
