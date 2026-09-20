import { describe, expect, it } from "vitest";

import { distanceToStroke, pointInLasso, simplifyPoints, strokeBounds, strokeHitsPoint } from "../src/drawing";

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
