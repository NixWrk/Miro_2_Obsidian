import { describe, expect, it } from "vitest";

import { MIRO_STICKY_COLORS } from "../src/miro-palette";
import { LOCAL_ITEM_SIZES, LOCAL_ITEM_TYPES, readLocalItem, readLocalLine, readLocalStroke } from "../src/local-items";

const STROKE = { color: "#1a1a1a", width: 5, box: { width: 40, height: 20 }, points: [0, 0, 20, 10, 40, 20] };
const LINE = { route: "straight", color: "#1a1a1a", width: 2, endCap: "stealth", box: { width: 108, height: 10 }, points: [4, 5, 104, 5] };

describe("readLocalItem", () => {
  it("accepts every type the board tools make", () => {
    for (const type of LOCAL_ITEM_TYPES) {
      // A drawing is its stroke, a line its course; every other item stands
      // on its type alone.
      if (type === "drawing" || type === "line") continue;
      expect(readLocalItem({ type })).toEqual({ type });
    }
    expect(readLocalItem({ type: "drawing" })).toBeUndefined();
    expect(readLocalItem({ type: "drawing", stroke: STROKE })).toEqual({ type: "drawing", stroke: STROKE });
    // Only a drawing carries one.
    expect(readLocalItem({ type: "text", stroke: STROKE })).toBeUndefined();
    expect(readLocalItem({ type: "line" })).toBeUndefined();
    expect(readLocalItem({ type: "line", line: LINE })).toEqual({ type: "line", line: LINE });
    expect(readLocalItem({ type: "text", line: LINE })).toBeUndefined();
  });

  it("keeps a line's route, look and course, and refuses a malformed one", () => {
    expect(readLocalLine({ ...LINE, strokeStyle: "dashed", startCap: "none", block: true }))
      .toEqual({ ...LINE, strokeStyle: "dashed", block: true });
    for (const broken of [
      { ...LINE, route: "zigzag" }, { ...LINE, color: "red" }, { ...LINE, width: 0 }, { ...LINE, strokeStyle: "wavy" },
      { ...LINE, endCap: "<b>" }, { ...LINE, block: "yes" }, { ...LINE, points: [1, 2] }, { ...LINE, points: [1, 2, 3] },
      { ...LINE, points: Array.from({ length: 200 }, () => 1) }, { ...LINE, box: { width: 0, height: 5 } },
    ]) expect(readLocalLine(broken)).toBeUndefined();
  });

  it("keeps a valid Miro sticky colour name and a short title", () => {
    expect(readLocalItem({ type: "sticky_note", color: "light_yellow", title: "Idea" }))
      .toEqual({ type: "sticky_note", color: "light_yellow", title: "Idea" });
  });

  it("keeps every one of Miro's own sticky colour tokens, not just one", () => {
    for (const { token } of MIRO_STICKY_COLORS) {
      expect(readLocalItem({ type: "sticky_note", color: token })).toEqual({ type: "sticky_note", color: token });
    }
  });

  it("rejects anything that is not a plain object", () => {
    for (const value of [null, undefined, "sticky_note", 42, true, ["sticky_note"]]) {
      expect(readLocalItem(value)).toBeUndefined();
    }
  });

  it("rejects a type the board tools do not make", () => {
    expect(readLocalItem({ type: "shape" })).toBeUndefined();
    expect(readLocalItem({})).toBeUndefined();
  });

  it("rejects a colour that is not one of Miro's sticky tokens", () => {
    expect(readLocalItem({ type: "sticky_note", color: "sky_blue" })).toBeUndefined();
    expect(readLocalItem({ type: "sticky_note", color: 7 })).toBeUndefined();
  });

  it("rejects a title longer than 256 characters", () => {
    expect(readLocalItem({ type: "code", title: "a".repeat(257) })).toBeUndefined();
    expect(readLocalItem({ type: "code", title: "a".repeat(256) })).toEqual({ type: "code", title: "a".repeat(256) });
  });

  it("freezes the result and carries only the fields it recognises", () => {
    const item = readLocalItem({ type: "sticky_note", color: "light_yellow", shape: "star" });
    expect(item).toEqual({ type: "sticky_note", color: "light_yellow" });
    expect(Object.keys(item!)).toEqual(["type", "color"]);
    expect(Object.isFrozen(item)).toBe(true);
  });
});

describe("LOCAL_ITEM_SIZES", () => {
  it("gives every item type a positive starting size", () => {
    for (const type of LOCAL_ITEM_TYPES) {
      expect(LOCAL_ITEM_SIZES[type].width).toBeGreaterThan(0);
      expect(LOCAL_ITEM_SIZES[type].height).toBeGreaterThan(0);
    }
  });
});

describe("readLocalStroke", () => {
  it("accepts a well-formed stroke and freezes it, its box and its points", () => {
    const stroke = readLocalStroke(STROKE);
    expect(stroke).toEqual(STROKE);
    expect(Object.isFrozen(stroke)).toBe(true);
    expect(Object.isFrozen(stroke!.box)).toBe(true);
    expect(Object.isFrozen(stroke!.points)).toBe(true);
  });

  it("accepts an optional opacity above 0 and up to 1", () => {
    expect(readLocalStroke({ ...STROKE, opacity: 0.4 })).toEqual({ ...STROKE, opacity: 0.4 });
    expect(readLocalStroke({ ...STROKE, opacity: 1 })).toEqual({ ...STROKE, opacity: 1 });
  });

  it("rejects anything that is not a plain object", () => {
    for (const value of [null, undefined, "stroke", 42, true, [STROKE]]) {
      expect(readLocalStroke(value)).toBeUndefined();
    }
  });

  it("rejects a colour that is not #rrggbb", () => {
    for (const color of ["#fff", "1a1a1a", "#gggggg", "#1a1a1a1a", "red"]) {
      expect(readLocalStroke({ ...STROKE, color })).toBeUndefined();
    }
  });

  it("rejects a width of zero, negative, or over 1000", () => {
    for (const width of [0, -5, 1001]) {
      expect(readLocalStroke({ ...STROKE, width })).toBeUndefined();
    }
  });

  it("rejects an opacity of 0 or above 1", () => {
    for (const opacity of [0, 1.1]) {
      expect(readLocalStroke({ ...STROKE, opacity })).toBeUndefined();
    }
  });

  it("rejects a box with a zero or negative side", () => {
    expect(readLocalStroke({ ...STROKE, box: { width: 0, height: 20 } })).toBeUndefined();
    expect(readLocalStroke({ ...STROKE, box: { width: 40, height: -1 } })).toBeUndefined();
  });

  it("rejects an odd-length points list", () => {
    expect(readLocalStroke({ ...STROKE, points: [0, 0, 20, 10, 5] })).toBeUndefined();
  });

  it("rejects fewer than four coordinates", () => {
    expect(readLocalStroke({ ...STROKE, points: [0, 0] })).toBeUndefined();
  });

  it("rejects a non-finite coordinate", () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(readLocalStroke({ ...STROKE, points: [0, 0, bad, 10, 40, 20] })).toBeUndefined();
    }
  });

  it("rejects a points list longer than the module's limit", () => {
    const tooLong = Array.from({ length: 4_096 * 2 + 2 }, (_, index) => index);
    expect(readLocalStroke({ ...STROKE, points: tooLong })).toBeUndefined();
  });
});
