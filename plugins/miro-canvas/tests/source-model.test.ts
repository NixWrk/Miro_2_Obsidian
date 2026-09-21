import { describe, expect, it } from "vitest";

import { buildSourceScene, effectiveRotation, rotatePoint, rotatedBounds, takesShape } from "../src/source-model";

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

  it("draws a text item given a shape as that shape, and says which cards take one", () => {
    const scene = buildSourceScene({
      nodes: [
        { id: "t", type: "text" }, { id: "plain", type: "text" }, { id: "note", type: "text" },
        { id: "grid", type: "text" }, { id: "restyled", type: "text" }, { id: "page", type: "file" },
      ],
      miroSource: { items: [{ id: "t", type: "text", style: { color: "#123456" } }] },
      miroCanvas: { localOverrides: {
        t: { shape: { kind: "ellipse", fallback: "text" } },
        note: { item: { type: "sticky_note" } },
        grid: { item: { type: "table" } },
        restyled: { colors: { fill: "#ffeeaa" } },
      } },
    });
    expect(scene.items.get("t")).toMatchObject({ sourceId: "t", kind: "shape", shape: "ellipse", css: { color: "#123456" } });
    const takes = (id: string, type = "text"): boolean => takesShape(scene.items.get(id), type);
    expect(takes("t")).toBe(true);
    expect(takes("plain")).toBe(true);
    expect(takes("restyled")).toBe(true);
    expect(takes("note")).toBe(false);
    expect(takes("grid")).toBe(false);
    expect(takes("page", "file")).toBe(false);
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

  it("fills a sticky from Miro's own colours and reads its vertical placement", () => {
    const scene = buildSourceScene({ miroSource: { items: [
      { id: "gray", type: "sticky_note", style: { fillColor: "gray", textAlignVertical: "bottom" } },
      { id: "hex", type: "sticky_note", style: { fillColor: "#123456" } },
      { id: "shape", type: "shape", style: { fillColor: "gray" } },
    ] } });
    expect(scene.items.get("gray")?.css).toMatchObject({ "background-color": "#f4f6f8", "vertical-align": "bottom" });
    expect(scene.items.get("hex")?.css["background-color"]).toBe("#123456");
    // A sticky name means nothing on another item.
    expect(scene.items.get("shape")?.css["background-color"]).not.toBe("#f4f6f8");
  });

  it("projects only the proven bounded code fields", () => {
    const scene = buildSourceScene({ miroSource: { items: [{
      id: "code-1",
      type: "code",
      data: {
        title: "  Code block  ",
        language: "  JavaScript  ",
        lineNumbersVisible: true,
        code: "const answer = 42;\nconsole.log(answer);",
        content: "<b>raw html must stay in miroSource only</b>",
        url: "https://example.invalid/raw",
        payload: { secretShape: "must-not-project" },
      },
    }] } });
    expect(scene.items.get("code-1")).toMatchObject({
      sourceId: "code-1",
      kind: "code",
      structured: { code: {
        title: "Code block",
        language: "JavaScript",
        lineNumbersVisible: true,
        text: "const answer = 42;\nconsole.log(answer);",
      } },
    });
    const projected = JSON.stringify(scene.items.get("code-1"));
    expect(projected).not.toContain("raw html");
    expect(projected).not.toContain("example.invalid");
    expect(projected).not.toContain("secretShape");
  });

  it("hard-limits code strings and ignores non-boolean line-number metadata", () => {
    const scene = buildSourceScene({ miroSource: { items: [{
      id: "code-limited",
      type: "code",
      data: {
        title: ` ${"t".repeat(300)} `,
        language: ` ${"l".repeat(100)} `,
        lineNumbersVisible: "true",
        code: "x".repeat(120_000),
      },
    }] } });
    const code = scene.items.get("code-limited")?.structured?.code;
    expect(code?.title).toHaveLength(256);
    expect(code?.language).toHaveLength(64);
    expect(code?.text).toHaveLength(100_000);
    expect(code).not.toHaveProperty("lineNumbersVisible");
    expect(scene.diagnostics.filter((item) => item.startsWith("source-code-field-truncated:"))).toHaveLength(3);
  });

  it("keeps table source families unsupported without inventing cells", () => {
    const scene = buildSourceScene({ miroSource: { items: [
      { id: "table", type: "table", geometry: { width: 400, height: 200 } },
      { id: "cell", type: "table_text", geometry: { width: 100, height: 40 } },
      { id: "format", type: "data_table_format" },
    ] } });
    expect(scene.items.size).toBe(0);
    expect(scene.diagnostics.filter((item) => item.startsWith("source-type-unsupported:"))).toEqual([
      "source-type-unsupported: table.",
      "source-type-unsupported: cell.",
      "source-type-unsupported: format.",
    ]);
    expect(JSON.stringify([...scene.items.values()])).not.toContain("cell");
  });

  it("projects bounded app-card state without copying fields, HTML, URLs or icons", () => {
    const scene = buildSourceScene({ miroSource: { items: [{
      id: "app-card-1",
      type: "app_card",
      data: {
        title: "Integration task",
        description: "Track the export",
        url: "javascript:alert(1)",
        fields: [
          { label: "Status", value: "In Progress", iconUrl: "https://example.invalid/icon.png" },
          { label: "Owner", value: { name: "Ada" }, html: "<script>unsafe</script>" },
        ],
      },
      style: { cardTheme: "#2d9bf0" },
    }] } });
    expect(scene.items.get("app-card-1")).toMatchObject({
      kind: "text",
      css: { "background-color": "#2d9bf0" },
      structured: { appCard: {
        kind: "app_card",
        hasTitle: true,
        hasDescription: true,
        fieldCount: 2,
      } },
    });
    const projected = JSON.stringify(scene.items.get("app-card-1"));
    expect(projected).not.toContain("javascript:");
    expect(projected).not.toContain("example.invalid");
    expect(projected).not.toContain("unsafe");
    expect(projected).not.toContain("In Progress");
  });

  it("caps app-card field projection without enumerating oversized payloads", () => {
    const scene = buildSourceScene({ miroSource: { items: [{
      id: "app-card-large",
      type: "app_card",
      data: { fields: Array.from({ length: 100 }, (_, index) => ({ value: String(index) })) },
    }] } });
    expect(scene.items.get("app-card-large")?.structured?.appCard?.fieldCount).toBe(64);
    expect(scene.diagnostics).toContain("source-app-card-fields-truncated: app-card-large.data.fields.");
  });

  it("projects preview availability without copying or trusting source URLs and HTML", () => {
    const scene = buildSourceScene({ miroSource: { items: [{
      id: "preview-1",
      type: "preview",
      data: {
        title: "Article",
        description: "Saved preview",
        provider: { name: "Example" },
        url: "javascript:alert(1)",
        previewUrl: "https://example.invalid/preview.png",
        html: "<script>unsafe</script>",
      },
    }, { id: "preview-empty", type: "preview", data: {} }] } });
    expect(scene.items.get("preview-1")).toMatchObject({
      kind: "media",
      structured: { preview: {
        title: "Article",
        description: "Saved preview",
        provider: "Example",
        hasTargetUrl: true,
        hasPreviewAsset: true,
      } },
    });
    expect(scene.items.get("preview-empty")?.structured?.preview).toEqual({
      hasTargetUrl: false,
      hasPreviewAsset: false,
    });
    const projected = JSON.stringify(scene.items.get("preview-1"));
    expect(projected).not.toContain("javascript:");
    expect(projected).not.toContain("example.invalid");
    expect(projected).not.toContain("unsafe");
    expect(projected).not.toContain("<script>");
  });

  it("projects a document's name, type and opening words but none of its locations or markup", () => {
    const scene = buildSourceScene({ miroSource: { items: [
      { id: "pdf", type: "document", data: { title: "  Specification.pdf ", documentUrl: "https://files.invalid/spec.pdf?sig=secret" } },
      { id: "untitled", type: "document", data: { documentUrl: "https://files.invalid/archive.ZIP#part" } },
      { id: "doc", type: "doc_format", local_name: "notes.html", data: { html: "<style>p{}</style><p>Plan&nbsp;<b>A</b></p>" } },
      { id: "video", type: "embed", data: { providerName: "YouTube", title: "Demo", html: "<iframe src=https://bad.invalid>" } },
    ] } });
    expect(scene.items.get("pdf")?.structured?.document).toEqual({ kind: "document", title: "Specification.pdf", extension: "PDF" });
    expect(scene.items.get("untitled")?.structured?.document).toEqual({ kind: "document", extension: "ZIP" });
    expect(scene.items.get("doc")?.structured?.document).toEqual({ kind: "doc_format", extension: "HTML", excerpt: "Plan A" });
    expect(scene.items.get("video")?.structured?.embed).toEqual({ provider: "YouTube", title: "Demo" });
    const projected = JSON.stringify([...scene.items.values()]);
    expect(projected).not.toContain("files.invalid");
    expect(projected).not.toContain("secret");
    expect(projected).not.toContain("bad.invalid");
    expect(projected).not.toContain("<");
  });

  it("ties a presentation to its slides in showing order and reads groups and frame fills", () => {
    const at = (x: number, y: number) => ({ x, y, width: 100, height: 60 });
    const scene = buildSourceScene({
      nodes: [
        { id: "deck", ...at(0, 0) }, { id: "s1", ...at(0, 0) }, { id: "s2", ...at(200, 3) }, { id: "s3", ...at(0, 200) },
        { id: "title", ...at(10, 10) }, { id: "loose", ...at(900, 900) },
      ],
      miroSource: { items: [
        { id: "deck", type: "slide_container", data: { title: " Kittens " } },
        { id: "s3", type: "frame", parent: { id: "deck" }, style: { fillColor: "#fff8ee" } },
        { id: "s2", type: "frame", parent: { id: "deck" } },
        { id: "s1", type: "frame", parent: { id: "deck" }, style: { fillColor: "#ffffff" } },
        { id: "title", type: "text", parent: { id: "s1" } },
        { id: "loose", type: "frame" },
        { id: "g", type: "group", data: {} },
      ] },
    });
    expect(scene.items.get("deck")).toMatchObject({ kind: "frame", structured: { deck: { title: "Kittens", slides: ["s1", "s2", "s3"] } } });
    expect(scene.items.get("s2")?.structured?.slide).toEqual({ deckId: "deck", index: 1 });
    expect(scene.items.get("s3")?.structured?.slide).toEqual({ deckId: "deck", index: 2 });
    expect(scene.items.get("loose")?.structured).toBeUndefined();
    expect(scene.items.get("g")?.kind).toBe("group");
    expect(scene.items.get("title")?.structured?.backdrop).toBe("#ffffff");
  });

  it("reads the Miro item a node made with the board tools stands for", () => {
    const scene = buildSourceScene({
      nodes: [{ id: "n1" }, { id: "n2" }, { id: "n3" }, { id: "n4" }],
      miroCanvas: { localOverrides: {
        n1: { item: { type: "sticky_note", color: "cyan" } },
        n2: { item: { type: "code", title: "Code block" } },
        n3: { item: { type: "table", title: "Grid" } },
        n4: { item: { type: "nonsense" } },
      } },
    });
    expect(scene.items.get("n1")).toMatchObject({ kind: "sticky", localItem: "sticky_note", css: { "background-color": "#8ae9e0" } });
    expect(scene.items.get("n2")).toMatchObject({ kind: "code", localItem: "code", structured: { code: { title: "Code block", lineNumbersVisible: true } } });
    // A grid is Markdown text; only its name is the plugin's.
    expect(scene.items.get("n3")).toMatchObject({ kind: "text", localItem: "table", structured: { table: { title: "Grid" } } });
    expect(scene.items.has("n4")).toBe(false);
  });

  it("resolves ordinary card tags from source definitions without rendering tag records", () => {
    const scene = buildSourceScene({ miroSource: {
      items: [
        { id: "tag-todo", type: "tag", title: "Todo", color: "yellow", future: { keep: true } },
        { id: "tag-urgent", type: "tag", data: { title: "Urgent", color: "#ea94bb" } },
        {
          id: "card-1",
          type: "card",
          data: {
            title: "Release",
            description: "Ship it",
            url: "https://example.invalid/card",
            dueDate: "2026-06-30",
            assigneeId: "user-1",
            fields: [{ label: "Status", value: "Ready" }],
            tagIds: ["tag-todo", "tag-urgent", "missing-tag"],
          },
          style: { cardTheme: "#4262ff" },
        },
      ],
    } });
    expect(scene.items.has("tag-todo")).toBe(false);
    expect(scene.items.has("tag-urgent")).toBe(false);
    expect(scene.items.get("card-1")).toMatchObject({
      kind: "text",
      css: { "background-color": "#4262ff" },
      structured: {
        card: {
          kind: "card",
          hasTitle: true,
          hasDescription: true,
          hasUrl: true,
          hasDueDate: true,
          hasAssignee: true,
          fieldCount: 1,
        },
        tags: [
          { id: "tag-todo", title: "Todo", color: "#ffd02f" },
          { id: "tag-urgent", title: "Urgent", color: "#ea94bb" },
        ],
      },
    });
    expect(scene.diagnostics).toContain("source-tag-dangling: card-1 -> missing-tag.");
    expect(scene.diagnostics.some((item) => item.includes("source-type-unsupported: tag"))).toBe(false);
  });

  it("resolves root tag definitions and keeps tag titles bounded", () => {
    const scene = buildSourceScene({ miroSource: {
      tags: [{ id: "tag-root", title: "t".repeat(200), color: "magenta" }],
      items: [{ id: "card-root", type: "card", tagIds: ["tag-root"] }],
    } });
    expect(scene.items.get("card-root")?.structured?.tags?.[0]).toMatchObject({ color: "#ea94bb" });
    expect(scene.items.get("card-root")?.structured?.tags?.[0]?.title).toHaveLength(128);
    expect(scene.diagnostics).toContain("source-tag-title-truncated: tag-root.");
  });

  it("projects proven mindmap nodes and identifies generated hierarchy edges", () => {
    const document = {
      nodes: [
        { id: "mind-root", type: "text", x: 0, y: 0, width: 140, height: 64 },
        { id: "mind-child", type: "text", x: 260, y: 20, width: 110, height: 36 },
      ],
      edges: [{ id: "mindmap-mind-root-mind-child", fromNode: "mind-root", toNode: "mind-child" }],
      miroSource: { items: [
        {
          id: "mind-root", type: "mindmap_node", style: { nodeColor: "#1a85ff", shape: "rounded_rectangle" },
          data: { isRoot: true, nodeView: { data: { content: "<p>Root</p>" } } },
        },
        {
          id: "mind-child", type: "mindmap_node", parent: { id: "mind-root" }, style: { nodeColor: "#7a28ff", shape: "none" },
          data: { nodeView: { data: { content: "<p>Child</p>" } } },
        },
      ] },
    };
    const before = JSON.stringify(document);
    const scene = buildSourceScene(document);
    expect(scene.items.get("mind-root")?.structured?.mindmapNode).toEqual({
      isRoot: true, hasContent: true, shape: "round_rectangle", branchColor: "#1a85ff",
    });
    expect(scene.items.get("mind-child")?.structured?.mindmapNode).toEqual({
      isRoot: false, hasContent: true, parentId: "mind-root", branchColor: "#7a28ff",
    });
    expect(scene.items.get("mindmap-mind-root-mind-child")).toMatchObject({
      kind: "connector",
      css: { stroke: "#7a28ff" },
      connector: { shape: "curved", startCap: "none", endCap: "none", strokeStyle: "solid" },
      structured: { mindmapEdge: { parentId: "mind-root", childId: "mind-child", branchColor: "#7a28ff" } },
    });
    expect(JSON.stringify(document)).toBe(before);
  });

  it("keeps legacy mindmap source-limited instead of inventing a tree", () => {
    const scene = buildSourceScene({ miroSource: { items: [{ id: "legacy", type: "mindmap", data: { content: "unknown" } }] } });
    expect(scene.items.has("legacy")).toBe(false);
    expect(scene.diagnostics).toContain("source-mindmap-legacy-limited: legacy.");
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

describe("local overrides without a shape", () => {
  const board = (override: Record<string, unknown>) => ({
    nodes: [{ id: "a", type: "text", x: 0, y: 0, width: 100, height: 80 }],
    edges: [{ id: "e", fromNode: "a", fromSide: "right", toNode: "a", toSide: "left" }],
    miroCanvas: { schemaVersion: 1, settings: {}, localOverrides: override },
  });

  it("projects a node that is only rotated locally", () => {
    const scene = buildSourceScene(board({ a: { rotation: -18 } }));
    // Without this the node reaches neither the renderer nor the geometry, so
    // it stays upright and its connectors end on a border it no longer has.
    expect(scene.items.get("a")).toMatchObject({ kind: "text", rotation: -18 });
  });

  it("projects a node that is only restyled locally", () => {
    const scene = buildSourceScene(board({ a: { colors: { fill: "#123456" } } }));
    expect(scene.items.get("a")?.kind).toBe("text");
    expect(scene.items.get("a")?.css["background-color"]).toBe("#123456");
  });

  it("ignores an override that changes nothing this renderer draws", () => {
    expect(buildSourceScene(board({ a: { locked: true } })).items.has("a")).toBe(false);
    expect(buildSourceScene(board({ a: { rotation: 0 } })).items.has("a")).toBe(false);
  });

  it("never turns an edge override into a node", () => {
    const scene = buildSourceScene(board({ e: { rotation: 45 } }));
    expect(scene.items.get("e")?.kind).toBe("connector");
  });
});

