import { describe, expect, it } from "vitest";
import { ConnectorLayer } from "../src/connector-layer";
import { buildCanvasAnchorGeometry } from "../src/connector-endpoints";
import type { BoardConnector } from "../src/board-connectors";

class FakeElement {
  children: FakeElement[] = [];
  parentElement: FakeElement | null = null;
  attrs = new Map<string, string>();
  styles = new Map<string, string>();
  listeners = new Map<string, (event: unknown) => void>();
  style = {
    setProperty: (name: string, value: string) => this.styles.set(name, value),
  };
  constructor(readonly tag: string) {}
  get firstChild(): FakeElement | null {
    return this.children[0] ?? null;
  }
  appendChild(child: FakeElement): FakeElement {
    child.parentElement = this;
    this.children.push(child);
    return child;
  }
  replaceChild(next: FakeElement, old: FakeElement): void {
    this.children = this.children.map((item) => (item === old ? next : item));
    next.parentElement = this;
    old.parentElement = null;
  }
  removeChild(child: FakeElement): void {
    this.children = this.children.filter((item) => item !== child);
    child.parentElement = null;
  }
  remove(): void {
    this.parentElement?.removeChild(this);
  }
  setAttribute(key: string, value: string): void {
    this.attrs.set(key, value);
  }
  getAttribute(key: string): string | null {
    return this.attrs.get(key) ?? null;
  }
  addEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.set(type, listener);
  }
  removeEventListener(type: string): void {
    this.listeners.delete(type);
  }
  closest(selector: string): FakeElement | null {
    const attribute = /^\[(.+)\]$/u.exec(selector)?.[1];
    for (let at: FakeElement | null = this; at !== null; at = at.parentElement) {
      if (attribute !== undefined && at.attrs.has(attribute)) return at;
    }
    return null;
  }
}

const fakeDocument = {
  createElementNS: (_namespace: string, tag: string) => new FakeElement(tag),
};
const all = (element: FakeElement): FakeElement[] => [element, ...element.children.flatMap(all)];

function connector(patch: Partial<BoardConnector> = {}): BoardConnector {
  return {
    id: "a", from: { type: "free", x: 0, y: 0 }, to: { type: "free", x: 100, y: 0 },
    route: "straight", color: "#123456", width: 2, startCap: "arrow", endCap: "stealth", ...patch,
  };
}

function layerOf(connectors: readonly BoardConnector[], pressed: string[] = []) {
  let document: unknown = { nodes: [], edges: [], miroCanvas: { connectors: Object.fromEntries(connectors.map((item) => [item.id, item])) } };
  let geometry = buildCanvasAnchorGeometry(document);
  const layer = new ConnectorLayer(fakeDocument as unknown as Document, {
    document: () => document,
    geometry: () => geometry,
    press: (_event, id) => pressed.push(id),
  });
  const replace = (next: readonly BoardConnector[]) => {
    document = { nodes: [], edges: [], miroCanvas: { connectors: Object.fromEntries(next.map((item) => [item.id, item])) } };
    geometry = buildCanvasAnchorGeometry(document);
  };
  return { layer, svg: layer.element as unknown as FakeElement, replace };
}

describe("connector layer", () => {
  it("draws each connector as native Canvas draws an edge, in board units", () => {
    const { layer, svg } = layerOf([connector()]);
    layer.render();
    const group = all(svg).find((element) => element.tag === "g")!;
    expect(group.styles.get("--canvas-color")).toBe("#123456");
    const [, line, hit] = group.children;
    expect(hit!.attrs.get("data-connector-id")).toBe("a");
    expect(hit!.attrs.get("class")).toBe("canvas-interaction-path miro-board-connector-hit");
    expect(line!.attrs.get("class")).toBe("canvas-display-path");
    expect(line!.attrs.get("d")).toBe(hit!.attrs.get("d"));
    expect(line!.attrs.get("d")).toMatch(/^M 0 0/u);
    expect(line!.styles.get("stroke-width")).toBe("2");
  });

  it("sizes arrowheads by the line, or by the head size set on it", () => {
    const markers = (item: BoardConnector) => {
      const { layer, svg } = layerOf([item]);
      layer.render();
      return all(svg).filter((element) => element.tag === "marker").map((element) => Object.fromEntries(element.attrs));
    };
    const plain = markers(connector());
    expect(plain).toHaveLength(2);
    for (const marker of plain) expect(marker).toMatchObject({ markerWidth: "10.799999999999999", markerHeight: "9.6" });
    for (const marker of markers(connector({ width: 50, headSize: 20 }))) {
      expect(marker).toMatchObject({ markerUnits: "userSpaceOnUse", markerWidth: "36", markerHeight: "32" });
    }
  });

  it("marks the selection and draws again only what changed", () => {
    const { layer, svg, replace } = layerOf([connector(), connector({ id: "b" })]);
    layer.render();
    const [a, b] = svg.children;
    layer.render();
    expect(svg.children).toEqual([a, b]);
    layer.select(["b"]);
    expect(svg.children[0]).toBe(a);
    expect(svg.children[1]).not.toBe(b);
    const focused = all(svg).filter((element) => element.attrs.get("class")?.includes("is-focused"));
    expect(focused.map((element) => element.children[2]?.attrs.get("data-connector-id"))).toEqual(["b"]);
    replace([connector()]);
    layer.render();
    expect(layer.selection()).toEqual([]);
    expect(svg.children).toEqual([a]);
  });

  it("previews a connector where it is dragged, and says which one was pressed", () => {
    const pressed: string[] = [];
    const { layer, svg } = layerOf([connector()], pressed);
    layer.preview(connector({ from: { type: "free", x: 10, y: 10 }, to: { type: "free", x: 110, y: 10 } }));
    expect(layer.routeOf("a")?.start).toMatchObject({ x: 10, y: 10 });
    const hit = all(svg).find((element) => element.attrs.has("data-connector-id"))!;
    svg.listeners.get("pointerdown")!({ target: hit });
    expect(pressed).toEqual(["a"]);
    layer.preview(undefined);
    expect(layer.routeOf("a")?.start).toMatchObject({ x: 0, y: 0 });
  });
});
