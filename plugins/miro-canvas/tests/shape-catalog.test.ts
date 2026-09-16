import { describe, expect, it } from "vitest";

import { SHAPE_CATALOG, shapeCatalogEntry, shapeCatalogLabel } from "../src/shape-catalog";
import { shapePath } from "../src/shape-geometry";
import { LOCAL_SHAPE_KINDS } from "../src/source-model";

describe("shape catalogue", () => {
  it("draws every shape kind with exactly one entry", () => {
    const drawn = SHAPE_CATALOG.flatMap((item) => [item.kind, ...item.aliases]);
    expect([...drawn].sort()).toEqual([...LOCAL_SHAPE_KINDS].sort());
    for (const kind of LOCAL_SHAPE_KINDS) {
      expect(shapeCatalogEntry(kind), kind).toBeDefined();
    }
  });

  it("never offers the same picture twice", () => {
    const pictures = SHAPE_CATALOG.map((item) => shapePath(item.kind));
    expect(pictures.every((path) => path !== undefined)).toBe(true);
    expect(new Set(pictures).size).toBe(pictures.length);
    for (const item of SHAPE_CATALOG) {
      for (const alias of item.aliases) {
        expect(shapePath(alias), alias).toBeDefined();
      }
    }
  });

  it("files a flowchart symbol drawn like a basic shape under the basic shape", () => {
    expect(shapeCatalogEntry("flow_chart_decision")?.kind).toBe("rhombus");
    expect(shapeCatalogEntry("flow_chart_note_curly_left")?.kind).toBe("left_brace");
    expect(shapeCatalogEntry("flow_chart_note_curly_right")?.kind).toBe("right_brace");
    expect(shapeCatalogEntry("flow_chart_magnetic_disk")?.kind).toBe("can");
    expect(SHAPE_CATALOG.filter((item) => item.section === "basic").every((item) => !item.kind.startsWith("flow_chart_"))).toBe(true);
    expect(SHAPE_CATALOG.filter((item) => item.section === "flowchart").every((item) => item.kind.startsWith("flow_chart_"))).toBe(true);
  });

  it("names every entry and gives every flowchart picture its meaning", () => {
    const names = SHAPE_CATALOG.map((item) => item.name);
    expect(new Set(names).size).toBe(names.length);
    for (const item of SHAPE_CATALOG) {
      if (item.section === "flowchart" || item.aliases.some((alias) => alias.startsWith("flow_chart_"))) {
        expect(item.meaning, item.kind).toBeTruthy();
      }
    }
    const rhombus = shapeCatalogEntry("rhombus")!;
    expect(shapeCatalogLabel(rhombus)).toBe(`Rhombus\n${rhombus.meaning!}`);
    expect(shapeCatalogLabel(shapeCatalogEntry("star")!)).toBe("Star");
    expect(shapeCatalogEntry("not_a_shape")).toBeUndefined();
    expect(shapeCatalogEntry(undefined)).toBeUndefined();
  });
});
