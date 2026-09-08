import { describe, expect, it } from "vitest";

import { buildSourceScene, effectiveRotation, rotatePoint, rotatedBounds } from "../src/source-model";

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

describe("source projection model", () => {
  it("is read-only, ignores original_items, and preserves native content/geometry and unknown metadata", () => {
    const document = {
      nodes: [{ id: "s1", type: "text", x: -4, y: 7, width: 81, height: 23, text: "**native**" }],
      unknownRoot: { keep: true },
      miroSource: {
        items: [{ id: "s1", type: "text", data: { content: "<b>source html</b>" }, style: { color: "#123456" }, future: { keep: true } }],
        original_items: [{ id: "wrong", type: "shape", subtype: "star" }],
        futureSource: { keep: true },
      },
    };
    const before = clone(document);
    const scene = buildSourceScene(document);
    expect(scene.items.get("s1")).toMatchObject({ sourceId: "s1", kind: "text", rotation: 0, css: { color: "#123456" } });
    expect(scene.items.has("wrong")).toBe(false);
    expect(document).toEqual(before);
    expect(Object.isFrozen(document)).toBe(false);
    expect(document.nodes[0]).toEqual(before.nodes[0]);
  });

  it("uses explicit bindings over matching IDs and preserves exact IDs", () => {
    const scene = buildSourceScene({
      miroSource: { items: [{ id: "source exact", type: "shape", subtype: "star" }] },
      miroCanvas: { bindings: { "Canvas Exact": { sourceId: "source exact", role: "item" } } },
    });
    expect([...scene.items.keys()]).toEqual(["Canvas Exact"]);
    expect(scene.items.get("Canvas Exact")).toMatchObject({ sourceId: "source exact", kind: "shape", shape: "star" });
  });

  it("diagnoses malformed, ambiguous, duplicate, unknown, and unsupported source values", () => {
    const scene = buildSourceScene({
      miroSource: {
        items: [
          { id: "dup", type: "shape", subtype: "future_blob" },
          { id: "dup", type: "text" },
          { id: "unknown", type: "future_widget" },
          { id: "missing-type" },
          null,
        ],
      },
      miroCanvas: {
        bindings: {
          a: { sourceId: "dup" },
          b: { sourceId: "dup" },
          broken: { sourceId: 3 },
        },
      },
    });
    expect(scene.diagnostics.some((item) => item.startsWith("source-id-duplicate:"))).toBe(true);
    expect(scene.diagnostics.some((item) => item.startsWith("shape-subtype-unknown:"))).toBe(true);
    expect(scene.diagnostics.some((item) => item.startsWith("source-type-unsupported:"))).toBe(true);
    expect(scene.diagnostics.some((item) => item.startsWith("source-item-malformed:"))).toBe(true);
    expect(scene.diagnostics.some((item) => item.startsWith("binding-ambiguous:"))).toBe(true);
    expect(scene.diagnostics.some((item) => item.startsWith("binding-malformed:"))).toBe(true);
    expect(scene.items.has("missing-type")).toBe(false);
  });

  it("applies rotation precedence including zero and negative values", () => {
    const document = {
      miroSource: {
        items: [
          { id: "a", type: "shape", subtype: "rectangle", rotation: 90, geometry: { rotation: -30 } },
          { id: "b", type: "text", rotation: -15 },
        ],
      },
      miroCanvas: { localOverrides: { a: { rotation: 0 }, b: { rotation: -45 } } },
    };
    expect(effectiveRotation(document, "a")).toBe(0);
    expect(effectiveRotation(document, "b")).toBe(-45);
    expect(effectiveRotation({ miroSource: document.miroSource }, "a")).toBe(-30);
    expect(effectiveRotation({ miroSource: document.miroSource }, "b")).toBe(-15);
  });

  it("rotates points and computes axis-aligned bounds around the rectangle center", () => {
    const point = rotatePoint({ x: 2, y: 1 }, { x: 1, y: 1 }, 90);
    expect(point.x).toBeCloseTo(1);
    expect(point.y).toBeCloseTo(2);
    const bounds = rotatedBounds({ x: 10, y: 20, width: 100, height: 40 }, 90);
    expect(bounds.x).toBeCloseTo(40);
    expect(bounds.y).toBeCloseTo(-10);
    expect(bounds.width).toBeCloseTo(40);
    expect(bounds.height).toBeCloseTo(100);
  });

  it("projects safe source styles and applies local transparent/color/typography precedence", () => {
    const scene = buildSourceScene({
      miroSource: {
        items: [{
          id: "a", type: "shape", subtype: "rectangle",
          style: {
            fillColor: "#abcdef", fillOpacity: "0", borderColor: "#111111", borderWidth: "2",
            color: "#222222", fontFamily: "Inter", fontSize: "18", fontWeight: "600", lineHeight: "1.25",
          },
        }],
      },
      miroCanvas: {
        localOverrides: {
          a: {
            colors: { fill: null, text: "#010203", border: "#040506", edge: "#070809" },
            typography: { fontFamily: "Noto Sans", fontSize: 20, format: { bold: true, italic: true, underline: true } },
          },
        },
      },
    });
    expect(scene.items.get("a")?.css).toMatchObject({
      "background-color": "transparent",
      "--miro-fill-opacity": "0",
      "border-color": "#040506",
      "border-width": "2px",
      "color": "#010203",
      "stroke": "#070809",
      "font-family": "Noto Sans",
      "font-size": "20px",
      "font-weight": "bold",
      "font-style": "italic",
      "text-decoration": "underline",
      "line-height": "1.25",
    });
  });

  it("drops hostile CSS URLs and unsafe endcaps while retaining safe connector renderer data", () => {
    const scene = buildSourceScene({
      miroSource: {
        connectors: [{
          id: "c", shape: "curved",
          style: {
            strokeColor: "url(https://attacker.invalid/x)", strokeWidth: "3", strokeOpacity: "0",
            strokeStyle: "dashed", startStrokeCap: "stealth", endStrokeCap: "url(evil)", fontFamily: "url(evil)",
          },
        }],
      },
    });
    expect(scene.items.get("c")).toMatchObject({
      kind: "connector",
      css: { "stroke-width": "3", "stroke-opacity": "0" },
      connector: { shape: "curved", strokeStyle: "dashed", startCap: "stealth" },
    });
    expect(scene.items.get("c")?.css).not.toHaveProperty("stroke");
    expect(scene.items.get("c")?.css).not.toHaveProperty("font-family");
    expect(scene.items.get("c")?.connector).not.toHaveProperty("endCap");
    expect(scene.diagnostics.some((item) => item.startsWith("connector-endcap-unsafe:"))).toBe(true);
  });

  it("treats ordinary Canvas without source as normal and recognizes six local M2 shapes", () => {
    const kinds = ["rectangle", "round_rectangle", "ellipse", "triangle", "diamond", "star"];
    const localOverrides = Object.fromEntries(kinds.map((kind, index) => [`local-${index}`, { shape: { kind, fallback: "text" } }]));
    const ordinary = buildSourceScene({ nodes: [{ id: "plain", type: "text" }] });
    expect(ordinary.items.size).toBe(0);
    expect(ordinary.diagnostics).toEqual([]);
    const local = buildSourceScene({ miroCanvas: { localOverrides } });
    expect([...local.items.values()].map((item) => item.shape)).toEqual(kinds);
    expect([...local.items.values()].every((item) => item.kind === "shape" && item.sourceId === undefined)).toBe(true);
  });

  it("projects every M3 renderer family without reading active source content", () => {
    const scene = buildSourceScene({ miroSource: { items: [
      { id: "shape", type: "shape", data: { shape: "star", content: "<script>bad()</script>" } },
      { id: "text", type: "text", data: { content: "<img src=https://bad.invalid>" } },
      { id: "sticky", type: "sticky_note", data: { content: "source only" } },
      { id: "frame", type: "frame", data: { title: "Frame" } },
      { id: "media", type: "image", data: { url: "https://bad.invalid/image.png" } },
      { id: "connector", type: "connector", shape: "straight" },
    ] } });
    expect([...scene.items.values()].map((item) => item.kind))
      .toEqual(["shape", "text", "sticky", "frame", "media", "connector"]);
    expect(JSON.stringify([...scene.items.values()])).not.toContain("bad.invalid");
    expect(JSON.stringify([...scene.items.values()])).not.toContain("script");
  });

  it("prefers Canvas zOrder, maps source IDs through bindings, and keeps dangling entries", () => {
    const scene = buildSourceScene({
      miroSource: { items: [{ id: "s1", type: "text" }, { id: "s2", type: "text" }, { id: "s3", type: "text" }], zOrder: ["s3", "s2"] },
      miroCanvas: { bindings: { canvas2: { sourceId: "s2" } }, zOrder: ["s2", "dangling", "s1"] },
    });
    expect(scene.order).toEqual(["canvas2", "dangling", "s1", "s3"]);
    expect(scene.diagnostics.some((item) => item.startsWith("miro-canvas-z-order-partial:"))).toBe(true);
  });

  it("uses zIndex rank and diagnoses source-limited order instead of claiming fallback order", () => {
    const ranked = buildSourceScene({
      miroSource: { items: [{ id: "a", type: "text", zIndex: 5 }, { id: "b", type: "text", zIndex: -1 }, { id: "c", type: "text" }] },
    });
    expect(ranked.order).toEqual(["b", "a", "c"]);
    expect(ranked.diagnostics.some((item) => item.startsWith("source-order-partial:"))).toBe(true);

    const limited = buildSourceScene({ miroSource: { items: [{ id: "a", type: "text" }, { id: "b", type: "text" }] } });
    expect(limited.order).toEqual(["a", "b"]);
    expect(limited.diagnostics.some((item) => item.startsWith("source-order-limited:"))).toBe(true);
  });
});
