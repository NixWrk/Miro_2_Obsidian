/**
 * Freehand strokes: what a pen gesture leaves behind, how much of it is worth
 * keeping, and what the eraser touches.  Pure geometry, so the board, the
 * renderer and the tests all measure a stroke the same way.
 */

/** Below this a stroke is a mark, not a shape anyone meant to draw. */
const MIN_SHAPE_SIZE = 24;

export interface StrokePoint {
  readonly x: number;
  readonly y: number;
}

export interface StrokeBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * The same line with the points that say nothing left out.
 *
 * A pen reports far more points than a line needs; Ramer-Douglas-Peucker
 * keeps the ones that carry its shape, within `tolerance` of the original.
 */
export function simplifyPoints(points: readonly StrokePoint[], tolerance: number): readonly StrokePoint[] {
  if (points.length <= 2 || !(tolerance > 0)) return points;
  const keep = new Array<boolean>(points.length).fill(false);
  keep[0] = true;
  keep[points.length - 1] = true;
  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length > 0) {
    const [first, last] = stack.pop()!;
    let farthest = -1;
    let distance = tolerance;
    for (let index = first + 1; index < last; index += 1) {
      const away = distanceToSegment(points[index]!, points[first]!, points[last]!);
      if (away > distance) {
        distance = away;
        farthest = index;
      }
    }
    if (farthest < 0) continue;
    keep[farthest] = true;
    stack.push([first, farthest], [farthest, last]);
  }
  return points.filter((_, index) => keep[index] === true);
}

/**
 * The box a stroke occupies: every point, half the width of the line on each
 * side, and a unit of slack so a round end is never clipped by rounding.
 */
export function strokeBounds(points: readonly StrokePoint[], width = 0): StrokeBox {
  if (points.length === 0) return { x: 0, y: 0, width: Math.max(width, 1), height: Math.max(width, 1) };
  let minX = Number.POSITIVE_INFINITY, minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY, maxY = Number.NEGATIVE_INFINITY;
  for (const point of points) {
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  }
  const margin = width / 2 + 1;
  return {
    x: minX - margin,
    y: minY - margin,
    width: Math.max(maxX - minX + margin * 2, 1),
    height: Math.max(maxY - minY + margin * 2, 1),
  };
}

/** How far a point lies from a stroke given as x and y in turn. */
export function distanceToStroke(points: readonly number[], point: StrokePoint): number {
  let best = Number.POSITIVE_INFINITY;
  for (let index = 0; index + 3 < points.length; index += 2) {
    const from = { x: points[index]!, y: points[index + 1]! };
    const to = { x: points[index + 2]!, y: points[index + 3]! };
    best = Math.min(best, distanceToSegment(point, from, to));
  }
  if (points.length === 2) best = Math.hypot(point.x - points[0]!, point.y - points[1]!);
  return best;
}

/**
 * Whether the eraser, at a board point, is on a drawing.
 *
 * The stroke was drawn in `box` and the node now occupies `rect`, so the
 * point is measured in the stroke's own space, where its width is stated.
 */
export function strokeHitsPoint(
  stroke: { readonly points: readonly number[]; readonly width: number; readonly box: { readonly width: number; readonly height: number } },
  rect: StrokeBox,
  point: StrokePoint,
  tolerance: number,
): boolean {
  if (!(rect.width > 0) || !(rect.height > 0)) return false;
  const scaleX = stroke.box.width / rect.width;
  const scaleY = stroke.box.height / rect.height;
  const local = { x: (point.x - rect.x) * scaleX, y: (point.y - rect.y) * scaleY };
  // The reach is measured in the stroke's space too, along the thinner axis.
  const reach = stroke.width / 2 + tolerance * Math.min(scaleX, scaleY);
  return distanceToStroke(stroke.points, local) <= reach;
}

/**
 * What is left of a stroke after the eraser passed over part of it.
 *
 * Points within the reach of the eraser's own line go; what remains is kept as
 * separate pieces of the same stroke, since a stroke erased in the middle is
 * two lines afterwards.  Nothing left means the whole drawing goes.
 */
export function eraseFromStroke(
  points: readonly number[],
  breaks: readonly number[],
  eraser: readonly number[],
  reach: number,
): { readonly points: readonly number[]; readonly breaks: readonly number[] } | undefined {
  // A line is kept as the few points that carry its shape, so a long stretch
  // may be one segment.  Stepping along it first lets the eraser cut anywhere,
  // and what survives is reduced again afterwards.
  const step = Math.max(reach / 2, 0.5);
  const pieces: number[][] = [];
  let piece: StrokePoint[] = [];
  const starts = new Set(breaks);
  const finish = (): void => {
    const line = piece.length >= 2 ? simplifyPoints(piece, step / 2) : [];
    if (line.length >= 2) pieces.push(line.flatMap((point) => [point.x, point.y]));
    piece = [];
  };
  let previous: StrokePoint | undefined;
  for (let index = 0; index + 1 < points.length; index += 2) {
    const point = { x: points[index]!, y: points[index + 1]! };
    if (starts.has(index / 2)) {
      finish();
      previous = undefined;
    }
    const walk = previous === undefined ? [point] : along(previous, point, step);
    for (const stop of walk) {
      if (distanceToStroke(eraser, stop) <= reach) finish();
      else piece.push(stop);
    }
    previous = point;
  }
  finish();
  if (pieces.length === 0) return undefined;
  const result: number[] = [];
  const nextBreaks: number[] = [];
  for (const item of pieces) {
    if (result.length > 0) nextBreaks.push(result.length / 2);
    result.push(...item);
  }
  return { points: result, breaks: nextBreaks };
}

/**
 * Whether a point lies inside the ring a lasso drew.
 *
 * The ring is closed from its last point back to its first, and counted by
 * crossings: a point is inside when a ray from it crosses the ring an odd
 * number of times.
 */
export function pointInLasso(ring: readonly StrokePoint[], point: StrokePoint): boolean {
  let inside = false;
  for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index, index += 1) {
    const a = ring[index]!, b = ring[previous]!;
    const straddles = (a.y > point.y) !== (b.y > point.y);
    if (!straddles) continue;
    const crossing = a.x + ((point.y - a.y) / (b.y - a.y)) * (b.x - a.x);
    if (point.x < crossing) inside = !inside;
  }
  return inside;
}

export interface StrokeShape {
  readonly kind: "rectangle" | "circle" | "ellipse" | "triangle" | "line";
  readonly box: StrokeBox;
  readonly from: StrokePoint;
  readonly to: StrokePoint;
}

/**
 * The shape a rough stroke was meant to be, the way Miro's smart drawing
 * reads one, or nothing when the stroke says nothing in particular.
 *
 * A stroke that comes back to where it started is a closed shape, told apart
 * by how much of its box it fills: a rectangle fills nearly all of it, an
 * ellipse about four fifths, a triangle about half.  One that does not close
 * is a line when it hardly bends.
 */
export function recogniseStroke(points: readonly StrokePoint[]): StrokeShape | undefined {
  if (points.length < 2) return undefined;
  const first = points[0]!;
  const last = points[points.length - 1]!;
  const box = strokeBounds(points);
  const diagonal = Math.hypot(box.width, box.height);
  if (diagonal < MIN_SHAPE_SIZE) return undefined;
  const chord = Math.hypot(last.x - first.x, last.y - first.y);
  let length = 0;
  let bend = 0;
  for (let index = 1; index < points.length; index += 1) {
    length += Math.hypot(points[index]!.x - points[index - 1]!.x, points[index]!.y - points[index - 1]!.y);
    bend = Math.max(bend, distanceToSegment(points[index]!, first, last));
  }
  if (length === 0) return undefined;
  if (bend <= Math.max(diagonal * 0.08, 2)) {
    return { kind: "line", box, from: first, to: last };
  }
  // Closed when the ends meet, measured against how far the line travelled.
  if (chord > length * 0.25) return undefined;
  const area = Math.abs(shoelace(points)) / 2;
  const filled = area / Math.max(box.width * box.height, 1);
  const kind = filled > 0.82 ? "rectangle"
    : filled > 0.62
      ? (Math.abs(box.width - box.height) <= Math.max(box.width, box.height) * 0.2 ? "circle" : "ellipse")
      : "triangle";
  return { kind, box, from: first, to: last };
}

function shoelace(points: readonly StrokePoint[]): number {
  let sum = 0;
  for (let index = 0, previous = points.length - 1; index < points.length; previous = index, index += 1) {
    sum += (points[previous]!.x + points[index]!.x) * (points[previous]!.y - points[index]!.y);
  }
  return sum;
}

/** The points along a segment, no further apart than one step, its end last. */
function along(from: StrokePoint, to: StrokePoint, step: number): StrokePoint[] {
  const distance = Math.hypot(to.x - from.x, to.y - from.y);
  const stops = Math.max(1, Math.ceil(distance / step));
  const walk: StrokePoint[] = [];
  for (let index = 1; index <= stops; index += 1) {
    const at = index / stops;
    walk.push({ x: from.x + (to.x - from.x) * at, y: from.y + (to.y - from.y) * at });
  }
  return walk;
}

function distanceToSegment(point: StrokePoint, from: StrokePoint, to: StrokePoint): number {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) return Math.hypot(point.x - from.x, point.y - from.y);
  const along = Math.min(1, Math.max(0, ((point.x - from.x) * dx + (point.y - from.y) * dy) / lengthSquared));
  return Math.hypot(point.x - (from.x + along * dx), point.y - (from.y + along * dy));
}
