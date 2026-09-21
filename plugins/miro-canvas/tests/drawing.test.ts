import { describe, expect, it } from "vitest";

import {
  distanceToStroke, eraseFromStroke, pointInLasso, recogniseStroke, simplifyPoints, strokeBounds, strokeHitsPoint,
  strokeHitsSegment,
} from "../src/drawing";

describe("simplifyPoints", () => {
  it("keeps only the two ends when every interior point sits within the tolerance of the line between them", () => {
    const points = [
      { x: 0, y: 0 },
      { x: 3, y: 0.1 },
      { x: 6, y: -0.1 },
      { x: 10, y: 0 },
    ];
    expect(simplifyPoints(points, 1)).toEqual([points[0], points[3]]);
  });

  it("keeps an interior point that deviates more than the tolerance from its chord", () => {
    const points = [{ x: 0, y: 0 }, { x: 5, y: 5 }, { x: 10, y: 0 }];
    expect(simplifyPoints(points, 1)).toEqual(points);
  });

  it("returns the input unchanged when there are only two points", () => {
    const points = [{ x: 0, y: 0 }, { x: 1, y: 1 }];
    expect(simplifyPoints(points, 1)).toBe(points);
  });

  it("returns the input unchanged for a non-positive tolerance", () => {
    const points = [{ x: 0, y: 0 }, { x: 5, y: 5 }, { x: 10, y: 0 }];
    expect(simplifyPoints(points, 0)).toBe(points);
    expect(simplifyPoints(points, -3)).toBe(points);
  });

  it("never reorders points, even when some are dropped", () => {
    const points = [
      { x: 0, y: 0 },
      { x: 2, y: 5 },
      { x: 4, y: 0.05 },
      { x: 6, y: -5 },
      { x: 8, y: 0 },
    ];
    expect(simplifyPoints(points, 1)).toEqual([points[0], points[1], points[3], points[4]]);
  });
});

describe("strokeBounds", () => {
  it("covers every point plus half the line width on each side", () => {
    // margin is width / 2 plus an extra unit of padding on every side.
    expect(strokeBounds([{ x: 0, y: 0 }, { x: 10, y: 4 }], 6)).toEqual({ x: -4, y: -4, width: 18, height: 12 });
  });

  it("is at least 1 by 1 even when every point is the same", () => {
    expect(strokeBounds([{ x: 5, y: 5 }, { x: 5, y: 5 }], 0)).toEqual({ x: 4, y: 4, width: 2, height: 2 });
  });

  it("handles an empty list by falling back to the line width, floored at 1", () => {
    expect(strokeBounds([], 0)).toEqual({ x: 0, y: 0, width: 1, height: 1 });
    expect(strokeBounds([], 5)).toEqual({ x: 0, y: 0, width: 5, height: 5 });
  });
});

describe("distanceToStroke", () => {
  it("is zero for a point on the line", () => {
    expect(distanceToStroke([0, 0, 10, 0], { x: 5, y: 0 })).toBe(0);
  });

  it("is the perpendicular distance beside a segment, checked across a polyline", () => {
    expect(distanceToStroke([0, 0, 10, 0, 10, 10], { x: 5, y: 3 })).toBe(3);
  });

  it("is the distance to the nearer end once the point is beyond it", () => {
    expect(distanceToStroke([0, 0, 10, 0], { x: 13, y: 4 })).toBe(5);
  });

  it("is the distance to a single point given as one coordinate pair", () => {
    expect(distanceToStroke([7, 2], { x: 10, y: 6 })).toBe(5);
  });
});

describe("strokeHitsPoint", () => {
  const stroke = { points: [0, 0, 10, 10], width: 2, box: { width: 10, height: 10 } };
  const rect = { x: 0, y: 0, width: 10, height: 10 };

  it("is true when the eraser lands on the line", () => {
    expect(strokeHitsPoint(stroke, rect, { x: 5, y: 5 }, 0)).toBe(true);
  });

  it("is false when the eraser is clearly away from the line", () => {
    expect(strokeHitsPoint(stroke, rect, { x: 9, y: 1 }, 0)).toBe(false);
  });

  it("is true within the tolerance just off the line", () => {
    // Perpendicular distance from (6,4) to the diagonal is sqrt(2) ~= 1.41,
    // past the line's own half-width of 1 but inside a tolerance of 1.
    expect(strokeHitsPoint(stroke, rect, { x: 6, y: 4 }, 0)).toBe(false);
    expect(strokeHitsPoint(stroke, rect, { x: 6, y: 4 }, 1)).toBe(true);
  });

  it("scales the point into the stroke's own box after the node was resized", () => {
    const resized = { x: 100, y: 200, width: 20, height: 20 };
    expect(strokeHitsPoint(stroke, resized, { x: 110, y: 210 }, 0)).toBe(true);
    expect(strokeHitsPoint(stroke, resized, { x: 100, y: 220 }, 0)).toBe(false);
  });

  it("misses a rect with no width or no height", () => {
    expect(strokeHitsPoint(stroke, { x: 0, y: 0, width: 0, height: 10 }, { x: 5, y: 5 }, 1000)).toBe(false);
    expect(strokeHitsPoint(stroke, { x: 0, y: 0, width: 10, height: 0 }, { x: 5, y: 5 }, 1000)).toBe(false);
  });
});

describe("pointInLasso", () => {
  const RING = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 60 }, { x: 0, y: 60 }];

  it("catches what the ring goes round and leaves the rest", () => {
    expect(pointInLasso(RING, { x: 50, y: 30 })).toBe(true);
    expect(pointInLasso(RING, { x: 120, y: 30 })).toBe(false);
    expect(pointInLasso(RING, { x: 50, y: -1 })).toBe(false);
  });

  it("closes the ring from its last point back to its first", () => {
    // Drawn as three corners; the fourth side is the one the lasso implies.
    const open = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 60 }];
    expect(pointInLasso(open, { x: 80, y: 30 })).toBe(true);
    expect(pointInLasso(open, { x: 20, y: 50 })).toBe(false);
  });

  it("is false for a ring that encloses nothing", () => {
    expect(pointInLasso([], { x: 1, y: 1 })).toBe(false);
    expect(pointInLasso([{ x: 0, y: 0 }, { x: 10, y: 10 }], { x: 5, y: 5 })).toBe(false);
  });
});

describe("eraseFromStroke", () => {
  // A straight line kept as its two ends: the eraser must still cut its middle.
  const LINE = [0, 0, 100, 0];

  it("cuts the middle out and leaves the two ends as pieces of one stroke", () => {
    const left = eraseFromStroke(LINE, [], [50, -5, 50, 5], 4)!;
    expect(left.breaks).toHaveLength(1);
    const cut = left.breaks[0]! * 2;
    expect(left.points.slice(0, 2)).toEqual([0, 0]);
    expect(left.points[cut - 2]).toBeLessThan(50);
    expect(left.points[cut]).toBeGreaterThan(50);
    expect(left.points.slice(-2)).toEqual([100, 0]);
  });

  it("keeps the far end when only one end is erased", () => {
    const left = eraseFromStroke(LINE, [], [0, -5, 0, 5], 8)!;
    expect(left.breaks).toEqual([]);
    expect(left.points.slice(-2)).toEqual([100, 0]);
    expect(left.points[0]).toBeGreaterThan(0);
  });

  it("reports nothing left when the whole stroke is erased", () => {
    expect(eraseFromStroke(LINE, [], [0, 0, 100, 0], 5)).toBeUndefined();
  });

  it("erases inside one piece of an already cut stroke and leaves the other", () => {
    const left = eraseFromStroke([0, 0, 40, 0, 60, 0, 100, 0], [2], [20, -2, 20, 2], 3)!;
    // Three pieces now: both halves of the first, and the second untouched.
    expect(left.breaks).toHaveLength(2);
    expect(left.points.slice(-2)).toEqual([100, 0]);
  });
});

describe("recogniseStroke", () => {
  const ring = (radiusX: number, radiusY: number, jitter = 0) => Array.from({ length: 33 }, (_, index) => {
    const angle = (index / 32) * Math.PI * 2;
    const wobble = jitter * (index % 3 === 0 ? 1 : -1);
    return { x: 200 + (radiusX + wobble) * Math.cos(angle), y: 200 + (radiusY + wobble) * Math.sin(angle) };
  });
  const corners = (points: readonly { x: number; y: number }[]) => points.flatMap((point, index) => {
    const next = points[(index + 1) % points.length]!;
    return Array.from({ length: 9 }, (_, step) => ({
      x: point.x + ((next.x - point.x) * step) / 9,
      y: point.y + ((next.y - point.y) * step) / 9,
    }));
  });

  it("reads a nearly straight stroke as a line between its ends", () => {
    const shape = recogniseStroke([{ x: 0, y: 0 }, { x: 60, y: 3 }, { x: 120, y: 1 }])!;
    expect(shape.kind).toBe("line");
    expect(shape.from).toEqual({ x: 0, y: 0 });
    expect(shape.to).toEqual({ x: 120, y: 1 });
  });

  it("reads a rough rectangle, triangle, circle and ellipse by how much of their box they fill", () => {
    const box = corners([{ x: 0, y: 0 }, { x: 200, y: 4 }, { x: 198, y: 120 }, { x: 2, y: 118 }]);
    expect(recogniseStroke([...box, box[0]!])?.kind).toBe("rectangle");
    const triangle = corners([{ x: 0, y: 120 }, { x: 100, y: 0 }, { x: 200, y: 122 }]);
    expect(recogniseStroke([...triangle, triangle[0]!])?.kind).toBe("triangle");
    expect(recogniseStroke(ring(100, 96, 4))?.kind).toBe("circle");
    expect(recogniseStroke(ring(140, 60))?.kind).toBe("ellipse");
  });

  it("says nothing of a mark too small to mean a shape, or of a stroke left open", () => {
    expect(recogniseStroke(ring(6, 6))).toBeUndefined();
    expect(recogniseStroke([{ x: 0, y: 0 }, { x: 80, y: 60 }, { x: 160, y: 0 }, { x: 240, y: 90 }])).toBeUndefined();
    expect(recogniseStroke([{ x: 5, y: 5 }])).toBeUndefined();
  });
});

describe("precise erasing", () => {
  const LINE = [0, 0, 100, 0];

  it("takes only what the eraser covers, however short the cut", () => {
    // An eraser 4 units across over the middle of a 100-unit line.
    const left = eraseFromStroke(LINE, [], [50, -5, 50, 5], 2)!;
    expect(left.changed).toBe(true);
    const cut = left.breaks[0]! * 2;
    const gapStart = left.points[cut - 2]!, gapEnd = left.points[cut]!;
    expect(gapStart).toBeGreaterThan(47);
    expect(gapEnd).toBeLessThan(53);
  });

  it("leaves a stroke it never reached exactly as it was", () => {
    const stroke = [0, 0, 30, 12, 60, 3, 100, 20];
    const left = eraseFromStroke(stroke, [], [0, 80, 100, 80], 3)!;
    expect(left.changed).toBe(false);
    expect(left.points).toEqual(stroke);
  });

  it("keeps an untouched piece of an erased stroke point for point", () => {
    const stroke = [0, 0, 40, 0, 60, 10, 70, 30, 90, 10];
    const left = eraseFromStroke(stroke, [2], [20, -3, 20, 3], 2)!;
    expect(left.changed).toBe(true);
    // The second piece, which the eraser never touched, ends the result as it was.
    expect(left.points.slice(-6)).toEqual([60, 10, 70, 30, 90, 10]);
  });
});

describe("strokeHitsSegment", () => {
  const STROKE = { points: [50, 0, 50, 100], width: 1, box: { width: 100, height: 100 } };
  const RECT = { x: 0, y: 0, width: 100, height: 100 };

  it("catches a thin line swept across between two far points", () => {
    // Neither end of the sweep is near the line; the sweep crosses it.
    expect(strokeHitsSegment(STROKE, RECT, { x: 0, y: 50 }, { x: 100, y: 50 }, 1)).toBe(true);
  });

  it("misses a line the sweep stays clear of", () => {
    expect(strokeHitsSegment(STROKE, RECT, { x: 0, y: 50 }, { x: 40, y: 50 }, 1)).toBe(false);
  });
});
