import { afterEach, describe, expect, it } from "vitest";
import { capLabels, headMarkerAttributes, routeLabels, strokeLabels } from "../src/connector-style";
import { setLocale } from "../src/i18n";

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

describe("connector look in Russian", () => {
  afterEach(() => setLocale("en"));

  it("names ends, routes and strokes from the Russian word table", () => {
    setLocale("ru");
    expect(capLabels().arrow).toBe("Открытая стрелка");
    expect(capLabels().erd_many).toBe("ERD: много\nОтношение сущностей: много");
    expect(routeLabels().elbowed).toBe("Ломаная линия");
    expect(strokeLabels().dashed).toBe("Штриховая линия");
  });
});
