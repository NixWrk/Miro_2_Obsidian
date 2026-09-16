/**
 * The path a connector follows between its two ends, and the edits a person
 * makes to it.
 *
 * A connector is straight, elbowed or curved.  Its ends sit on node outlines,
 * where they know which way the outline faces, or float free.  A person bends
 * it by dragging: a straight or curved connector passes through waypoints,
 * and an elbowed one keeps its bends, each segment dragged square to itself.
 * Everything is in board units and pure, so the renderer, the anchoring
 * geometry and the drag handles all read the same route.
 *
 * Waypoints and bends stay where they were put when a node moves; only the
 * first and last bend of an elbowed route slide to stay square with the ends.
 */

import type { AnchorPoint } from "./anchors";
import type { ConnectorRoute } from "./connector-style";

export interface RouteEnd {
  readonly point: AnchorPoint;
  /** The outward direction of the node's outline at the end; a free end has none. */
  readonly normal?: AnchorPoint;
}

export type RouteSegment =
  | { readonly kind: "line"; readonly to: AnchorPoint }
  | { readonly kind: "curve"; readonly c1: AnchorPoint; readonly c2: AnchorPoint; readonly to: AnchorPoint };

export interface PlannedRoute {
  readonly route: ConnectorRoute;
  readonly start: AnchorPoint;
  readonly end: AnchorPoint;
  readonly segments: readonly RouteSegment[];
  /** The ends and every point the route turns at, in order. */
  readonly corners: readonly AnchorPoint[];
  /** A polyline along the route, for anchors on it, hit tests and the minimap. */
  readonly points: readonly AnchorPoint[];
  /** The SVG path of the route in board units. */
  readonly path: string;
}

/** A place on a route a person can grab. */
export type RouteHandle =
  /** A waypoint of a straight or curved route, moved freely. */
  | { readonly kind: "waypoint"; readonly index: number; readonly point: AnchorPoint }
  /** The middle of a stretch between waypoints; dragging it adds a waypoint at `index`. */
  | { readonly kind: "insert"; readonly index: number; readonly point: AnchorPoint }
  /** The middle of an elbowed segment, dragged square to itself along `axis`. */
  | { readonly kind: "segment"; readonly index: number; readonly point: AnchorPoint; readonly axis: "x" | "y" };

export const MAX_WAYPOINTS = 64;
/** How far an elbowed route runs straight out of a node before it turns. */
export const ELBOW_STUB = 24;
const EPSILON = 1e-6;
const CURVE_STEPS = 16;
/** Obsidian's own curve keeps its control points this near and this far. */
const NATIVE_REACH_MIN = 70;
const NATIVE_REACH_MAX = 150;

const round = (value: number): number => {
  const rounded = Math.round(value * 1000) / 1000;
  return Object.is(rounded, -0) ? 0 : rounded;
};
const same = (a: AnchorPoint, b: AnchorPoint): boolean => Math.abs(a.x - b.x) < EPSILON && Math.abs(a.y - b.y) < EPSILON;
const add = (a: AnchorPoint, b: AnchorPoint, scale = 1): AnchorPoint => ({ x: a.x + b.x * scale, y: a.y + b.y * scale });
const unit = (x: number, y: number, fallback: AnchorPoint = { x: 1, y: 0 }): AnchorPoint => {
  const length = Math.hypot(x, y);
  return length <= EPSILON ? fallback : { x: x / length, y: y / length };
};
const toward = (from: AnchorPoint, to: AnchorPoint): AnchorPoint => unit(to.x - from.x, to.y - from.y);

function cubicAt(from: AnchorPoint, c1: AnchorPoint, c2: AnchorPoint, to: AnchorPoint, t: number): AnchorPoint {
  const s = 1 - t;
  return {
    x: s ** 3 * from.x + 3 * s * s * t * c1.x + 3 * s * t * t * c2.x + t ** 3 * to.x,
    y: s ** 3 * from.y + 3 * s * s * t * c1.y + 3 * s * t * t * c2.y + t ** 3 * to.y,
  };
}

/** The SVG path of a route, with every point mapped first - into a path's own space, say. */
export function routePath(
  start: AnchorPoint,
  segments: readonly RouteSegment[],
  map: (point: AnchorPoint) => AnchorPoint = (point) => point,
): string {
  const at = (point: AnchorPoint): string => {
    const mapped = map(point);
    return `${round(mapped.x)} ${round(mapped.y)}`;
  };
  let path = `M ${at(start)}`;
  for (const segment of segments) {
    path += segment.kind === "line"
      ? ` L ${at(segment.to)}`
      : ` C ${at(segment.c1)} ${at(segment.c2)} ${at(segment.to)}`;
  }
  return path;
}

function finish(route: ConnectorRoute, start: AnchorPoint, segments: readonly RouteSegment[], corners: readonly AnchorPoint[], steps = CURVE_STEPS): PlannedRoute {
  const points: AnchorPoint[] = [start];
  let from = start;
  for (const segment of segments) {
    if (segment.kind === "line") points.push(segment.to);
    else for (let step = 1; step <= steps; step += 1) points.push(cubicAt(from, segment.c1, segment.c2, segment.to, step / steps));
    from = segment.to;
  }
  return { route, start, end: from, segments, corners, points, path: routePath(start, segments) };
}

function lines(route: ConnectorRoute, corners: readonly AnchorPoint[]): PlannedRoute {
  return finish(route, corners[0]!, corners.slice(1).map((to) => ({ kind: "line", to })), corners);
}

/**
 * The route Miro's imported connectors have always had: it turns on the
 * dominant axis at the midpoint and knows nothing of the nodes it joins.
 */
function legacyRoute(start: AnchorPoint, end: AnchorPoint, route: ConnectorRoute): PlannedRoute {
  const horizontal = Math.abs(end.x - start.x) >= Math.abs(end.y - start.y);
  const c1 = horizontal ? { x: (start.x + end.x) / 2, y: start.y } : { x: start.x, y: (start.y + end.y) / 2 };
  const c2 = horizontal ? { x: c1.x, y: end.y } : { x: end.x, y: c1.y };
  if (route === "elbowed") return lines(route, [start, c1, c2, end]);
  if (route === "curved") return finish(route, start, [{ kind: "curve", c1, c2, to: end }], [start, end], 128);
  return lines(route, [start, end]);
}

/** The axis and direction an end leaves along: its outline's facing, or towards `other`. */
function exitOf(end: RouteEnd, other: AnchorPoint): { readonly horizontal: boolean; readonly sign: number } {
  const direction = end.normal ?? toward(end.point, other);
  const horizontal = Math.abs(direction.x) >= Math.abs(direction.y);
  const component = horizontal ? direction.x : direction.y;
  return { horizontal, sign: component < 0 ? -1 : 1 };
}

/** Drop repeated points and points in the middle of a straight run. */
export function simplifyCorners(corners: readonly AnchorPoint[]): AnchorPoint[] {
  const result: AnchorPoint[] = [];
  for (const point of corners) {
    if (result.length > 0 && same(result[result.length - 1]!, point)) continue;
    result.push(point);
    while (result.length >= 3) {
      const [a, b, c] = result.slice(-3) as [AnchorPoint, AnchorPoint, AnchorPoint];
      const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
      const dot = (b.x - a.x) * (c.x - b.x) + (b.y - a.y) * (c.y - b.y);
      if (Math.abs(cross) > EPSILON || dot < 0) break;
      result.splice(result.length - 2, 1);
    }
  }
  return result;
}

/** The bends an elbowed route takes between two ends when nobody has shaped it. */
export function autoBends(from: RouteEnd, to: RouteEnd): AnchorPoint[] {
  const a = from.point, b = to.point;
  const ea = exitOf(from, b), eb = exitOf(to, a);
  // Work in a frame where the start leaves horizontally, then map back.
  const flip = !ea.horizontal;
  const map = (point: AnchorPoint): AnchorPoint => (flip ? { x: point.y, y: point.x } : point);
  const A = map(a), B = map(b);
  const sa = ea.sign, sb = eb.sign;
  const endHorizontal = eb.horizontal !== flip;
  let bends: AnchorPoint[];
  if (endHorizontal) {
    const mx = (A.x + B.x) / 2;
    if ((mx - A.x) * sa > 0 && (mx - B.x) * sb > 0) {
      bends = [{ x: mx, y: A.y }, { x: mx, y: B.y }];
    } else if (sa === sb) {
      const x = sa > 0 ? Math.max(A.x, B.x) + ELBOW_STUB : Math.min(A.x, B.x) - ELBOW_STUB;
      bends = [{ x, y: A.y }, { x, y: B.y }];
    } else {
      const x1 = A.x + sa * ELBOW_STUB, x2 = B.x + sb * ELBOW_STUB;
      const my = Math.abs(A.y - B.y) >= 2 * ELBOW_STUB ? (A.y + B.y) / 2 : Math.min(A.y, B.y) - 2 * ELBOW_STUB;
      bends = [{ x: x1, y: A.y }, { x: x1, y: my }, { x: x2, y: my }, { x: x2, y: B.y }];
    }
  } else if ((B.x - A.x) * sa > 0 && (A.y - B.y) * sb > 0) {
    bends = [{ x: B.x, y: A.y }];
  } else {
    const x1 = A.x + sa * ELBOW_STUB, y2 = B.y + sb * ELBOW_STUB;
    bends = [{ x: x1, y: A.y }, { x: x1, y: y2 }, { x: B.x, y: y2 }];
  }
  return simplifyCorners([A, ...bends, B]).slice(1, -1).map(map);
}

/** Whether the elbowed segment from `a` to `b` runs horizontally; a point-long one takes `fallback`. */
function isHorizontal(a: AnchorPoint, b: AnchorPoint, fallback: boolean): boolean {
  const dx = Math.abs(b.x - a.x), dy = Math.abs(b.y - a.y);
  if (dx < EPSILON && dy < EPSILON) return fallback;
  return dy < EPSILON || (dx >= EPSILON && dx >= dy);
}

/**
 * Stored bends, squared up with ends that may have moved.  The segments
 * alternate, so the first bend shares the start's line and the last bend
 * shares the end's; everything between stays where it was put.
 */
export function squareBends(from: RouteEnd, to: RouteEnd, stored: readonly AnchorPoint[]): AnchorPoint[] {
  const bends = stored.map((point) => ({ x: point.x, y: point.y }));
  if (bends.length === 0) return bends;
  const firstHorizontal = bends.length >= 2
    ? !isHorizontal(bends[0]!, bends[1]!, !exitOf(from, to.point).horizontal)
    : exitOf(from, to.point).horizontal;
  if (firstHorizontal) bends[0]!.y = from.point.y; else bends[0]!.x = from.point.x;
  const lastHorizontal = bends.length % 2 === 0 ? firstHorizontal : !firstHorizontal;
  const last = bends[bends.length - 1]!;
  if (lastHorizontal) last.y = to.point.y; else last.x = to.point.x;
  return bends;
}

function curveThrough(from: RouteEnd, to: RouteEnd, waypoints: readonly AnchorPoint[]): PlannedRoute {
  const corners = [from.point, ...waypoints, to.point];
  const last = corners.length - 1;
  const tangents = corners.map((point, index) => {
    if (index === 0) return from.normal ?? toward(point, corners[1]!);
    if (index === last) {
      return to.normal === undefined ? toward(corners[last - 1]!, point) : { x: -to.normal.x, y: -to.normal.y };
    }
    return unit(corners[index + 1]!.x - corners[index - 1]!.x, corners[index + 1]!.y - corners[index - 1]!.y);
  });
  const segments: RouteSegment[] = [];
  for (let index = 0; index < last; index += 1) {
    const a = corners[index]!, b = corners[index + 1]!;
    const reach = Math.hypot(b.x - a.x, b.y - a.y) / 3;
    segments.push({ kind: "curve", c1: add(a, tangents[index]!, reach), c2: add(b, tangents[index + 1]!, -reach), to: b });
  }
  return finish("curved", from.point, segments, corners);
}

/**
 * The route between two ends.
 *
 * Without waypoints a curved route is Obsidian's own curve - it leaves each
 * outline square to it, its control points half the distance out and kept
 * between 70 and 150 units - and an elbowed route turns where it must to
 * leave and reach each node squarely.  Two free ends with no waypoints keep
 * the route imported Miro connectors have always had.
 */
export function planRoute(
  from: RouteEnd,
  to: RouteEnd,
  route: ConnectorRoute,
  waypoints: readonly AnchorPoint[] = [],
): PlannedRoute {
  const points = waypoints.slice(0, MAX_WAYPOINTS);
  if (points.length === 0 && from.normal === undefined && to.normal === undefined) {
    return legacyRoute(from.point, to.point, route);
  }
  if (route === "straight") return lines(route, [from.point, ...points, to.point]);
  if (route === "elbowed") {
    const bends = points.length > 0 ? squareBends(from, to, points) : autoBends(from, to);
    return lines(route, [from.point, ...bends, to.point]);
  }
  if (points.length > 0) return curveThrough(from, to, points);
  const distance = Math.hypot(to.point.x - from.point.x, to.point.y - from.point.y);
  const reach = Math.min(NATIVE_REACH_MAX, Math.max(NATIVE_REACH_MIN, distance / 2));
  const n1 = from.normal ?? toward(from.point, to.point);
  const n2 = to.normal ?? toward(to.point, from.point);
  return finish(route, from.point, [{
    kind: "curve", c1: add(from.point, n1, reach), c2: add(to.point, n2, reach), to: to.point,
  }], [from.point, to.point]);
}

/** The waypoints or bends a route passes through, without its ends. */
export function routeBends(route: PlannedRoute): AnchorPoint[] {
  return route.corners.slice(1, -1).map((point) => ({ x: point.x, y: point.y }));
}

/** Where a person can grab a route to reshape it. */
export function routeHandles(route: PlannedRoute): RouteHandle[] {
  const handles: RouteHandle[] = [];
  const corners = route.corners;
  if (route.route === "elbowed") {
    for (let index = 0; index + 1 < corners.length; index += 1) {
      const a = corners[index]!, b = corners[index + 1]!;
      if (same(a, b)) continue;
      const horizontal = isHorizontal(a, b, true);
      handles.push({
        kind: "segment", index, axis: horizontal ? "y" : "x",
        point: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
      });
    }
    return handles;
  }
  for (let index = 0; index + 1 < corners.length; index += 1) {
    const segment = route.segments[index];
    const a = corners[index]!;
    const middle = segment?.kind === "curve"
      ? cubicAt(a, segment.c1, segment.c2, segment.to, 0.5)
      : { x: (a.x + corners[index + 1]!.x) / 2, y: (a.y + corners[index + 1]!.y) / 2 };
    handles.push({ kind: "insert", index, point: middle });
    if (index > 0) handles.push({ kind: "waypoint", index: index - 1, point: a });
  }
  return handles;
}

/** Distance from a point to the segment between two others. */
function distanceToSegment(point: AnchorPoint, a: AnchorPoint, b: AnchorPoint): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const length = dx * dx + dy * dy;
  const t = length <= EPSILON ? 0 : Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / length));
  return Math.hypot(point.x - (a.x + dx * t), point.y - (a.y + dy * t));
}

/**
 * Waypoints after one is dragged to `point`, or added there when `insert` is
 * set.  A waypoint dropped back onto the straight line between its
 * neighbours is no longer a bend and goes away.
 */
export function placeWaypoint(
  from: AnchorPoint,
  to: AnchorPoint,
  waypoints: readonly AnchorPoint[],
  index: number,
  point: AnchorPoint,
  options: { readonly insert: boolean; readonly straighten?: number },
): AnchorPoint[] {
  const result = waypoints.map((item) => ({ x: item.x, y: item.y }));
  const position = Math.max(0, Math.min(result.length, index));
  if (options.insert) {
    if (result.length >= MAX_WAYPOINTS) return result;
    result.splice(position, 0, { x: point.x, y: point.y });
  } else if (position < result.length) {
    result[position] = { x: point.x, y: point.y };
  } else {
    return result;
  }
  const tolerance = options.straighten ?? 0;
  if (tolerance > 0) {
    const before = position === 0 ? from : result[position - 1]!;
    const after = position + 1 >= result.length ? to : result[position + 1]!;
    if (distanceToSegment(point, before, after) <= tolerance) result.splice(position, 1);
  }
  return result;
}

export function removeWaypoint(waypoints: readonly AnchorPoint[], index: number): AnchorPoint[] {
  return waypoints.filter((_, position) => position !== index).map((item) => ({ x: item.x, y: item.y }));
}

/**
 * The bends of an elbowed route after segment `index` is dragged so that it
 * runs through `value` on its perpendicular axis.  A segment that leaves or
 * reaches a node cannot move its end, so it first gains a short stub there
 * and the part beyond the stub moves instead.
 */
export function moveElbowSegment(
  from: RouteEnd,
  to: RouteEnd,
  bends: readonly AnchorPoint[],
  index: number,
  value: number,
): AnchorPoint[] {
  const corners = [from.point, ...bends, to.point].map((point) => ({ x: point.x, y: point.y }));
  let segment = Math.max(0, Math.min(corners.length - 2, index));
  const horizontal = isHorizontal(corners[segment]!, corners[segment + 1]!, exitOf(from, to.point).horizontal);
  const stubFrom = (base: AnchorPoint, next: AnchorPoint, end: RouteEnd): AnchorPoint => {
    // Along the segment's own axis, the way the segment already runs.
    const run = horizontal ? next.x - base.x : next.y - base.y;
    const sign = Math.abs(run) > EPSILON ? Math.sign(run) : (end.normal === undefined ? 1 : Math.sign(horizontal ? end.normal.x : end.normal.y) || 1);
    const reach = Math.min(ELBOW_STUB, Math.abs(run) > EPSILON ? Math.abs(run) / 2 : ELBOW_STUB);
    return horizontal ? { x: base.x + sign * reach, y: base.y } : { x: base.x, y: base.y + sign * reach };
  };
  if (segment === corners.length - 2) {
    const last = corners[corners.length - 1]!;
    const stub = stubFrom(last, corners[corners.length - 2]!, to);
    corners.splice(corners.length - 1, 0, { ...stub }, { ...stub });
    segment = corners.length - 4;
  }
  if (segment === 0) {
    const stub = stubFrom(corners[0]!, corners[1]!, from);
    corners.splice(1, 0, { ...stub }, { ...stub });
    segment = 2;
  }
  const a = corners[segment]!, b = corners[segment + 1]!;
  if (horizontal) {
    a.y = value;
    b.y = value;
  } else {
    a.x = value;
    b.x = value;
  }
  return corners.slice(1, -1);
}
