import {describe,it,expect} from "vitest";
import {routeIntersectsBox} from "../src/board-selection";
describe("connector marquee hit testing",()=>{
  const a={x:10,y:10},b={x:20,y:20};
  it("includes crossings even when both ends are outside",()=>{
    expect(routeIntersectsBox([{x:0,y:15},{x:30,y:15}],a,b)).toBe(true);
    expect(routeIntersectsBox([{x:15,y:0},{x:15,y:30}],b,a)).toBe(true);
  });
  it("does not select a diagonal only because its bounding box overlaps",()=>{
    expect(routeIntersectsBox([{x:0,y:15},{x:15,y:30}],a,b)).toBe(false);
  });
  it("handles tangencies, degenerate segments and sampled curves",()=>{
    expect(routeIntersectsBox([{x:0,y:10},{x:30,y:10}],a,b)).toBe(true);
    expect(routeIntersectsBox([{x:15,y:15},{x:15,y:15}],a,b)).toBe(true);
    expect(routeIntersectsBox([{x:0,y:0},{x:15,y:15},{x:30,y:0}],a,b)).toBe(true);
    expect(routeIntersectsBox([],a,b)).toBe(false);
  });
});
