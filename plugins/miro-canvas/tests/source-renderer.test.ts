import { describe, expect, it } from "vitest";
import { SourceRenderer } from "../src/source-renderer";
import { buildCanvasAnchorGeometry, updateConnectorEndpoint } from "../src/connector-endpoints";
import { resolveAnchor } from "../src/anchors";

class Element {
  nodeType = 1;
  children: Element[] = [];
  parentNode?: Element;
  attributes = new Map<string, string>();
  values = new Map<string, string>();
  priorities = new Map<string, string>();
  classes = new Set<string>();
  classList = { contains: (s: string) => this.classes.has(s), add: (s: string) => this.classes.add(s), remove: (s: string) => this.classes.delete(s) };
  style = {
    getPropertyValue: (s: string) => this.values.get(s) ?? "",
    getPropertyPriority: (s: string) => this.priorities.get(s) ?? "",
    setProperty: (s: string, value: string, priority = "") => { this.values.set(s, value); this.priorities.set(s, priority); },
    removeProperty: (s: string) => { this.values.delete(s); this.priorities.delete(s); },
  };
  constructor(public tagName: string) {}
  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  getAttribute(name: string) { return this.attributes.get(name) ?? null; }
  removeAttribute(name: string) { this.attributes.delete(name); }
  appendChild(child: Element) { child.parentNode = this; this.children.push(child); return child; }
  removeChild(child: Element) { this.children.splice(this.children.indexOf(child), 1); child.parentNode = undefined; }
  contains(child: Element): boolean { return this === child || this.children.some(item => item.contains(child)); }
  querySelectorAll(selector: string): Element[] {
    return this.children.flatMap(child => [...(child.tagName === selector ? [child] : []), ...child.querySelectorAll(selector)]);
  }
  closest(selector: string): Element | null {
    return selector.split(", ").includes(this.tagName) ? this : this.parentNode?.closest(selector) ?? null;
  }
}
const dom = { createElement: (tag: string) => new Element(tag), createElementNS: (_ns: string, tag: string) => new Element(tag) } as unknown as Document;
function fixture(shape = "triangle", routing = "straight") {
  let data: any = {
    nodes: [{ id: "a", type: "text", x: 0, y: 0, width: 100, height: 80 }, { id: "b", type: "text", x: 300, y: 200, width: 100, height: 80 }],
    edges: [{ id: "e", fromNode: "a", fromSide: "right", toNode: "b", toSide: "left", future: { keep: true } }],
    miroSource: { items: [{ id: "a", type: "shape", data: { shape }, style: { fillColor: "#123456", borderColor: "#abcdef", borderWidth: 3 } }],
      connectors: [{ id: "e", shape: routing, style: { strokeColor: "#223344", strokeWidth: 4, strokeStyle: "dashed", startStrokeCap: "circle", endStrokeCap: "stealth" } }], future: [1, 2] },
    miroCanvas: { schemaVersion: 1, localOverrides: { e: { connectorAnchors: { from: { type: "node", nodeId: "a", u: 1, v: 0.2 }, to: { type: "node", nodeId: "b", u: 0.25, v: 0.75 } }, opaque: ["keep"] } } }, unknown: { deep: 1 },
  };
  const nodeEl = new Element("div"), contentEl = new Element("div"); nodeEl.appendChild(contentEl);
  nodeEl.style.setProperty("background-color", "native-bg"); nodeEl.style.setProperty("border-color", "native-border");
  const edgeEl = new Element("g"), lineGroupEl = new Element("g"), lineEndGroupEl = new Element("g");
  edgeEl.appendChild(lineGroupEl); edgeEl.appendChild(lineEndGroupEl);
  const path = new Element("path"), hit = new Element("path");
  path.setAttribute("d", "M 100 40 L 300 240"); path.style.setProperty("stroke", "native-stroke", "important");
  hit.setAttribute("d", "M 100 40 L 300 240"); hit.classList.add("canvas-interaction-path"); hit.style.setProperty("stroke-width", "24");
  lineGroupEl.appendChild(path); lineGroupEl.appendChild(hit);
  let preview: { id: string; rotation: number } | undefined;
  let nodesVisible = true;
  const renderer = new SourceRenderer({
    getDocument: () => data,
    getNodes: () => nodesVisible ? [{ id: "a", nodeEl, contentEl }] : [],
    getEdges: () => [{ id: "e", edgeEl, lineGroupEl, lineEndGroupEl }],
    getRotationPreview: () => preview,
  }, dom);
  return {
    renderer, nodeEl, contentEl, path, hit, lineGroupEl, lineEndGroupEl,
    get data() { return data; }, set data(value: any) { data = value; },
    get preview() { return preview; }, set preview(value: { id: string; rotation: number } | undefined) { preview = value; },
    get nodesVisible() { return nodesVisible; }, set nodesVisible(value: boolean) { nodesVisible = value; },
  };
}

describe("reversible source geometry DOM", () => {
  it("renders exact U/V endpoints, stroke and real cap geometry; hit path follows without losing hit width", () => {
    const f = fixture(); const before = JSON.stringify(f.data);
    f.renderer.refresh();
    expect(f.path.getAttribute("d")).toBe("M 100 16 L 325 260");
    expect(f.hit.getAttribute("d")).toBe(f.path.getAttribute("d"));
    expect(f.hit.style.getPropertyValue("stroke-width")).toBe("24");
    expect(f.path.style.getPropertyValue("stroke")).toBe("#223344");
    expect(f.path.style.getPropertyValue("stroke-width")).toBe("4");
    expect(f.path.style.getPropertyValue("stroke-dasharray")).toBe("8 6");
    expect(f.path.getAttribute("marker-end")).toMatch(/^url\(#miro-cap-/);
    expect(f.lineGroupEl.querySelectorAll("marker")).toHaveLength(2);
    expect(f.lineGroupEl.querySelectorAll("marker")[1].querySelectorAll("path")[0].getAttribute("d")).toBe("M-10 -5L0 0L-10 5L-7 0Z");
    expect(f.lineEndGroupEl.style.getPropertyValue("display")).toBe("none");
    expect(JSON.stringify(f.data)).toBe(before);
    f.renderer.dispose();
    expect(f.path.getAttribute("d")).toBe("M 100 40 L 300 240");
    expect(f.path.style.getPropertyValue("stroke")).toBe("native-stroke");
    expect(f.path.style.getPropertyPriority("stroke")).toBe("important");
    expect(f.path.getAttribute("marker-end")).toBeNull();
    expect(f.lineGroupEl.querySelectorAll("defs")).toHaveLength(0);
    expect(f.lineEndGroupEl.style.getPropertyValue("display")).toBe("");
  });
  it.each(["straight", "elbowed", "curved"])("uses %s route for both rendering and edge anchors", routing => {
    const f = fixture("triangle", routing); f.renderer.refresh();
    const geometry = buildCanvasAnchorGeometry(f.data);
    expect(f.path.getAttribute("d")).toBe(geometry.edges?.e?.path);
    expect(f.path.getAttribute("d")).toContain(routing === "curved" ? " C " : " L ");
    expect(geometry.edges?.e?.points?.length).toBe(routing === "curved" ? 129 : routing === "elbowed" ? 4 : 2);
    const point = resolveAnchor({ type: "edge", edgeId: "e", t: 0.25 }, geometry).point!;
    if (routing === "elbowed") expect(point).toMatchObject({ x: 100, y: 133.25 });
    if (routing === "curved") expect(point.x).toBeLessThan(156.25); // not the straight chord
  });
  it.each(["triangle", "rhombus", "star", "circle", "cloud", "can", "left_brace", "flow_chart_document", "flow_chart_predefined_process", "flow_chart_delay"])("draws %s as a stroked SVG contour and restores native paint", shape => {
    const f = fixture(shape); f.renderer.refresh();
    const path = f.nodeEl.querySelectorAll("path")[0];
    expect(path).toBeDefined(); expect(path.getAttribute("d")).not.toBe("M0 0H100V100H0Z");
    expect(path.getAttribute("stroke")).toBe("#abcdef");
    expect(path.getAttribute("stroke-width")).toBe("3");
    expect(path.getAttribute("vector-effect")).toBe("non-scaling-stroke");
    expect(f.nodeEl.style.getPropertyValue("background-color")).toBe("transparent");
    expect(f.contentEl.parentNode).toBe(f.nodeEl);
    f.renderer.refresh(); expect(f.nodeEl.querySelectorAll("svg")).toHaveLength(1);
    f.renderer.dispose(); expect(f.nodeEl.querySelectorAll("svg")).toHaveLength(0);
    expect(f.nodeEl.style.getPropertyValue("background-color")).toBe("native-bg");
    expect(f.nodeEl.style.getPropertyValue("border-color")).toBe("native-border");
  });
  it("renders local anchors without source and respects document snapshots for undo/redo", () => {
    const f = fixture(); delete f.data.miroSource; const before = structuredClone(f.data);
    f.renderer.refresh(); expect(f.path.getAttribute("d")).toBe("M 100 16 L 325 260");
    const change = updateConnectorEndpoint(f.data, { edgeId: "e", end: "from", anchor: { type: "free", x: 13, y: 19 } });
    expect(change.ok).toBe(true); const after = change.document!;
    f.data = after; f.renderer.refresh(); expect(f.path.getAttribute("d")).toBe("M 13 19 L 325 260");
    f.data = before; f.renderer.refresh(); expect(f.path.getAttribute("d")).toBe("M 100 16 L 325 260");
    f.data = after; f.renderer.refresh(); expect(f.path.getAttribute("d")).toBe("M 13 19 L 325 260");
    expect(f.data.unknown).toEqual({ deep: 1 }); expect(f.data.edges[0].future).toEqual({ keep: true });
  });
  it("recomputes moved, resized and rotated anchor targets", () => {
    const f = fixture(); f.data.miroCanvas.localOverrides.a = { rotation: 90 };
    f.renderer.refresh(); expect(f.path.getAttribute("d")).toMatch(/^M 74 90 /);
    f.data.nodes[0].x = 20; f.data.nodes[0].width = 200;
    f.renderer.refresh(); expect(f.path.getAttribute("d")).toMatch(/^M 144 140 /);
  });
  it("retains newer native DOM changes during disposal", () => {
    const f = fixture(); f.renderer.refresh(); f.path.setAttribute("d", "M 1 2 L 3 4");
    f.path.style.setProperty("stroke", "new-native"); f.renderer.dispose();
    expect(f.path.getAttribute("d")).toBe("M 1 2 L 3 4"); expect(f.path.style.getPropertyValue("stroke")).toBe("new-native");
  });
  it("falls back for unknown shapes, unresolved anchors and unsupported caps", () => {
    const f = fixture("future_shape"); f.data.miroCanvas.localOverrides.e.connectorAnchors.from.nodeId = "missing";
    expect(f.renderer.refresh().some(s => s.startsWith("connector-geometry-fallback"))).toBe(true);
    expect(f.nodeEl.querySelectorAll("svg")).toHaveLength(0);
    expect(f.nodeEl.style.getPropertyValue("border-color")).toBe("#abcdef");
    expect(f.path.getAttribute("d")).toBe("M 100 40 L 300 240");
    f.data.miroCanvas.localOverrides.e.connectorAnchors.from.nodeId = "a";
    f.data.miroSource.connectors[0].style.endStrokeCap = "future_cap";
    expect(f.renderer.refresh().some(s => s.startsWith("connector-endcap-fallback"))).toBe(true);
    expect(f.path.getAttribute("d")).toBe("M 100 40 L 300 240");
    expect(f.lineEndGroupEl.style.getPropertyValue("display")).toBe("");
  });
});

describe("shape text insets", () => {
  it("reserves room inside a contour so the text stays within the shape", () => {
    const f = fixture("triangle");
    f.renderer.refresh();
    // Top gives up the most room: a triangle has almost no width up there.
    // The largest rectangle inside a triangle is its lower half, and the
    // reserve is in pixels of the node's own 100x80 box, not percentages:
    // a percentage padding resolves against the width on every side.
    expect(f.contentEl.style.getPropertyValue("padding")).toBe("40px 25px 0px 25px");
    // The box is pinned so the reserve cannot inflate the node instead.
    expect(f.contentEl.style.getPropertyValue("box-sizing")).toBe("border-box");
    expect(f.contentEl.style.getPropertyValue("height")).toBe("100%");
  });

  it("leaves a rectangle alone and restores an inset shape on dispose", () => {
    const rectangle = fixture("rectangle");
    rectangle.renderer.refresh();
    expect(rectangle.contentEl.style.getPropertyValue("padding")).toBe("");
    const ellipse = fixture("circle");
    ellipse.renderer.refresh();
    // The inscribed square of a circle: 50 - 50/sqrt(2) of each dimension.
    expect(ellipse.contentEl.style.getPropertyValue("padding")).toBe("11.7px 14.7px 11.7px 14.7px");
    ellipse.renderer.dispose();
    expect(ellipse.contentEl.style.getPropertyValue("padding")).toBe("");
  });
});

describe("native paint markers", () => {
  it("rotates the complete node shell and restores the host transform", () => {
    const f = fixture("rectangle");
    f.nodeEl.style.setProperty("transform", "translate(10px, 20px)");
    const data = f.data;
    data.miroCanvas = { schemaVersion: 1, settings: {}, localOverrides: { a: { rotation: 24 } } };
    f.data = data;
    f.renderer.refresh();
    expect(f.nodeEl.getAttribute("data-miro-source-rotated")).toBe("true");
    expect(f.nodeEl.style.getPropertyValue("transform")).toBe("translate(10px, 20px) rotate(24deg)");
    expect(f.contentEl.style.getPropertyValue("transform")).toBe("");
    f.renderer.dispose();
    expect(f.nodeEl.getAttribute("data-miro-source-rotated")).toBe(null);
    expect(f.nodeEl.style.getPropertyValue("transform")).toBe("translate(10px, 20px)");
  });

  it("uses the renderer as the single writer for rotation previews", () => {
    const f = fixture("rectangle");
    f.data.miroCanvas = { schemaVersion: 1, settings: {}, localOverrides: { a: { rotation: 10 } } };
    f.renderer.refresh();
    expect(f.nodeEl.style.getPropertyValue("transform")).toContain("rotate(10deg)");
    f.preview = { id: "a", rotation: 55 };
    f.renderer.refresh();
    expect(f.nodeEl.style.getPropertyValue("transform")).toContain("rotate(55deg)");
    f.preview = undefined;
    f.renderer.refresh();
    expect(f.nodeEl.style.getPropertyValue("transform")).toContain("rotate(10deg)");
  });

  it("reapplies rotation after the host rewrites its transform", () => {
    const f = fixture("rectangle");
    f.data.miroCanvas = { schemaVersion: 1, settings: {}, localOverrides: { a: { rotation: 24 } } };
    f.nodeEl.style.setProperty("transform", "translate(10px, 20px)");
    f.renderer.refresh();
    f.nodeEl.style.setProperty("transform", "translate(30px, 40px)");
    f.renderer.refresh();
    expect(f.nodeEl.style.getPropertyValue("transform")).toBe("translate(30px, 40px) rotate(24deg)");
  });

  it("replaces every stale plugin rotation instead of accumulating on reselection", () => {
    const f = fixture("rectangle");
    f.data.miroCanvas = { schemaVersion: 1, settings: {}, localOverrides: { a: { rotation: 24 } } };
    f.nodeEl.style.setProperty("transform", "translate(10px, 20px) rotate(90deg) rotate(24deg)");
    f.renderer.refresh();
    expect(f.nodeEl.style.getPropertyValue("transform")).toBe("translate(10px, 20px) rotate(24deg)");
    for (let pass = 0; pass < 5; pass += 1) {
      f.nodeEl.style.setProperty("transform", `${f.nodeEl.style.getPropertyValue("transform")} rotate(24deg)`);
      f.renderer.refresh();
      expect(f.nodeEl.style.getPropertyValue("transform")).toBe("translate(10px, 20px) rotate(24deg)");
    }
    f.renderer.dispose();
    expect(f.nodeEl.style.getPropertyValue("transform")).toBe("translate(10px, 20px)");
  });

  it("skips an intact projection, rebuilds a removed layer, and clears stale decoration", () => {
    const f = fixture("rectangle");
    f.renderer.refresh();
    let writes = 0;
    const setProperty = f.nodeEl.style.setProperty;
    f.nodeEl.style.setProperty = (name: string, value: string, priority = "") => {
      writes += 1;
      setProperty.call(f.nodeEl.style, name, value, priority);
    };
    f.renderer.refresh();
    expect(writes).toBe(0);

    const layer = f.nodeEl.children.find((child) => child.getAttribute("data-miro-source-decoration") !== null)!;
    f.nodeEl.removeChild(layer);
    f.renderer.refresh();
    expect(f.nodeEl.children.some((child) => child.getAttribute("data-miro-source-decoration") !== null)).toBe(true);

    f.data = { nodes: f.data.nodes, edges: [] };
    f.renderer.refresh();
    expect(f.nodeEl.getAttribute("data-miro-source-kind")).toBe(null);
    expect(f.nodeEl.children.some((child) => child.getAttribute("data-miro-source-decoration") !== null)).toBe(false);
  });

  it("retries incomplete projections and preserves render diagnostics across intact refreshes", () => {
    const f = fixture("rectangle");
    f.nodesVisible = false;
    expect(f.renderer.refresh()).toContain("node-runtime-missing: a.");
    f.nodesVisible = true;
    expect(f.renderer.refresh()).not.toContain("node-runtime-missing: a.");
    expect(f.nodeEl.getAttribute("data-miro-source-kind")).toBe("shape");

    f.data.miroSource.connectors[0].style.endStrokeCap = "future_cap";
    expect(f.renderer.refresh().some((item) => item.startsWith("connector-endcap-fallback"))).toBe(true);
    expect(f.renderer.refresh().some((item) => item.startsWith("connector-endcap-fallback"))).toBe(true);
  });

  it("leaves an upright node unmarked", () => {
    const f = fixture("rectangle");
    f.renderer.refresh();
    expect(f.nodeEl.getAttribute("data-miro-source-rotated")).toBe(null);
    // The shape marker is what the stylesheet keys the contour override on.
    expect(f.nodeEl.getAttribute("data-miro-source-kind")).toBe("shape");
  });
});

describe("source-backed code rendering", () => {
  it("adds reversible code chrome and metadata without replacing editable content", () => {
    const nativeText = '<p><strong>Example</strong> · JavaScript · line-numbers</p><pre><code>const answer = 42;</code></pre>';
    const data: any = {
      nodes: [{ id: "code-1", type: "text", text: nativeText, x: 0, y: 0, width: 360, height: 180 }],
      edges: [],
      miroSource: { items: [{
        id: "code-1",
        type: "code",
        data: {
          title: "Example",
          language: "JavaScript",
          lineNumbersVisible: true,
          code: "const answer = 42;",
          content: "<script>must stay inert</script>",
          url: "javascript:alert(1)",
        },
        future: { keep: true },
      }], future: { keep: true } },
      unknown: { keep: true },
    };
    const before = JSON.stringify(data);
    const nodeEl = new Element("div"), contentEl = new Element("div");
    (contentEl as any).textContent = nativeText;
    nodeEl.appendChild(contentEl);
    const renderer = new SourceRenderer({
      getDocument: () => data,
      getNodes: () => [{ id: "code-1", nodeEl, contentEl }],
      getEdges: () => [],
    }, dom);

    renderer.refresh();
    expect(nodeEl.getAttribute("data-miro-source-kind")).toBe("code");
    expect(nodeEl.getAttribute("data-miro-source-code-title")).toBe("Example");
    expect(nodeEl.getAttribute("data-miro-source-code-language")).toBe("JavaScript");
    expect(nodeEl.getAttribute("data-miro-source-code-line-numbers")).toBe("true");
    expect(nodeEl.querySelectorAll("div")).toHaveLength(2);
    expect((contentEl as any).textContent).toBe(nativeText);
    expect(JSON.stringify(data)).toBe(before);

    renderer.refresh();
    expect(nodeEl.querySelectorAll("div")).toHaveLength(2);
    renderer.dispose();
    expect(nodeEl.querySelectorAll("div")).toHaveLength(1);
    expect(nodeEl.getAttribute("data-miro-source-kind")).toBeNull();
    expect(nodeEl.getAttribute("data-miro-source-code-title")).toBeNull();
    expect(nodeEl.getAttribute("data-miro-source-code-language")).toBeNull();
    expect(nodeEl.getAttribute("data-miro-source-code-line-numbers")).toBeNull();
    expect((contentEl as any).textContent).toBe(nativeText);
    expect(data.miroSource.items[0].future).toEqual({ keep: true });
    expect(data.unknown).toEqual({ keep: true });
  });
});

describe("source-backed app-card rendering", () => {
  it("adds reversible card chrome without copying source fields into the DOM", () => {
    const nativeText = "<p><strong>Status:</strong> In Progress</p>";
    const data: any = {
      nodes: [{ id: "app-card-1", type: "text", text: nativeText, x: 0, y: 0, width: 360, height: 260 }],
      edges: [],
      miroSource: { items: [{
        id: "app-card-1",
        type: "app_card",
        data: {
          title: "Task",
          description: "Track export",
          url: "javascript:alert(1)",
          fields: [{ label: "Status", value: "In Progress", html: "<script>unsafe</script>" }],
        },
        style: { cardTheme: "#2d9bf0" },
        future: { keep: true },
      }] },
    };
    const before = JSON.stringify(data);
    const nodeEl = new Element("div"), contentEl = new Element("div");
    (contentEl as any).textContent = nativeText;
    nodeEl.appendChild(contentEl);
    const renderer = new SourceRenderer({
      getDocument: () => data,
      getNodes: () => [{ id: "app-card-1", nodeEl, contentEl }],
      getEdges: () => [],
    }, dom);

    renderer.refresh();
    expect(nodeEl.classList.contains("miro-source-app-card")).toBe(true);
    expect(nodeEl.getAttribute("data-miro-source-card-kind")).toBe("app_card");
    expect(nodeEl.getAttribute("data-miro-source-card-fields")).toBe("1");
    expect(nodeEl.getAttribute("data-miro-source-card-title")).toBe("true");
    expect(nodeEl.getAttribute("data-miro-source-card-description")).toBe("true");
    const decoration = nodeEl.children.find((child) => child.classList.contains("miro-source-decoration-app-card"));
    expect(decoration).toBeDefined();
    expect(decoration?.style.getPropertyValue("background-color")).toBe("#2d9bf0");
    expect((contentEl as any).textContent).toBe(nativeText);
    expect(JSON.stringify(data)).toBe(before);

    renderer.refresh();
    expect(nodeEl.children.filter((child) => child.classList.contains("miro-source-decoration-app-card"))).toHaveLength(1);
    renderer.dispose();
    expect(nodeEl.classList.contains("miro-source-app-card")).toBe(false);
    expect(nodeEl.getAttribute("data-miro-source-card-kind")).toBeNull();
    expect(nodeEl.getAttribute("data-miro-source-card-fields")).toBeNull();
    expect(nodeEl.children.filter((child) => child.classList.contains("miro-source-decoration-app-card"))).toHaveLength(0);
    expect((contentEl as any).textContent).toBe(nativeText);
    expect(data.miroSource.items[0].future).toEqual({ keep: true });
  });
});

describe("source-backed preview rendering", () => {
  it("adds reversible inert preview chrome while keeping the native link untouched", () => {
    const data: any = {
      nodes: [{ id: "preview-1", type: "link", url: "https://example.test/article", x: 0, y: 0, width: 400, height: 225 }],
      edges: [],
      miroSource: { items: [{
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
        future: { keep: true },
      }] },
    };
    const before = JSON.stringify(data);
    const nodeEl = new Element("div"), contentEl = new Element("a");
    contentEl.setAttribute("href", "https://example.test/article");
    nodeEl.appendChild(contentEl);
    const renderer = new SourceRenderer({
      getDocument: () => data,
      getNodes: () => [{ id: "preview-1", nodeEl, contentEl }],
      getEdges: () => [],
    }, dom);

    renderer.refresh();
    expect(nodeEl.classList.contains("miro-source-preview")).toBe(true);
    expect(nodeEl.getAttribute("data-miro-source-preview-title")).toBe("true");
    expect(nodeEl.getAttribute("data-miro-source-preview-provider")).toBe("true");
    expect(nodeEl.getAttribute("data-miro-source-preview-target")).toBe("true");
    expect(nodeEl.getAttribute("data-miro-source-preview-asset")).toBe("true");
    const decoration = nodeEl.children.find((child) => child.classList.contains("miro-source-decoration-preview"));
    expect(decoration?.style.getPropertyValue("pointer-events")).toBe("none");
    expect(decoration?.style.getPropertyValue("z-index")).toBe("2");
    expect((decoration?.children.find((child) => child.classList.contains("miro-source-preview-meta"))?.children ?? [])
      .map((child) => (child as any).textContent)).toEqual(["Example", "Article", "Saved preview"]);
    expect(contentEl.getAttribute("href")).toBe("https://example.test/article");
    expect(JSON.stringify(data)).toBe(before);

    renderer.refresh();
    expect(nodeEl.children.filter((child) => child.classList.contains("miro-source-decoration-preview"))).toHaveLength(1);
    renderer.dispose();
    expect(nodeEl.classList.contains("miro-source-preview")).toBe(false);
    expect(nodeEl.getAttribute("data-miro-source-preview-target")).toBeNull();
    expect(nodeEl.children.filter((child) => child.classList.contains("miro-source-decoration-preview"))).toHaveLength(0);
    expect(contentEl.getAttribute("href")).toBe("https://example.test/article");
    expect(data.miroSource.items[0].future).toEqual({ keep: true });
  });
});

describe("source-backed card tags", () => {
  it("renders safe inert chips and restores the untouched native card", () => {
    const nativeText = "<p><strong>Release</strong></p><p>Status: Ready</p>";
    const data: any = {
      nodes: [{ id: "card-1", type: "text", text: nativeText, x: 0, y: 0, width: 360, height: 240 }],
      edges: [],
      miroSource: { items: [
        { id: "tag-todo", type: "tag", title: "Todo", color: "yellow" },
        { id: "tag-urgent", type: "tag", title: "Urgent", color: "#ea94bb" },
        {
          id: "card-1",
          type: "card",
          data: { title: "Release", dueDate: "2026-06-30", fields: [{ value: "Ready" }], tagIds: ["tag-todo", "tag-urgent"] },
          style: { cardTheme: "#4262ff" },
          future: { keep: true },
        },
      ] },
    };
    const before = JSON.stringify(data);
    const nodeEl = new Element("div"), contentEl = new Element("div");
    (contentEl as any).textContent = nativeText;
    nodeEl.appendChild(contentEl);
    const renderer = new SourceRenderer({
      getDocument: () => data,
      getNodes: () => [{ id: "card-1", nodeEl, contentEl }],
      getEdges: () => [],
    }, dom);

    renderer.refresh();
    expect(nodeEl.classList.contains("miro-source-card")).toBe(true);
    expect(nodeEl.getAttribute("data-miro-source-card-kind")).toBe("card");
    expect(nodeEl.getAttribute("data-miro-source-card-due-date")).toBe("true");
    const tagList = nodeEl.children.find((child) => child.classList.contains("miro-source-tag-list"));
    expect(tagList?.style.getPropertyValue("pointer-events")).toBe("none");
    expect(tagList?.children.map((child) => (child as any).textContent)).toEqual(["Todo", "Urgent"]);
    expect(tagList?.children.map((child) => child.style.getPropertyValue("background-color"))).toEqual(["#ffd02f", "#ea94bb"]);
    expect((contentEl as any).textContent).toBe(nativeText);
    expect(JSON.stringify(data)).toBe(before);

    renderer.refresh();
    expect(nodeEl.children.filter((child) => child.classList.contains("miro-source-tag-list"))).toHaveLength(1);
    renderer.dispose();
    expect(nodeEl.children.filter((child) => child.classList.contains("miro-source-tag-list"))).toHaveLength(0);
    expect(nodeEl.getAttribute("data-miro-source-card-kind")).toBeNull();
    expect((contentEl as any).textContent).toBe(nativeText);
    expect(data.miroSource.items[2].future).toEqual({ keep: true });
  });
});

describe("source-backed mindmap rendering", () => {
  it("decorates native nodes and hierarchy edges reversibly", () => {
    const data: any = {
      nodes: [
        { id: "mind-root", type: "text", text: "Root", x: 0, y: 0, width: 140, height: 64 },
        { id: "mind-child", type: "text", text: "Child", x: 260, y: 20, width: 110, height: 36 },
      ],
      edges: [{ id: "mindmap-mind-root-mind-child", fromNode: "mind-root", toNode: "mind-child" }],
      miroSource: { items: [
        { id: "mind-root", type: "mindmap_node", style: { nodeColor: "#1a85ff", shape: "rounded_rectangle" }, data: { isRoot: true, nodeView: { data: { content: "<p>Root</p>" } } } },
        { id: "mind-child", type: "mindmap_node", parent: { id: "mind-root" }, style: { nodeColor: "#7a28ff", shape: "none" }, data: { nodeView: { data: { content: "<p>Child</p>" } } } },
      ], future: { keep: true } },
    };
    const before = JSON.stringify(data);
    const rootEl = new Element("div"), rootContent = new Element("div"); rootEl.appendChild(rootContent);
    const childEl = new Element("div"), childContent = new Element("div"); childEl.appendChild(childContent);
    const edgeEl = new Element("g"), lineGroupEl = new Element("g"), lineEndGroupEl = new Element("g");
    edgeEl.appendChild(lineGroupEl); edgeEl.appendChild(lineEndGroupEl);
    const path = new Element("path"), hit = new Element("path");
    path.setAttribute("d", "M 140 32 L 260 38"); hit.setAttribute("d", "M 140 32 L 260 38");
    hit.classList.add("canvas-interaction-path"); lineGroupEl.appendChild(path); lineGroupEl.appendChild(hit);
    const renderer = new SourceRenderer({
      getDocument: () => data,
      getNodes: () => [{ id: "mind-root", nodeEl: rootEl, contentEl: rootContent }, { id: "mind-child", nodeEl: childEl, contentEl: childContent }],
      getEdges: () => [{ id: "mindmap-mind-root-mind-child", edgeEl, lineGroupEl, lineEndGroupEl }],
    }, dom);

    renderer.refresh();
    expect(rootEl.getAttribute("data-miro-source-mindmap-root")).toBe("true");
    expect(childEl.getAttribute("data-miro-source-mindmap-root")).toBe("false");
    expect(rootEl.children.some((child) => child.classList.contains("miro-source-decoration-mindmap-node"))).toBe(true);
    expect(edgeEl.getAttribute("data-miro-source-mindmap-edge")).toBe("true");
    expect(path.style.getPropertyValue("stroke")).toBe("#7a28ff");
    expect(path.getAttribute("marker-start")).toBe("none");
    expect(path.getAttribute("marker-end")).toBe("none");
    expect(JSON.stringify(data)).toBe(before);

    renderer.refresh();
    expect(rootEl.children.filter((child) => child.classList.contains("miro-source-decoration-mindmap-node"))).toHaveLength(1);
    renderer.dispose();
    expect(rootEl.getAttribute("data-miro-source-mindmap-root")).toBeNull();
    expect(edgeEl.getAttribute("data-miro-source-mindmap-edge")).toBeNull();
    expect(rootEl.children.filter((child) => child.classList.contains("miro-source-decoration-mindmap-node"))).toHaveLength(0);
    expect(path.getAttribute("d")).toBe("M 140 32 L 260 38");
    expect(data.miroSource.future).toEqual({ keep: true });
  });
});


