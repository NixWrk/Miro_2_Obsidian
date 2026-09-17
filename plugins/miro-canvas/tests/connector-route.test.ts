import { describe, expect, it } from "vitest";

import {
  ELBOW_STUB,
  autoBends,
  moveElbowSegment,
  placeWaypoint,
  planRoute,
  removeWaypoint,
  routeBends,
  routeHandles,
  routePath,
  simplifyCorners,
  squareBends,
  type RouteEnd,
} from "../src/connector-route";

const right = (x: number, y: number): RouteEnd => ({ point: { x, y }, normal: { x: 1, y: 0 } });
const left = (x: number, y: number): RouteEnd => ({ point: { x, y }, normal: { x: -1, y: 0 } });
const up = (x: number, y: number): RouteEnd => ({ point: { x, y }, normal: { x: 0, y: -1 } });
const down = (x: number, y: number): RouteEnd => ({ point: { x, y }, normal: { x: 0, y: 1 } });
const free = (x: number, y: number): RouteEnd => ({ point: { x, y } });

/** Every segment of an elbowed route runs along an axis. */
function square(corners: readonly { x: number; y: number }[]): boolean {
  return corners.slice(1).every((point, index) => point.x === corners[index]!.x || point.y === corners[index]!.y);
}

describe("connector routes", () => {
  it("keeps the route imported Miro connectors have always had", () => {
    const imported = { imported: true };
    const straight = planRoute(free(100, 16), free(325, 260), "straight", [], imported);
    expect(straight.path).toBe("M 100 16 L 325 260");
    const elbowed = planRoute(free(100, 16), free(325, 260), "elbowed", [], imported);
    expect(elbowed.path).toBe("M 100 16 L 100 138 L 325 138 L 325 260");
    expect(elbowed.points).toHaveLength(4);
    const curved = planRoute(free(100, 16), free(325, 260), "curved", [], imported);
    expect(curved.path).toBe("M 100 16 C 100 138 325 138 325 260");
    expect(curved.points).toHaveLength(129);
    // Once bent, an imported connector follows its waypoints like any other.
    expect(planRoute(free(0, 0), free(100, 0), "straight", [{ x: 50, y: 50 }], imported).path).toBe("M 0 0 L 50 50 L 100 0");
  });

  it("curves a local connector between free ends along the line joining them", () => {
    const route = planRoute(free(0, 0), free(300, 0), "curved");
    expect(route.path).toBe("M 0 0 C 150 0 150 0 300 0");
    expect(route.points.every((point) => point.y === 0)).toBe(true);
  });

  it("draws Obsidian's own curve between two outlines", () => {
    const route = planRoute(right(0, 0), left(400, 100), "curved");
    // Half the distance out, kept between 70 and 150.
    expect(route.path).toBe("M 0 0 C 150 0 250 100 400 100");
    const near = planRoute(right(0, 0), left(60, 0), "curved");
    expect(near.path).toBe("M 0 0 C 70 0 -10 0 60 0");
    expect(route.points[0]).toEqual({ x: 0, y: 0 });
    expect(route.points[route.points.length - 1]).toEqual({ x: 400, y: 100 });
  });

  it("runs a straight route through its waypoints", () => {
    const route = planRoute(right(0, 0), left(300, 0), "straight", [{ x: 100, y: 50 }, { x: 200, y: -50 }]);
    expect(route.path).toBe("M 0 0 L 100 50 L 200 -50 L 300 0");
    expect(routeBends(route)).toEqual([{ x: 100, y: 50 }, { x: 200, y: -50 }]);
  });

  it("curves smoothly through waypoints and meets each outline square on", () => {
    const route = planRoute(right(0, 0), up(300, 200), "curved", [{ x: 150, y: -40 }]);
    expect(route.segments).toHaveLength(2);
    const [first, second] = route.segments;
    if (first?.kind !== "curve" || second?.kind !== "curve") throw new Error("expected curves");
    // Leaves along the start's facing, arrives against the end's facing.
    expect(first.c1.y).toBeCloseTo(0);
    expect(first.c1.x).toBeGreaterThan(0);
    expect(second.c2.x).toBeCloseTo(300);
    expect(second.c2.y).toBeLessThan(200);
    // The tangent through the waypoint is shared by both sides.
    const inbound = { x: 150 - first.c2.x, y: -40 - first.c2.y };
    const outbound = { x: second.c1.x - 150, y: second.c1.y + 40 };
    expect(inbound.x * outbound.y - inbound.y * outbound.x).toBeCloseTo(0);
    expect(route.points.some((point) => Math.abs(point.x - 150) < 1e-9 && Math.abs(point.y + 40) < 1e-9)).toBe(true);
  });

  describe("elbowed routes", () => {
    it("turns once at the middle between facing sides", () => {
      const route = planRoute(right(0, 0), left(200, 100), "elbowed");
      expect(route.corners).toEqual([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 200, y: 100 }]);
    });

    it("runs straight between aligned facing sides", () => {
      expect(planRoute(right(0, 50), left(200, 50), "elbowed").path).toBe("M 0 50 L 200 50");
    });

    it("takes one corner from a side to a top when the corner lies ahead of both", () => {
      expect(autoBends(right(0, 0), up(200, 100))).toEqual([{ x: 200, y: 0 }]);
      expect(autoBends(down(0, 0), left(200, 100))).toEqual([{ x: 0, y: 100 }]);
    });

    it("steps out of both nodes when they face away from each other", () => {
      const route = planRoute(right(200, 0), left(0, 100), "elbowed");
      expect(square(route.corners)).toBe(true);
      expect(route.corners[1]).toEqual({ x: 200 + ELBOW_STUB, y: 0 });
      expect(route.corners[route.corners.length - 2]).toEqual({ x: -ELBOW_STUB, y: 100 });
      const sameWay = planRoute(right(0, 0), right(100, 100), "elbowed");
      expect(sameWay.corners).toEqual([{ x: 0, y: 0 }, { x: 124, y: 0 }, { x: 124, y: 100 }, { x: 100, y: 100 }]);
      const around = planRoute(right(100, 0), up(0, 100), "elbowed");
      expect(square(around.corners)).toBe(true);
      expect(around.corners).toHaveLength(5);
    });

    it("keeps shaped bends and squares the outer ones with moved ends", () => {
      const bends = [{ x: 60, y: 0 }, { x: 60, y: 150 }, { x: 180, y: 150 }, { x: 180, y: 100 }];
      const moved = squareBends(right(0, 20), left(250, 130), bends);
      expect(moved).toEqual([{ x: 60, y: 20 }, { x: 60, y: 150 }, { x: 180, y: 150 }, { x: 180, y: 130 }]);
      const route = planRoute(right(0, 20), left(250, 130), "elbowed", bends);
      expect(square(route.corners)).toBe(true);
      const single = squareBends(right(0, 30), up(200, 150), [{ x: 180, y: 0 }]);
      expect(single).toEqual([{ x: 200, y: 30 }]);
    });

    it("drags a middle segment square to itself", () => {
      const from = right(0, 0), to = left(200, 100);
      const bends = autoBends(from, to);
      const moved = moveElbowSegment(from, to, bends, 1, 140);
      expect(moved).toEqual([{ x: 140, y: 0 }, { x: 140, y: 100 }]);
    });

    it("gives an end segment a stub before moving it", () => {
      const from = right(0, 0), to = left(200, 100);
      const bends = autoBends(from, to);
      const first = moveElbowSegment(from, to, bends, 0, -40);
      expect(first).toEqual([{ x: ELBOW_STUB, y: 0 }, { x: ELBOW_STUB, y: -40 }, { x: 100, y: -40 }, { x: 100, y: 100 }]);
      expect(square([from.point, ...first, to.point])).toBe(true);
      const last = moveElbowSegment(from, to, bends, 2, 150);
      expect(last).toEqual([{ x: 100, y: 0 }, { x: 100, y: 150 }, { x: 200 - ELBOW_STUB, y: 150 }, { x: 200 - ELBOW_STUB, y: 100 }]);
      expect(square([from.point, ...last, to.point])).toBe(true);
    });

    it("bends a single straight run at both ends", () => {
      const from = right(0, 50), to = left(200, 50);
      const moved = moveElbowSegment(from, to, [], 0, 0);
      expect(square([from.point, ...moved, to.point])).toBe(true);
      expect(moved).toHaveLength(4);
      expect(moved[1]!.y).toBe(0);
      expect(moved[2]!.y).toBe(0);
    });

    it("offers one handle per segment, along the axis it moves on", () => {
      const route = planRoute(right(0, 0), left(200, 100), "elbowed");
      expect(routeHandles(route)).toEqual([
        { kind: "segment", index: 0, axis: "y", point: { x: 50, y: 0 } },
        { kind: "segment", index: 1, axis: "x", point: { x: 100, y: 50 } },
        { kind: "segment", index: 2, axis: "y", point: { x: 150, y: 100 } },
      ]);
    });
  });

  describe("waypoints", () => {
    it("offers a waypoint handle at each waypoint and an insert handle between", () => {
      const route = planRoute(right(0, 0), left(200, 0), "straight", [{ x: 100, y: 60 }]);
      expect(routeHandles(route)).toEqual([
        { kind: "insert", index: 0, point: { x: 50, y: 30 } },
        { kind: "insert", index: 1, point: { x: 150, y: 30 } },
        { kind: "waypoint", index: 0, point: { x: 100, y: 60 } },
      ]);
      const curved = routeHandles(planRoute(right(0, 0), left(200, 0), "curved"));
      expect(curved).toHaveLength(1);
      expect(curved[0]).toMatchObject({ kind: "insert", index: 0 });
      expect(curved[0]!.point.x).toBeCloseTo(100);
    });

    it("adds, moves and removes waypoints", () => {
      const a = { x: 0, y: 0 }, b = { x: 200, y: 0 };
      const added = placeWaypoint(a, b, [], 0, { x: 100, y: 50 }, { insert: true });
      expect(added).toEqual([{ x: 100, y: 50 }]);
      const second = placeWaypoint(a, b, added, 1, { x: 150, y: -20 }, { insert: true });
      expect(second).toEqual([{ x: 100, y: 50 }, { x: 150, y: -20 }]);
      expect(placeWaypoint(a, b, second, 0, { x: 90, y: 70 }, { insert: false })).toEqual([{ x: 90, y: 70 }, { x: 150, y: -20 }]);
      expect(removeWaypoint(second, 0)).toEqual([{ x: 150, y: -20 }]);
      expect(placeWaypoint(a, b, second, 5, { x: 1, y: 1 }, { insert: false })).toEqual(second);
    });

    it("drops a waypoint put back on the straight line between its neighbours", () => {
      const a = { x: 0, y: 0 }, b = { x: 200, y: 0 };
      expect(placeWaypoint(a, b, [{ x: 100, y: 50 }], 0, { x: 100, y: 3 }, { insert: false, straighten: 6 })).toEqual([]);
      expect(placeWaypoint(a, b, [{ x: 100, y: 50 }], 0, { x: 100, y: 30 }, { insert: false, straighten: 6 }))
        .toEqual([{ x: 100, y: 30 }]);
    });
  });

  it("drops repeated and in-line corners", () => {
    expect(simplifyCorners([
      { x: 0, y: 0 }, { x: 0, y: 0 }, { x: 50, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 },
    ])).toEqual([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }]);
    // A run that doubles back keeps its turning point.
    expect(simplifyCorners([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 50, y: 0 }])).toHaveLength(3);
  });

  it("maps a route into another space when it writes the path", () => {
    const route = planRoute(right(0, 0), left(10, 10), "straight");
    expect(routePath(route.start, route.segments, (point) => ({ x: point.x * 2, y: point.y + 1 }))).toBe("M 0 1 L 20 11");
  });
});
