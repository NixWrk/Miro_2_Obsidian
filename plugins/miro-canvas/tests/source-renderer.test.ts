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
  const renderer = new SourceRenderer({ getDocument: () => data, getNodes: () => [{ id: "a", nodeEl, contentEl }], getEdges: () => [{ id: "e", edgeEl, lineGroupEl, lineEndGroupEl }] }, dom);
  return { renderer, nodeEl, contentEl, path, hit, lineGroupEl, lineEndGroupEl, get data() { return data; }, set data(value: any) { data = value; } };
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
    expect(f.contentEl.style.getPropertyValue("padding")).toBe("30% 18% 4% 18%");
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
    expect(ellipse.contentEl.style.getPropertyValue("padding")).toBe("15% 15% 15% 15%");
    ellipse.renderer.dispose();
    expect(ellipse.contentEl.style.getPropertyValue("padding")).toBe("");
  });
});

describe("native paint markers", () => {
  it("marks a rotated node so its unrotated shell stops painting", () => {
    const f = fixture("rectangle");
    const data = f.data;
    data.miroCanvas = { schemaVersion: 1, settings: {}, localOverrides: { a: { rotation: 24 } } };
    f.data = data;
    f.renderer.refresh();
    expect(f.nodeEl.getAttribute("data-miro-source-rotated")).toBe("true");
    f.renderer.dispose();
    expect(f.nodeEl.getAttribute("data-miro-source-rotated")).toBe(null);
  });

  it("leaves an upright node unmarked", () => {
    const f = fixture("rectangle");
    f.renderer.refresh();
    expect(f.nodeEl.getAttribute("data-miro-source-rotated")).toBe(null);
    // The shape marker is what the stylesheet keys the contour override on.
    expect(f.nodeEl.getAttribute("data-miro-source-kind")).toBe("shape");
  });
});


