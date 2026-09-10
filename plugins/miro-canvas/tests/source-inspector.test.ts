import { describe, expect, it } from "vitest";

import { buildSourceInspection } from "../src/source-inspector";

describe("source provenance inspector", () => {
  it("reports bounded source, completeness and provenance summaries without exposing values", () => {
    const document = {
      nodes: [], edges: [],
      miroSource: {
        items: [
          { id: "a", type: "card", data: { title: "Private title", futureData: "private" }, future: { keep: true }, source_provenance: {
            field_sources: { "data.title": ["rest"] }, selected_field_sources: { "data.title": "rest" },
            original_items: { rest: { url: "https://private.invalid" }, web_sdk: { token: "sensitive-value" } },
          } },
          { id: "legacy", type: "mindmap" },
          { id: "unsafe", type: "https://private.invalid/sensitive-value" },
        ],
        connectors: [{ id: "edge", type: "connector", source_provenance: { original_items: { rest: {} } } }],
        comments: [{ id: "comment", source_provenance: { field_sources: { content: ["rest"] } } }],
        assets: [{ id: "asset" }], tags: [{ id: "tag" }],
        completeness: {
          complete: false, capture_complete: true, board_complete: false,
          items: { complete: true }, comments: { complete: true }, assets: { complete: false, checked: true },
          known_limitations: ["private limitation"], rest: { known_limitations: ["another"] },
        },
        futureSource: { access_token: "sensitive-value" },
      },
    };
    const before = JSON.stringify(document);
    const inspection = buildSourceInspection(document);

    expect(inspection.status).toBe("ready");
    expect(inspection.counts).toEqual({ items: 3, connectors: 1, comments: 1, assets: 1, tags: 1 });
    expect(inspection.typeCounts).toEqual([
      { label: "card", count: 1 }, { label: "connector", count: 1 }, { label: "mindmap", count: 1 }, { label: "other", count: 1 },
    ]);
    expect(inspection.provenance).toEqual({ itemsWithProvenance: 3, fieldSourceEntries: 2, selectedFieldSourceEntries: 1, originalSourceCopies: 3 });
    expect(inspection.completeness).toContainEqual({ path: "complete", state: "false" });
    expect(inspection.completeness).toContainEqual({ path: "assets.checked", state: "true" });
    expect(inspection.declaredLimitationCount).toBe(2);
    expect(inspection.diagnosticCounts).toContainEqual({ label: "source-mindmap-legacy-limited", count: 1 });
    expect(inspection.unknownFields).toContainEqual({ path: "miroSource.futureSource", type: "object" });
    expect(inspection.unknownFields).toContainEqual({ path: "miroSource.records[0].future", type: "object" });
    expect(inspection.unknownFields).toContainEqual({ path: "miroSource.records[0].data.futureData", type: "string" });
    const renderedModel = JSON.stringify(inspection);
    expect(renderedModel).not.toContain("Private title");
    expect(renderedModel).not.toContain("private.invalid");
    expect(renderedModel).not.toContain("sensitive-value");
    expect(JSON.stringify(document)).toBe(before);
  });

  it("counts item-backed tag definitions and bounds large source arrays", () => {
    const items = Array.from({ length: 20_005 }, (_, index) => ({ id: `item-${index}`, type: index === 0 ? "tag" : "text" }));
    const inspection = buildSourceInspection({ miroSource: { items } });
    expect(inspection.counts.items).toBe(20_005);
    expect(inspection.counts.tags).toBe(1);
    expect(inspection.truncated).toBe(true);
    expect(inspection.typeCounts).toContainEqual({ label: "tag", count: 1 });
  });

  it("summarizes the selected Canvas bindings without revealing IDs or values", () => {
    const document = {
      miroCanvas: { bindings: { canvasA: { sourceId: "sourceA" }, canvasB: { sourceId: "sourceB" } } },
      miroSource: { items: [
        { id: "sourceA", type: "shape", source_provenance: { original_items: { rest: {} } } },
        { id: "sourceB", type: "card" },
      ] },
    };
    const inspection = buildSourceInspection(document, ["canvasA", "canvasB", "missing"]);
    expect(inspection.selected).toEqual({
      canvasItems: 3, matchedSourceItems: 2, itemsWithProvenance: 1,
      typeCounts: [{ label: "card", count: 1 }, { label: "shape", count: 1 }],
    });
    expect(JSON.stringify(inspection.selected)).not.toContain("sourceA");
  });

  it("fails closed for absent, malformed and throwing source values", () => {
    expect(buildSourceInspection({}).status).toBe("absent");
    expect(buildSourceInspection({ miroSource: [] }).status).toBe("malformed");
    const document = Object.defineProperty({}, "miroSource", { get: () => { throw new Error("private"); } });
    const inspection = buildSourceInspection(document);
    expect(inspection.status).toBe("absent");
    expect(JSON.stringify(inspection)).not.toContain("private");
  });
});
