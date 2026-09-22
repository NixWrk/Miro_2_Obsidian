/** Independent board connectors. Arrowheads are style, never an element type. */
import { normalizeAnchor, resolveAnchor, type CanvasAnchor, type AnchorGeometry, type AnchorPoint } from "./anchors";
import { planRoute, type PlannedRoute } from "./connector-route";
import { readLocalLine, type LineRoute } from "./local-items";
import { lineBoardPoints } from "./free-line";
import { CONNECTOR_CAPS, effectiveRotation, rotatePoint } from "./source-model";

export interface BoardConnector {
  readonly id: string;
  readonly from: CanvasAnchor;
  readonly to: CanvasAnchor;
  readonly route: LineRoute;
  readonly color: string;
  readonly width: number;
  readonly startCap: string;
  readonly endCap: string;
  readonly strokeStyle?: "solid" | "dashed" | "dotted";
  readonly waypoints?: readonly AnchorPoint[];
  readonly block?: true;
  readonly [key: string]: unknown;
}
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const point = (v: unknown): v is AnchorPoint => record(v) && typeof v.x === "number" && Number.isFinite(v.x) && typeof v.y === "number" && Number.isFinite(v.y);
const safeId = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 512 && !["__proto__", "prototype", "constructor"].includes(v);
export function readBoardConnector(v: unknown): BoardConnector | undefined {
  if (!record(v) || !safeId(v.id) || !normalizeAnchor(v.from).valid || !normalizeAnchor(v.to).valid
    || !["straight", "elbowed", "curved"].includes(v.route as string)
    || typeof v.color !== "string" || !/^#[0-9a-f]{6}$/i.test(v.color)
    || typeof v.width !== "number" || !Number.isFinite(v.width) || v.width <= 0 || v.width > 1000
    || ![...CONNECTOR_CAPS, "circle", "filled_circle", "er_one", "er_many", "er_one_or_many"].includes(v.startCap as never)
    || ![...CONNECTOR_CAPS, "circle", "filled_circle", "er_one", "er_many", "er_one_or_many"].includes(v.endCap as never)
    || (v.strokeStyle !== undefined && !["solid", "dashed", "dotted"].includes(v.strokeStyle as string))
    || (v.block !== undefined && v.block !== true)
    || (v.waypoints !== undefined && (!Array.isArray(v.waypoints) || v.waypoints.length > 64 || !v.waypoints.every(point)))) return undefined;
  return v as unknown as BoardConnector;
}
export function boardConnectors(document: unknown): BoardConnector[] {
  const metadata = record(document) && record(document.miroCanvas) ? document.miroCanvas : document;
  if (!record(metadata) || !record(metadata.connectors)) return [];
  return Object.entries(metadata.connectors).flatMap(([id, value]) => {
    const connector = readBoardConnector(value);
    return connector?.id === id ? [connector] : [];
  });
}
/** Resolve a dependency DAG; cycles/missing targets are reported by absence, not fabricated points. */
export function connectorRoutes(connectors: readonly BoardConnector[], base: AnchorGeometry): Map<string, PlannedRoute> {
  const result = new Map<string, PlannedRoute>();
  const byId = new Map(connectors.map(c => [c.id, c]));
  const visiting = new Set<string>();
  const edges = { ...base.edges };
  for (const c of connectors) delete edges[c.id];
  const visit = (id: string): void => {
    if (result.has(id) || visiting.has(id)) return;
    const c = byId.get(id); if (!c) return;
    visiting.add(id);
    for (const end of [c.from, c.to]) if (end.type === "edge" && byId.has(end.edgeId)) visit(end.edgeId);
    const geometry = { ...base, edges };
    const from = resolveAnchor(c.from, geometry).point, to = resolveAnchor(c.to, geometry).point;
    if (from && to) {
      const route = planRoute({ point: from }, { point: to }, c.route, c.waypoints);
      result.set(id, route); edges[id] = { start: route.start, end: route.end, points: route.points };
    }
    visiting.delete(id);
  };
  for (const c of connectors) visit(c.id);
  return result;
}
export function translateConnector(c: BoardConnector, dx: number, dy: number, id = c.id): BoardConnector {
  const end = (a: CanvasAnchor): CanvasAnchor => a.type === "free" ? { ...a, x: a.x + dx, y: a.y + dy } : a;
  return { ...c, id, from: end(c.from), to: end(c.to), ...(c.waypoints ? { waypoints: c.waypoints.map(p => ({ x:p.x+dx, y:p.y+dy })) } : {}) };
}
/** Older block arrows stored their implicit end head as "none". */
export function connectorEndCap(c: BoardConnector): string {
  return c.block && c.startCap === "none" && c.endCap === "none" ? "stealth" : c.endCap;
}

/** Unsupported block styles become ordinary connectors without losing anchors. */
export function restyleBoardConnector(c: BoardConnector, patch: Partial<BoardConnector>): BoardConnector {
  const next = { ...c, endCap: connectorEndCap(c), ...patch };
  if (next.block && (next.route !== "straight" || next.strokeStyle && next.strokeStyle !== "solid"
    || !((next.startCap === "none" && next.endCap === "stealth") || (next.startCap === "stealth" && next.endCap === "none")))) {
    const { block: _block, ...line } = next;
    return line;
  }
  return next;
}
/** Pure, explicit migration. Archive the exact old record; do not modify source evidence. */
export function migrateLineNodes(input: Record<string, unknown>): { document: Record<string, unknown>; migrated: string[]; skipped: string[] } {
  const document = JSON.parse(JSON.stringify(input)) as Record<string, unknown>;
  const metadata = record(document.miroCanvas) ? document.miroCanvas : { schemaVersion: 1 };
  const overrides = record(metadata.localOverrides) ? metadata.localOverrides : {};
  const connectors = record(metadata.connectors) ? metadata.connectors : {};
  const archive = record(metadata.connectorMigrationArchive) ? metadata.connectorMigrationArchive : {};
  const migrated: string[] = [], skipped: string[] = [];
  const nodes = Array.isArray(document.nodes) ? document.nodes : [];
  const edges = Array.isArray(document.edges) ? document.edges : [];
  document.nodes = nodes.filter(node => {
    if (!record(node) || !safeId(node.id)) return true;
    const override = overrides[node.id];
    if (!record(override)) return true;
    const item=record(override.item)?override.item:override.localItem;
    if (!record(item) || item.type !== "line") return true;
    const line = readLocalLine(item.line);
    const rotation=effectiveRotation(input,node.id);
    const referencesNode=(a:unknown):boolean=>record(a)&&(a.type==="node"||a.type==="image")&&a.nodeId===node.id;
    const referenced=boardConnectors(input).some(c=>referencesNode(c.from)||referencesNode(c.to))
      || Object.values(overrides).some(o=>record(o)&&record(o.connectorAnchors)&&Object.values(o.connectorAnchors).some(referencesNode));
    // Native edges attached to this legacy node need a separate conversion; do not drop links.
    if (!line || connectors[node.id] || edges.some(e => record(e) && (e.fromNode === node.id || e.toNode === node.id))
      || referenced || rotation !== 0 && line.route !== "straight"
      || ![node.x,node.y,node.width,node.height].every(v => typeof v === "number" && Number.isFinite(v))) { skipped.push(node.id); return true; }
    const rect=node as unknown as {x:number;y:number;width:number;height:number};
    const center={x:rect.x+rect.width/2,y:rect.y+rect.height/2};
    const points = lineBoardPoints(line, rect).map(p=>rotatePoint(p,center,rotation));
    const first = points[0], last = points[points.length-1];
    if (!first || !last || points.length > 66) { skipped.push(node.id); return true; }
    const connector = { ...line, id:node.id, from:{type:"free",...first}, to:{type:"free",...last},
      startCap:line.startCap ?? "none", endCap:line.endCap ?? "none", waypoints:points.slice(1,-1) };
    if (!readBoardConnector(connector)) { skipped.push(node.id); return true; }
    archive[node.id] = { node, override };
    connectors[node.id] = connector;
    const { localItem: _old, item: _item, rotation: _rotation, ...rest } = override;
    overrides[node.id] = rest;
    migrated.push(node.id); return false;
  });
  if (migrated.length) document.miroCanvas = { ...metadata, localOverrides:overrides, connectors, connectorMigrationArchive:archive };
  return { document, migrated, skipped };
}
