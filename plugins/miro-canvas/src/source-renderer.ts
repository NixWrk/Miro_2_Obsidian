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

const ROUNDED_SHAPES = new Set([
  "round_rectangle",
  "wedge_round_rectangle_callout",
  "flow_chart_terminator",
  "can",
  "flow_chart_magnetic_disk",
  "flow_chart_magnetic_drum",
  "flow_chart_online_storage",
]);

const ELLIPSE_SHAPES = new Set(["ellipse", "circle", "flow_chart_connector", "flow_chart_or", "flow_chart_summing_junction"]);

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

function decorateShape(layer: DomElementLike, descriptor: SourceItemDescriptor, diagnostics: string[], id: string): void {
  const shape = descriptor.shape;
  if (shape === undefined) {
    addOwnedElementClass(layer, "miro-source-shape-generic");
    diagnostics.push(`shape-renderer-fallback: ${id}.`);
    return;
  }
  addOwnedElementClass(layer, `miro-source-shape-${shape}`);
  setOwnedElementAttribute(layer, "data-miro-source-shape", shape);
  const clipPath = SHAPE_CLIP_PATHS[shape];
  if (clipPath !== undefined) {
    setOwnedElementStyle(layer, "clip-path", clipPath);
  } else if (ELLIPSE_SHAPES.has(shape)) {
    setOwnedElementStyle(layer, "border-radius", "50%");
  } else if (ROUNDED_SHAPES.has(shape)) {
    setOwnedElementStyle(layer, "border-radius", shape === "flow_chart_terminator" ? "9999px" : "12px");
  } else if (shape === "rectangle" || shape.startsWith("flow_chart_") || shape === "cloud" || shape === "left_brace" || shape === "right_brace") {
    setOwnedElementStyle(layer, "clip-path", "inset(0)");
  } else {
    addOwnedElementClass(layer, "miro-source-shape-generic");
    diagnostics.push(`shape-renderer-fallback: ${id} (${shape}).`);
  }
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
      if (layer !== undefined) setOwnedElementStyle(layer, property, value);
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

function applyConnector(
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
      if (descriptor.kind === "shape") decorateShape(created, descriptor, diagnostics, id);
      if (appendOwnedChild(shell, created, patches)) layer = created;
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

  applyNodeCss(descriptor, shell, content, layer, patches);
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
    if (scene.items.size === 0) {
      this.diagnosticList = Object.freeze(diagnostics);
      return this.diagnosticList;
    }

    const nodes = itemById(readCollection(this.host, "getNodes", diagnostics));
    const edges = itemById(readCollection(this.host, "getEdges", diagnostics));
    const nextPatches: RestorePatch[] = [];
    const rendered: RenderedItem[] = [];
    try {
      for (const [id, descriptor] of scene.items) {
        if (descriptor.kind === "connector") {
          const runtime = edges.get(id);
          if (runtime === undefined) {
            diagnostics.push(`connector-runtime-missing: ${id}.`);
            continue;
          }
          const item = applyConnector(runtime, id, descriptor, nextPatches, diagnostics);
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
