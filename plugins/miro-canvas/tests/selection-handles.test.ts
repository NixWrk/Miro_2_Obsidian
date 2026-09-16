import { describe, expect, it } from "vitest";

import {
  SelectionHandles,
  normalizeAngle,
  nearestSide,
  rightAngleStep,
  pointerAngle,
  sideAnchor,
  type HandleSide,
  type HandlePosition,
  type SelectionHandlesState,
} from "../src/selection-handles";

class FakeElement {
  public readonly children: FakeElement[] = [];
  public readonly attributes = new Map<string, string>();
  public readonly listeners = new Map<string, Array<(event: unknown) => void>>();
  public readonly style: Record<string, string> = {};
  public parentNode: FakeElement | undefined;
  public textContent = "";
  public className = "";
  public title = "";
  public type = "";
  public hidden = false;

  public constructor(public readonly tagName: string) {}

  public appendChild(child: FakeElement): FakeElement {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  public setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  public getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  public removeAttribute(name: string): void {
    this.attributes.delete(name);
  }

  public addEventListener(name: string, listener: (event: unknown) => void): void {
    const listeners = this.listeners.get(name) ?? [];
    listeners.push(listener);
    this.listeners.set(name, listeners);
  }

  public removeEventListener(name: string, listener: (event: unknown) => void): void {
    this.listeners.set(name, (this.listeners.get(name) ?? []).filter((item) => item !== listener));
  }

  public dispatch(name: string, props: Record<string, unknown> = {}): void {
    for (const listener of [...(this.listeners.get(name) ?? [])]) {
      listener({ type: name, target: this, preventDefault() {}, ...props });
    }
  }

  public remove(): void {
    this.parentNode?.children.splice(this.parentNode.children.indexOf(this), 1);
  }
}

class FakeDocument {
  public createElement(tagName: string): FakeElement {
    return new FakeElement(tagName);
  }
}

function descendants(root: FakeElement): FakeElement[] {
  return [root, ...root.children.flatMap((child) => descendants(child))];
}

function bySide(root: FakeElement, side: HandleSide, position: HandlePosition = 0.5): FakeElement {
  return descendants(root).find((item) => item.attributes.get("data-handle-side") === side
    && item.attributes.get("data-handle-position") === String(position))!;
}

function byLabel(root: FakeElement, label: string): FakeElement {
  return descendants(root).find((item) => item.attributes.get("aria-label") === label)!;
}

const RECT = { left: 100, top: 100, width: 200, height: 100 };

function build(overrides: Partial<SelectionHandlesState> = {}, options: Record<string, unknown> = {}) {
  const rotations: Array<{ degrees: number; commit: boolean }> = [];
  let cancellations = 0;
  const connects: Array<{ sourceId: string; side: HandleSide; position: HandlePosition; point: { x: number; y: number } }> = [];
  const creates: Array<{ sourceId: string; side: HandleSide; position: HandlePosition }> = [];
  const moves: Array<{ edgeId: string; end: string; point: { x: number; y: number } }> = [];
  const handles = new SelectionHandles({
    onRotate: (degrees, commit) => { rotations.push({ degrees, commit }); },
    onCancelRotation: () => { cancellations += 1; },
    onConnect: (sourceId, side, position, point) => { connects.push({ sourceId, side, position, point: { x: point.x, y: point.y } }); },
    onCreateConnected: (sourceId, side, position) => { creates.push({ sourceId, side, position }); },
    onMoveEndpoint: (edgeId, end, point) => { moves.push({ edgeId, end, point: { x: point.x, y: point.y } }); },
  }, { document: new FakeDocument() as unknown as Document, ...options });
  const base: SelectionHandlesState = {
    rect: RECT, rotation: 0, editable: true, isEdge: false, selectedIds: ["n1"], ...overrides,
  };
  const update = (patch: Partial<SelectionHandlesState> = {}): void => handles.update({ ...base, ...patch });
  update();
  return { handles, root: handles.element as unknown as FakeElement, rotations, connects, creates, moves, update, cancellations: () => cancellations };
}

describe("selection handle geometry", () => {
  it("places anchors at arbitrary positions along each side", () => {
    expect(sideAnchor(RECT, "top")).toEqual({ x: 200, y: 100 });
    expect(sideAnchor(RECT, "right")).toEqual({ x: 300, y: 150 });
    expect(sideAnchor(RECT, "bottom")).toEqual({ x: 200, y: 200 });
    expect(sideAnchor(RECT, "left")).toEqual({ x: 100, y: 150 });
    expect(sideAnchor(RECT, "top", 0.25)).toEqual({ x: 150, y: 100 });
    expect(sideAnchor(RECT, "right", 0.75)).toEqual({ x: 300, y: 175 });
  });

  it("picks the side a point lies towards", () => {
    expect(nearestSide(RECT, { x: 500, y: 150 })).toBe("right");
    expect(nearestSide(RECT, { x: -50, y: 150 })).toBe("left");
    expect(nearestSide(RECT, { x: 200, y: -50 })).toBe("top");
    expect(nearestSide(RECT, { x: 200, y: 400 })).toBe("bottom");
  });

  it("measures the pointer angle around the center", () => {
    expect(pointerAngle(RECT, { x: 400, y: 150 })).toBeCloseTo(0);
    expect(pointerAngle(RECT, { x: 200, y: 400 })).toBeCloseTo(90);
    expect(pointerAngle(RECT, { x: 200, y: -100 })).toBeCloseTo(-90);
  });

  it("wraps and snaps an angle without producing negative zero", () => {
    expect(normalizeAngle(370)).toBeCloseTo(10);
    expect(normalizeAngle(-190)).toBeCloseTo(170);
    // Half a turn settles at the low end of the range, as the writer stores it.
    expect(normalizeAngle(180)).toBe(-180);
    expect(Object.is(normalizeAngle(360), 0)).toBe(true);
    expect(normalizeAngle(7, 15)).toBe(0);
    expect(normalizeAngle(23, 15)).toBe(30);
  });
});

describe("selection handles", () => {
  it("frames the selection and follows its rotation", () => {
    const { root, update } = build();
    const frame = root.children[0]!;
    expect(root.hidden).toBe(false);
    expect(frame.style.left).toBe("100px");
    expect(frame.style.width).toBe("200px");
    expect(frame.style.transform).toBe("none");
    update({ rotation: 30 });
    expect(frame.style.transform).toBe("rotate(30deg)");
  });

  it("hides without a rect, without a selection, and for a multiple selection", () => {
    const { root, update } = build();
    update({ rect: undefined });
    expect(root.hidden).toBe(true);
    update({ selectedIds: [] });
    expect(root.hidden).toBe(true);
    update({ selectedIds: ["n1", "n2"] });
    expect(root.hidden).toBe(true);
  });

  it("marks the gesture and reports nothing until the pointer moves", () => {
    const { root, rotations, handles } = build();
    byLabel(root, "Rotate").dispatch("pointerdown", { clientX: 200, clientY: 250, pointerId: 1 });
    expect(root.getAttribute("data-miro-canvas-rotating")).toBe("true");
    expect(handles.gestureActive).toBe(true);
    expect(rotations).toEqual([]);
  });

  it("keeps the grab offset so rotation does not jump on the first move", () => {
    const { root, rotations, handles } = build({ rotation: 45 });
    byLabel(root, "Rotate").dispatch("pointerdown", { clientX: 200, clientY: 250, pointerId: 1 });
    handles.handlePointerMove({ clientX: 200, clientY: 250 });
    // Same point as the grab: the rotation is unchanged, not reset to 90.
    expect(rotations[0]).toEqual({ degrees: 45, commit: false });
    handles.handlePointerMove({ clientX: 400, clientY: 150 });
    expect(rotations[1]!.degrees).toBeCloseTo(-45);
    handles.handlePointerUp({ clientX: 400, clientY: 150 });
    expect(rotations[rotations.length - 1]).toMatchObject({ commit: true });
    expect(handles.gestureActive).toBe(false);
  });

  it("snaps rotation while Shift is held", () => {
    const { root, rotations, handles } = build();
    byLabel(root, "Rotate").dispatch("pointerdown", { clientX: 200, clientY: 250, pointerId: 1 });
    handles.handlePointerMove({ clientX: 260, clientY: 245, shiftKey: true });
    expect(Number.isInteger(rotations[0]!.degrees / 15)).toBe(true);
  });

  it("cancels a preview without committing it", () => {
    const { root, rotations, handles, cancellations } = build({ rotation: 20 });
    byLabel(root, "Rotate").dispatch("pointerdown", { clientX: 200, clientY: 250, pointerId: 1 });
    handles.handlePointerMove({ clientX: 400, clientY: 150 });
    handles.cancelGesture();
    expect(rotations.filter((item) => item.commit)).toEqual([]);
    expect(cancellations()).toBe(1);
  });

  it("reports a connection pulled from a side to its release point", () => {
    const { root, connects, handles } = build();
    bySide(root, "right").dispatch("pointerdown", { clientX: 300, clientY: 150, pointerId: 2 });
    expect(root.getAttribute("data-miro-canvas-connecting")).toBe("right");
    handles.handlePointerUp({ clientX: 640, clientY: 155 });
    expect(connects).toEqual([{ sourceId: "n1", side: "right", position: 0.5, point: { x: 640, y: 155 } }]);
    expect(handles.gestureActive).toBe(false);
  });

  it("treats a click on a connection point as creating a connected node", () => {
    const { root, creates, connects, handles } = build();
    bySide(root, "top").dispatch("pointerdown", { clientX: 200, clientY: 100, pointerId: 6 });
    // Released where it started: a click, not a drag.
    handles.handlePointerUp({ clientX: 201, clientY: 101 });
    expect(creates).toEqual([{ sourceId: "n1", side: "top", position: 0.5 }]);
    expect(connects).toEqual([]);
  });

  it("offers one affordance per side, arrowed away from the node", () => {
    const { root } = build();
    expect(bySide(root, "top").textContent).toBe("↑");
    expect(bySide(root, "right").textContent).toBe("→");
    expect(bySide(root, "bottom").textContent).toBe("↓");
    expect(bySide(root, "left").textContent).toBe("←");
    expect(descendants(root).filter((item) => item.className.includes("--connect"))).toHaveLength(4);
    expect(bySide(root, "right").getAttribute("data-handle-position")).toBe("0.5");
    // The separate quick-create button is gone; the point is the arrow.
    expect(descendants(root).filter((item) => item.className.includes("--create"))).toHaveLength(0);
  });

  it("offers no rotation or connection on a connector or a locked selection", () => {
    const { root, rotations, connects, update, handles } = build({ isEdge: true });
    expect(byLabel(root, "Rotate").hidden).toBe(true);
    bySide(root, "right").dispatch("pointerdown", { clientX: 300, clientY: 150, pointerId: 3 });
    handles.handlePointerUp({ clientX: 500, clientY: 150 });
    expect(connects).toEqual([]);
    update({ isEdge: false, editable: false });
    byLabel(root, "Rotate").dispatch("pointerdown", { clientX: 200, clientY: 250, pointerId: 4 });
    expect(rotations).toEqual([]);
  });

  it("keeps the geometry a gesture started with only while none is reported", () => {
    const { root, update, handles } = build();
    const frame = root.children[0]!;
    byLabel(root, "Rotate").dispatch("pointerdown", { clientX: 200, clientY: 250, pointerId: 5 });
    // Pressing the grip can clear the selection: geometry that is not
    // reported must not be adopted as gone.
    update({ rect: undefined, selectedIds: [] });
    expect(frame.style.left).toBe("100px");
    // Geometry that is reported is followed, so panning under a drag does not
    // park the handles where the node used to be.
    update({ rect: { left: 900, top: 900, width: 10, height: 10 } });
    expect(frame.style.left).toBe("900px");
    handles.cancelGesture();
    update({ rect: { left: 900, top: 900, width: 10, height: 10 } });
    expect(frame.style.left).toBe("900px");
  });

  it("keeps gesture geometry, follows preview rotation, and commits once", () => {
    const { root, rotations, update, handles } = build({ rotation: 20 });
    const frame = root.children[0]!;
    byLabel(root, "Rotate").dispatch("pointerdown", { clientX: 200, clientY: 250, pointerId: 13 });
    handles.handlePointerMove({ clientX: 400, clientY: 150 });
    update({ rect: undefined, selectedIds: [], rotation: 33 });
    expect(frame.style.left).toBe("100px");
    expect(frame.style.transform).toBe("rotate(33deg)");
    handles.handlePointerUp({ clientX: 400, clientY: 150 });
    expect(rotations.filter((item) => item.commit)).toHaveLength(1);
  });

  it("keeps the source node when Canvas clears selection during a connection gesture", () => {
    const { root, creates, connects, update, handles } = build();
    bySide(root, "right").dispatch("pointerdown", { clientX: 300, clientY: 150, pointerId: 14 });
    update({ rect: undefined, selectedIds: [] });
    handles.handlePointerUp({ clientX: 300, clientY: 150 });
    expect(creates).toEqual([{ sourceId: "n1", side: "right", position: 0.5 }]);
    expect(connects).toEqual([]);
  });

  it("places the connection affordance on the visible shape contour", () => {
    const { root, update } = build();
    update({ shape: "triangle" });
    const point = bySide(root, "right");
    expect(Number.parseFloat(point.style.left)).toBeLessThan(100);
    expect(Number.parseFloat(point.style.left)).toBeGreaterThan(50);
  });

  it("adds a node however long the point was held, as long as it did not move", () => {
    const { root, creates, connects, handles } = build();
    bySide(root, "right").dispatch("pointerdown", { clientX: 300, clientY: 150, pointerId: 21 });
    handles.handlePointerUp({ clientX: 300, clientY: 150 });
    // Treating a slow click as a drag stopped the point adding a node at all.
    expect(creates).toHaveLength(1);
    expect(connects).toEqual([]);
  });

  it("removes its listeners on dispose", () => {
    const { root, creates, handles } = build();
    handles.dispose();
    bySide(root, "right").dispatch("pointerdown", { clientX: 300, clientY: 150, pointerId: 7 });
    handles.handlePointerUp({ clientX: 300, clientY: 150 });
    expect(creates).toEqual([]);
  });
});

describe("connector end grips", () => {
  const byEnd = (root: FakeElement, end: string): FakeElement =>
    descendants(root).find((item) => item.attributes.get("data-connector-end") === end)!;
  const endpoints = { from: { x: 120, y: 80 }, to: { x: 420, y: 160 } };

  it("puts a grip on each end of a selected connector and none on a node", () => {
    const { root, update } = build({ isEdge: true, rect: undefined, selectedIds: ["e1"], endpoints });
    expect(root.hidden).toBe(false);
    expect(root.children[0]!.hidden).toBe(true);
    expect(byEnd(root, "from").hidden).toBe(false);
    expect(byEnd(root, "from").style.left).toBe("120px");
    expect(byEnd(root, "to").style.top).toBe("160px");
    update({ isEdge: false, rect: RECT, selectedIds: ["n1"], endpoints: undefined });
    expect(byEnd(root, "from").hidden).toBe(true);
    expect(root.children[0]!.hidden).toBe(false);
    update({ isEdge: true, rect: undefined, selectedIds: ["e1"], endpoints, editable: false });
    expect(byEnd(root, "to").hidden).toBe(true);
  });

  it("moves an end with the pointer and reports where it was dropped", () => {
    const { root, moves, handles, update } = build({ isEdge: true, rect: undefined, selectedIds: ["e1"], endpoints });
    byEnd(root, "to").dispatch("pointerdown", { clientX: 420, clientY: 160, pointerId: 31 });
    expect(handles.gestureActive).toBe(true);
    handles.handlePointerMove({ clientX: 500, clientY: 200 });
    expect(byEnd(root, "to").style.left).toBe("500px");
    // A refresh mid-drag does not snap the grip back.
    update({ isEdge: true, rect: undefined, selectedIds: ["e1"], endpoints });
    expect(byEnd(root, "to").style.left).toBe("500px");
    handles.handlePointerUp({ clientX: 510, clientY: 205 });
    expect(moves).toEqual([{ edgeId: "e1", end: "to", point: { x: 510, y: 205 } }]);
    expect(handles.gestureActive).toBe(false);
  });

  it("leaves an end alone when it was only pressed", () => {
    const { root, moves, handles } = build({ isEdge: true, rect: undefined, selectedIds: ["e1"], endpoints });
    byEnd(root, "from").dispatch("pointerdown", { clientX: 120, clientY: 80, pointerId: 32 });
    handles.handlePointerMove({ clientX: 121, clientY: 81 });
    handles.handlePointerUp({ clientX: 121, clientY: 81 });
    expect(moves).toEqual([]);
    expect(byEnd(root, "from").style.left).toBe("120px");
  });
});

describe("rotation controls", () => {
  const byClass = (root: FakeElement, name: string): FakeElement =>
    descendants(root).find((item) => item.className.split(" ").includes(name))!;

  it("sit upright below the lowest point of the node, whatever its angle", () => {
    const { root, update } = build();
    const bar = byClass(root, "miro-canvas-handles__rotate-bar");
    // Not inside the frame, which turns with the node.
    expect(bar.parentNode).toBe(root);
    expect(bar.hidden).toBe(false);
    // RECT is 200 x 100 centred on (200, 150): its bottom is at 200.
    expect(bar.style.left).toBe("200px");
    expect(bar.style.top).toBe("228px");
    // Turned a quarter, the node reaches 100 below its centre.
    update({ rotation: 90 });
    expect(Number.parseFloat(bar.style.top)).toBeCloseTo(278);
    // Upside down it is as low as upright - not up by the toolbar.
    update({ rotation: 180 });
    expect(Number.parseFloat(bar.style.top)).toBeCloseTo(228);
    update({ editable: false });
    expect(bar.hidden).toBe(true);
    update({ isEdge: true, rect: undefined, selectedIds: ["e1"], endpoints: { from: { x: 1, y: 1 }, to: { x: 2, y: 2 } } });
    expect(bar.hidden).toBe(true);
  });

  it("turns the node to the next right angle either way in one write", () => {
    const { root, rotations, update } = build({ rotation: 30 });
    byLabel(root, "Turn to the next right angle").dispatch("click");
    byLabel(root, "Turn to the previous right angle").dispatch("click");
    expect(rotations).toEqual([{ degrees: 90, commit: true }, { degrees: 0, commit: true }]);
    update({ rotation: 90 });
    byLabel(root, "Turn to the next right angle").dispatch("click");
    update({ rotation: -180 });
    byLabel(root, "Turn to the next right angle").dispatch("click");
    expect(rotations.slice(2)).toEqual([{ degrees: -180, commit: true }, { degrees: -90, commit: true }]);
    update({ editable: false });
    byLabel(root, "Turn to the previous right angle").dispatch("click");
    expect(rotations).toHaveLength(4);
  });

  it("steps between right angles without stopping on the one it is at", () => {
    expect(rightAngleStep(30, 1)).toBe(90);
    expect(rightAngleStep(30, -1)).toBe(0);
    expect(rightAngleStep(0, 1)).toBe(90);
    expect(rightAngleStep(0, -1)).toBe(-90);
    expect(rightAngleStep(-100, -1)).toBe(-180);
    expect(rightAngleStep(170, 1)).toBe(-180);
    expect(rightAngleStep(-180, 1)).toBe(-90);
  });
});
