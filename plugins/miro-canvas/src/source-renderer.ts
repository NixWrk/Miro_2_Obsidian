import { buildCanvasAnchorGeometry, type NodeMeasurements } from "./connector-endpoints";
import type { AnchorEdgeGeometry, AnchorPoint } from "./anchors";
import { readCanvasElementId } from "./canvas-elements";
import { buildSourceScene, type SourceItemDescriptor, type SourceScene } from "./source-model";

type UnknownRecord = Record<PropertyKey, unknown>;

export interface SourceRendererHost {
  getDocument(): unknown | undefined;
  getNodes(): readonly unknown[] | undefined;
  getEdges(): readonly unknown[] | undefined;
}

interface DomElementLike extends UnknownRecord {
  readonly nodeType?: unknown;
}

interface RenderedItem {
  readonly id: string;
  readonly kind: "node" | "edge";
  readonly element: DomElementLike;
  readonly descriptor: SourceItemDescriptor;
}

type RestorePatch = () => void;

const OWNED_CLASS = "miro-source-rendered";
const DECORATION_CLASS = "miro-source-decoration";
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

const SHAPE_CLIP_PATHS: Readonly<Record<string, string>> = Object.freeze({
  triangle: "polygon(50% 0%, 100% 100%, 0% 100%)",
  rhombus: "polygon(50% 0%, 100% 50%, 50% 100%, 0% 50%)",
  diamond: "polygon(50% 0%, 100% 50%, 50% 100%, 0% 50%)",
  parallelogram: "polygon(18% 0%, 100% 0%, 82% 100%, 0% 100%)",
  trapezoid: "polygon(18% 0%, 82% 0%, 100% 100%, 0% 100%)",
  pentagon: "polygon(50% 0%, 100% 38%, 82% 100%, 18% 100%, 0% 38%)",
  hexagon: "polygon(25% 0%, 75% 0%, 100% 50%, 75% 100%, 25% 100%, 0% 50%)",
  octagon: "polygon(30% 0%, 70% 0%, 100% 30%, 100% 70%, 70% 100%, 30% 100%, 0% 70%, 0% 30%)",
  star: "polygon(50% 0%, 61% 35%, 98% 35%, 68% 57%, 79% 94%, 50% 72%, 21% 94%, 32% 57%, 2% 35%, 39% 35%)",
  cross: "polygon(35% 0%, 65% 0%, 65% 35%, 100% 35%, 100% 65%, 65% 65%, 65% 100%, 35% 100%, 35% 65%, 0% 65%, 0% 35%, 35% 35%)",
  right_arrow: "polygon(0% 25%, 65% 25%, 65% 0%, 100% 50%, 65% 100%, 65% 75%, 0% 75%)",
  left_arrow: "polygon(35% 0%, 35% 25%, 100% 25%, 100% 75%, 35% 75%, 35% 100%, 0% 50%)",
  left_right_arrow: "polygon(20% 0%, 20% 25%, 80% 25%, 80% 0%, 100% 50%, 80% 100%, 80% 75%, 20% 75%, 20% 100%, 0% 50%)",
  flow_chart_input_output: "polygon(18% 0%, 100% 0%, 82% 100%, 0% 100%)",
  flow_chart_decision: "polygon(50% 0%, 100% 50%, 50% 100%, 0% 50%)",
  flow_chart_manual_input: "polygon(12% 12%, 100% 0%, 100% 100%, 0% 100%)",
  flow_chart_manual_operation: "polygon(12% 0%, 88% 0%, 100% 100%, 0% 100%)",
  flow_chart_merge: "polygon(0% 0%, 100% 0%, 50% 100%)",
  flow_chart_offpage_connector: "polygon(0% 0%, 100% 0%, 100% 72%, 50% 100%, 0% 72%)",
  flow_chart_preparation: "polygon(20% 0%, 80% 0%, 100% 50%, 80% 100%, 20% 100%, 0% 50%)",
});

const SVG_NS = "http://www.w3.org/2000/svg";
let markerSequence = 0;

// Normalized contours; inner strokes are separate subpaths, never a clipped
// rectangular border. Unknown shapes deliberately retain native rendering.
const SHAPE_PATHS: Readonly<Record<string, string>> = Object.freeze({
  rectangle: "M0 0H100V100H0Z",
  round_rectangle: "M12 0H88Q100 0 100 12V88Q100 100 88 100H12Q0 100 0 88V12Q0 0 12 0Z",
  circle: "M50 0A50 50 0 1 1 50 100A50 50 0 1 1 50 0Z",
  ellipse: "M50 0A50 50 0 1 1 50 100A50 50 0 1 1 50 0Z",
  cloud: "M15 75C-5 75 -5 45 12 42C0 20 25 5 40 18C50 -8 82 -3 85 22C110 20 113 55 94 62C110 90 75 110 61 91C42 111 17 100 15 75Z",
  can: "M0 15C0 -5 100 -5 100 15V85C100 105 0 105 0 85ZM0 15C0 35 100 35 100 15",
  wedge_round_rectangle_callout: "M12 0H88Q100 0 100 12V68Q100 80 88 80H45L25 100V80H12Q0 80 0 68V12Q0 0 12 0Z",
  left_brace: "M80 0Q40 0 40 25V35Q40 50 10 50Q40 50 40 65V75Q40 100 80 100",
  right_brace: "M20 0Q60 0 60 25V35Q60 50 90 50Q60 50 60 65V75Q60 100 20 100",
  flow_chart_delay: "M0 0H50A50 50 0 0 1 50 100H0Z",
  flow_chart_display: "M20 0H75Q125 50 75 100H20L0 50Z",
  flow_chart_document: "M0 0H100V85C65 60 35 110 0 85Z",
  flow_chart_multidocuments: "M15 0H100V72M8 8H92V80M0 16H84V85C55 65 30 110 0 85Z",
  flow_chart_internal_storage: "M0 0H100V100H0ZM15 0V100M0 15H100",
  flow_chart_note_square: "M80 0H15V100H80",
  flow_chart_predefined_process: "M0 0H100V100H0ZM15 0V100M85 0V100",
  flow_chart_predefined_process_2: "M0 0H100V100H0ZM15 0V100M85 0V100M0 15H100M0 85H100",
  flow_chart_online_storage: "M15 0H100C80 15 80 85 100 100H15C-5 85 -5 15 15 0Z",
  flow_chart_magnetic_drum: "M15 0H85C105 0 105 100 85 100H15C-5 100 -5 0 15 0ZM85 0C65 0 65 100 85 100",
  flow_chart_terminator: "M25 0H75C108 0 108 100 75 100H25C-8 100 -8 0 25 0Z",
});

/**
 * Percentage insets that keep a node's text inside its contour.
 *
 * Native Canvas lays text out in the node's rectangle, so on a triangle or an
 * ellipse the words spill outside the drawn shape.  Miro reserves the same
 * space, and the values below are the fraction of the box each side gives up:
 * top, right, bottom, left.  A shape that is missing here is close enough to
 * its rectangle to need nothing.
 */
const SHAPE_CONTENT_INSETS: Readonly<Record<string, readonly [number, number, number, number]>> = Object.freeze({
  circle: [15, 15, 15, 15],
  ellipse: [15, 15, 15, 15],
  flow_chart_connector: [15, 15, 15, 15],
  flow_chart_or: [15, 15, 15, 15],
  flow_chart_summing_junction: [15, 15, 15, 15],
  triangle: [45, 22, 6, 22],
  rhombus: [22, 22, 22, 22],
  star: [30, 26, 22, 26],
  cloud: [22, 18, 20, 18],
  parallelogram: [6, 18, 6, 18],
  trapezoid: [6, 18, 6, 18],
  pentagon: [18, 12, 8, 12],
  hexagon: [8, 16, 8, 16],
  octagon: [12, 12, 12, 12],
  right_arrow: [6, 24, 6, 8],
  left_arrow: [6, 8, 6, 24],
  left_right_arrow: [6, 20, 6, 20],
  left_brace: [6, 8, 6, 42],
  right_brace: [6, 42, 6, 8],
  can: [18, 6, 10, 6],
  flow_chart_magnetic_disk: [18, 6, 10, 6],
  flow_chart_magnetic_drum: [6, 20, 6, 8],
  flow_chart_online_storage: [6, 12, 6, 16],
  flow_chart_delay: [6, 20, 6, 6],
  flow_chart_display: [6, 22, 6, 14],
  flow_chart_document: [6, 6, 18, 6],
  flow_chart_multidocuments: [10, 10, 20, 6],
  flow_chart_decision: [22, 22, 22, 22],
  flow_chart_input_output: [6, 18, 6, 18],
  flow_chart_preparation: [6, 18, 6, 18],
  flow_chart_manual_input: [16, 6, 6, 6],
  flow_chart_manual_operation: [6, 16, 6, 16],
  flow_chart_internal_storage: [16, 6, 6, 16],
  flow_chart_predefined_process: [6, 16, 6, 16],
  flow_chart_predefined_process_2: [16, 16, 16, 16],
  flow_chart_offpage_connector: [6, 6, 18, 6],
  flow_chart_note_square: [6, 14, 6, 14],
  flow_chart_note_curly_left: [6, 8, 6, 42],
  flow_chart_note_curly_right: [6, 42, 6, 8],
  wedge_round_rectangle_callout: [6, 8, 22, 8],
  cross: [30, 30, 30, 30],
});

function shapePath(shape: string | undefined): string | undefined {
  if (shape === undefined) return undefined;
  const aliases: Record<string, string> = {
    flow_chart_process: "rectangle", flow_chart_connector: "circle",
    flow_chart_note_curly_left: "left_brace", flow_chart_note_curly_right: "right_brace",
    flow_chart_magnetic_disk: "can",
  };
  const base = aliases[shape] ?? shape;
  if (base === "flow_chart_or" || base === "flow_chart_summing_junction") {
    return SHAPE_PATHS.circle + (base === "flow_chart_or" ? "M0 50H100M50 0V100" : "M15 15L85 85M85 15L15 85");
  }
  const polygon = SHAPE_CLIP_PATHS[base];
  if (polygon !== undefined) {
    const points = polygon.match(/[\d.]+/g)!;
    return `M${points[0]} ${points[1]}` + points.slice(2).reduce((text, n, i) => text + (i % 2 === 0 ? `L${n}` : ` ${n}`), "") + "Z";
  }
  return SHAPE_PATHS[base];
}

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

function setStyleRaw(element: DomElementLike, property: string, value: string, priority = ""): boolean {
  const style = styleObject(element);
  if (style === undefined || typeof safeGet(style, "setProperty") !== "function") return false;
  safeCall(style, "setProperty", [property, value, priority]);
  return readStyle(element, property) === value;
}

function patchStyle(element: DomElementLike, property: string, value: string, patches: RestorePatch[]): boolean {
  const before = readStyle(element, property);
  if (before === undefined) return false;
  const beforePriority = readStylePriority(element, property) ?? "";
  if (before === value && beforePriority === "") return true;
  if (!setStyleRaw(element, property, value)) return false;
  patches.push(() => {
    const current = readStyle(element, property);
    const currentPriority = readStylePriority(element, property) ?? "";
    if (current !== value || currentPriority !== "") {
      // Native Canvas may update its translate while our trailing rotation is
      // active. Remove only that exact owned suffix so refresh cannot
      // accumulate rotations and the newer native transform remains intact.
      if (property === "transform" && current !== undefined && currentPriority === "") {
        const ownedSuffix = before.trim().length === 0 || before.trim() === "none"
          ? value.trim()
          : value.startsWith(`${before} `) ? value.slice(before.length + 1).trim() : "";
        const marker = ` ${ownedSuffix}`;
        if (ownedSuffix.length > 0 && (current === ownedSuffix || current.endsWith(marker))) {
          const retained = current === ownedSuffix ? "" : current.slice(0, -marker.length);
          if (retained.length === 0) {
            const currentStyle = styleObject(element);
            if (currentStyle !== undefined) safeCall(currentStyle, "removeProperty", [property]);
          } else {
            setStyleRaw(element, property, retained);
          }
        }
      }
      return;
    }
    if (before.length === 0) {
      const currentStyle = styleObject(element);
      if (currentStyle !== undefined) safeCall(currentStyle, "removeProperty", [property]);
    } else {
      setStyleRaw(element, property, before, beforePriority);
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

function composedTransform(element: DomElementLike, rotation: number): string | undefined {
  const before = readStyle(element, "transform");
  if (before === undefined) return undefined;
  const rotate = `rotate(${rotation}deg)`;
  return before.trim().length === 0 || before.trim() === "none" ? rotate : `${before} ${rotate}`;
}

function applyRotation(runtime: unknown, primary: DomElementLike, rotation: number, patches: RestorePatch[], diagnostics: string[], id: string): void {
  if (!Number.isFinite(rotation) || rotation === 0) return;
  const transform = composedTransform(primary, rotation);
  if (transform === undefined || !patchStyle(primary, "transform", transform, patches)) {
    diagnostics.push(`rotation-dom-inaccessible: ${id}.`);
    return;
  }
  patchStyle(primary, "transform-origin", "50% 50%", patches);

  const interactionElements = allElementsFor(runtime, ["hitboxEl", "interactionEl", "resizerEl", "resizeEl", "selectionEl", "bboxEl"]);
  for (const element of interactionElements) {
    if (element === primary || isContained(primary, element) || isContained(element, primary)) continue;
    const interactionTransform = composedTransform(element, rotation);
    if (interactionTransform !== undefined) {
      patchStyle(element, "transform", interactionTransform, patches);
      patchStyle(element, "transform-origin", "50% 50%", patches);
    }
  }
}

function normalizedZIndex(value: number | undefined): string | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined;
  const integer = Math.trunc(value);
  if (integer > MAX_Z_INDEX || integer < -MAX_Z_INDEX) return undefined;
  return String(integer);
}

const CAP_PATHS: Readonly<Record<string, string>> = Object.freeze({
  rounded_stealth: "M-10 -5Q-2 -2 0 0Q-2 2 -10 5L-7 0Z",
  filled_oval: "M-5 -5A5 5 0 1 1 -5 5A5 5 0 1 1 -5 -5Z",
  erd_one: "M-5 -6V6",
  erd_many: "M-10 -6L0 0L-10 6M-10 0H0",
  erd_one_or_many: "M-10 -6L0 0L-10 6M-10 0H0M-13 -6V6",
  erd_only_one: "M-5 -6V6M-10 -6V6",
  erd_zero_or_many: "M-8 -6L0 0L-8 6M-8 0H0M-12 -3A3 3 0 1 1 -12 3A3 3 0 1 1 -12 -3Z",
  erd_zero_or_one: "M-5 -6V6M-11 -3A3 3 0 1 1 -11 3A3 3 0 1 1 -11 -3Z",
  arrow: "M-10 -5L0 0L-10 5", triangle: "M-10 -5L0 0L-10 5Z",
  stealth: "M-10 -5L0 0L-10 5L-7 0Z", diamond: "M-12 0L-6 -5L0 0L-6 5Z",
  circle: "M-5 -5A5 5 0 1 1 -5 5A5 5 0 1 1 -5 -5Z",
  oval: "M-5 -5A5 5 0 1 1 -5 5A5 5 0 1 1 -5 -5Z",
  filled_triangle: "M-10 -5L0 0L-10 5Z", filled_diamond: "M-12 0L-6 -5L0 0L-6 5Z",
  filled_circle: "M-5 -5A5 5 0 1 1 -5 5A5 5 0 1 1 -5 -5Z",
  er_one: "M-5 -6V6", er_many: "M-10 -6L0 0L-10 6M-10 0H0",
  er_one_or_many: "M-10 -6L0 0L-10 6M-10 0H0M-13 -6V6",
});

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
 * nodes that agree with the document, and a rotated node is never measured
 * because its DOM box is the inflated axis-aligned bounds, not its own size.
 */
function measureNodes(document: unknown, runtimeNodes: readonly unknown[], scene: SourceScene): NodeMeasurements {
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
    const size = domSize(elementFor(runtime, ["nodeEl", "containerEl", "el"]));
    const declaredSize = id === undefined ? undefined : declared.get(id);
    if (id === undefined || size === undefined || declaredSize === undefined) continue;
    observed.set(id, size);
    if ((scene.items.get(id)?.rotation ?? 0) === 0) ratios.push(size.width / declaredSize.width);
  }
  if (ratios.length === 0) return {};
  ratios.sort((left, right) => left - right);
  const scale = ratios[Math.floor(ratios.length / 2)]!;
  if (!Number.isFinite(scale) || scale <= 0) return {};
  const measurements: Record<string, { width: number; height: number }> = Object.create(null);
  for (const [id, size] of observed) {
    if ((scene.items.get(id)?.rotation ?? 0) !== 0) continue;
    const declaredSize = declared.get(id)!;
    const width = size.width / scale, height = size.height / scale;
    // Only a real disagreement is reported; rounding noise is not a measurement.
    if (Math.abs(width - declaredSize.width) > 1 || Math.abs(height - declaredSize.height) > 1) {
      measurements[id] = { width, height };
    }
  }
  return measurements;
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

function marker(document: Document | undefined, cap: string, color: string, patches: RestorePatch[], parent: DomElementLike): string | undefined {
  if (cap === "none") return "none";
  const d = CAP_PATHS[cap];
  if (d === undefined) return undefined;
  const defs = createSvg(document, "defs"), mark = createSvg(document, "marker"), path = createSvg(document, "path");
  if (defs === undefined || mark === undefined || path === undefined) return undefined;
  const id = `miro-cap-${++markerSequence}`;
  for (const [key, value] of Object.entries({ id, viewBox: "-16 -8 18 16", refX: "0", refY: "0", markerWidth: "18", markerHeight: "16", markerUnits: "strokeWidth", orient: "auto-start-reverse" })) {
    setOwnedElementAttribute(mark, key, value);
  }
  const filled = cap.startsWith("filled_") || cap === "stealth" || cap === "rounded_stealth";
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
  const p = (point: AnchorPoint): string => { const q = map(point); return `${q.x} ${q.y}`; };
  const controls = geometry.controls;
  if (Array.isArray(controls) && controls.length === 2) return `M ${p(start)} C ${p(controls[0])} ${p(controls[1])} ${p(end)}`;
  return `M ${p(start)}` + (geometry.points ?? [start, end]).slice(1).map(point => ` L ${p(point)}`).join("");
}

function renderConnectorGeometry(document: Document | undefined, runtime: unknown, descriptor: SourceItemDescriptor,
  geometry: AnchorEdgeGeometry | undefined, native: unknown, patches: RestorePatch[], diagnostics: string[], id: string): void {
  const group = elementFor(runtime, ["lineGroupEl", "edgeEl", "el"]);
  const direct = elementFor(runtime, ["pathEl", "lineEl"]);
  const paths = group === undefined ? [] : queryAll(group, "path").filter(path => !safeCall(path, "closest", ["defs, marker"]));
  if (direct !== undefined && !paths.includes(direct)) paths.push(direct);
  const routes = geometry === undefined ? [] : paths.map(path => ({ path, d: localRoute(path, geometry) }));
  if (group === undefined || routes.length === 0 || routes.some(route => route.d === undefined)) {
    diagnostics.push(`connector-geometry-fallback: ${id}.`);
    return;
  }
  const caps = [descriptor.connector?.startCap ?? (safeGet(native, "fromEnd") === "arrow" ? "arrow" : "none"),
    descriptor.connector?.endCap ?? (safeGet(native, "toEnd") === "none" ? "none" : "arrow")];
  if (caps.some(cap => cap !== "none" && CAP_PATHS[cap] === undefined)) {
    diagnostics.push(`connector-endcap-fallback: ${id}.`);
    return;
  }
  const color = descriptor.css.stroke ?? "var(--canvas-color, currentColor)";
  const startMarker = marker(document, caps[0]!, color, patches, group);
  const endMarker = marker(document, caps[1]!, color, patches, group);
  if (startMarker === undefined || endMarker === undefined) {
    diagnostics.push(`connector-marker-fallback: ${id}.`);
    return;
  }
  for (const { path, d } of routes) {
    patchAttribute(path, "d", d!, patches);
    // Native hit paths follow the visible route but keep their generous hit width.
    if (safeCall(safeGet(path, "classList"), "contains", ["canvas-interaction-path"]) === true) continue;
    const values = { fill: "none", stroke: color, "stroke-width": descriptor.css["stroke-width"] ?? "2",
      "stroke-opacity": descriptor.css["stroke-opacity"] ?? "1",
      "stroke-dasharray": descriptor.connector?.strokeStyle === "dashed" ? "8 6" : descriptor.connector?.strokeStyle === "dotted" ? "2 5" : "none",
      "stroke-linecap": descriptor.connector?.strokeStyle === "dotted" ? "round" : "butt",
      "marker-start": startMarker, "marker-end": endMarker };
    for (const [key, value] of Object.entries(values)) {
      patchAttribute(path, key, value, patches);
      patchStyle(path, key, value, patches);
    }
  }
  const ends = elementFor(runtime, ["lineEndGroupEl"]);
  if (ends !== undefined && ends !== group && !isContained(ends, group)) patchStyle(ends, "display", "none", patches);
}

function applyConnector(
  document: Document | undefined, geometry: AnchorEdgeGeometry | undefined, native: unknown,
  runtime: unknown,
  id: string,
  descriptor: SourceItemDescriptor,
  patches: RestorePatch[],
  diagnostics: string[],
): RenderedItem | undefined {
  const targets = allElementsFor(runtime, ["edgeEl", "lineGroupEl", "lineEndGroupEl", "el"]);
  if (targets.length === 0) {
    diagnostics.push(`connector-dom-inaccessible: ${id}.`);
    return undefined;
  }
  const primary = targets[0]!;
  for (const target of targets) {
    patchClass(target, OWNED_CLASS, patches);
    patchClass(target, "miro-source-connector", patches);
    patchAttribute(target, "data-miro-source-kind", "connector", patches);
    if (descriptor.sourceId !== undefined) patchAttribute(target, "data-miro-source-id", descriptor.sourceId, patches);
    for (const [property, attribute] of Object.entries(CONNECTOR_ATTRIBUTE_CSS)) {
      const value = descriptor.css[property];
      if (value !== undefined) patchAttribute(target, attribute, value, patches);
    }
    if (descriptor.connector?.shape !== undefined) {
      patchAttribute(target, "data-miro-source-connector-shape", descriptor.connector.shape, patches);
      patchClass(target, `miro-source-connector-${descriptor.connector.shape}`, patches);
    }
    if (descriptor.connector?.strokeStyle !== undefined) {
      const dash = descriptor.connector.strokeStyle === "dashed" ? "8 6" : descriptor.connector.strokeStyle === "dotted" ? "2 5" : "none";
      patchAttribute(target, "stroke-dasharray", dash, patches);
      patchAttribute(target, "data-miro-source-stroke-style", descriptor.connector.strokeStyle, patches);
    }
    if (descriptor.connector?.startCap !== undefined) patchAttribute(target, "data-miro-source-start-cap", descriptor.connector.startCap, patches);
    if (descriptor.connector?.endCap !== undefined) patchAttribute(target, "data-miro-source-end-cap", descriptor.connector.endCap, patches);
    for (const [property, value] of Object.entries(descriptor.css)) {
      if (TYPOGRAPHY_CSS.has(property)) patchAttribute(target, `data-miro-source-label-${property}`, value, patches);
    }
  }
  renderConnectorGeometry(document, runtime, descriptor, geometry, native, patches, diagnostics, id);
  return { id, kind: "edge", element: primary, descriptor };
}

function applyNode(
  document: Document | undefined,
  runtime: unknown,
  id: string,
  descriptor: SourceItemDescriptor,
  patches: RestorePatch[],
  diagnostics: string[],
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

  let layer: DomElementLike | undefined;
  if (descriptor.kind === "shape" || descriptor.kind === "sticky" || descriptor.kind === "frame" || descriptor.kind === "media") {
    const created = document === undefined ? undefined : createElement(document, "div");
    if (created !== undefined) {
      addOwnedElementClass(created, DECORATION_CLASS);
      addOwnedElementClass(created, `miro-source-decoration-${descriptor.kind}`);
      setOwnedElementAttribute(created, "aria-hidden", "true");
      setOwnedElementAttribute(created, "data-miro-source-decoration", descriptor.kind);
      setOwnedElementStyle(created, "position", "absolute");
      setOwnedElementStyle(created, "inset", "0");
      setOwnedElementStyle(created, "box-sizing", "border-box");
      setOwnedElementStyle(created, "pointer-events", "none");
      setOwnedElementStyle(created, "z-index", "0");
      const drawable = descriptor.kind !== "shape" || decorateShape(document, created, descriptor);
      if (!drawable) diagnostics.push(`shape-renderer-fallback: ${id} (${descriptor.shape ?? "unknown"}).`);
      if (drawable && appendOwnedChild(shell, created, patches)) layer = created;
    }
    if (layer === undefined) diagnostics.push(`decoration-dom-inaccessible: ${id}.`);
  }

  if (layer !== undefined) {
    patchStyle(shell, "isolation", "isolate", patches);
    for (const foreground of allElementsFor(runtime, ["contentEl", "labelEl", "fileEl", "embedEl"])) {
      if (foreground === layer || !isContained(shell, foreground)) continue;
      patchStyle(foreground, "position", "relative", patches);
      patchStyle(foreground, "z-index", "1", patches);
    }
  }

  // Reserve the room the contour takes away, so the text stays inside it.
  if (descriptor.kind === "shape" && descriptor.shape !== undefined && layer !== undefined) {
    const inset = SHAPE_CONTENT_INSETS[descriptor.shape];
    if (inset !== undefined) {
      patchStyle(content, "padding", inset.map((value) => `${value}%`).join(" "), patches);
      patchStyle(content, "box-sizing", "border-box", patches);
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
  // Rotation is applied to the inner container because native Canvas owns the
  // shell's own transform and rewrites it while panning.  The shell therefore
  // stays axis-aligned, so its paint would show as an unrotated rectangle
  // behind the rotated node unless it steps aside.
  if (Number.isFinite(descriptor.rotation) && descriptor.rotation !== 0 && primary !== shell) {
    patchStyle(shell, "background-color", "transparent", patches);
    patchStyle(shell, "border-color", "transparent", patches);
    patchStyle(shell, "box-shadow", "none", patches);
  }
  applyRotation(runtime, primary, descriptor.rotation, patches, diagnostics, id);
  return { id, kind: "node", element: primary, descriptor };
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
  private diagnosticList: readonly string[] = [];
  private readonly document: Document | undefined;

  public constructor(private readonly host: SourceRendererHost, document?: Document) {
    this.document = document ?? defaultDocument();
  }

  public get diagnostics(): readonly string[] {
    return this.diagnosticList;
  }

  public refresh(): readonly string[] {
    this.restoreOwnedPatches();
    const diagnostics: string[] = [];
    const sourceDocument = safeCall(this.host, "getDocument");
    let scene: SourceScene;
    try {
      scene = buildSourceScene(sourceDocument);
    } catch {
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
        && !isObject(safeGet(override, "connectorAnchors")) && !isObject(safeGet(override, "connector"))) descriptors.delete(id);
    }
    const rawEdges = safeGet(sourceDocument, "edges");
    const nativeEdges = Array.isArray(rawEdges) ? itemById(rawEdges) : new Map<string, unknown>();
    for (const id of nativeEdges.keys()) {
      if (!descriptors.has(id) && isObject(safeGet(safeGet(overrides, id), "connectorAnchors"))) {
        descriptors.set(id, { kind: "connector", rotation: 0, css: {} });
      }
    }
    if (descriptors.size === 0) {
      this.diagnosticList = Object.freeze(diagnostics);
      return this.diagnosticList;
    }

    const runtimeNodes = readCollection(this.host, "getNodes", diagnostics);
    // A connector must end on what the host drew, not on what the file says a
    // collapsed group would occupy if it were open.
    const geometry = buildCanvasAnchorGeometry(sourceDocument, measureNodes(sourceDocument, runtimeNodes, scene));
    const nodes = itemById(runtimeNodes);
    const edges = itemById(readCollection(this.host, "getEdges", diagnostics));
    const nextPatches: RestorePatch[] = [];
    const rendered: RenderedItem[] = [];
    try {
      for (const [id, descriptor] of descriptors) {
        if (descriptor.kind === "connector") {
          const runtime = edges.get(id);
          if (runtime === undefined) {
            diagnostics.push(`connector-runtime-missing: ${id}.`);
            continue;
          }
          const item = applyConnector(this.document, geometry.edges?.[id], nativeEdges.get(id), runtime, id, descriptor, nextPatches, diagnostics);
          if (item !== undefined) rendered.push(item);
        } else {
          const runtime = nodes.get(id);
          if (runtime === undefined) {
            diagnostics.push(`node-runtime-missing: ${id}.`);
            continue;
          }
          const item = applyNode(this.document, runtime, id, descriptor, nextPatches, diagnostics);
          if (item !== undefined) rendered.push(item);
        }
      }
      applyOrdering(scene, rendered, nextPatches, diagnostics);
      this.patches = nextPatches;
    } catch {
      for (let index = nextPatches.length - 1; index >= 0; index -= 1) {
        try { nextPatches[index]!(); } catch { /* fail closed */ }
      }
      diagnostics.push("source-render-failed: DOM decoration aborted safely.");
      this.patches = [];
    }
    this.diagnosticList = Object.freeze(diagnostics);
    return this.diagnosticList;
  }

  public dispose(): void {
    this.restoreOwnedPatches();
    this.diagnosticList = Object.freeze([]);
  }

  private restoreOwnedPatches(): void {
    const current = this.patches;
    this.patches = [];
    for (let index = current.length - 1; index >= 0; index -= 1) {
      try { current[index]!(); } catch { /* exact-owned restoration is best-effort */ }
    }
  }
}
