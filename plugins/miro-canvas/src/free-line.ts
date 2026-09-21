/**
 * Lines drawn on their own: the shape tool's line, arrow, elbow arrow,
 * block arrow, curve, polyline and spline.
 *
 * A line is a connector whose ends hold on to nothing, so it runs along the
 * routes connectors run along and is bent with the same grips.  Its points
 * are stored in the box of the node that carries it; this module maps them
 * to the board and back, and plans the course between them.  Pure, so the
 * renderer, the grips and the tests all read one line the same way.
 */

import { planRoute, type PlannedRoute } from "./connector-route";
import type { LineRoute, LocalLine } from "./local-items";

export interface LinePoint {
  readonly x: number;
  readonly y: number;
}

export interface LineRect extends LinePoint {
  readonly width: number;
  readonly height: number;
}

export type LineKind = "line" | "arrow" | "elbow" | "block" | "curve" | "polyline" | "spline";

export interface LineKindSpec {
  readonly kind: LineKind;
  /** The hover text: the name, then how it is drawn when that is not obvious. */
  readonly label: string;
  readonly route: LineRoute;
  readonly endCap?: string;
  readonly block?: true;
  /** How thick it starts; a block arrow is much thicker than a line. */
  readonly width?: number;
  /** A drag draws from press to release; points are placed a click at a time. */
  readonly input: "drag" | "points";
  /** The picture, in a 24-unit box. */
  readonly icon: string;
}

export const LINE_KINDS: readonly LineKindSpec[] = Object.freeze([
  { kind: "line", label: "Line\nHold Shift to keep it level, upright or at 45°", route: "straight", input: "drag", icon: "M4 20L20 4" },
  { kind: "arrow", label: "Arrow", route: "straight", endCap: "stealth", input: "drag", icon: "M4 20L20 4M11 4H20V13" },
  { kind: "elbow", label: "Elbow arrow", route: "elbowed", endCap: "stealth", input: "drag", icon: "M4 19H12V5H20M16 1L20 5L16 9" },
  {
    kind: "block", label: "Block arrow", route: "straight", block: true, width: 16, input: "drag",
    icon: "M3 17.5L14 10.5L13 8L21 7L17 14.5L15.5 12.3L4 19.5Z",
  },
  { kind: "curve", label: "Curve", route: "curved", input: "drag", icon: "M4 19C14 19 10 5 20 5" },
  {
    kind: "polyline", label: "Polyline\nClick at each corner; double-click or Enter to finish",
    route: "straight", input: "points", icon: "M3 19L9 7L15 15L21 5",
  },
  {
    kind: "spline", label: "Spline\nClick at each point it passes; double-click or Enter to finish",
    route: "curved", input: "points", icon: "M3 18C5 6 10 5 12 12S19 19 21 6",
  },
] satisfies LineKindSpec[]);

/** The spec of a line kind, or undefined for anything else the shape tool makes. */
export function lineKind(kind: string | undefined): LineKindSpec | undefined {
  return LINE_KINDS.find((spec) => spec.kind === kind);
}

/**
 * The outline of a block arrow from `from` to `to`: a shaft that widens from
 * a third of `width` at its tail to `width` where the head starts, and a
 * head three times as wide, as Miro draws it.  A short arrow keeps a head no
 * longer than half of it.
 */
export function blockArrowOutline(from: LinePoint, to: LinePoint, width: number): LinePoint[] {
  const dx = to.x - from.x, dy = to.y - from.y;
  const length = Math.hypot(dx, dy);
  if (length === 0) return [from, from, from];
  const ux = dx / length, uy = dy / length;
  const nx = -uy, ny = ux;
  const head = Math.min(width * 2.5, length / 2);
  const neck = { x: to.x - ux * head, y: to.y - uy * head };
  const at = (base: LinePoint, side: number): LinePoint => ({ x: base.x + nx * side, y: base.y + ny * side });
  return [
    at(from, -width / 6), at(neck, -width / 2), at(neck, -width * 1.5), to,
    at(neck, width * 1.5), at(neck, width / 2), at(from, width / 6),
  ];
}

/** How far a curve with only its two ends bows out, as a share of its length. */
const BOW = 0.2;
/** Room around a line's course inside its node, beyond half its width. */
const LINE_MARGIN = 4;

/**
 * The middle of a curve that has nothing else to pass through: to the left
 * of the way it runs, a fifth of its length out, so it reads as a curve.
 */
export function bowPoint(from: LinePoint, to: LinePoint): LinePoint {
  const dx = to.x - from.x, dy = to.y - from.y;
  return { x: (from.x + to.x) / 2 + dy * BOW, y: (from.y + to.y) / 2 - dx * BOW };
}

/** The points a line bends through, with its ends left out. */
export function lineBends(route: LineRoute, points: readonly LinePoint[]): LinePoint[] {
  const bends = points.slice(1, -1).map((point) => ({ x: point.x, y: point.y }));
  // A curve through nothing but its ends would be straight.
  if (route === "curved" && bends.length === 0 && points.length >= 2) return [bowPoint(points[0]!, points[points.length - 1]!)];
  return bends;
}

/** The course of a line through its points: the route a connector with free ends would take. */
export function planLine(route: LineRoute, points: readonly LinePoint[]): PlannedRoute {
  const from = points[0] ?? { x: 0, y: 0 };
  const to = points[points.length - 1] ?? from;
  return planRoute({ point: from }, { point: to }, route, lineBends(route, points));
}

/** A stored line's points in pairs, in the box it was drawn in. */
export function linePoints(line: LocalLine): LinePoint[] {
  const points: LinePoint[] = [];
  for (let index = 0; index + 1 < line.points.length; index += 2) points.push({ x: line.points[index]!, y: line.points[index + 1]! });
  return points;
}

/** Where a stored line's points are on the board, for the node's rectangle now. */
export function lineBoardPoints(line: LocalLine, rect: LineRect): LinePoint[] {
  const sx = rect.width / line.box.width, sy = rect.height / line.box.height;
  return linePoints(line).map((point) => ({ x: rect.x + point.x * sx, y: rect.y + point.y * sy }));
}

const round = (value: number): number => Math.round(value * 100) / 100;

/**
 * The node rectangle and stored line for a course through board points.
 * The rectangle is whole units, as Canvas keeps a node's, and wraps the
 * whole course - a curve bows past its points - with room for the width.
 */
export function lineFromBoard(
  points: readonly LinePoint[],
  style: Omit<LocalLine, "box" | "points">,
): { readonly rect: LineRect; readonly line: LocalLine } {
  const course = planLine(style.route, points).points;
  const all = [...points, ...course];
  // A block arrow's head is three times as wide as the arrow is thick, and
  // an arrowhead nearly five times: the box keeps them whole.
  const capped = style.startCap !== undefined || style.endCap !== undefined;
  const margin = style.width * (style.block === true ? 1.5 : capped ? 4.8 : 0.5) + LINE_MARGIN;
  const x = Math.floor(Math.min(...all.map((point) => point.x)) - margin);
  const y = Math.floor(Math.min(...all.map((point) => point.y)) - margin);
  const width = Math.max(1, Math.ceil(Math.max(...all.map((point) => point.x)) + margin) - x);
  const height = Math.max(1, Math.ceil(Math.max(...all.map((point) => point.y)) + margin) - y);
  return {
    rect: { x, y, width, height },
    line: Object.freeze({
      ...style,
      box: Object.freeze({ width, height }),
      points: Object.freeze(points.flatMap((point) => [round(point.x - x), round(point.y - y)])),
    }),
  };
}
