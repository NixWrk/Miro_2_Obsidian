import { afterEach, describe, expect, it } from "vitest";

import { setLocale } from "../src/i18n";
import {
  DEFAULT_EXPORT_STATE, captureTiles, exportPixels, exportRecord, isExportRecord, pageAround, paperLabels, paperRatio,
  paperSize, readExportState, reshapePage,
} from "../src/export-pages";

describe("paper", () => {
  it("measures each format in points, turned as asked", () => {
    expect(paperSize("a4", "portrait")).toEqual({ width: 595.28, height: 841.89 });
    expect(paperSize("a4", "landscape")).toEqual({ width: 841.89, height: 595.28 });
    expect(paperSize("16:9", "landscape")).toEqual({ width: 960, height: 540 });
    expect(paperRatio("4:3", "landscape")).toBeCloseTo(4 / 3);
    expect(paperRatio("free", "landscape")).toBeUndefined();
  });

  it("gives a free page a sheet of its own shape, as long as A4", () => {
    expect(paperSize("free", "landscape", { x: 0, y: 0, width: 200, height: 100 })).toEqual({ width: 841.89, height: 420.95 });
  });
});

describe("pages", () => {
  it("covers a rectangle with a page of the paper's shape, centred on it", () => {
    const page = pageAround({ x: 0, y: 0, width: 400, height: 100 }, 2, 10);
    expect(page.width / page.height).toBeCloseTo(2);
    expect(page.width).toBeCloseTo(420);
    expect(page.x + page.width / 2).toBeCloseTo(200);
    expect(page.y + page.height / 2).toBeCloseTo(50);
    expect(pageAround({ x: 5, y: 5, width: 10, height: 10 }, undefined)).toEqual({ x: 5, y: 5, width: 10, height: 10 });
  });

  it("takes a new shape about its middle, keeping its area", () => {
    const page = reshapePage({ x: 0, y: 0, width: 400, height: 100 }, 1);
    expect(page.width).toBeCloseTo(200);
    expect(page.height).toBeCloseTo(200);
    expect(page.x).toBeCloseTo(100);
  });

  it("is captured in pieces the size of the view, covering it exactly", () => {
    const tiles = captureTiles({ x: 10, y: 20, width: 250, height: 90 }, { width: 100, height: 60 });
    expect(tiles).toHaveLength(6);
    expect(tiles[0]).toEqual({ x: 10, y: 20, width: 100, height: 60 });
    expect(tiles[5]).toEqual({ x: 210, y: 80, width: 50, height: 30 });
    expect(captureTiles({ x: 0, y: 0, width: 100, height: 60 }, { width: 100, height: 60 })).toHaveLength(1);
  });

  it("is exported with its long side at two or three thousand pixels", () => {
    expect(exportPixels({ x: 0, y: 0, width: 1000, height: 500 }, "standard")).toEqual({ width: 2000, height: 1000, scale: 2 });
    expect(exportPixels({ x: 0, y: 0, width: 500, height: 1000 }, "high").height).toBe(3000);
  });
});

describe("the stored record", () => {
  it("reads back what it wrote, and leaves out what is malformed", () => {
    const state = readExportState({
      format: "16:9", orientation: "portrait", quality: "high",
      pages: [{ id: "p1", x: 1.234, y: 2, width: 300, height: 200, name: "Intro" }, { id: "", x: 0, y: 0, width: 1, height: 1 }, { id: "p3", x: 0, y: 0, width: -1, height: 1 }],
    });
    expect(state.pages.map((page) => page.id)).toEqual(["p1"]);
    expect(exportRecord(state)).toEqual({
      format: "16:9", orientation: "portrait", quality: "high",
      pages: [{ id: "p1", x: 1.23, y: 2, width: 300, height: 200, name: "Intro" }],
    });
    expect(readExportState("nonsense")).toEqual(DEFAULT_EXPORT_STATE);
    expect(isExportRecord(exportRecord(state))).toBe(true);
    expect(isExportRecord({ pages: [{ id: "x" }] })).toBe(false);
  });
});

describe("paper labels in Russian", () => {
  afterEach(() => setLocale("en"));

  it("keeps format names and translates the rest, from the Russian word table", () => {
    setLocale("ru");
    expect(paperLabels().a4).toBe("A4");
    expect(paperLabels().letter).toBe("Letter");
    expect(paperLabels()["16:9"]).toBe("Слайд 16:9");
    expect(paperLabels().free).toBe("Свободный размер");
  });
});
