import { describe, expect, it } from "vitest";

import { MIRO_STICKY_COLORS } from "../src/miro-palette";
import { LOCAL_ITEM_SIZES, LOCAL_ITEM_TYPES, readLocalItem } from "../src/local-items";

const STROKE = { color: "#1a1a1a", width: 5, box: { width: 40, height: 20 }, points: [0, 0, 20, 10, 40, 20] };

describe("readLocalItem", () => {
  it("accepts every type the board tools make", () => {
    for (const type of LOCAL_ITEM_TYPES) {
      // A drawing is its stroke; every other item stands on its type alone.
      if (type === "drawing") continue;
      expect(readLocalItem({ type })).toEqual({ type });
    }
    expect(readLocalItem({ type: "drawing" })).toBeUndefined();
    expect(readLocalItem({ type: "drawing", stroke: STROKE })).toEqual({ type: "drawing", stroke: STROKE });
    // Only a drawing carries one.
    expect(readLocalItem({ type: "text", stroke: STROKE })).toBeUndefined();
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
