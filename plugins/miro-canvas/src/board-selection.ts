/**
 * What a rectangle or a lasso catches, and where a caught selection goes when
 * it is dragged: cards, native edges, the board's own connectors and comment
 * pins move together, and a connector caught by one end moves only that end.
 */

import { boardConnectors, translateConnector } from "./board-connectors";
import { normalizeAnchor, type AnchorPoint } from "./anchors";
import { buildCanvasAnchorGeometry } from "./connector-endpoints";
import { listCommentThreads, type CommentOrigin } from "./local-comments";

const COMMENT_ID_PREFIX = "miro-comment:";

/** Distinct from graph IDs, including when an imported comment has a node ID. */
export function commentSelectionId(origin: CommentOrigin, id: string): string {
  return `${COMMENT_ID_PREFIX}${origin}:${id}`;
}

export function selectedComment(id: string): { origin: CommentOrigin; id: string; key: string } | undefined {
  if (!id.startsWith(COMMENT_ID_PREFIX)) return undefined;
  const rest = id.slice(COMMENT_ID_PREFIX.length);
  const separator = rest.indexOf(":");
  const origin = rest.slice(0, separator);
  const threadId = rest.slice(separator + 1);
  return separator > 0 && threadId && (origin === "local" || origin === "imported")
    ? { origin, id: threadId, key: `${origin}:${threadId}` } : undefined;
}

interface Box {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

/** The box two opposite corners span, whichever way it was dragged. */
function boxOf(a: AnchorPoint, b: AnchorPoint): Box {
  return { left: Math.min(a.x, b.x), top: Math.min(a.y, b.y), right: Math.max(a.x, b.x), bottom: Math.max(a.y, b.y) };
}

export function pointInSelectionBox(point: AnchorPoint, a: AnchorPoint, b: AnchorPoint): boolean {
  const box = boxOf(a, b);
  return Number.isFinite(point.x) && Number.isFinite(point.y)
    && point.x >= box.left && point.x <= box.right && point.y >= box.top && point.y <= box.bottom;
}

/** A connector belongs to a rectangular selection only if its whole painted route does. */
export function routeContainedInBox(points: readonly AnchorPoint[], a: AnchorPoint, b: AnchorPoint): boolean {
  return points.length >= 2 && points.every((point) => pointInSelectionBox(point, a, b));
}

export interface SelectedRouteEnds {
  readonly from: boolean;
  readonly to: boolean;
  readonly wholeRoute: boolean;
}

/** A marquee selects endpoint handles, not the unlimited span of a crossing line. */
export function routeEndsInBox(points: readonly AnchorPoint[], a: AnchorPoint, b: AnchorPoint): SelectedRouteEnds | undefined {
  if (points.length < 2) return undefined;
  const from = pointInSelectionBox(points[0]!, a, b), to = pointInSelectionBox(points[points.length - 1]!, a, b);
  return from || to ? { from, to, wholeRoute: routeContainedInBox(points, a, b) } : undefined;
}

/** Selection is measured against the painted screen box, not a model centre. */
export function rectIntersectsBox(rect: Box, a: AnchorPoint, b: AnchorPoint, contained = false): boolean {
  if (![rect.left, rect.top, rect.right, rect.bottom].every(Number.isFinite)) return false;
  const box = boxOf(a, b);
  return contained
    ? rect.left >= box.left && rect.right <= box.right && rect.top >= box.top && rect.bottom <= box.bottom
    : rect.left <= box.right && rect.right >= box.left && rect.top <= box.bottom && rect.bottom >= box.top;
}

type Loose = Record<string, any>;

/**
 * The board with a selection moved by (dx, dy): the dragged preview and the
 * write share it, and source records stay untouched.  `routeEnds` names the
 * connectors caught by their ends only; an end that stays behind holds on to
 * what it held, and one carried away from what it held is let go there.
 */
export function translateBoardSelection(document: Record<string, unknown>, ids: readonly string[], dx: number, dy: number,
  routeEnds: Readonly<Record<string, SelectedRouteEnds>> = {}): Record<string, unknown> {
  const next = JSON.parse(JSON.stringify(document)) as Loose;
  const selected = new Set(ids);
  const shift = (point: { x: number; y: number }): { x: number; y: number } => ({ x: point.x + dx, y: point.y + dy });
  const geometry = Object.keys(routeEnds).length > 0 ? buildCanvasAnchorGeometry(document) : undefined;
  // Whether an end goes with the selection because what holds it does.
  const follows = (anchor: unknown, fallback?: string): boolean => {
    const normalized = normalizeAnchor(anchor).anchor;
    if (normalized?.type === "node" || normalized?.type === "image") return selected.has(normalized.nodeId);
    if (normalized?.type === "comment") return selected.has(commentSelectionId(normalized.origin, normalized.commentId));
    if (normalized?.type === "edge") return selected.has(normalized.edgeId);
    return anchor === undefined && fallback !== undefined && selected.has(fallback);
  };

  const comments = ids.map(selectedComment).filter((item): item is NonNullable<typeof item> => item !== undefined);
  if (comments.length > 0) {
    const pins = buildCanvasAnchorGeometry(document).comments ?? {};
    const threads = new Map(listCommentThreads(document).map((thread) => [`${thread.origin}:${thread.id}`, thread]));
    next.miroCanvas ??= {};
    next.miroCanvas.commentPlaces ??= {};
    for (const comment of comments) {
      const point = pins[comment.key], thread = threads.get(comment.key);
      if (point === undefined || thread === undefined) continue;
      const anchor = normalizeAnchor(next.miroCanvas.commentPlaces[comment.key] ?? thread.anchor).anchor;
      // A selected parent carries its child comment already. Keep that link.
      const carried = ((anchor?.type === "node" || anchor?.type === "image") && selected.has(anchor.nodeId))
        || (anchor?.type === "comment" && selected.has(commentSelectionId(anchor.origin, anchor.commentId)));
      if (!carried) next.miroCanvas.commentPlaces[comment.key] = { type: "free", ...shift(point) };
    }
  }

  for (const node of next.nodes ?? []) {
    if (!selected.has(node.id)) continue;
    node.x += dx;
    node.y += dy;
  }

  for (const connector of boardConnectors(next)) {
    if (!selected.has(connector.id)) continue;
    const mask = routeEnds[connector.id];
    if (mask === undefined) {
      next.miroCanvas.connectors[connector.id] = translateConnector(connector, dx, dy);
      continue;
    }
    const route = geometry?.edges?.[connector.id];
    const shifted: Loose = { ...connector };
    for (const end of ["from", "to"] as const) {
      if (!mask[end]) continue;
      const anchor = connector[end], point = end === "from" ? route?.start : route?.end;
      if (anchor.type === "free") shifted[end] = { ...anchor, ...shift(anchor) };
      else if (!follows(anchor) && point !== undefined) shifted[end] = { type: "free", ...shift(point) };
    }
    if (mask.wholeRoute && connector.waypoints !== undefined) shifted.waypoints = connector.waypoints.map(shift);
    next.miroCanvas.connectors[connector.id] = shifted;
  }

  // Native route control points are absolute board coordinates as well.
  for (const edge of next.edges ?? []) {
    if (!selected.has(edge.id) && !(selected.has(edge.fromNode) && selected.has(edge.toNode))) continue;
    const override = next.miroCanvas?.localOverrides?.[edge.id];
    const mask = routeEnds[edge.id];
    if (mask === undefined) {
      if (override?.connector?.waypoints !== undefined) override.connector.waypoints = override.connector.waypoints.map(shift);
      for (const end of ["from", "to"]) {
        const anchor = override?.connectorAnchors?.[end];
        if (anchor?.type === "free") Object.assign(anchor, shift(anchor));
      }
      continue;
    }
    const route = geometry?.edges?.[edge.id];
    const replacements: Loose = {};
    for (const end of ["from", "to"] as const) {
      const point = end === "from" ? route?.start : route?.end;
      if (mask[end] && !follows(override?.connectorAnchors?.[end], edge[`${end}Node`]) && point !== undefined) {
        replacements[end] = { type: "free", ...shift(point) };
      }
    }
    if (Object.keys(replacements).length > 0) {
      next.miroCanvas ??= { schemaVersion: 1 };
      next.miroCanvas.localOverrides ??= {};
      const target = next.miroCanvas.localOverrides[edge.id] ??= {};
      target.connectorAnchors = { ...target.connectorAnchors, ...replacements };
    }
    if (mask.wholeRoute && override?.connector?.waypoints !== undefined) override.connector.waypoints = override.connector.waypoints.map(shift);
  }
  return next;
}
