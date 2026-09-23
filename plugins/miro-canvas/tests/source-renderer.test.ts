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
function fixture(shape = "triangle", routing = "straight", document: Document = dom) {
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
  }, document);
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
    f.renderer.refresh(); expect(f.path.getAttribute("d")).toMatch(/^M 100 16 L 107 16 M 107 16 C .* 325 267$/);
    const change = updateConnectorEndpoint(f.data, { edgeId: "e", end: "from", anchor: { type: "free", x: 13, y: 19 } });
    expect(change.ok).toBe(true); const after = change.document!;
    f.data = after; f.renderer.refresh(); expect(f.path.getAttribute("d")).toMatch(/^M 13 19 L 18.54 23.279 M 18.54 23.279 C .* 325 267$/);
    f.data = before; f.renderer.refresh(); expect(f.path.getAttribute("d")).toMatch(/^M 100 16 L 107 16 M 107 16 C .* 325 267$/);
    f.data = after; f.renderer.refresh(); expect(f.path.getAttribute("d")).toMatch(/^M 13 19 L 18.54 23.279 M 18.54 23.279 C .* 325 267$/);
    expect(f.data.unknown).toEqual({ deep: 1 }); expect(f.data.edges[0].future).toEqual({ keep: true });
  });
  it("recomputes moved, resized and rotated anchor targets", () => {
    const f = fixture(); f.data.miroCanvas.localOverrides.a = { rotation: 90 };
    f.renderer.refresh(); expect(f.path.getAttribute("d")).toMatch(/^M 74 90 /);
    f.data.nodes[0].x = 20; f.data.nodes[0].width = 200;
    f.renderer.refresh(); expect(f.path.getAttribute("d")).toMatch(/^M 144 140 /);
  });
  it("aims anchored connectors at the angle a node is being turned to", () => {
    const f = fixture();
    f.renderer.refresh(); expect(f.path.getAttribute("d")).toMatch(/^M 100 16 /);
    // Mid-gesture the node is shown at the preview angle; its connectors must be too.
    f.preview = { id: "a", rotation: 90 };
    f.renderer.refresh(); expect(f.path.getAttribute("d")).toMatch(/^M 74 90 /);
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
  it("rotates the complete shape once, after the host transform", () => {
    const f = fixture("rectangle");
    f.nodeEl.style.setProperty("transform", "translate(10px, 20px)");
    const data = f.data;
    data.miroCanvas = { schemaVersion: 1, settings: {}, localOverrides: { a: { rotation: 24 } } };
    f.data = data;
    f.renderer.refresh();
    const decoration = f.nodeEl.children.find((item) => item.getAttribute("data-miro-source-decoration") === "shape")!;
    expect(f.nodeEl.getAttribute("data-miro-source-rotated")).toBe("true");
    // After the translate, so the node turns about its own centre; the
    // independent rotate property would turn the translate as well.
    expect(f.nodeEl.style.getPropertyValue("transform")).toBe("translate(10px, 20px) rotate(24deg)");
    expect(f.nodeEl.style.getPropertyValue("rotate")).toBe("");
    expect(decoration.style.getPropertyValue("transform")).toBe("");
    expect(f.contentEl.style.getPropertyValue("transform")).toBe("");
    expect(f.nodeEl.style.getPropertyValue("isolation")).toBe("");
    expect(f.contentEl.style.getPropertyValue("text-rendering")).toBe("geometricPrecision");
    f.renderer.dispose();
    expect(f.nodeEl.getAttribute("data-miro-source-rotated")).toBe(null);
    expect(f.nodeEl.style.getPropertyValue("transform")).toBe("translate(10px, 20px)");
    expect(f.nodeEl.style.getPropertyValue("rotate")).toBe("");
  });

  it("uses the renderer as the single writer for rotation previews", () => {
    const f = fixture("rectangle");
    f.data.miroCanvas = { schemaVersion: 1, settings: {}, localOverrides: { a: { rotation: 10 } } };
    f.renderer.refresh();
    expect(f.nodeEl.style.getPropertyValue("transform")).toBe("rotate(10deg)");
    f.preview = { id: "a", rotation: 55 };
    f.renderer.refresh();
    expect(f.nodeEl.style.getPropertyValue("transform")).toBe("rotate(55deg)");
    f.preview = undefined;
    f.renderer.refresh();
    expect(f.nodeEl.style.getPropertyValue("transform")).toBe("rotate(10deg)");
  });

  it("uses the same whole-node rotation for a plain local text node", () => {
    const f = fixture("rectangle");
    delete f.data.miroSource;
    f.data.miroCanvas.localOverrides.a = { rotation: 31 };
    f.renderer.refresh();
    expect(f.nodeEl.style.getPropertyValue("transform")).toBe("rotate(31deg)");
    expect(f.contentEl.style.getPropertyValue("transform")).toBe("");
    expect(f.nodeEl.style.getPropertyValue("isolation")).toBe("");
  });

  it("keeps one absolute rotation when selection rewrites the host transform", () => {
    const f = fixture("rectangle");
    f.data.miroCanvas = { schemaVersion: 1, settings: {}, localOverrides: { a: { rotation: 24 } } };
    f.nodeEl.style.setProperty("transform", "translate(10px, 20px)");
    f.renderer.refresh();
    for (let selection = 0; selection < 5; selection += 1) {
      f.nodeEl.style.setProperty("transform", `translate(${30 + selection}px, 40px)`);
      f.renderer.refresh();
      expect(f.nodeEl.style.getPropertyValue("transform")).toBe(`translate(${30 + selection}px, 40px) rotate(24deg)`);
      expect(f.contentEl.style.getPropertyValue("transform")).toBe("");
    }
  });

  it("preserves an unmarked host rotation and repairs marked legacy suffixes", () => {
    const f = fixture("rectangle");
    f.data.miroCanvas = { schemaVersion: 1, settings: {}, localOverrides: { a: { rotation: 24 } } };
    f.nodeEl.style.setProperty("transform", "translate(10px, 20px) rotate(90deg)");
    f.contentEl.style.setProperty("transform", "rotate(24deg) rotate(24deg)");
    f.contentEl.setAttribute("data-miro-source-owned-rotation", "24");
    f.renderer.refresh();
    expect(f.nodeEl.style.getPropertyValue("transform")).toBe("translate(10px, 20px) rotate(90deg) rotate(24deg)");
    expect(f.contentEl.style.getPropertyValue("transform")).toBe("");
    expect(f.contentEl.getAttribute("data-miro-source-owned-rotation")).toBe(null);
    // Each pass renders again: the preview changes the signature every time.
    for (let pass = 0; pass < 5; pass += 1) {
      f.preview = pass % 2 === 0 ? { id: "a", rotation: 24 } : undefined;
      f.renderer.refresh();
    }
    expect(f.nodeEl.style.getPropertyValue("transform")).toBe("translate(10px, 20px) rotate(90deg) rotate(24deg)");
    f.renderer.dispose();
    expect(f.nodeEl.style.getPropertyValue("transform")).toBe("translate(10px, 20px) rotate(90deg)");
    expect(f.contentEl.style.getPropertyValue("transform")).toBe("");
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

  it("does not rebuild everything while one item has no runtime or is scrolled away", () => {
    const f = fixture("rectangle");
    // Metadata for a node the host does not hold, as a deleted item leaves behind.
    f.data.miroCanvas.localOverrides.b = { rotation: 15 };
    expect(f.renderer.refresh()).toContain("node-runtime-missing: b.");
    let writes = 0;
    const setProperty = f.nodeEl.style.setProperty;
    f.nodeEl.style.setProperty = (name: string, value: string, priority = "") => {
      writes += 1;
      setProperty.call(f.nodeEl.style, name, value, priority);
    };
    expect(f.renderer.refresh()).toContain("node-runtime-missing: b.");
    expect(writes).toBe(0);
    // Native Canvas detaches a node outside the viewport; it keeps its decoration.
    (f.nodeEl as unknown as { isConnected: boolean }).isConnected = false;
    f.renderer.refresh();
    expect(writes).toBe(0);
    expect(f.nodeEl.getAttribute("data-miro-source-kind")).toBe("shape");
  });

  it("renders again when a runtime appears, builds its content, or is replaced", () => {
    const data: any = {
      nodes: [{ id: "a", type: "text", text: "", x: 0, y: 0, width: 100, height: 80 }],
      edges: [],
      miroCanvas: { schemaVersion: 1, localOverrides: { a: { rotation: 20 } } },
    };
    let runtime: Record<string, unknown> | undefined;
    const renderer = new SourceRenderer({ getDocument: () => data, getNodes: () => runtime === undefined ? [] : [runtime], getEdges: () => [] }, dom);
    expect(renderer.refresh()).toContain("node-runtime-missing: a.");
    const first = new Element("div");
    runtime = { id: "a", nodeEl: first, initialized: false };
    renderer.refresh();
    expect(first.style.getPropertyValue("transform")).toBe("rotate(20deg)");
    let writes = 0;
    const setProperty = first.style.setProperty;
    first.style.setProperty = (name: string, value: string, priority = "") => {
      writes += 1;
      setProperty.call(first.style, name, value, priority);
    };
    renderer.refresh();
    expect(writes).toBe(0);
    // Native Canvas builds a node's container the first time it is shown.
    const container = new Element("div"); first.appendChild(container);
    runtime = { ...runtime, containerEl: container, initialized: true };
    renderer.refresh();
    expect(writes).toBeGreaterThan(0);
    expect(first.style.getPropertyValue("transform")).toBe("rotate(20deg)");
    // A host that swaps the element for a new one gets the decoration moved over.
    const second = new Element("div");
    runtime = { id: "a", nodeEl: second, initialized: true };
    renderer.refresh();
    expect(second.style.getPropertyValue("transform")).toBe("rotate(20deg)");
    expect(first.style.getPropertyValue("transform")).toBe("");
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
      getNodes: () => [{ id: "code-1", nodeEl, contentEl, text: nativeText }],
      getEdges: () => [],
    }, dom);

    renderer.refresh();
    expect(nodeEl.getAttribute("data-miro-source-kind")).toBe("code");
    expect(nodeEl.getAttribute("data-miro-source-code-title")).toBe("Example");
    expect(nodeEl.getAttribute("data-miro-source-code-language")).toBe("JavaScript");
    expect(nodeEl.getAttribute("data-miro-source-code-line-numbers")).toBe("true");
    // The layer and the title above the panel; the code stays native.
    const divs = nodeEl.querySelectorAll("div");
    expect(divs).toHaveLength(3);
    expect(divs.find((item) => item.classes.has("miro-source-code-title"))).toMatchObject({ textContent: "Example" });
    expect(nodeEl.getAttribute("data-miro-source-code-numbered")).toBe("true");
    expect(nodeEl.style.getPropertyValue("--miro-code-lines")).toBe("\"1\"");
    expect(nodeEl.style.getPropertyValue("--miro-code-gutter")).toBe("1ch");
    expect((contentEl as any).textContent).toBe(nativeText);
    expect(JSON.stringify(data)).toBe(before);

    renderer.refresh();
    expect(nodeEl.querySelectorAll("div")).toHaveLength(3);
    renderer.dispose();
    expect(nodeEl.querySelectorAll("div")).toHaveLength(1);
    expect(nodeEl.style.getPropertyValue("--miro-code-lines")).toBe("");
    expect(nodeEl.getAttribute("data-miro-source-code-numbered")).toBeNull();
    expect(nodeEl.getAttribute("data-miro-source-kind")).toBeNull();
    expect(nodeEl.getAttribute("data-miro-source-code-title")).toBeNull();
    expect(nodeEl.getAttribute("data-miro-source-code-language")).toBeNull();
    expect(nodeEl.getAttribute("data-miro-source-code-line-numbers")).toBeNull();
    expect((contentEl as any).textContent).toBe(nativeText);
    expect(data.miroSource.items[0].future).toEqual({ keep: true });
    expect(data.unknown).toEqual({ keep: true });
  });
});

describe("source-backed document and embed cards", () => {
  function cardFixture(item: Record<string, unknown>, runtime: Record<string, unknown>) {
    const nodeEl = new Element("div"), contentEl = new Element("div");
    nodeEl.appendChild(contentEl);
    const data = {
      nodes: [{ id: "d", type: "link", x: 0, y: 0, width: 300, height: 400 }],
      edges: [],
      miroSource: { items: [{ id: "d", ...item }] },
    };
    const renderer = new SourceRenderer({
      getDocument: () => data,
      getNodes: () => [{ id: "d", nodeEl, contentEl, ...runtime }],
      getEdges: () => [],
    }, dom);
    renderer.refresh();
    const layer = nodeEl.children.find((child) => child.classes.has("miro-source-decoration"))!;
    return { renderer, nodeEl, layer };
  }
  const words = (element: Element): string[] => [
    ...((element as any).textContent ? [(element as any).textContent] : []),
    ...element.children.flatMap(words),
  ];

  it("covers a document without a file with a card naming its type", () => {
    const f = cardFixture(
      { type: "document", data: { title: "Specification.pdf", documentUrl: "https://files.invalid/x.pdf" } },
      { url: "https://files.invalid/x.pdf" },
    );
    expect(f.nodeEl.classes.has("miro-source-document")).toBe(true);
    expect(f.layer.classes.has("miro-source-decoration-document")).toBe(true);
    expect(f.layer.style.getPropertyValue("z-index")).toBe("2");
    const icon = f.layer.querySelectorAll("div").find((item) => item.classes.has("miro-source-document-icon"))!;
    expect(icon.getAttribute("data-extension")).toBe("PDF");
    expect(words(f.layer)).toEqual(["PDF", "Specification.pdf", "files.invalid"]);
    f.renderer.dispose();
    expect(f.nodeEl.classes.has("miro-source-document")).toBe(false);
    expect(f.nodeEl.children).toHaveLength(1);
  });

  it("names a document that has a file above its native preview", () => {
    const f = cardFixture({ type: "document", data: { title: "Brief.docx" } }, { file: { path: "a/Brief.docx" } });
    expect(f.nodeEl.getAttribute("data-miro-source-host")).toBe("file");
    expect(f.layer.style.getPropertyValue("z-index")).toBe("0");
    expect(f.layer.children.map((child) => [...child.classes][0])).toEqual(["miro-source-caption"]);
    expect(words(f.layer)).toEqual(["Brief.docx"]);
  });

  it("shows a Miro doc's opening words and frames an embed", () => {
    const doc = cardFixture(
      { type: "doc_format", data: { html: "<h1>Notes</h1><script>steal()</script><p>Agenda &amp; decisions</p>" } },
      { text: "<p>[doc format]</p>" },
    );
    expect(words(doc.layer)).toEqual(["DOC", "Document", "Notes Agenda & decisions"]);
    const embed = cardFixture({ type: "embed", data: { providerName: "YouTube", html: "<iframe></iframe>" } }, { url: "https://youtube.test/v" });
    expect(embed.nodeEl.classes.has("miro-source-embed")).toBe(true);
    expect(embed.layer.style.getPropertyValue("z-index")).toBe("0");
    expect(embed.layer.children).toHaveLength(0);
  });
});

describe("presentations, groups and ink", () => {
  function scene(items: unknown[], nodes: { id: string; [key: string]: unknown }[], onDeckAction?: (deckId: string, action: string) => void) {
    const elements = new Map(nodes.map((node) => {
      const nodeEl = new Element("div"), containerEl = new Element("div"), contentEl = new Element("div");
      nodeEl.appendChild(containerEl); containerEl.appendChild(contentEl);
      return [node.id, { id: node.id, nodeEl, containerEl, contentEl }] as const;
    }));
    const data = { nodes: nodes.map((node) => ({ x: 0, y: 0, width: 100, height: 60, ...node })), edges: [], miroSource: { items } };
    const renderer = new SourceRenderer({
      getDocument: () => data,
      getNodes: () => [...elements.values()],
      getEdges: () => [],
      ...(onDeckAction === undefined ? {} : { onDeckAction }),
    }, dom);
    renderer.refresh();
    return { renderer, el: (id: string) => elements.get(id)! };
  }
  it("puts Miro's bar over a presentation and runs its buttons without reaching the board", () => {
    const actions: string[] = [];
    const created: Element[] = [];
    const handlers = new Map<Element, Map<string, (event: unknown) => void>>();
    const recording = {
      createElement: (tag: string) => {
        const element = new Element(tag);
        created.push(element);
        (element as any).addEventListener = (type: string, listener: (event: unknown) => void) => {
          handlers.set(element, new Map([...(handlers.get(element) ?? []), [type, listener]]));
        };
        return element;
      },
      createElementNS: (_ns: string, tag: string) => new Element(tag),
    } as unknown as Document;
    const elements = new Map(["deck", "s1"].map((id) => {
      const nodeEl = new Element("div"), containerEl = new Element("div"), contentEl = new Element("div");
      nodeEl.appendChild(containerEl); containerEl.appendChild(contentEl);
      return [id, { id, nodeEl, containerEl, contentEl }] as const;
    }));
    const data = {
      nodes: [{ id: "deck", x: 0, y: 0, width: 300, height: 100 }, { id: "s1", x: 10, y: 10, width: 96, height: 54 }],
      edges: [],
      miroSource: { items: [{ id: "deck", type: "slide_container" }, { id: "s1", type: "frame", parent: { id: "deck" } }] },
    };
    const renderer = new SourceRenderer({
      getDocument: () => data, getNodes: () => [...elements.values()], getEdges: () => [],
      onDeckAction: (deckId, action) => { actions.push(`${deckId}:${action}`); },
    }, recording);
    renderer.refresh();
    const deck = elements.get("deck")!.nodeEl;
    expect(deck.classes.has("miro-source-deck")).toBe(true);
    expect(elements.get("s1")!.nodeEl.classes.has("miro-source-slide")).toBe(true);
    expect(elements.get("s1")!.nodeEl.getAttribute("data-miro-source-slide")).toBe("1");
    const bar = created.find((element) => element.classes.has("miro-source-deck-bar"))!;
    expect(bar.parentNode?.parentNode).toBe(deck);
    const buttons = created.filter((element) => element.classes.has("miro-source-deck-button"));
    expect(buttons.map((button) => button.getAttribute("aria-label"))).toEqual(["Present slides", "Show all slides"]);
    const stopped: string[] = [];
    const fire = (button: Element, type: string) => handlers.get(button)?.get(type)?.({ type, stopPropagation: () => stopped.push(type) });
    fire(buttons[0]!, "pointerdown");
    fire(buttons[0]!, "click");
    fire(buttons[1]!, "click");
    expect(stopped).toEqual(["pointerdown", "click", "click"]);
    expect(actions).toEqual(["deck:present", "deck:fit"]);
    renderer.dispose();
    expect(deck.classes.has("miro-source-deck")).toBe(false);
    expect(deck.children).toHaveLength(1);
  });

  it("hides a group, inks text against its frame and centres a shape's text", () => {
    const f = scene([
      { id: "g", type: "group" },
      { id: "slide", type: "frame", style: { fillColor: "#ffffff" } },
      { id: "t", type: "text", parent: { id: "slide" } },
      { id: "dark", type: "shape", data: { shape: "circle" }, style: { fillColor: "#1a1a1a" } },
      { id: "chosen", type: "shape", data: { shape: "circle" }, style: { fillColor: "#ffffff", color: "#ff0000", textAlign: "left" } },
    ], [{ id: "g" }, { id: "slide" }, { id: "t" }, { id: "dark" }, { id: "chosen" }]);
    expect(f.el("g").nodeEl.classes.has("miro-source-group")).toBe(true);
    expect(f.el("t").nodeEl.style.getPropertyValue("--miro-ink")).toBe("#1a1a1a");
    expect(f.el("t").nodeEl.getAttribute("data-miro-source-inked")).toBe("true");
    expect(f.el("dark").nodeEl.style.getPropertyValue("--miro-ink")).toBe("#ffffff");
    expect(f.el("dark").nodeEl.getAttribute("data-miro-source-valign")).toBe("middle");
    expect(f.el("dark").contentEl.style.getPropertyValue("text-align")).toBe("center");
    // A colour and an alignment of its own are kept.
    expect(f.el("chosen").nodeEl.getAttribute("data-miro-source-inked")).toBeNull();
    expect(f.el("chosen").contentEl.style.getPropertyValue("text-align")).toBe("left");
    f.renderer.dispose();
    expect(f.el("t").nodeEl.style.getPropertyValue("--miro-ink")).toBe("");
    expect(f.el("dark").contentEl.style.getPropertyValue("text-align")).toBe("");
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
      getNodes: () => [{ id: "preview-1", nodeEl, contentEl, url: "https://www.example.test/article" }],
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
    expect(nodeEl.getAttribute("data-miro-source-host")).toBe("link");
    // The card: the provider's initial and name, the title, the summary and
    // the site the native link opens - never the source's own address.
    const face = decoration!.children.find((child) => child.classList.contains("miro-source-card-face"))!;
    const text = (element: Element): string[] => [
      ...((element as any).textContent ? [(element as any).textContent] : []),
      ...element.children.flatMap(text),
    ];
    expect(text(face)).toEqual(["E", "Example", "Article", "Saved preview", "example.test"]);
    expect(JSON.stringify(text(face))).not.toContain("javascript");
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

describe("source-backed drawing rendering", () => {
  it("draws a local stroke as an SVG polyline and removes it again on dispose", () => {
    const stroke = { color: "#ff00ff", width: 6, opacity: 0.5, box: { width: 40, height: 20 }, points: [0, 0, 20, 10, 40, 20] };
    const data: any = {
      nodes: [{ id: "drawing-1", type: "text", x: 0, y: 0, width: 200, height: 100 }],
      edges: [],
      miroCanvas: { schemaVersion: 1, localOverrides: { "drawing-1": { item: { type: "drawing", stroke } } } },
    };
    const nodeEl = new Element("div"), contentEl = new Element("div");
    nodeEl.appendChild(contentEl);
    const renderer = new SourceRenderer({
      getDocument: () => data,
      getNodes: () => [{ id: "drawing-1", nodeEl, contentEl }],
      getEdges: () => [],
    }, dom);

    renderer.refresh();
    expect(nodeEl.classes.has("miro-source-drawing")).toBe(true);
    const layer = nodeEl.children.find((child) => child.classes.has("miro-source-decoration-drawing"))!;
    const svg = layer.children.find((child) => child.tagName === "svg")!;
    expect(svg.getAttribute("viewBox")).toBe("0 0 40 20");
    const polyline = svg.children.find((child) => child.tagName === "polyline")!;
    expect(polyline.getAttribute("points")).toBe("0,0 20,10 40,20");
    expect(polyline.getAttribute("stroke")).toBe("#ff00ff");
    expect(polyline.getAttribute("stroke-width")).toBe("6");
    expect(polyline.getAttribute("stroke-opacity")).toBe("0.5");

    renderer.refresh();
    expect(nodeEl.children.filter((child) => child.classes.has("miro-source-decoration-drawing"))).toHaveLength(1);
    renderer.dispose();
    expect(nodeEl.classes.has("miro-source-drawing")).toBe(false);
    expect(nodeEl.children.some((child) => child.classes.has("miro-source-decoration-drawing"))).toBe(false);
  });
});

describe("rotation and a node the host is moving", () => {
  it("follows the host's transform instead of pinning the node where it was", () => {
    const f = fixture("rectangle");
    const data = f.data;
    data.miroCanvas = { schemaVersion: 1, settings: {}, localOverrides: { a: { rotation: 24 } } };
    f.data = data;
    f.nodeEl.style.setProperty("transform", "translate(10px, 20px)");
    f.renderer.refresh();
    expect(f.nodeEl.values.get("transform")).toBe("translate(10px, 20px) rotate(24deg)");
    // The host drags the node: it writes its own transform, with no rotation.
    f.nodeEl.style.setProperty("transform", "translate(300px, 400px)");
    f.renderer.refresh();
    // Replaying the captured value would put the node back at 10,20 while the
    // document, the handles and every connector had moved on.
    expect(f.nodeEl.values.get("transform")).toBe("translate(300px, 400px) rotate(24deg)");
    f.renderer.dispose();
    expect(f.nodeEl.values.get("transform")).toBe("translate(300px, 400px)");
  });

  it("puts the rotation back as soon as the host rewrites the transform", () => {
    const observers: FakeObserver[] = [];
    class FakeObserver {
      public readonly targets: unknown[] = [];
      public connected = true;
      public constructor(public readonly callback: (records: unknown[]) => void) { observers.push(this); }
      public observe(target: unknown): void { this.targets.push(target); }
      public disconnect(): void { this.connected = false; }
    }
    const watched = { ...(dom as unknown as object), defaultView: { MutationObserver: FakeObserver } } as unknown as Document;
    const f = fixture("rectangle", "straight", watched);
    f.data.miroCanvas = { schemaVersion: 1, settings: {}, localOverrides: { a: { rotation: 24 } } };
    f.nodeEl.style.setProperty("transform", "translate(10px, 20px)");
    f.renderer.refresh();
    const observer = observers[observers.length - 1]!;
    expect(observer.targets).toContain(f.nodeEl);
    // Native Canvas writes the whole transform on every step of a drag; the
    // node must not stand upright until the next refresh.
    f.nodeEl.style.setProperty("transform", "translate(300px, 400px)");
    observer.callback([{ type: "attributes", attributeName: "style", target: f.nodeEl }]);
    expect(f.nodeEl.style.getPropertyValue("transform")).toBe("translate(300px, 400px) rotate(24deg)");
    // Its own write comes back as a record too, and changes nothing.
    observer.callback([{ type: "attributes", attributeName: "style", target: f.nodeEl }]);
    expect(f.nodeEl.style.getPropertyValue("transform")).toBe("translate(300px, 400px) rotate(24deg)");

    // A new angle replaces the watch instead of fighting it.
    f.preview = { id: "a", rotation: 40 };
    f.renderer.refresh();
    expect(observer.connected).toBe(false);
    const next = observers[observers.length - 1]!;
    f.nodeEl.style.setProperty("transform", "translate(310px, 400px)");
    next.callback([{ type: "attributes", attributeName: "style", target: f.nodeEl }]);
    expect(f.nodeEl.style.getPropertyValue("transform")).toBe("translate(310px, 400px) rotate(40deg)");

    f.renderer.dispose();
    expect(next.connected).toBe(false);
    expect(f.nodeEl.style.getPropertyValue("transform")).toBe("translate(310px, 400px)");
  });
});

type Matrix = readonly [number, number, number, number, number, number];
const multiply = (m: Matrix, n: Matrix): Matrix => [
  m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
];
const shift = (x: number, y: number): Matrix => [1, 0, 0, 1, x, y];
const turn = (degrees: number): Matrix => {
  const radians = degrees * Math.PI / 180;
  return [Math.cos(radians), Math.sin(radians), -Math.sin(radians), Math.cos(radians), 0, 0];
};

/**
 * Where CSS paints a point of an element's own box, following CSS Transforms 2:
 * origin, then the independent rotate property, then the transform list, then
 * the origin taken back off.
 */
function painted(element: Element, width: number, height: number, point: { x: number; y: number }): { x: number; y: number } {
  const origin = (element.style.getPropertyValue("transform-origin") || "50% 50%").split(/\s+/u)
    .map((part, index) => part.endsWith("%") ? parseFloat(part) / 100 * (index === 0 ? width : height) : parseFloat(part));
  let matrix = shift(origin[0]!, origin[1]!);
  const property = element.style.getPropertyValue("rotate");
  if (property.length > 0) matrix = multiply(matrix, turn(parseFloat(property)));
  for (const [, name, args] of element.style.getPropertyValue("transform").matchAll(/(\w+)\(([^)]*)\)/gu)) {
    const values = args!.split(",").map((item) => parseFloat(item));
    if (name === "translate") matrix = multiply(matrix, shift(values[0]!, values[1] ?? 0));
    else if (name === "rotate") matrix = multiply(matrix, turn(values[0]!));
    else throw new Error(`unsupported transform function ${name}`);
  }
  matrix = multiply(matrix, shift(-origin[0]!, -origin[1]!));
  return { x: matrix[0] * point.x + matrix[2] * point.y + matrix[4], y: matrix[1] * point.x + matrix[3] * point.y + matrix[5] };
}

/** Store a value the way Chromium serializes it: six significant digits, colours as rgb(). */
function storeLikeChromium(element: Element): void {
  element.style.setProperty = (name: string, value: string, priority = "") => {
    const stored = value
      .replace(/#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})\b/giu,
        (_match, r: string, g: string, b: string) => `rgb(${parseInt(r, 16)}, ${parseInt(g, 16)}, ${parseInt(b, 16)})`)
      .replace(/-?(?:\d+(?:\.\d*)?|\.\d+)/gu, (number) => String(Number(Number(number).toPrecision(6))));
    element.values.set(name, stored);
    element.priorities.set(name, priority);
  };
}

describe("the point a node turns about", () => {
  it("turns every node about its own centre, however far from the origin the host placed it", () => {
    const radians = 24 * Math.PI / 180;
    for (const [x, y] of [[0, 0], [600, 400], [-2500, 1800]] as const) {
      const f = fixture("rectangle");
      f.data.miroCanvas = { schemaVersion: 1, settings: {}, localOverrides: { a: { rotation: 24 } } };
      // Native Canvas positions every node with a translate on its element.
      f.nodeEl.style.setProperty("transform", `translate(${x}px, ${y}px)`);
      f.renderer.refresh();
      // The 100x80 node keeps its centre where its geometry puts it...
      const centre = painted(f.nodeEl, 100, 80, { x: 50, y: 40 });
      expect(centre.x).toBeCloseTo(x + 50, 6);
      expect(centre.y).toBeCloseTo(y + 40, 6);
      // ...and really turns about it.
      const corner = painted(f.nodeEl, 100, 80, { x: 0, y: 0 });
      expect(corner.x).toBeCloseTo(x + 50 - 50 * Math.cos(radians) + 40 * Math.sin(radians), 6);
      expect(corner.y).toBeCloseTo(y + 40 - 50 * Math.sin(radians) - 40 * Math.cos(radians), 6);
    }
  });

  it("rotates, stays intact and restores exactly when the engine rewrites angles and colours", () => {
    const f = fixture("rectangle");
    for (const element of [f.nodeEl, f.contentEl, f.path]) storeLikeChromium(element);
    f.nodeEl.style.setProperty("transform", "translate(600px, 400px)");
    f.data.miroCanvas.localOverrides.a = { rotation: -9.636363636363637 };
    const diagnostics = f.renderer.refresh();
    expect(diagnostics.filter((item) => item.startsWith("rotation-"))).toEqual([]);
    expect(f.nodeEl.style.getPropertyValue("transform")).toBe("translate(600px, 400px) rotate(-9.636deg)");
    expect(f.nodeEl.style.getPropertyValue("rotate")).toBe("");
    expect(f.path.style.getPropertyValue("stroke")).toBe("rgb(34, 51, 68)");
    // An intact projection is left alone rather than rebuilt on every refresh.
    let writes = 0;
    const store = f.nodeEl.style.setProperty;
    f.nodeEl.style.setProperty = (name: string, value: string, priority = "") => { writes += 1; store(name, value, priority); };
    f.renderer.refresh();
    expect(writes).toBe(0);
    // Every write was recorded against the value the engine stored, so every
    // one is undone - none outlives dispose.
    f.renderer.dispose();
    expect(f.nodeEl.style.getPropertyValue("transform")).toBe("translate(600px, 400px)");
    expect(f.nodeEl.style.getPropertyValue("transform-origin")).toBe("");
    expect(f.path.style.getPropertyValue("stroke")).toBe("native-stroke");
    expect(f.path.style.getPropertyPriority("stroke")).toBe("important");
  });

  it("clears the rotate property an earlier build left behind", () => {
    const turned = fixture("rectangle");
    turned.data.miroCanvas.localOverrides.a = { rotation: -9.636363636363637 };
    // What that build left: the property, and the fallback's matching suffix.
    turned.nodeEl.style.setProperty("rotate", "-9.63636deg");
    turned.nodeEl.style.setProperty("transform", "translate(600px, 400px) rotate(-9.63636deg)");
    turned.renderer.refresh();
    expect(turned.nodeEl.style.getPropertyValue("rotate")).toBe("");
    expect(turned.nodeEl.style.getPropertyValue("transform")).toBe("translate(600px, 400px) rotate(-9.636deg)");
    turned.renderer.dispose();
    expect(turned.nodeEl.style.getPropertyValue("transform")).toBe("translate(600px, 400px)");

    const upright = fixture("rectangle");
    upright.nodeEl.style.setProperty("rotate", "15deg");
    upright.nodeEl.style.setProperty("transform", "translate(1px, 2px) rotate(15deg)");
    upright.renderer.refresh();
    expect(upright.nodeEl.style.getPropertyValue("rotate")).toBe("");
    expect(upright.nodeEl.style.getPropertyValue("transform")).toBe("translate(1px, 2px)");
  });

  it("asserts the node's own centre over a host that holds the origin elsewhere", () => {
    const f = fixture("rectangle");
    const data = f.data;
    data.miroCanvas = { schemaVersion: 1, settings: {}, localOverrides: { a: { rotation: 24 } } };
    f.data = data;
    // A host that pins the origin to a corner would swing the node away from
    // where its geometry says it is.
    f.nodeEl.style.setProperty("transform-origin", "0 0", "important");
    f.renderer.refresh();
    expect(f.nodeEl.values.get("transform-origin")).toBe("50% 50%");
    expect(f.nodeEl.priorities.get("transform-origin")).toBe("important");
    f.renderer.dispose();
    expect(f.nodeEl.values.get("transform-origin")).toBe("0 0");
    expect(f.nodeEl.priorities.get("transform-origin")).toBe("important");
  });
});

/** A native edge from node a's right side to node b's left, as Obsidian holds it. */
function routeFixture({ rotation = 0, shape, observe = false, preview }: {
  rotation?: number; shape?: string; observe?: boolean; preview?: { id: string; rotation: number };
} = {}) {
  const observers: Array<{ callback: (records: unknown[]) => void; connected: boolean }> = [];
  class FakeObserver {
    public connected = true;
    public constructor(public readonly callback: (records: unknown[]) => void) { observers.push(this); }
    public observe(): void {}
    public disconnect(): void { this.connected = false; }
  }
  const document = observe
    ? { ...(dom as unknown as object), defaultView: { MutationObserver: FakeObserver } } as unknown as Document
    : dom;
  const data: any = {
    nodes: [{ id: "a", type: "text", text: "", x: 0, y: 0, width: 100, height: 80 }, { id: "b", type: "text", text: "", x: 300, y: 200, width: 100, height: 80 }],
    edges: [{ id: "n1", fromNode: "a", fromSide: "right", toNode: "b", toSide: "left" }],
    ...(shape === undefined ? {} : { miroSource: { items: [{ id: "a", type: "shape", data: { shape } }] } }),
    miroCanvas: { schemaVersion: 1, localOverrides: rotation === 0 ? {} : { a: { rotation } } },
  };
  const node = (id: string, x: number, y: number) => {
    const nodeEl = new Element("div"), contentEl = new Element("div"); nodeEl.appendChild(contentEl);
    return { id, nodeEl, contentEl, x, y, width: 100, height: 80 };
  };
  const a = node("a", 0, 0), b = node("b", 300, 200);
  const lineGroupEl = new Element("g"), lineEndGroupEl = new Element("g"), head = new Element("g");
  const display = new Element("path"), interaction = new Element("path");
  interaction.classList.add("canvas-interaction-path");
  lineGroupEl.appendChild(interaction); lineGroupEl.appendChild(display); lineEndGroupEl.appendChild(head);
  const NATIVE = "native route";
  const edge = {
    id: "n1", lineGroupEl, lineEndGroupEl,
    from: { node: a, side: "right", end: "none" },
    to: { node: b, side: "left", end: "arrow" },
    fromLineEnd: null, toLineEnd: { el: head, type: "arrow" },
    redraws: 0,
    // The host's own redraw: back to the middle of a side of the upright box.
    updatePath() {
      this.redraws += 1;
      display.setAttribute("d", NATIVE); interaction.setAttribute("d", NATIVE);
      head.style.setProperty("transform", "translate(300px, 240px) rotate(90deg)");
    },
  };
  edge.updatePath(); edge.redraws = 0;
  let movingIds: string[] | undefined;
  const renderer = new SourceRenderer({
    getDocument: () => data,
    getNodes: () => [a, b],
    getEdges: () => [edge],
    getRotationPreview: () => preview,
    getSelectionMovePreviewIds: () => movingIds,
  }, document);
  const numbers = (value: string | null) => (value ?? "").match(/-?\d+(?:\.\d+)?/gu)!.map(Number);
  return { renderer, data, a, b, edge, display, interaction, head, NATIVE, observers, numbers,
    get movingIds() { return movingIds; }, set movingIds(value: string[] | undefined) { movingIds = value; } };
}

describe("native edges on turned and shaped nodes", () => {
  it("turns a native edge with the node it leaves, keeping the host's own arrowhead", () => {
    const f = routeFixture({ rotation: 90 });
    f.renderer.refresh();
    const d = f.display.getAttribute("d")!;
    // The right side of a node turned a quarter faces down: the edge leaves
    // its middle (50, 90), runs the 7 units native Canvas keeps for a head,
    // then curves away downwards before bending towards b.
    expect(d.startsWith("M 50 90 L 50 97 M 50 97 C 50 ")).toBe(true);
    const [, , , , , , c1x, c1y, c2x, c2y, endX, endY] = f.numbers(d);
    expect(c1x).toBe(50);
    expect(c1y).toBeGreaterThan(97 + 70 - 0.001);
    expect(c2y).toBe(240);
    expect(c2x).toBeLessThan(293);
    expect([endX, endY]).toEqual([293, 240]);
    expect(f.interaction.getAttribute("d")).toBe(d);
    // b is upright: its arrowhead stays on its left side, turned as the host turns it.
    expect(f.head.style.getPropertyValue("transform")).toBe("translate(300px, 240px) rotate(90deg)");
    f.renderer.dispose();
    // The host redraws its own edge rather than being handed a stale copy.
    expect(f.edge.redraws).toBe(1);
    expect(f.display.getAttribute("d")).toBe(f.NATIVE);
  });

  it("ends an edge on a node being turned at its own size, not its inflated bounds", () => {
    // Saved upright, previewed at 40 degrees: the DOM reports the box the turned node covers.
    const f = routeFixture({ preview: { id: "a", rotation: 40 } });
    const box = (width: number, height: number) => () => ({ left: 0, top: 0, right: width, bottom: height, width, height });
    Object.assign(f.a.nodeEl, { getBoundingClientRect: box(128.3, 125.6) });
    Object.assign(f.b.nodeEl, { getBoundingClientRect: box(100, 80) });
    f.renderer.refresh();
    const radians = 40 * Math.PI / 180;
    const [startX, startY] = f.numbers(f.display.getAttribute("d"));
    expect(startX).toBeCloseTo(50 + 50 * Math.cos(radians), 2);
    expect(startY).toBeCloseTo(40 + 50 * Math.sin(radians), 2);
    expect(f.display.getAttribute("d")!.endsWith("293 240")).toBe(true);
  });

  it("turns the arrowhead on the turned node it points at", () => {
    const f = routeFixture({ rotation: 90 });
    f.edge.from.node = f.b; f.edge.to.node = f.a;
    f.data.edges[0] = { id: "n1", fromNode: "b", fromSide: "left", toNode: "a", toSide: "right" };
    f.edge.from.side = "left"; f.edge.to.side = "right";
    f.renderer.refresh();
    // Native angle for a right side is 270; the node adds its own 90.
    expect(f.head.style.getPropertyValue("transform")).toBe("translate(50px, 90px) rotate(0deg)");
    expect(f.display.getAttribute("d")!.endsWith("50 97")).toBe(true);
  });

  it("follows the host when it redraws the edge of a node being dragged", () => {
    const f = routeFixture({ rotation: 90, observe: true });
    f.renderer.refresh();
    const observer = f.observers[f.observers.length - 1]!;
    // Native Canvas moves the node and redraws the edge to the upright box.
    f.a.x = 100;
    f.edge.updatePath();
    expect(f.display.getAttribute("d")).toBe(f.NATIVE);
    observer.callback([{ type: "attributes", attributeName: "d", target: f.display }]);
    expect(f.display.getAttribute("d")!.startsWith("M 150 90 L 150 97 ")).toBe(true);
    // Its own write comes back as a record too, and changes nothing.
    const followed = f.display.getAttribute("d");
    observer.callback([{ type: "attributes", attributeName: "d", target: f.display }]);
    expect(f.display.getAttribute("d")).toBe(followed);
    f.renderer.dispose();
    expect(observer.connected).toBe(false);
  });

  it("meets a shape's contour where the host would stop at its box", () => {
    const f = routeFixture({ shape: "triangle" });
    f.renderer.refresh();
    // A triangle's right flank crosses the middle of the box a quarter in.
    expect(f.display.getAttribute("d")!.startsWith("M 75 40 L 82 40 M 82 40 C ")).toBe(true);
  });

  it("leaves the edges of an upright rectangle to the host", () => {
    const f = routeFixture();
    f.renderer.refresh();
    expect(f.display.getAttribute("d")).toBe(f.NATIVE);
    expect(f.edge.redraws).toBe(0);
  });

  it("draws an ordinary native edge from projected positions during a group drag", () => {
    const f = routeFixture();
    f.renderer.refresh();
    expect(f.display.getAttribute("d")).toBe(f.NATIVE);
    f.data.nodes[0].x = 120;
    f.movingIds = ["a"];
    f.renderer.refresh();
    expect(f.display.getAttribute("d")).toMatch(/^M 220 40 /);
    expect(f.interaction.getAttribute("d")).toBe(f.display.getAttribute("d"));
    expect(f.a.x).toBe(0); // Native runtime still has the old position.
    f.movingIds = undefined;
    f.renderer.refresh();
    expect(f.display.getAttribute("d")).toBe(f.NATIVE);
  });

  it("uses projected geometry for precise and source-backed arrows as well", () => {
    const f = routeFixture();
    f.data.miroCanvas.localOverrides.n1 = { connectorAnchors: {
      from: { type: "node", nodeId: "a", u: 1, v: 0.25 },
      to: { type: "node", nodeId: "b", u: 0, v: 0.75 },
    } };
    f.renderer.refresh();
    f.data.nodes[0].x = 120;
    f.movingIds = ["a"];
    f.renderer.refresh();
    expect(f.display.getAttribute("d")).toMatch(/^M 220 20 /);
    f.data.miroSource = { connectors: [{ id: "n1", shape: "straight", style: { strokeColor: "#123456", strokeWidth: 2 } }] };
    f.renderer.refresh();
    expect(f.display.getAttribute("d")).toMatch(/^M 220 20 /);
    expect(f.display.style.getPropertyValue("stroke")).toBe("#123456");
    expect(f.a.x).toBe(0);
  });

  it("keeps a precisely anchored connector on its anchors while its node is dragged", () => {
    const f = routeFixture({ observe: true });
    f.data.miroCanvas.localOverrides.n1 = { connectorAnchors: {
      from: { type: "node", nodeId: "a", u: 1, v: 0.25 },
      to: { type: "node", nodeId: "b", u: 0, v: 0.75 },
    } };
    f.renderer.refresh();
    // Drawn the native way: out of the anchor along its side, into the other one.
    expect(f.display.getAttribute("d")).toMatch(/^M 100 20 L 107 20 M 107 20 C .* 293 260$/);
    const observer = f.observers[f.observers.length - 1]!;
    f.a.x = 100;
    f.edge.updatePath();
    observer.callback([{ type: "attributes", attributeName: "d", target: f.display }]);
    // The anchor rides along with the node instead of the host's side middle.
    expect(f.display.getAttribute("d")).toMatch(/^M 200 20 L 207 20 M 207 20 C .* 293 260$/);
    expect(f.interaction.getAttribute("d")).toBe(f.display.getAttribute("d"));
    expect(f.head.style.getPropertyValue("transform")).toBe("translate(300px, 260px) rotate(90deg)");
    f.renderer.dispose();
    // The route no longer matches what was captured, so the host redraws its own.
    expect(f.edge.redraws).toBe(2);
    expect(f.display.getAttribute("d")).toBe(f.NATIVE);
  });
});

describe("sticky notes", () => {
  function stickyFixture(style: Record<string, unknown>, text = "<p>REST sticky yellow</p>") {
    const nodeEl = new Element("div"), containerEl = new Element("div"), contentEl = new Element("div");
    nodeEl.appendChild(containerEl); containerEl.appendChild(contentEl);
    const data = {
      nodes: [{ id: "s", type: "text", text, x: 0, y: 0, width: 280, height: 160 }],
      edges: [],
      miroSource: { items: [{ id: "s", type: "sticky_note", data: { content: "x" }, style, zIndex: 4 }] },
    };
    const renderer = new SourceRenderer({
      getDocument: () => data,
      getNodes: () => [{ id: "s", nodeEl, containerEl, contentEl, text }],
      getEdges: () => [],
    }, dom);
    return { renderer, nodeEl, containerEl, contentEl };
  }

  it("fills the note from Miro's palette, inks and fits its text, and keeps the text above the fill", () => {
    const f = stickyFixture({ fillColor: "black", textAlignVertical: "top" });
    f.renderer.refresh();
    const layer = f.nodeEl.children.find((child) => child.classes.has("miro-source-decoration-sticky"))!;
    expect(layer.style.getPropertyValue("background-color")).toBe("#1a1a1a");
    expect(f.nodeEl.style.getPropertyValue("--miro-sticky-ink")).toBe("#ffffff");
    expect(f.nodeEl.getAttribute("data-miro-source-valign")).toBe("top");
    expect(f.nodeEl.getAttribute("data-miro-source-fit")).toBe("true");
    expect(Number.parseInt(f.nodeEl.style.getPropertyValue("--miro-sticky-font-size"), 10)).toBeGreaterThan(18);
    // The strictly contained native container would otherwise paint under the fill.
    expect(f.containerEl.style.getPropertyValue("z-index")).toBe("1");
    f.renderer.dispose();
    expect(f.nodeEl.style.getPropertyValue("--miro-sticky-ink")).toBe("");
    expect(f.nodeEl.getAttribute("data-miro-source-fit")).toBeNull();
    expect(f.containerEl.style.getPropertyValue("z-index")).toBe("");
  });

  it("keeps a chosen text size and colour", () => {
    const f = stickyFixture({ fillColor: "gray", fontSize: "24", color: "#ff0000" });
    f.renderer.refresh();
    expect(f.nodeEl.getAttribute("data-miro-source-fit")).toBeNull();
    expect(f.nodeEl.style.getPropertyValue("--miro-sticky-ink")).toBe("");
    expect(f.nodeEl.getAttribute("data-miro-source-valign")).toBe("middle");
    expect(f.contentEl.style.getPropertyValue("font-size")).toBe("24px");
  });
});
