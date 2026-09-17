import { describe, expect, it, vi } from "vitest";
import { buildCommentMarkers, CommentMarkers, type CommentMarkersState } from "../src/comment-markers";
import { listCommentThreads, type CommentThread } from "../src/local-comments";

const thread: CommentThread = {
  id: "t", origin: "local", text: "Check this", createdAt: "2026-09-09T13:42:00Z",
  author: { name: "Alice" }, resolved: false, replies: [],
};
const display = { locale: "en-GB", timeZone: "UTC" };

class Element {
  public children: Element[] = [];
  public parent?: Element;
  public attributes = new Map<string, string>();
  public listeners = new Map<string, Set<(event: Event) => void>>();
  public style: Record<string, string> = {};
  public type = "";
  public className = "";
  public title = "";
  public textContent = "";
  public constructor(public readonly tagName: string) {}
  public setAttribute(name: string, value: string): void { this.attributes.set(name, value); }
  public appendChild(child: Element): Element { child.parent = this; this.children.push(child); return child; }
  public addEventListener(name: string, listener: (event: Event) => void): void {
    if (!this.listeners.has(name)) this.listeners.set(name, new Set());
    this.listeners.get(name)!.add(listener);
  }
  public removeEventListener(name: string, listener: (event: Event) => void): void {
    this.listeners.get(name)?.delete(listener);
  }
  public dispatch(name: string): Event {
    const event = { stopPropagation: vi.fn(), preventDefault: vi.fn() } as unknown as Event;
    for (const listener of this.listeners.get(name) ?? []) listener(event);
    return event;
  }
  public remove(): void {
    if (this.parent) this.parent.children = this.parent.children.filter((child) => child !== this);
    this.parent = undefined;
  }
}
const dom = { createElement: (tag: string) => new Element(tag) } as unknown as Document;

describe("comment marker model", () => {
  it("resolves board, rotated node, image and polyline edge anchors through viewport projection", () => {
    const state: CommentMarkersState = {
      threads: [
        { ...thread, id: "board", anchor: { type: "free", x: -10, y: 20 } },
        { ...thread, id: "node", anchor: { type: "node", nodeId: "n", u: 1, v: 0 } },
        { ...thread, id: "image", anchor: { type: "image", nodeId: "i", u: 0.25, v: 0.75 } },
        { ...thread, id: "edge", resolved: true, anchor: { type: "edge", edgeId: "e", t: 0.5 } },
      ],
      geometry: {
        nodes: { n: { x: 100, y: 200, width: 80, height: 40, rotation: 90 } },
        images: { i: { x: 300, y: 50, width: 200, height: 100 } },
        edges: { e: { points: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 300 }] } },
      },
      boardToViewport: ({ x, y }) => ({ x: x * 2 + 10, y: y * 2 - 5 }),
    };
    const before = JSON.stringify(state);
    const model = buildCommentMarkers(state, display);
    expect(model.diagnostics).toEqual([]);
    expect(model.markers.map((item) => [item.anchorType, item.point])).toEqual([
      ["board", { x: -10, y: 35 }], ["node", { x: 330, y: 515 }],
      ["image", { x: 710, y: 245 }], ["edge", { x: 210, y: 195 }],
    ]);
    expect(model.markers[3].state).toBe("resolved");
    expect(model.markers[3].label).toContain("Resolved comment by Alice");
    expect(model.markers[0].label).toContain("13:42");
    expect(buildCommentMarkers({ ...state, includeResolved: false }).markers).toHaveLength(3);
    expect(buildCommentMarkers({ ...state, scope: "selection", selectedElementIds: ["i"] }).markers[0].threadId).toBe("image");
    expect(JSON.stringify(state)).toBe(before);
  });

  it("uses an explicit board position for unanchored threads and reports broken anchors", () => {
    const state = { threads: [thread], geometry: {} };
    expect(buildCommentMarkers(state).markers).toHaveLength(0);
    expect(buildCommentMarkers({ ...state, boardPoint: { x: 20, y: 40 } }).markers[0])
      .toMatchObject({ anchorType: "board", point: { x: 20, y: 40 } });
    const result = buildCommentMarkers({ threads: [
      { ...thread, anchor: { type: "node", nodeId: "missing", u: 0, v: 0 } },
      { ...thread, id: "edge", anchor: { type: "edge", edgeId: "missing", t: 0.5 } },
      { ...thread, id: "image", anchor: { type: "image", nodeId: "missing", u: 0.5, v: 0.5 } },
      { ...thread, id: "bad", anchor: { type: "free", x: NaN, y: 10 } },
    ], geometry: {} });
    expect(result.markers).toHaveLength(0);
    expect(result.diagnostics.map((item) => item.threadId)).toEqual(["t", "edge", "image", "bad"]);
    expect(buildCommentMarkers({ ...state, boardPoint: { x: 0, y: 0 },
      boardToViewport: () => ({ x: Infinity, y: 0 }) }).diagnostics[0].code).toBe("projection-invalid");
  });

  it("keeps imported evidence, unknown fields and timestamp history unchanged", () => {
    const source = { comments: [{ id: "t", content: "Source", createdAt: thread.createdAt,
      createdBy: { name: "Imported author" }, position: { x: 5, y: 10 },
      future: { keep: true }, messages: [{ id: "r", content: "Reply", createdAt: thread.createdAt,
        updatedAt: "2026-09-10T12:00:00Z", history: ["first"] }] }] };
    const metadata = { miroSource: source, localComments: [{ ...thread, history: ["local"] }] };
    const before = JSON.stringify(metadata);
    const threads = listCommentThreads(metadata);
    const result = buildCommentMarkers({ threads, geometry: {}, boardPoint: { x: 1, y: 2 } }, display);
    expect(result.markers).toHaveLength(2);
    expect(result.markers[0].key).not.toBe(result.markers[1].key);
    expect(result.markers[0].label).toContain("1 replies");
    expect(threads[0].immutable).toBe(true);
    expect(threads[0].source).toEqual(source.comments[0]);
    expect(threads[0].replies[0].history).toEqual(["first"]);
    expect(JSON.stringify(metadata)).toBe(before);
  });
});

describe("comment marker DOM renderer", () => {
  it("renders accessible native buttons, isolates Canvas gestures and opens the correct origin", () => {
    const onOpenThread = vi.fn();
    const renderer = new CommentMarkers({ onOpenThread }, { document: dom, ...display });
    const state: CommentMarkersState = { threads: [
      { ...thread, text: "<img src=x onerror=alert(1)>" },
      { ...thread, origin: "imported", immutable: true, resolved: true },
    ], geometry: {}, boardPoint: { x: 10, y: 20 } };
    renderer.update(state);
    const root = renderer.element as unknown as Element;
    expect(root.attributes.get("aria-label")).toBe("Canvas comments");
    expect(root.style.pointerEvents).toBe("none");
    const [local, imported] = root.children;
    expect(local.tagName).toBe("button");
    expect(local.type).toBe("button");
    expect(local.attributes.get("aria-label")).toContain("Open comment by Alice");
    expect(local.attributes.get("aria-label")).toContain("<img src=x onerror=alert(1)>");
    expect(local.children).toHaveLength(0);
    // The pin shows who opened the thread, and counts its messages.
    expect(local.textContent).toBe("A");
    expect(local.attributes.get("data-comment-count")).toBe(String(thread.replies.length + 1));
    expect(local.style.left).toBe("10px");
    expect(local.style.top).toBe("20px");
    expect(imported.attributes.get("data-comment-state")).toBe("resolved");
    for (const name of ["pointerdown", "mousedown", "dblclick", "keydown", "keyup"]) {
      const event = local.dispatch(name);
      expect(event.stopPropagation).toHaveBeenCalledOnce();
      expect(event.preventDefault).not.toHaveBeenCalled();
    }
    expect(onOpenThread).not.toHaveBeenCalled();
    local.dispatch("click");
    imported.dispatch("click");
    expect(onOpenThread.mock.calls).toEqual([["t", "local"], ["t", "imported"]]);
  });

  it("reuses buttons across move/zoom/state updates and disposes removed marker callbacks", () => {
    const onOpenThread = vi.fn();
    const renderer = new CommentMarkers({ onOpenThread }, { document: dom, ...display });
    const root = renderer.element as unknown as Element;
    const state: CommentMarkersState = { threads: [{ ...thread,
      anchor: { type: "node", nodeId: "n", u: 0.5, v: 0.5 } }],
      geometry: { nodes: { n: { x: 0, y: 0, width: 100, height: 100 } } } };
    renderer.update(state);
    const button = root.children[0];
    renderer.update({ ...state, threads: [{ ...state.threads[0], resolved: true }],
      geometry: { nodes: { n: { x: 100, y: 100, width: 100, height: 100 } } },
      boardToViewport: ({ x, y }) => ({ x: x / 2, y: y / 2 }) });
    expect(root.children[0]).toBe(button);
    expect(button.style.left).toBe("75px");
    expect(button.style.top).toBe("75px");
    expect(button.textContent).toBe("✓");
    expect(button.attributes.get("aria-label")).toContain("Resolved");
    renderer.update({ ...state, geometry: {} });
    expect(root.children).toHaveLength(0);
    button.dispatch("click");
    expect(onOpenThread).not.toHaveBeenCalled();
    renderer.update(state);
    const restored = root.children[0];
    renderer.destroy();
    restored.dispatch("click");
    renderer.update(state);
    expect(onOpenThread).not.toHaveBeenCalled();
    expect(root.children).toHaveLength(1);
  });
});
