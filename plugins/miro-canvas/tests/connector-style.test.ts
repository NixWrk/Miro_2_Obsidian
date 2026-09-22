import { describe, expect, it } from "vitest";
import { headMarkerAttributes } from "../src/connector-style";

describe("arrowhead marker sizing", () => {
  it("leaves legacy attributes alone", () => {
    expect(headMarkerAttributes(undefined, 2)).toEqual({});
  });
  it("uses board units scaled by zoom without a stroke-width multiplier", () => {
    expect(headMarkerAttributes(20, 0.5)).toEqual({
      markerUnits:"userSpaceOnUse", viewBox:"-16 -8 18 16", markerWidth:"18", markerHeight:"16",
    });
    expect(headMarkerAttributes(20, 2)).toMatchObject({markerWidth:"72", markerHeight:"64"});
  });
});
