/**
 * Lines and arrows that native Canvas cannot keep as edges.
 *
 * A line and an arrow are one element - a connector - which arrowheads turn
 * into an arrow.  Whenever both of its ends hold on to nodes it is a native
 * Canvas edge, as every connector between cards is, and shows as one with
 * the plugin off.  Only a connector with an end on empty board, on another
 * connector or on a comment pin has no edge to be, and is kept here, in the
 * plugin's record under `miroCanvas.connectors`, never as a node.  Putting
 * an end down turns one form into the other under the same id.
 */

import {
  normalizeAnchor, resolveAnchor,
  type AnchorGeometry, type AnchorPoint, type CanvasAnchor, type ImageAnchor, type NodeAnchor,
} from "./anchors";
import { moveElbowSegment, placeWaypoint, planRoute, routeBends, type PlannedRoute, type RouteHandle } from "./connector-route";
import { validHeadSize } from "./connector-style";
import { lineBoardPoints } from "./free-line";
import { readLocalLine, type LineRoute } from "./local-items";
import { CONNECTOR_CAPS, effectiveRotation, rotatePoint } from "./source-model";

export interface BoardConnector {
  readonly id: string;
  readonly from: CanvasAnchor;
  readonly to: CanvasAnchor;
  readonly route: LineRoute;
  readonly color: string;
  readonly width: number;
  readonly headSize?: number;
  readonly label?: string;
  /** Where the label sits, as a share of the route's length; absent uses the configured default. */
  readonly labelT?: number;
  readonly startCap: string;
  readonly endCap: string;
  readonly strokeStyle?: "solid" | "dashed" | "dotted";
  readonly waypoints?: readonly AnchorPoint[];
  readonly block?: true;
  readonly [key: string]: unknown;
}

/** Ends drawn by connectors as well as the caps Miro names. */
const CAPS = new Set<string>([...CONNECTOR_CAPS, "circle", "filled_circle", "er_one", "er_many", "er_one_or_many"]);
const ROUTES = new Set<string>(["straight", "elbowed", "curved"]);
const STROKES = new Set<string>(["solid", "dashed", "dotted"]);
const MAX_WAYPOINTS = 64;
const MAX_LABEL_LENGTH = 1024;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const isPoint = (value: unknown): value is AnchorPoint =>
  isRecord(value) && typeof value.x === "number" && Number.isFinite(value.x) && typeof value.y === "number" && Number.isFinite(value.y);
const isSafeId = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 512 && !["__proto__", "prototype", "constructor"].includes(value);
const isFraction = (value: unknown): boolean => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;

/** A stored connector, or undefined when the record is not one this plugin wrote. */
export function readBoardConnector(value: unknown): BoardConnector | undefined {
  if (!isRecord(value) || !isSafeId(value.id)) return undefined;
  if (!normalizeAnchor(value.from).valid || !normalizeAnchor(value.to).valid) return undefined;
  if (typeof value.route !== "string" || !ROUTES.has(value.route)) return undefined;
  if (typeof value.color !== "string" || !/^#[0-9a-f]{6}$/iu.test(value.color)) return undefined;
  if (typeof value.width !== "number" || !Number.isFinite(value.width) || value.width <= 0 || value.width > 1000) return undefined;
  if (value.headSize !== undefined && !validHeadSize(value.headSize)) return undefined;
  if (value.label !== undefined && (typeof value.label !== "string" || value.label.length > MAX_LABEL_LENGTH)) return undefined;
  if (value.labelT !== undefined && !isFraction(value.labelT)) return undefined;
  if (typeof value.startCap !== "string" || !CAPS.has(value.startCap)) return undefined;
  if (typeof value.endCap !== "string" || !CAPS.has(value.endCap)) return undefined;
  if (value.strokeStyle !== undefined && (typeof value.strokeStyle !== "string" || !STROKES.has(value.strokeStyle))) return undefined;
  if (value.block !== undefined && value.block !== true) return undefined;
  if (value.waypoints !== undefined
    && (!Array.isArray(value.waypoints) || value.waypoints.length > MAX_WAYPOINTS || !value.waypoints.every(isPoint))) return undefined;
  return value as unknown as BoardConnector;
}

/**
 * The connectors read from each record of them, with the values they were
 * read from: a large board is asked for its connectors many times a frame,
 * and a record written into in place is read again.
 */
const readRecords = new WeakMap<object, { readonly values: readonly unknown[]; readonly connectors: readonly BoardConnector[] }>();

/** The connectors a board keeps of its own, each under its own id; anything malformed is left out. */
export function boardConnectors(document: unknown): BoardConnector[] {
  const metadata = isRecord(document) && isRecord(document.miroCanvas) ? document.miroCanvas : document;
  if (!isRecord(metadata) || !isRecord(metadata.connectors)) return [];
  const record = metadata.connectors;
  const values = Object.values(record);
  const known = readRecords.get(record);
  if (known !== undefined && known.values.length === values.length && known.values.every((value, index) => value === values[index])) {
    return [...known.connectors];
  }
  const connectors = Object.entries(record).flatMap(([id, value]) => {
    const connector = readBoardConnector(value);
    return connector?.id === id ? [connector] : [];
  });
  readRecords.set(record, { values, connectors });
  return [...connectors];
}

/** How far along a route - as a share of its length - the point nearest `at` lies. */
export function nearestRouteFraction(points: readonly AnchorPoint[], at: AnchorPoint): number {
  const lengths = points.slice(1).map((point, index) => Math.hypot(point.x - points[index]!.x, point.y - points[index]!.y));
  const total = lengths.reduce((sum, length) => sum + length, 0);
  if (total <= 0) return 0.5;
  let before = 0, best = Number.POSITIVE_INFINITY, fraction = 0.5;
  lengths.forEach((length, index) => {
    const start = points[index]!, end = points[index + 1]!;
    if (length > 0) {
      const along = Math.max(0, Math.min(1, ((at.x - start.x) * (end.x - start.x) + (at.y - start.y) * (end.y - start.y)) / (length * length)));
      const distance = Math.hypot(at.x - (start.x + (end.x - start.x) * along), at.y - (start.y + (end.y - start.y) * along));
      if (distance < best) {
        best = distance;
        fraction = (before + along * length) / total;
      }
    }
    before += length;
  });
  return Math.round(fraction * 1000) / 1000;
}

/**
 * The routes of a board's connectors.  A connector held by another is
 * planned after it; one whose target is missing, or which would hold on to
 * itself through others, has no route rather than a made-up one.
 */
export function connectorRoutes(connectors: readonly BoardConnector[], base: AnchorGeometry): Map<string, PlannedRoute> {
  const routes = new Map<string, PlannedRoute>();
  const byId = new Map(connectors.map((connector) => [connector.id, connector]));
  const visiting = new Set<string>();
  const edges = { ...base.edges };
  for (const connector of connectors) delete edges[connector.id];
  const visit = (id: string): void => {
    const connector = byId.get(id);
    if (connector === undefined || routes.has(id) || visiting.has(id)) return;
    visiting.add(id);
    for (const end of [connector.from, connector.to]) {
      if (end.type === "edge" && byId.has(end.edgeId)) visit(end.edgeId);
    }
    const geometry = { ...base, edges };
    const from = resolveAnchor(connector.from, geometry).point, to = resolveAnchor(connector.to, geometry).point;
    if (from !== undefined && to !== undefined) {
      const route = planRoute({ point: from }, { point: to }, connector.route, connector.waypoints);
      routes.set(id, route);
      edges[id] = { start: route.start, end: route.end, points: route.points };
    }
    visiting.delete(id);
  };
  for (const connector of connectors) visit(connector.id);
  return routes;
}

/** A connector moved by an offset: its free ends and its bends move, what holds its other ends does not. */
export function translateConnector(connector: BoardConnector, dx: number, dy: number, id = connector.id): BoardConnector {
  const moved = (anchor: CanvasAnchor): CanvasAnchor => (anchor.type === "free" ? { ...anchor, x: anchor.x + dx, y: anchor.y + dy } : anchor);
  return {
    ...connector, id, from: moved(connector.from), to: moved(connector.to),
    ...(connector.waypoints === undefined ? {} : { waypoints: connector.waypoints.map((point) => ({ x: point.x + dx, y: point.y + dy })) }),
  };
}

/** A connector's route reshaped by one of its grips; both ends stay where they hold. */
export function reshapeBoardConnector(connector: BoardConnector, route: PlannedRoute, grip: RouteHandle, at: AnchorPoint): BoardConnector {
  const bends = routeBends(route);
  const waypoints = grip.kind === "segment"
    ? moveElbowSegment({ point: route.start }, { point: route.end }, bends, grip.index, grip.axis === "x" ? at.x : at.y)
    : placeWaypoint(route.start, route.end, bends, grip.index, at, { insert: grip.kind === "insert" });
  return { ...connector, waypoints };
}

/** The end cap a connector shows: older block arrows stored their implicit head as "none". */
export function connectorEndCap(connector: BoardConnector): string {
  return connector.block === true && connector.startCap === "none" && connector.endCap === "none" ? "stealth" : connector.endCap;
}

/**
 * A connector with a new look.  A block arrow is a straight, solid arrow
 * with one head; asked to be anything else, it becomes an ordinary line and
 * keeps its ends.
 */
export function restyleBoardConnector(connector: BoardConnector, patch: Partial<BoardConnector>): BoardConnector {
  const next = { ...connector, endCap: connectorEndCap(connector), ...patch };
  const oneHead = (next.startCap === "none" && next.endCap === "stealth") || (next.startCap === "stealth" && next.endCap === "none");
  const blockFits = next.route === "straight" && (next.strokeStyle === undefined || next.strokeStyle === "solid") && oneHead;
  if (next.block === true && !blockFits) {
    const { block: _block, ...line } = next;
    return line;
  }
  return next;
}

/** Whether an end holds on to a node - a card, a frame, a picture - which a native edge can join. */
export function heldByNode(anchor: CanvasAnchor): anchor is NodeAnchor | ImageAnchor {
  return anchor.type === "node" || anchor.type === "image";
}

/** Whether a connector can be a native edge: its two ends on two different nodes. */
export function fitsNativeEdge(connector: Pick<BoardConnector, "from" | "to">): boolean {
  return heldByNode(connector.from) && heldByNode(connector.to) && connector.from.nodeId !== connector.to.nodeId;
}

/** The side of a node an end is nearest, which native Canvas draws the edge from. */
export function sideOf(anchor: NodeAnchor | ImageAnchor): "top" | "right" | "bottom" | "left" {
  const distances: readonly ["top" | "right" | "bottom" | "left", number][] = [
    ["top", anchor.v], ["right", 1 - anchor.u], ["bottom", 1 - anchor.v], ["left", anchor.u],
  ];
  return distances.reduce((best, candidate) => (candidate[1] < best[1] ? candidate : best))[0];
}

const roundPoint = (point: AnchorPoint): AnchorPoint => ({ x: Math.round(point.x * 100) / 100, y: Math.round(point.y * 100) / 100 });

/**
 * The native edge and the plugin's record of it that together keep a
 * connector joining two nodes.  Native Canvas draws the edge between the
 * two sides; the record adds where exactly each end holds, the route, the
 * ends, the dashes, the width and the colour, as it does for any edge.
 */
export function nativeEdgeOf(connector: BoardConnector): { readonly edge: Record<string, unknown>; readonly override: Record<string, unknown> } {
  if (!heldByNode(connector.from) || !heldByNode(connector.to)) throw new Error("A native edge needs a node at both ends.");
  const startCap = connector.startCap, endCap = connectorEndCap(connector);
  return {
    edge: {
      id: connector.id,
      fromNode: connector.from.nodeId, fromSide: sideOf(connector.from),
      toNode: connector.to.nodeId, toSide: sideOf(connector.to),
      // Native Canvas draws an arrow at the end unless told otherwise.
      ...(startCap === "none" ? {} : { fromEnd: "arrow" }),
      ...(endCap === "none" ? { toEnd: "none" } : {}),
      ...(connector.label === undefined || connector.label === "" ? {} : { label: connector.label }),
    },
    override: {
      colors: { edge: connector.color },
      connectorAnchors: { from: connector.from, to: connector.to },
      connector: {
        route: connector.route, startCap, endCap, width: connector.width,
        strokeStyle: connector.strokeStyle ?? "solid",
        waypoints: (connector.waypoints ?? []).map(roundPoint),
        ...(connector.headSize === undefined ? {} : { headSize: connector.headSize }),
        ...(connector.labelT === undefined ? {} : { labelT: connector.labelT }),
        ...(connector.block === true ? { block: true } : {}),
      },
    },
  };
}

/** Pure, explicit migration of lines once drawn as nodes.  The exact old record is archived; source data is untouched. */
export function migrateLineNodes(input: Record<string, unknown>): { document: Record<string, unknown>; migrated: string[]; skipped: string[] } {
  const document = JSON.parse(JSON.stringify(input)) as Record<string, unknown>;
  const metadata = isRecord(document.miroCanvas) ? document.miroCanvas : { schemaVersion: 1 };
  const overrides = isRecord(metadata.localOverrides) ? metadata.localOverrides : {};
  const connectors = isRecord(metadata.connectors) ? metadata.connectors : {};
  const archive = isRecord(metadata.connectorMigrationArchive) ? metadata.connectorMigrationArchive : {};
  const migrated: string[] = [], skipped: string[] = [];
  const nodes = Array.isArray(document.nodes) ? document.nodes : [];
  const edges = Array.isArray(document.edges) ? document.edges : [];
  const existing = boardConnectors(input);
  document.nodes = nodes.filter((node) => {
    if (!isRecord(node) || !isSafeId(node.id)) return true;
    const id = node.id;
    const override = overrides[id];
    if (!isRecord(override)) return true;
    const item = isRecord(override.item) ? override.item : override.localItem;
    if (!isRecord(item) || item.type !== "line") return true;
    const line = readLocalLine(item.line);
    const rotation = effectiveRotation(input, id);
    const holdsHere = (anchor: unknown): boolean => isRecord(anchor) && (anchor.type === "node" || anchor.type === "image") && anchor.nodeId === id;
    const held = existing.some((connector) => holdsHere(connector.from) || holdsHere(connector.to))
      || Object.values(overrides).some((entry) => isRecord(entry) && isRecord(entry.connectorAnchors) && Object.values(entry.connectorAnchors).some(holdsHere));
    // A line something else holds on to, or that a native edge ends on, needs
    // a conversion of its own; one that is turned and bent cannot be carried
    // over exactly.  Both are left as they are and reported.
    const joined = edges.some((edge) => isRecord(edge) && (edge.fromNode === id || edge.toNode === id));
    const measurable = [node.x, node.y, node.width, node.height].every((value) => typeof value === "number" && Number.isFinite(value));
    if (line === undefined || connectors[id] !== undefined || joined || held || (rotation !== 0 && line.route !== "straight") || !measurable) {
      skipped.push(id);
      return true;
    }
    const rect = node as unknown as { x: number; y: number; width: number; height: number };
    const centre = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    const points = lineBoardPoints(line, rect).map((point) => rotatePoint(point, centre, rotation));
    const first = points[0], last = points[points.length - 1];
    if (first === undefined || last === undefined || points.length > MAX_WAYPOINTS + 2) {
      skipped.push(id);
      return true;
    }
    const connector = {
      ...line, id, from: { type: "free", ...first }, to: { type: "free", ...last },
      startCap: line.startCap ?? "none", endCap: line.endCap ?? "none", waypoints: points.slice(1, -1),
    };
    if (readBoardConnector(connector) === undefined) {
      skipped.push(id);
      return true;
    }
    archive[id] = { node, override };
    connectors[id] = connector;
    const { localItem: _old, item: _item, rotation: _rotation, ...rest } = override;
    overrides[id] = rest;
    migrated.push(id);
    return false;
  });
  if (migrated.length > 0) document.miroCanvas = { ...metadata, localOverrides: overrides, connectors, connectorMigrationArchive: archive };
  return { document, migrated, skipped };
}
