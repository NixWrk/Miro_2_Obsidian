import type { AnchorEdgeGeometry, AnchorPoint, EdgeAnchor } from "./anchors";

/** Closest point on the rendered polyline, parameterized by its arc length. */
export function edgeLanding(edgeId: string, geometry: AnchorEdgeGeometry, point: AnchorPoint):
  { anchor: EdgeAnchor; board: AnchorPoint; distance: number } | undefined {
  const points = geometry.points ?? (geometry.start && geometry.end ? [geometry.start, geometry.end] : []);
  if (points.length < 2 || points.some(p => !Number.isFinite(p.x) || !Number.isFinite(p.y))) return undefined;
  const lengths = points.slice(1).map((p, i) => Math.hypot(p.x - points[i]!.x, p.y - points[i]!.y));
  const total = lengths.reduce((sum, length) => sum + length, 0);
  if (!(total > 0)) return undefined;
  let traversed = 0;
  let best: { anchor: EdgeAnchor; board: AnchorPoint; distance: number } | undefined;
  for (let i = 0; i < lengths.length; i++) {
    const a = points[i]!, b = points[i + 1]!, length = lengths[i]!;
    const ratio = length === 0 ? 0 : Math.max(0, Math.min(1, ((point.x-a.x)*(b.x-a.x) + (point.y-a.y)*(b.y-a.y))/(length*length)));
    const board = { x: a.x+(b.x-a.x)*ratio, y: a.y+(b.y-a.y)*ratio };
    const distance = Math.hypot(board.x-point.x, board.y-point.y);
    if (best === undefined || distance < best.distance) best = {
      anchor: { type: "edge", edgeId, t: (traversed+length*ratio)/total }, board, distance,
    };
    traversed += length;
  }
  return best;
}
