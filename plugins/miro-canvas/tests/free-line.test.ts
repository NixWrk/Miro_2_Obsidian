import { describe, expect, it } from "vitest";

import {
  LINE_KINDS, blockArrowOutline, bowPoint, lineBends, lineBoardPoints, lineFromBoard, lineKind, planLine,
} from "../src/free-line";
import { readLocalLine } from "../src/local-items";

const STYLE = { route: "straight", color: "#1a1a1a", width: 2 } as const;

describe("line kinds", () => {
  it("offers Miro's lines and arrows, the curves and the lines placed point by point", () => {
    expect(LINE_KINDS.map((spec) => spec.kind)).toEqual(["line", "arrow", "elbow", "block", "curve", "polyline", "spline"]);
    expect(lineKind("arrow")).toMatchObject({ route: "straight", endCap: "stealth", input: "drag" });
    expect(lineKind("spline")).toMatchObject({ route: "curved", input: "points" });
    expect(lineKind("rectangle")).toBeUndefined();
  });
});

describe("a line's course", () => {
  it("bows a curve that has nothing but its ends, and leaves other lines to their points", () => {
    const from = { x: 0, y: 0 }, to = { x: 100, y: 0 };
    expect(bowPoint(from, to)).toEqual({ x: 50, y: -20 });
    expect(lineBends("curved", [from, to])).toEqual([{ x: 50, y: -20 }]);
    expect(lineBends("straight", [from, to])).toEqual([]);
    expect(lineBends("curved", [from, { x: 50, y: 30 }, to])).toEqual([{ x: 50, y: 30 }]);
  });

  it("runs through every point it was given, from the first to the last", () => {
    const points = [{ x: 0, y: 0 }, { x: 40, y: 30 }, { x: 80, y: 0 }];
    const straight = planLine("straight", points);
    expect(straight.corners).toEqual(points);
    const curve = planLine("curved", points);
    expect(curve.start).toEqual(points[0]);
    expect(curve.end).toEqual(points[2]);
    expect(curve.path.startsWith("M 0 0")).toBe(true);
    const elbow = planLine("elbowed", [{ x: 0, y: 0 }, { x: 100, y: 60 }]);
    // Every stretch of an elbowed line is level or upright.
    elbow.corners.slice(1).forEach((corner, index) => {
      const before = elbow.corners[index]!;
      expect(corner.x === before.x || corner.y === before.y).toBe(true);
    });
  });
});

describe("storing a line", () => {
  it("wraps the whole course in whole units with room for the width, and maps back to the same points", () => {
    const points = [{ x: 10.5, y: 20 }, { x: 110.25, y: 20 }];
    const { rect, line } = lineFromBoard(points, STYLE);
    expect(rect).toEqual({ x: 5, y: 15, width: 111, height: 10 });
    expect(line.box).toEqual({ width: 111, height: 10 });
    expect(readLocalLine(line)).toEqual(line);
    expect(lineBoardPoints(line, rect)).toEqual(points);
    // A node resized to twice its width stretches the line with it.
    expect(lineBoardPoints(line, { ...rect, width: rect.width * 2 })[1]!.x).toBeCloseTo(5 + (110.25 - 5) * 2);
  });

  it("makes room for a curve's bow and a block arrow's head", () => {
    const curve = lineFromBoard([{ x: 0, y: 0 }, { x: 50, y: -20 }, { x: 100, y: 0 }], { ...STYLE, route: "curved" });
    expect(curve.rect.y).toBeLessThanOrEqual(-20 - 1);
    const block = lineFromBoard([{ x: 0, y: 0 }, { x: 100, y: 0 }], { ...STYLE, width: 16, block: true });
    expect(block.rect.height).toBeGreaterThanOrEqual(48);
  });
});

describe("block arrows", () => {
  it("sizes the head independently while retaining the shaft and short-arrow limit", () => {
    const from = {x: 0, y: 0}, to = {x: 100, y: 0};
    const thin = blockArrowOutline(from, to, 2, 20);
    const thick = blockArrowOutline(from, to, 16, 20);
    expect(thin[2]).toEqual({x: 80, y: -12});
    expect(thick[2]).toEqual(thin[2]);
    expect(thin[0]).not.toEqual(thick[0]);
    expect(blockArrowOutline(from, {x: 10, y: 0}, 2, 20)[2]!.x).toBe(5);
    expect(blockArrowOutline(from, from, 2, 20)).toEqual([from, from, from]);
  });
  it("widens from a slim tail to a head three times as wide, its tip at the end", () => {
    const outline = blockArrowOutline({ x: 0, y: 0 }, { x: 100, y: 0 }, 12);
    expect(outline).toHaveLength(7);
    expect(outline[3]).toEqual({ x: 100, y: 0 });
    const ys = outline.map((point) => point.y);
    expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(36);
    expect(Math.abs(outline[0]!.y - outline[6]!.y)).toBeCloseTo(4);
  });

  it("keeps the head of a short arrow to half its length", () => {
    const outline = blockArrowOutline({ x: 0, y: 0 }, { x: 20, y: 0 }, 16);
    expect(outline[2]!.x).toBeCloseTo(10);
  });
});
