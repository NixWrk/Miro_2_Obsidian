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
import { planRoute, type RouteEnd } from "./connector-route";
import { closestContourPoint, contourPoint, shapeOutline, type ShapePoint } from "./shape-geometry";
import { decideInteraction } from "./interaction-policy";
import {
  MIRO_CANVAS_SCHEMA_VERSION,
  parseMiroCanvasMetadata,
} from "./metadata";

type UnknownRecord = Record<string, unknown>;
type ConnectorEnd = "from" | "to";
type NativeSide = "top" | "right" | "bottom" | "left";
export type NodeBoundarySide = NativeSide;

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
    const descriptor = sourceScene.items.get(edgeId);
    // Imported Miro connectors keep the route they were drawn with; a local
    // connector leaves each outline square to it, the way Obsidian draws.
    const local = descriptor?.sourceId === undefined;
    const endpoint = (end: ConnectorEnd): RouteEnd | undefined => {
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
          return point === undefined ? undefined : { point: { x: point.x, y: point.y } };
        }
        const point = resolveAnchor(anchor, { nodes, images }).point;
        if (point === undefined) return undefined;
        const rect = anchor.type === "node" ? nodes[anchor.nodeId] : undefined;
        const facing = local && rect !== undefined && anchor.type === "node"
          ? nativeAnchorEnd(rect, anchor.u, anchor.v, shapeOutline(sourceScene.items.get(anchor.nodeId)?.shape))
          : undefined;
        return { point: { x: point.x, y: point.y }, ...(facing === undefined ? {} : { normal: facing.normal }) };
      }
      const nodeId = readOwn(edge, `${end}Node`);
      const side = readOwn(edge, `${end}Side`);
      if (!safeId(nodeId)) {
        return undefined;
      }
      const rect = nodes[nodeId];
      if (rect === undefined) return undefined;
      const outline = shapeOutline(sourceScene.items.get(nodeId)?.shape);
      const point = sidePoint(rect, side, outline);
      if (point === undefined) return undefined;
      const facing = local ? nativeEdgeEnd(rect, side, outline) : undefined;
      return { point, ...(facing === undefined ? {} : { normal: facing.normal }) };
    };
    const start = endpoint("from");
    const end = endpoint("to");
    resolving.delete(edgeId);
    if (start === undefined || end === undefined) {
      return undefined;
    }
    const route = descriptor?.connector?.shape ?? (local ? "curved" : "straight");
    // The ends and the import flag travel with the route, so a drag can plan it again.
    const geometry = {
      ...planRoute(start, end, route, descriptor?.connector?.waypoints ?? [], { imported: !local }),
      ends: { from: start, to: end },
      imported: !local,
    };
    edges[edgeId] = geometry;
    return geometry;
  };
  for (const edgeId of graph.edges.keys()) {
    resolveEdge(edgeId);
  }
  return { nodes, images, edges };
}

/**
 * Project a point onto the actual silhouette of a node and return a relative
 * anchor that survives resize and rotation. This is the precise endpoint used
 * by the plugin; native Canvas still receives the nearest-side fallback.
 */
export function nodeBoundaryAnchor(
  document: unknown,
  nodeId: string,
  toward: AnchorPoint,
): CanvasAnchor | undefined {
  const rect = buildCanvasAnchorGeometry(document).nodes?.[nodeId];
  if (rect === undefined) return undefined;
  return boundaryAnchorOnRect(nodeId, rect, shapeOutline(buildSourceScene(document).items.get(nodeId)?.shape), toward);
}

/** The point of a node's outline closest to a board point, for a node box already known. */
export function boundaryAnchorOnRect(
  nodeId: string,
  rect: AnchorRect,
  outline: readonly ShapePoint[] | undefined,
  toward: AnchorPoint,
): CanvasAnchor | undefined {
  if (!(rect.width > 0) || !(rect.height > 0) || !Number.isFinite(toward.x) || !Number.isFinite(toward.y)) return undefined;
  const center = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  const local = turn({ x: toward.x - center.x, y: toward.y - center.y }, -rectRotation(rect));
  const target = { x: 50 + (local.x / rect.width) * 100, y: 50 + (local.y / rect.height) * 100 };
  const point = closestContourPoint(outline ?? shapeOutline("rectangle"), target, { x: rect.width / 100, y: rect.height / 100 });
  const clamp = (value: number): number => Math.max(0, Math.min(1, value / 100));
  return { type: "node", nodeId, u: clamp(point.x), v: clamp(point.y) };
}

/** Whether a board point lies within a node's turned box. */
export function insideRect(rect: AnchorRect, point: AnchorPoint): boolean {
  const local = turn({ x: point.x - (rect.x + rect.width / 2), y: point.y - (rect.y + rect.height / 2) }, -rectRotation(rect));
  return Math.abs(local.x) <= rect.width / 2 && Math.abs(local.y) <= rect.height / 2;
}

/** Resolve a dragged handle to the real local silhouette, including non-rectangular shapes. */
export function nodeBoundaryAnchorAtSide(
  document: unknown,
  nodeId: string,
  side: NodeBoundarySide,
  position: number,
): CanvasAnchor | undefined {
  const rect = buildCanvasAnchorGeometry(document).nodes?.[nodeId];
  if (rect === undefined || !(rect.width > 0) || !(rect.height > 0)) return undefined;
  return sideAnchorOnOutline(nodeId, shapeOutline(buildSourceScene(document).items.get(nodeId)?.shape), side, position);
}

/** A point along one side of a node, pulled onto its outline. */
export function sideAnchorOnOutline(
  nodeId: string,
  outline: readonly ShapePoint[] | undefined,
  side: NodeBoundarySide,
  position: number,
): CanvasAnchor | undefined {
  if (!Number.isFinite(position) || position < 0 || position > 1) return undefined;
  const along = position * 100;
  const target: ShapePoint = side === "top" ? { x: along, y: 0 }
    : side === "right" ? { x: 100, y: along }
      : side === "bottom" ? { x: along, y: 100 }
        : { x: 0, y: along };
  const point = contourPoint(outline ?? shapeOutline("rectangle"), target);
  const clamp = (value: number): number => Math.max(0, Math.min(1, value / 100));
  return { type: "node", nodeId, u: clamp(point.x), v: clamp(point.y) };
}

/** A board coordinate to a thousandth of a unit, without a negative zero. */
export function roundCoordinate(value: number): number {
  const rounded = Math.round(value * 1000) / 1000;
  return Object.is(rounded, -0) ? 0 : rounded;
}

/** Outward normals of the four sides, before the node turns. */
const SIDE_NORMALS: Readonly<Record<NativeSide, AnchorPoint>> = {
  top: { x: 0, y: -1 }, right: { x: 1, y: 0 }, bottom: { x: 0, y: 1 }, left: { x: -1, y: 0 },
};

export interface NativeEdgeEnd {
  /** Where the edge meets the node, on its contour, turned with the node. */
  readonly point: AnchorPoint;
  /** The contour's outward direction there, turned with the node. */
  readonly normal: AnchorPoint;
  /** The angle that points a native arrowhead into the node along that direction. */
  readonly arrowAngle: number;
}

function rectRotation(rect: AnchorRect): number {
  return Number.isFinite(rect.rotation) ? rect.rotation ?? 0 : 0;
}

function turn(vector: AnchorPoint, degrees: number): AnchorPoint {
  const radians = degrees * Math.PI / 180;
  return {
    x: vector.x * Math.cos(radians) - vector.y * Math.sin(radians),
    y: vector.x * Math.sin(radians) + vector.y * Math.cos(radians),
  };
}

/**
 * The rotation that turns a native arrowhead to face along `normal`.  Its
 * polygon has the tip at the origin and the base towards +y, which is why an
 * upright node's bottom side uses 0 and its top 180.
 */
function arrowAngleFor(normal: AnchorPoint): number {
  const degrees = roundCoordinate(Math.atan2(-normal.x, normal.y) * 180 / Math.PI);
  return ((degrees % 360) + 360) % 360;
}

/** One end of a native edge on a node that may be turned or drawn as a shape. */
export function nativeEdgeEnd(rect: AnchorRect, side: unknown, outline?: readonly ShapePoint[]): NativeEdgeEnd | undefined {
  if (typeof side !== "string" || !SIDES.has(side as NativeSide)) return undefined;
  const point = sidePoint(rect, side, outline);
  if (point === undefined) return undefined;
  const normal = turn(SIDE_NORMALS[side as NativeSide], rectRotation(rect));
  return { point, normal, arrowAngle: arrowAngleFor(normal) };
}

/**
 * The outward normal of a contour at a point of the normalized box, in board
 * directions for a box of the given size.  Where the point sits on a vertex
 * the normals of the segments meeting there are averaged, so a connector
 * leaves a corner diagonally instead of along whichever side came first.
 */
function contourNormal(outline: readonly ShapePoint[], point: ShapePoint, width: number, height: number): AnchorPoint {
  const sx = width / 100, sy = height / 100;
  const candidates: { readonly distance: number; readonly normal: AnchorPoint }[] = [];
  for (let index = 0; index < outline.length; index += 1) {
    const from = outline[index]!;
    const to = outline[(index + 1) % outline.length]!;
    const dx = (to.x - from.x) * sx, dy = (to.y - from.y) * sy;
    const length = Math.hypot(dx, dy);
    if (length <= 1e-9) continue;
    const tx = (point.x - from.x) * sx, ty = (point.y - from.y) * sy;
    const along = Math.max(0, Math.min(1, (tx * dx + ty * dy) / (length * length)));
    const distance = Math.hypot(tx - dx * along, ty - dy * along);
    candidates.push({ distance, normal: { x: dy / length, y: -dx / length } });
  }
  const best = Math.min(...candidates.map((candidate) => candidate.distance));
  const outward = { x: (point.x - 50) * sx, y: (point.y - 50) * sy };
  let x = 0, y = 0;
  for (const { distance, normal } of candidates) {
    if (distance > best + 1e-6) continue;
    const sign = normal.x * outward.x + normal.y * outward.y < 0 ? -1 : 1;
    x += normal.x * sign;
    y += normal.y * sign;
  }
  const length = Math.hypot(x, y);
  if (length <= 1e-9) {
    const fallback = Math.hypot(outward.x, outward.y);
    return fallback <= 1e-9 ? { x: 0, y: 1 } : { x: outward.x / fallback, y: outward.y / fallback };
  }
  return { x: x / length, y: y / length };
}

/**
 * One end of an edge anchored at an arbitrary point of a node, drawn the way
 * native Canvas draws a side: leaving along the contour's outward normal.
 */
export function nativeAnchorEnd(rect: AnchorRect, u: number, v: number, outline?: readonly ShapePoint[]): NativeEdgeEnd | undefined {
  if (!Number.isFinite(u) || !Number.isFinite(v) || !(rect.width > 0) || !(rect.height > 0)) return undefined;
  const rotation = rectRotation(rect);
  const cx = rect.rotationCenterX ?? rect.x + rect.width / 2;
  const cy = rect.rotationCenterY ?? rect.y + rect.height / 2;
  const offset = turn({ x: rect.x + u * rect.width - cx, y: rect.y + v * rect.height - cy }, rotation);
  const local = contourNormal(outline ?? shapeOutline("rectangle")!, { x: u * 100, y: v * 100 }, rect.width, rect.height);
  const normal = turn(local, rotation);
  return { point: { x: cx + offset.x, y: cy + offset.y }, normal, arrowAngle: arrowAngleFor(normal) };
}

/** The side of a node that faces a board point, judged in the node's own turned frame. */
export function facingSide(document: unknown, nodeId: string, toward: AnchorPoint): NodeBoundarySide | undefined {
  const rect = buildCanvasAnchorGeometry(document).nodes?.[nodeId];
  return rect === undefined ? undefined : facingSideOfRect(rect, toward);
}

/** The side of a node box that faces a board point, judged in the box's own turned frame. */
export function facingSideOfRect(rect: AnchorRect, toward: AnchorPoint): NodeBoundarySide | undefined {
  if (!(rect.width > 0) || !(rect.height > 0) || !Number.isFinite(toward.x) || !Number.isFinite(toward.y)) return undefined;
  const local = turn({ x: toward.x - (rect.x + rect.width / 2), y: toward.y - (rect.y + rect.height / 2) }, -rectRotation(rect));
  const across = local.x / rect.width, down = local.y / rect.height;
  if (Math.abs(across) >= Math.abs(down)) return across >= 0 ? "right" : "left";
  return down >= 0 ? "bottom" : "top";
}

/**
 * An edge end left in free space.  It has no outline to leave, so it faces
 * the other end, and its arrowhead points along the line arriving there.
 */
export function nativeFreeEnd(point: AnchorPoint, toward: AnchorPoint | undefined): NativeEdgeEnd | undefined {
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return undefined;
  const dx = (toward?.x ?? point.x) - point.x, dy = (toward?.y ?? point.y + 1) - point.y;
  const length = Math.hypot(dx, dy);
  const normal = length <= 1e-9 ? { x: 0, y: 1 } : { x: dx / length, y: dy / length };
  return { point: { x: point.x, y: point.y }, normal, arrowAngle: arrowAngleFor(normal) };
}

/** The outward direction of a side of a node, turned with the node. */
export function sideDirection(side: NodeBoundarySide, rotation: number): AnchorPoint {
  return turn(SIDE_NORMALS[side], Number.isFinite(rotation) ? rotation : 0);
}

/**
 * Snap an anchor to the nearest of a node's four standard points when it is
 * within `reach` board units of it.  Standard points sit in the middle of
 * each side, on the contour, which is where a connector lands unless the
 * user deliberately places it elsewhere.
 */
export function snapToStandardPoint(
  anchor: CanvasAnchor,
  rect: AnchorRect,
  outline: readonly ShapePoint[] | undefined,
  reach: number,
): CanvasAnchor {
  if (anchor.type !== "node" || !(reach > 0)) return anchor;
  let best: { readonly u: number; readonly v: number; readonly distance: number } | undefined;
  for (const target of [{ x: 50, y: 0 }, { x: 100, y: 50 }, { x: 50, y: 100 }, { x: 0, y: 50 }]) {
    const point = contourPoint(outline ?? shapeOutline("rectangle"), target);
    const distance = Math.hypot((anchor.u - point.x / 100) * rect.width, (anchor.v - point.y / 100) * rect.height);
    if (best === undefined || distance < best.distance) best = { u: point.x / 100, v: point.y / 100, distance };
  }
  return best !== undefined && best.distance <= reach ? { ...anchor, u: best.u, v: best.v } : anchor;
}

/**
 * The curve native Canvas draws between two edge ends, as a path.
 *
 * It follows Obsidian's own: the line stops 7 units short of a side, where the
 * arrowhead sits - or runs on to the side without one - and leaves along the
 * side's outward normal, its control points half the distance away and kept
 * between 70 and 150 units.  The only difference is that the normals turn
 * with the node, so an edge still meets a rotated side square on.
 */
export function nativeEdgeRoute(from: NativeEdgeEnd, fromArrow: boolean, to: NativeEdgeEnd, toArrow: boolean): string {
  const along = (origin: AnchorPoint, normal: AnchorPoint, distance: number): AnchorPoint =>
    ({ x: origin.x + normal.x * distance, y: origin.y + normal.y * distance });
  const start = along(from.point, from.normal, 7);
  const finish = along(to.point, to.normal, 7);
  const reach = Math.min(150, Math.max(70, Math.hypot(finish.x - start.x, finish.y - start.y) / 2));
  const p = (point: AnchorPoint): string => `${roundCoordinate(point.x)} ${roundCoordinate(point.y)}`;
  let path = `M ${p(start)} C ${p(along(start, from.normal, reach))} ${p(along(finish, to.normal, reach))} ${p(finish)}`;
  if (!fromArrow) path = `M ${p(from.point)} L ${p(start)} ${path}`;
  if (!toArrow) path = `${path} M ${p(finish)} L ${p(to.point)}`;
  return path;
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
