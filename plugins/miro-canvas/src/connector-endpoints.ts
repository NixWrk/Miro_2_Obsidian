/** Pure connector-endpoint geometry and document mutation helpers. */

import {
  normalizeAnchor,
  resolveAnchor,
} from "./anchors";
import type {
  AnchorEdgeGeometry,
  AnchorGeometry,
  AnchorPoint,
  AnchorRect,
  CanvasAnchor,
} from "./anchors";
import { buildSourceScene } from "./source-model";
import { contourPoint, shapeOutline, type ShapePoint } from "./shape-geometry";
import { decideInteraction } from "./interaction-policy";
import {
  MIRO_CANVAS_SCHEMA_VERSION,
  parseMiroCanvasMetadata,
} from "./metadata";

type UnknownRecord = Record<string, unknown>;
type ConnectorEnd = "from" | "to";
type NativeSide = "top" | "right" | "bottom" | "left";

const ABSENT = Symbol("connector-endpoint-absent");
const ERROR = Symbol("connector-endpoint-error");
const MAX_JSON_DEPTH = 64;
const RESERVED_IDS = new Set(["__proto__", "prototype", "constructor"]);
const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "avif"]);
const SIDES = new Set<NativeSide>(["top", "right", "bottom", "left"]);
const KNOWN_ANCHOR_FIELDS = ["type", "nodeId", "edgeId", "u", "v", "x", "y", "t"] as const;

export interface ConnectorEndpointDiagnostic {
  readonly code: string;
  readonly message: string;
}

export interface UpdateConnectorEndpointInput {
  readonly edgeId: string;
  readonly end: ConnectorEnd;
  readonly anchor: CanvasAnchor;
}

export interface UpdateConnectorEndpointResult {
  readonly ok: boolean;
  readonly document?: Record<string, unknown>;
  readonly diagnostics: readonly ConnectorEndpointDiagnostic[];
}

interface GraphIndex {
  readonly document: UnknownRecord;
  readonly nodes: ReadonlyMap<string, UnknownRecord>;
  readonly edges: ReadonlyMap<string, UnknownRecord>;
}

interface CloneResult {
  readonly ok: boolean;
  readonly value?: unknown;
}

function diagnostic(code: string, message: string): ConnectorEndpointDiagnostic {
  return { code, message };
}

function isRecord(value: unknown): value is UnknownRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function readOwn(record: UnknownRecord, key: string): unknown | typeof ABSENT | typeof ERROR {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    if (descriptor === undefined) {
      return ABSENT;
    }
    return Object.prototype.hasOwnProperty.call(descriptor, "value") ? descriptor.value : ERROR;
  } catch {
    return ERROR;
  }
}

function setOwn(record: UnknownRecord, key: string, value: unknown): void {
  Object.defineProperty(record, key, {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  });
}

function mergeStoredAnchor(existing: unknown, replacement: UnknownRecord): UnknownRecord | undefined {
  const merged = isRecord(existing) ? existing : {};
  for (const key of KNOWN_ANCHOR_FIELDS) {
    if (!Reflect.deleteProperty(merged, key)) {
      return undefined;
    }
  }
  for (const key of Object.keys(replacement)) {
    const value = readOwn(replacement, key);
    if (value === ABSENT || value === ERROR) {
      return undefined;
    }
    setOwn(merged, key, value);
  }
  return merged;
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function unit(value: unknown): value is number {
  return finite(value) && value >= 0 && value <= 1;
}

function safeId(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && !/\s/u.test(value)
    && !RESERVED_IDS.has(value);
}

function hasEnumerableSymbol(value: object): boolean {
  return Object.getOwnPropertySymbols(value).some((symbol) =>
    Object.getOwnPropertyDescriptor(value, symbol)?.enumerable === true);
}

function cloneJsonValue(value: unknown, seen = new WeakSet<object>(), depth = 0): CloneResult {
  if (depth > MAX_JSON_DEPTH) {
    return { ok: false };
  }
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return { ok: true, value };
  }
  if (typeof value === "number") {
    return finite(value) ? { ok: true, value } : { ok: false };
  }
  if (value === undefined) {
    return { ok: false };
  }
  if (typeof value !== "object") {
    return { ok: false };
  }
  if (seen.has(value)) {
    return { ok: false };
  }
  seen.add(value);
  try {
    if (hasEnumerableSymbol(value)) {
      return { ok: false };
    }
    if (Array.isArray(value)) {
      const ownKeys = Reflect.ownKeys(value);
      for (const key of ownKeys) {
        if (typeof key === "symbol") {
          continue;
        }
        if (key === "length") {
          continue;
        }
        const index = Number(key);
        if (!Number.isInteger(index) || index < 0 || index >= value.length || String(index) !== key) {
          return { ok: false };
        }
      }
      const copy: unknown[] = new Array(value.length);
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (descriptor === undefined || !Object.prototype.hasOwnProperty.call(descriptor, "value")) {
          return { ok: false };
        }
        const cloned = cloneJsonValue(descriptor.value, seen, depth + 1);
        if (!cloned.ok) {
          return { ok: false };
        }
        copy[index] = cloned.value;
      }
      return { ok: true, value: copy };
    }
    if (!isRecord(value)) {
      return { ok: false };
    }
    const copy: UnknownRecord = {};
    for (const key of Object.keys(value)) {
      const property = readOwn(value, key);
      if (property === ERROR || property === ABSENT) {
        return { ok: false };
      }
      const cloned = cloneJsonValue(property, seen, depth + 1);
      if (!cloned.ok) {
        return { ok: false };
      }
      setOwn(copy, key, cloned.value);
    }
    return { ok: true, value: copy };
  } catch {
    return { ok: false };
  } finally {
    seen.delete(value);
  }
}

function rectFromNode(node: UnknownRecord): AnchorRect | undefined {
  const x = readOwn(node, "x");
  const y = readOwn(node, "y");
  const width = readOwn(node, "width");
  const height = readOwn(node, "height");
  if (!finite(x) || !finite(y) || !finite(width) || !finite(height) || width < 0 || height < 0) {
    return undefined;
  }
  return { x, y, width, height };
}

function imageExtension(node: UnknownRecord): string | undefined {
  const file = readOwn(node, "file");
  if (typeof file !== "string") {
    return undefined;
  }
  const clean = file.split(/[?#]/u, 1)[0] ?? "";
  const match = /\.([^.\\/]+)$/u.exec(clean);
  return match?.[1]?.toLowerCase();
}

function isImageNode(node: UnknownRecord): boolean {
  const type = readOwn(node, "type");
  return type === "image" || (type === "file" && IMAGE_EXTENSIONS.has(imageExtension(node) ?? ""));
}

function metadataOverride(document: UnknownRecord, id: string): UnknownRecord | undefined {
  const metadata = readOwn(document, "miroCanvas");
  if (!isRecord(metadata)) {
    return undefined;
  }
  const overrides = readOwn(metadata, "localOverrides");
  if (!isRecord(overrides)) {
    return undefined;
  }
  const override = readOwn(overrides, id);
  return isRecord(override) ? override : undefined;
}

function explicitImageCrop(document: UnknownRecord, node: UnknownRecord, id: string, base: AnchorRect): AnchorRect | undefined {
  const override = metadataOverride(document, id);
  const direct = readOwn(node, "imageCrop");
  const local = override === undefined ? ABSENT : readOwn(override, "imageCrop");
  const crop = direct !== ABSENT && direct !== ERROR ? direct : local;
  if (!isRecord(crop)) {
    return undefined;
  }
  const x = readOwn(crop, "x");
  const y = readOwn(crop, "y");
  const width = readOwn(crop, "width");
  const height = readOwn(crop, "height");
  const space = readOwn(crop, "space");
  if (!finite(x) || !finite(y) || !finite(width) || !finite(height) || width < 0 || height < 0) {
    return undefined;
  }
  if (space === "canvas") {
    return { x, y, width, height };
  }
  if (space === "relative" && unit(x) && unit(y) && unit(width) && unit(height) && x + width <= 1 && y + height <= 1) {
    return {
      x: base.x + base.width * x,
      y: base.y + base.height * y,
      width: base.width * width,
      height: base.height * height,
    };
  }
  return undefined;
}

/**
 * The point on a node where a connector meets it.
 *
 * Native Canvas only records which of four sides an edge leaves from, and the
 * middle of that side belongs to the bounding rectangle, not to the shape
 * drawn inside it: on a triangle or an ellipse it lands in empty space. With
 * a silhouette the point is pulled onto the contour first, and the node's own
 * rotation is applied afterwards so the connector follows the shape as it
 * turns.
 */
function sidePoint(rect: AnchorRect, side: unknown, outline?: readonly ShapePoint[]): AnchorPoint | undefined {
  if (side === ABSENT) {
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  }
  if (typeof side !== "string" || !SIDES.has(side as NativeSide)) {
    return undefined;
  }
  let point: AnchorPoint;
  switch (side as NativeSide) {
    case "top": point = { x: rect.x + rect.width / 2, y: rect.y }; break;
    case "right": point = { x: rect.x + rect.width, y: rect.y + rect.height / 2 }; break;
    case "bottom": point = { x: rect.x + rect.width / 2, y: rect.y + rect.height }; break;
    case "left": point = { x: rect.x, y: rect.y + rect.height / 2 }; break;
  }
  if (outline !== undefined && rect.width > 0 && rect.height > 0) {
    const local = contourPoint(outline, {
      x: ((point.x - rect.x) / rect.width) * 100,
      y: ((point.y - rect.y) / rect.height) * 100,
    });
    point = { x: rect.x + (local.x / 100) * rect.width, y: rect.y + (local.y / 100) * rect.height };
  }
  if (rect.rotation === undefined || rect.rotation === 0) return point;
  const cx = rect.rotationCenterX ?? rect.x + rect.width / 2;
  const cy = rect.rotationCenterY ?? rect.y + rect.height / 2;
  const radians = rect.rotation * Math.PI / 180;
  const dx = point.x - cx, dy = point.y - cy;
  return { x: cx + dx * Math.cos(radians) - dy * Math.sin(radians), y: cy + dx * Math.sin(radians) + dy * Math.cos(radians) };
}

function connectorAnchor(document: UnknownRecord, edgeId: string, end: ConnectorEnd): unknown | typeof ABSENT {
  const override = metadataOverride(document, edgeId);
  if (override === undefined) {
    return ABSENT;
  }
  const anchors = readOwn(override, "connectorAnchors");
  if (!isRecord(anchors)) {
    return ABSENT;
  }
  const value = readOwn(anchors, end);
  return value === ERROR ? ABSENT : value;
}

function indexGraph(document: UnknownRecord): GraphIndex | undefined {
  const nodesValue = readOwn(document, "nodes");
  const edgesValue = readOwn(document, "edges");
  if (!Array.isArray(nodesValue) || !Array.isArray(edgesValue)) {
    return undefined;
  }
  const nodes = new Map<string, UnknownRecord>();
  const edges = new Map<string, UnknownRecord>();
  const ids = new Set<string>();
  const add = (items: readonly unknown[], target: Map<string, UnknownRecord>): boolean => {
    for (const item of items) {
      if (!isRecord(item)) {
        return false;
      }
      const id = readOwn(item, "id");
      if (!safeId(id) || ids.has(id)) {
        return false;
      }
      ids.add(id);
      target.set(id, item);
    }
    return true;
  };
  return add(nodesValue, nodes) && add(edgesValue, edges) ? { document, nodes, edges } : undefined;
}

/** Build only geometry that is explicitly recoverable from the Canvas document. */
/**
 * A node box observed from the live runtime, in board units.
 *
 * The `.canvas` file has no place to record that a group is collapsed, so a
 * document-only model necessarily aims a connector at the box the group would
 * occupy when open.  A host that can measure supplies what it actually drew;
 * anything it cannot measure keeps the document geometry.
 */
export interface MeasuredNodeRect {
  readonly width?: number;
  readonly height?: number;
  readonly rotation?: number;
}

export type NodeMeasurements = Readonly<Record<string, MeasuredNodeRect>>;

function measuredRect(rect: AnchorRect, measured: MeasuredNodeRect | undefined): AnchorRect {
  if (measured === undefined) {
    return rect;
  }
  const width = finite(measured.width) && measured.width >= 0 ? measured.width : rect.width;
  const height = finite(measured.height) && measured.height >= 0 ? measured.height : rect.height;
  // A collapsed group keeps its top-left and loses height downwards, which is
  // also how a host reports any box it shrank in place.
  return { ...rect, width, height };
}

export function buildCanvasAnchorGeometry(document: unknown, measurements?: NodeMeasurements): AnchorGeometry {
  if (!isRecord(document)) {
    return {};
  }
  const graph = indexGraph(document);
  if (graph === undefined) {
    return {};
  }
  const nodes = Object.create(null) as Record<string, AnchorRect>;
  const images = Object.create(null) as Record<string, AnchorRect>;
  const sourceScene = buildSourceScene(document);
  for (const [id, node] of graph.nodes) {
    const measured = measurements === undefined ? undefined : readOwn(measurements, id);
    const observed = isRecord(measured) ? measured as MeasuredNodeRect : undefined;
    const documentRect = rectFromNode(node);
    const base = documentRect === undefined ? undefined : measuredRect(documentRect, observed);
    const rotation = finite(observed?.rotation)
      ? observed!.rotation!
      : sourceScene.items.get(id)?.rotation ?? 0;
    const rect = base === undefined ? undefined : rotation === 0 ? base : {
      ...base, rotation,
      rotationCenterX: base.x + base.width / 2,
      rotationCenterY: base.y + base.height / 2,
    };
    if (rect === undefined) {
      continue;
    }
    nodes[id] = rect;
    if (isImageNode(node)) {
      const crop = explicitImageCrop(document, node, id, rect);
      images[id] = crop === undefined || rotation === 0 ? crop ?? rect : {
        ...crop, rotation,
        rotationCenterX: rect.rotationCenterX,
        rotationCenterY: rect.rotationCenterY,
      };
    }
  }

  const edges = Object.create(null) as Record<string, AnchorEdgeGeometry>;
  const resolving = new Set<string>();
  const resolveEdge = (edgeId: string): AnchorEdgeGeometry | undefined => {
    if (edges[edgeId] !== undefined) {
      return edges[edgeId];
    }
    if (resolving.has(edgeId)) {
      return undefined;
    }
    const edge = graph.edges.get(edgeId);
    if (edge === undefined) {
      return undefined;
    }
    resolving.add(edgeId);
    const endpoint = (end: ConnectorEnd): AnchorPoint | undefined => {
      const anchorValue = connectorAnchor(document, edgeId, end);
      if (anchorValue !== ABSENT) {
        const normalized = normalizeAnchor(anchorValue);
        if (!normalized.valid || normalized.anchor === undefined) {
          return undefined;
        }
        const anchor = normalized.anchor;
        if (anchor.type === "edge") {
          const target = resolveEdge(anchor.edgeId);
          if (target === undefined) {
            return undefined;
          }
          const targetEdges = Object.create(null) as Record<string, AnchorEdgeGeometry>;
          targetEdges[anchor.edgeId] = target;
          const point = resolveAnchor(anchor, { edges: targetEdges }).point;
          return point === undefined ? undefined : { x: point.x, y: point.y };
        }
        const point = resolveAnchor(anchor, { nodes, images }).point;
        return point === undefined ? undefined : { x: point.x, y: point.y };
      }
      const nodeId = readOwn(edge, `${end}Node`);
      const side = readOwn(edge, `${end}Side`);
      if (!safeId(nodeId)) {
        return undefined;
      }
      const rect = nodes[nodeId];
      return rect === undefined
        ? undefined
        : sidePoint(rect, side, shapeOutline(sourceScene.items.get(nodeId)?.shape));
    };
    const start = endpoint("from");
    const end = endpoint("to");
    resolving.delete(edgeId);
    if (start === undefined || end === undefined) {
      return undefined;
    }
    const descriptor = sourceScene.items.get(edgeId);
    const override = metadataOverride(document, edgeId);
    const localRoute = override === undefined ? undefined : readOwn(override, "connector");
    const routing = descriptor?.sourceId !== undefined || isRecord(localRoute) ? descriptor?.connector?.shape : undefined;
    const geometry = routeConnector(start, end, routing);
    edges[edgeId] = geometry;
    return geometry;
  };
  for (const edgeId of graph.edges.keys()) {
    resolveEdge(edgeId);
  }
  return { nodes, images, edges };
}

/** One read-only route for the SVG renderer and edge-relative anchors. */
export function routeConnector(
  start: AnchorPoint, end: AnchorPoint, routing: "straight" | "elbowed" | "curved" = "straight",
): AnchorEdgeGeometry & { readonly path: string } {
  const p = (point: AnchorPoint): string => `${point.x} ${point.y}`;
  const horizontal = Math.abs(end.x - start.x) >= Math.abs(end.y - start.y);
  const c1 = horizontal ? { x: (start.x + end.x) / 2, y: start.y } : { x: start.x, y: (start.y + end.y) / 2 };
  const c2 = horizontal ? { x: c1.x, y: end.y } : { x: end.x, y: c1.y };
  if (routing === "elbowed") {
    return { start, end, points: [start, c1, c2, end], path: `M ${p(start)} L ${p(c1)} L ${p(c2)} L ${p(end)}` };
  }
  if (routing === "curved") {
    // Bounded arc-length sampling keeps anchors on the same cubic used by SVG.
    const points = Array.from({ length: 129 }, (_, i) => {
      const t = i / 128, s = 1 - t;
      return { x: s ** 3 * start.x + 3 * s * s * t * c1.x + 3 * s * t * t * c2.x + t ** 3 * end.x,
        y: s ** 3 * start.y + 3 * s * s * t * c1.y + 3 * s * t * t * c2.y + t ** 3 * end.y };
    });
    return { start, end, points, controls: [c1, c2], path: `M ${p(start)} C ${p(c1)} ${p(c2)} ${p(end)}` };
  }
  return { start, end, points: [start, end], path: `M ${p(start)} L ${p(end)}` };
}

function nearestSide(anchor: CanvasAnchor): NativeSide | undefined {
  if (anchor.type !== "node" && anchor.type !== "image") {
    return undefined;
  }
  const candidates: readonly [NativeSide, number][] = [
    ["left", anchor.u],
    ["right", 1 - anchor.u],
    ["top", anchor.v],
    ["bottom", 1 - anchor.v],
  ];
  let best = candidates[0];
  for (const candidate of candidates.slice(1)) {
    if (candidate[1] < best[1]) {
      best = candidate;
    }
  }
  return best[0];
}

function logicalNodeTarget(graph: GraphIndex, edge: UnknownRecord, edgeId: string, end: ConnectorEnd): string | undefined {
  const anchorValue = connectorAnchor(graph.document, edgeId, end);
  if (anchorValue !== ABSENT) {
    const normalized = normalizeAnchor(anchorValue);
    if (normalized.anchor?.type === "node" || normalized.anchor?.type === "image") {
      return normalized.anchor.nodeId;
    }
    return undefined;
  }
  const nodeId = readOwn(edge, `${end}Node`);
  return safeId(nodeId) ? nodeId : undefined;
}

function validateNativeFallback(graph: GraphIndex, edge: UnknownRecord, end: ConnectorEnd): ConnectorEndpointDiagnostic | undefined {
  const nodeId = readOwn(edge, `${end}Node`);
  if (!safeId(nodeId) || !graph.nodes.has(nodeId)) {
    return diagnostic("native-fallback-missing", `The ${end} endpoint has no valid native node fallback.`);
  }
  const side = readOwn(edge, `${end}Side`);
  if (side !== ABSENT && (typeof side !== "string" || !SIDES.has(side as NativeSide))) {
    return diagnostic("native-side-invalid", `The ${end} endpoint has an invalid native side.`);
  }
  return undefined;
}

function validateStoredConnectorAnchors(graph: GraphIndex): ConnectorEndpointDiagnostic | undefined {
  for (const [edgeId] of graph.edges) {
    const metadata = readOwn(graph.document, "miroCanvas");
    if (metadata === ABSENT) {
      continue;
    }
    if (metadata === ERROR || !isRecord(metadata)) {
      return diagnostic("metadata-invalid", "Stored miroCanvas metadata is malformed.");
    }
    const overrides = readOwn(metadata, "localOverrides");
    if (overrides === ABSENT) {
      continue;
    }
    if (overrides === ERROR || !isRecord(overrides)) {
      return diagnostic("metadata-invalid", "Stored localOverrides metadata is malformed.");
    }
    const override = readOwn(overrides, edgeId);
    if (override === ABSENT) {
      continue;
    }
    if (override === ERROR || !isRecord(override)) {
      return diagnostic("metadata-invalid", `Stored local override ${edgeId} is malformed.`);
    }
    const anchors = readOwn(override, "connectorAnchors");
    if (anchors === ABSENT) {
      continue;
    }
    if (anchors === ERROR || !isRecord(anchors)) {
      return diagnostic("metadata-invalid", `Stored connectorAnchors ${edgeId} is malformed.`);
    }
    for (const end of ["from", "to"] as const) {
      const value = readOwn(anchors, end);
      if (value === ABSENT) {
        continue;
      }
      if (value === ERROR) {
        return diagnostic("metadata-invalid", `Stored connector anchor ${edgeId}.${end} is malformed.`);
      }
      const normalized = normalizeAnchor(value);
      if (!normalized.valid || normalized.anchor === undefined) {
        return diagnostic("metadata-invalid", `Stored connector anchor ${edgeId}.${end} is malformed.`);
      }
      const anchor = normalized.anchor;
      if ((anchor.type === "node" || anchor.type === "image") && !graph.nodes.has(anchor.nodeId)) {
        return diagnostic("missing-reference", `Stored connector anchor ${edgeId}.${end} references missing node ${anchor.nodeId}.`);
      }
      if (anchor.type === "image" && !isImageNode(graph.nodes.get(anchor.nodeId)!)) {
        return diagnostic("missing-reference", `Stored image anchor ${edgeId}.${end} does not reference an image node.`);
      }
      if (anchor.type === "edge" && !graph.edges.has(anchor.edgeId)) {
        return diagnostic("missing-reference", `Stored connector anchor ${edgeId}.${end} references missing edge ${anchor.edgeId}.`);
      }
    }
  }
  return undefined;
}

function edgeReferences(graph: GraphIndex, edgeId: string, candidate?: { readonly edgeId: string; readonly end: ConnectorEnd; readonly anchor: CanvasAnchor }): readonly string[] {
  const result: string[] = [];
  for (const end of ["from", "to"] as const) {
    const value = candidate !== undefined && candidate.edgeId === edgeId && candidate.end === end
      ? candidate.anchor
      : connectorAnchor(graph.document, edgeId, end);
    if (value === ABSENT) {
      continue;
    }
    const normalized = normalizeAnchor(value);
    if (normalized.anchor?.type === "edge") {
      result.push(normalized.anchor.edgeId);
    }
  }
  return result;
}

function hasEdgeAnchorCycle(graph: GraphIndex, candidate: { readonly edgeId: string; readonly end: ConnectorEnd; readonly anchor: CanvasAnchor }): boolean {
  const visited = new Set<string>();
  const active = new Set<string>();
  const visit = (edgeId: string): boolean => {
    if (active.has(edgeId)) {
      return true;
    }
    if (visited.has(edgeId)) {
      return false;
    }
    visited.add(edgeId);
    active.add(edgeId);
    for (const target of edgeReferences(graph, edgeId, candidate)) {
      if (visit(target)) {
        return true;
      }
    }
    active.delete(edgeId);
    return false;
  };
  return [...graph.edges.keys()].some(visit);
}

function mutableMetadata(document: UnknownRecord): UnknownRecord {
  const current = readOwn(document, "miroCanvas");
  if (isRecord(current)) {
    return current;
  }
  const metadata: UnknownRecord = { schemaVersion: MIRO_CANVAS_SCHEMA_VERSION };
  setOwn(document, "miroCanvas", metadata);
  return metadata;
}

function mutableOverride(metadata: UnknownRecord, edgeId: string): UnknownRecord {
  const overridesValue = readOwn(metadata, "localOverrides");
  let overrides: UnknownRecord;
  if (isRecord(overridesValue)) {
    overrides = overridesValue;
  } else {
    overrides = {};
    setOwn(metadata, "localOverrides", overrides);
  }
  const overrideValue = readOwn(overrides, edgeId);
  let override: UnknownRecord;
  if (isRecord(overrideValue)) {
    override = overrideValue;
  } else {
    override = {};
    setOwn(overrides, edgeId, override);
  }
  return override;
}

function anchorTarget(anchor: CanvasAnchor): string | undefined {
  if (anchor.type === "node" || anchor.type === "image") {
    return anchor.nodeId;
  }
  if (anchor.type === "edge") {
    return anchor.edgeId;
  }
  return undefined;
}

function currentEndpointTarget(graph: GraphIndex, edge: UnknownRecord, edgeId: string, end: ConnectorEnd): string | undefined {
  const anchorValue = connectorAnchor(graph.document, edgeId, end);
  if (anchorValue !== ABSENT) {
    const normalized = normalizeAnchor(anchorValue);
    if (normalized.anchor !== undefined) {
      return anchorTarget(normalized.anchor);
    }
    return undefined;
  }
  const nodeId = readOwn(edge, `${end}Node`);
  return safeId(nodeId) ? nodeId : undefined;
}

function policyIds(graph: GraphIndex, edge: UnknownRecord, edgeId: string, end: ConnectorEnd, anchor: CanvasAnchor): readonly string[] {
  const ids = new Set<string>([edgeId]);
  const oldTarget = currentEndpointTarget(graph, edge, edgeId, end);
  const newTarget = anchorTarget(anchor);
  if (oldTarget !== undefined) {
    ids.add(oldTarget);
  }
  if (newTarget !== undefined) {
    ids.add(newTarget);
  }
  return [...ids];
}

/**
 * Return a detached Canvas document with one connector endpoint updated.
 * The caller owns transaction/history integration; this function performs no IO.
 */
export function updateConnectorEndpoint(
  document: Record<string, unknown>,
  input: UpdateConnectorEndpointInput,
): UpdateConnectorEndpointResult {
  const diagnostics: ConnectorEndpointDiagnostic[] = [];
  if (!isRecord(document) || !safeId(input?.edgeId) || (input?.end !== "from" && input?.end !== "to")) {
    return { ok: false, diagnostics: [diagnostic("invalid-input", "Connector endpoint input is invalid.")] };
  }
  const normalized = normalizeAnchor(input.anchor);
  if (!normalized.valid || normalized.anchor === undefined) {
    return { ok: false, diagnostics: [diagnostic("anchor-invalid", "Connector endpoint anchor is invalid.")] };
  }
  const anchor = normalized.anchor;
  const graph = indexGraph(document);
  if (graph === undefined) {
    return { ok: false, diagnostics: [diagnostic("canvas-document-invalid", "Canvas document must contain unique object nodes and edges with safe IDs.")] };
  }
  const edgeId = input.edgeId;
  const edge = graph.edges.get(edgeId);
  if (edge === undefined) {
    return { ok: false, diagnostics: [diagnostic("edge-not-found", `Connector edge ${edgeId} does not exist.`)] };
  }

  const metadata = parseMiroCanvasMetadata(document);
  if (metadata.status === "invalid" || metadata.status === "unsupported") {
    return { ok: false, diagnostics: [diagnostic("metadata-invalid", "Existing miroCanvas metadata is invalid or unsupported.")] };
  }
  const storedAnchorError = validateStoredConnectorAnchors(graph);
  if (storedAnchorError !== undefined) {
    return { ok: false, diagnostics: [storedAnchorError] };
  }

  if (anchor.type === "node" || anchor.type === "image") {
    const node = graph.nodes.get(anchor.nodeId);
    if (node === undefined || (anchor.type === "image" && !isImageNode(node))) {
      return { ok: false, diagnostics: [diagnostic("missing-reference", `Anchor target ${anchor.nodeId} is missing or has the wrong node kind.`)] };
    }
  } else if (anchor.type === "edge") {
    if (!graph.edges.has(anchor.edgeId)) {
      return { ok: false, diagnostics: [diagnostic("missing-reference", `Anchor target edge ${anchor.edgeId} does not exist.`)] };
    }
    if (anchor.edgeId === edgeId) {
      return { ok: false, diagnostics: [diagnostic("self-link", "A connector cannot anchor to itself.")] };
    }
  }

  if (hasEdgeAnchorCycle(graph, { edgeId, end: input.end, anchor })) {
    return { ok: false, diagnostics: [diagnostic("edge-anchor-cycle", "The connector anchor would create an edge-anchor cycle.")] };
  }

  const otherEnd: ConnectorEnd = input.end === "from" ? "to" : "from";
  const candidateNode = anchor.type === "node" || anchor.type === "image" ? anchor.nodeId : undefined;
  const otherNode = logicalNodeTarget(graph, edge, edgeId, otherEnd);
  if (candidateNode !== undefined && otherNode === candidateNode) {
    return { ok: false, diagnostics: [diagnostic("self-link", "A connector cannot link a node to itself.")] };
  }

  const decision = decideInteraction(document, {
    operation: "reconnect",
    elementIds: policyIds(graph, edge, edgeId, input.end, anchor),
  });
  if (!decision.allowed) {
    const code = decision.reason === "review-mode" ? "reconnect-blocked-review"
      : decision.reason === "element-locked" ? "reconnect-blocked-lock"
        : "reconnect-blocked-invalid-policy";
    return { ok: false, diagnostics: [diagnostic(code, `Reconnect is blocked by interaction policy (${decision.reason}).`)] };
  }

  if (anchor.type === "free" || anchor.type === "edge") {
    const fallbackError = validateNativeFallback(graph, edge, input.end);
    if (fallbackError !== undefined) {
      return { ok: false, diagnostics: [fallbackError] };
    }
    diagnostics.push(diagnostic(
      "approximate-native-fallback",
      `The ${input.end} native node endpoint is retained as an approximate plugin-off fallback for the ${anchor.type} anchor.`,
    ));
  }

  const copied = cloneJsonValue(document);
  if (!copied.ok || !isRecord(copied.value)) {
    return { ok: false, diagnostics: [diagnostic("document-copy-failed", "Canvas document could not be deep-copied safely.")] };
  }
  const nextDocument = copied.value;
  const nextGraph = indexGraph(nextDocument);
  const nextEdge = nextGraph?.edges.get(edgeId);
  if (nextGraph === undefined || nextEdge === undefined) {
    return { ok: false, diagnostics: [diagnostic("document-copy-failed", "Copied Canvas graph is invalid.")] };
  }

  if (anchor.type === "node" || anchor.type === "image") {
    setOwn(nextEdge, `${input.end}Node`, anchor.nodeId);
    setOwn(nextEdge, `${input.end}Side`, nearestSide(anchor));
  }
  const fromNode = readOwn(nextEdge, "fromNode");
  const toNode = readOwn(nextEdge, "toNode");
  if (!safeId(fromNode) || !safeId(toNode) || !nextGraph.nodes.has(fromNode) || !nextGraph.nodes.has(toNode)) {
    return { ok: false, diagnostics: [diagnostic("missing-reference", "The resulting native connector endpoints must reference existing nodes.")] };
  }
  if (fromNode === toNode) {
    return { ok: false, diagnostics: [diagnostic("self-link", "The resulting native connector fallback cannot be a self-link.")] };
  }

  const anchorCopy = cloneJsonValue(anchor);
  if (!anchorCopy.ok || !isRecord(anchorCopy.value)) {
    return { ok: false, diagnostics: [diagnostic("anchor-invalid", "Connector anchor could not be copied safely.")] };
  }
  const nextMetadata = mutableMetadata(nextDocument);
  const override = mutableOverride(nextMetadata, edgeId);
  const connectorAnchorsValue = readOwn(override, "connectorAnchors");
  let connectorAnchors: UnknownRecord;
  if (isRecord(connectorAnchorsValue)) {
    connectorAnchors = connectorAnchorsValue;
  } else {
    connectorAnchors = {};
    setOwn(override, "connectorAnchors", connectorAnchors);
  }
  const storedAnchor = readOwn(connectorAnchors, input.end);
  if (storedAnchor === ERROR) {
    return { ok: false, diagnostics: [diagnostic("metadata-invalid", `Stored connector anchor ${edgeId}.${input.end} is malformed.`)] };
  }
  const mergedAnchor = mergeStoredAnchor(storedAnchor === ABSENT ? undefined : storedAnchor, anchorCopy.value);
  if (mergedAnchor === undefined) {
    return { ok: false, diagnostics: [diagnostic("metadata-invalid", `Stored connector anchor ${edgeId}.${input.end} could not be updated safely.`)] };
  }
  setOwn(connectorAnchors, input.end, mergedAnchor);
  return { ok: true, document: nextDocument, diagnostics };
}
