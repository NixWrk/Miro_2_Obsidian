import { describe, expect, it } from "vitest";

import {
  SHAPE_CLIP_PATHS,
  closestContourPoint,
  contourPoint,
  inscribedInsets,
  shapeOutline,
} from "../src/shape-geometry";
import { LOCAL_SHAPE_KINDS } from "../src/source-model";

describe("shape silhouettes", () => {
  it("knows an outline for every kind the renderer draws", () => {
    const missing = LOCAL_SHAPE_KINDS.filter((kind) => shapeOutline(kind) === undefined);
    expect(missing).toEqual([]);
  });

  it("returns nothing for an unknown kind so the caller keeps the rectangle", () => {
    expect(shapeOutline(undefined)).toBeUndefined();
    expect(shapeOutline("future_hexagon")).toBeUndefined();
  });

  it("parses a polygon silhouette exactly", () => {
    expect(shapeOutline("triangle")).toEqual([
      { x: 50, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 },
    ]);
    expect(Object.keys(SHAPE_CLIP_PATHS)).toContain("star");
  });

  it("keeps every outline inside the normalized box", () => {
    for (const kind of LOCAL_SHAPE_KINDS) {
      for (const point of shapeOutline(kind)!) {
        expect(point.x).toBeGreaterThanOrEqual(-0.001);
        expect(point.x).toBeLessThanOrEqual(100.001);
        expect(point.y).toBeGreaterThanOrEqual(-0.001);
        expect(point.y).toBeLessThanOrEqual(100.001);
      }
    }
  });
});

describe("contour points", () => {
	it("keeps arbitrary points on polygon and curved perimeters", () => {
		const star = shapeOutline("star")!;
		const from = star[2]!, to = star[3]!;
		const arbitrary = { x: from.x + (to.x - from.x) * 0.37, y: from.y + (to.y - from.y) * 0.37 };
		expect(closestContourPoint(star, arbitrary)).toEqual(arbitrary);

		const circle = closestContourPoint(shapeOutline("circle"), { x: 91, y: 73 }, { x: 2, y: 1 });
		expect(Math.hypot(circle.x - 50, circle.y - 50)).toBeCloseTo(50, 0);
	});

  it("meets a triangle on its slanted edge, not on the bounding box", () => {
    const outline = shapeOutline("triangle");
    // The middle of the right-hand side of the box is outside the triangle.
    const right = contourPoint(outline, { x: 100, y: 50 });
    expect(right.x).toBeLessThan(100);
    expect(right.x).toBeCloseTo(75, 0);
    expect(right.y).toBeCloseTo(50, 0);
    // Straight down still reaches the base.
    expect(contourPoint(outline, { x: 50, y: 100 })).toMatchObject({ y: 100 });
  });

  it("meets a circle on its arc", () => {
    const point = contourPoint(shapeOutline("circle"), { x: 100, y: 100 });
    const radius = Math.hypot(point.x - 50, point.y - 50);
    expect(radius).toBeCloseTo(50, 0);
  });

  it("leaves a rectangle's own edges alone", () => {
    for (const target of [{ x: 100, y: 50 }, { x: 50, y: 0 }, { x: 0, y: 50 }]) {
      expect(contourPoint(shapeOutline("rectangle"), target)).toMatchObject(target);
    }
  });

  it("returns the target when there is no usable outline or direction", () => {
    expect(contourPoint(undefined, { x: 7, y: 9 })).toEqual({ x: 7, y: 9 });
    expect(contourPoint(shapeOutline("triangle"), { x: 50, y: 50 })).toEqual({ x: 50, y: 50 });
  });
});

describe("inscribed insets", () => {
  it("reserves nothing in a rectangle", () => {
    expect(inscribedInsets(shapeOutline("rectangle"))).toEqual([0, 0, 0, 0]);
  });

  it("derives a triangle's reserve from its own edges", () => {
    const [top, right, bottom, left] = inscribedInsets(shapeOutline("triangle"))!;
    // A triangle narrows upwards, so the reserve is taken from the top.
    expect(top).toBeGreaterThan(20);
    expect(bottom).toBeLessThan(top);
    expect(left).toBeCloseTo(right, 0);
    // The reserved box must actually fit: at its top row the triangle is
    // exactly as wide as the rectangle claims to be.
    const halfWidth = (100 - left - right) / 2;
    expect(halfWidth).toBeLessThanOrEqual(50 * (1 - top / 100) + 0.6);
  });

  it("reserves a symmetric ring in a circle", () => {
    const [top, right, bottom, left] = inscribedInsets(shapeOutline("circle"))!;
    expect(top).toBeCloseTo(bottom, 0);
    expect(left).toBeCloseTo(right, 0);
    expect(top).toBeGreaterThan(5);
    expect(top).toBeLessThan(30);
  });

  it("returns nothing without a usable outline", () => {
    expect(inscribedInsets(undefined)).toBeUndefined();
    expect(inscribedInsets([{ x: 0, y: 0 }, { x: 1, y: 1 }])).toBeUndefined();
  });
});
