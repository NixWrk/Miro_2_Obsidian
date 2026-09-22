import { describe, it, expect } from "vitest";
import { edgeLanding } from "../src/edge-landing";
import { resolveAnchor } from "../src/anchors";

describe("edge-to-edge landing", () => {
  it("attaches to an arbitrary point on a bent route, not only its ends", () => {
    const geometry = { points: [{x:0,y:0}, {x:100,y:0}, {x:100,y:300}] };
    const hit = edgeLanding("other", geometry, {x:103,y:123})!;
    expect(hit.board.x).toBeCloseTo(100);
    expect(hit.board.y).toBeCloseTo(123);
    expect(hit.distance).toBeCloseTo(3);
    expect(hit.anchor.t).toBeCloseTo(223/400);
    const resolved = resolveAnchor(hit.anchor, { edges: { other: geometry } });
    expect(resolved.point?.x).toBeCloseTo(hit.board.x);
    expect(resolved.point?.y).toBeCloseTo(hit.board.y);
  });
  it("rejects invalid routes and clamps to an end beyond the route", () => {
    expect(edgeLanding("e", {points:[{x:NaN,y:0},{x:1,y:1}]}, {x:0,y:0})).toBeUndefined();
    expect(edgeLanding("e", {start:{x:0,y:0},end:{x:10,y:0}}, {x:20,y:0})?.anchor.t).toBe(1);
  });
});
