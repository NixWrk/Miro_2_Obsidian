import { describe, expect, it } from "vitest";

import {
  SelectionHandles,
  normalizeAngle,
  nearestSide,
  pointerAngle,
  sideAnchor,
  type HandleSide,
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

function bySide(root: FakeElement, side: HandleSide): FakeElement {
  return descendants(root).find((item) => item.attributes.get("data-handle-side") === side)!;
}

function byLabel(root: FakeElement, label: string): FakeElement {
  return descendants(root).find((item) => item.attributes.get("aria-label") === label)!;
}

const RECT = { left: 100, top: 100, width: 200, height: 100 };

function build(overrides: Partial<SelectionHandlesState> = {}) {
  const rotations: Array<{ degrees: number; commit: boolean }> = [];
  const connects: Array<{ side: HandleSide; point: { x: number; y: number } }> = [];
  const creates: HandleSide[] = [];
  const handles = new SelectionHandles({
    onRotate: (degrees, commit) => { rotations.push({ degrees, commit }); },
    onConnect: (side, point) => { connects.push({ side, point: { x: point.x, y: point.y } }); },
    onCreateConnected: (side) => { creates.push(side); },
  }, { document: new FakeDocument() as unknown as Document });
  const base: SelectionHandlesState = {
    rect: RECT, rotation: 0, editable: true, isEdge: false, selectedIds: ["n1"], ...overrides,
  };
  const update = (patch: Partial<SelectionHandlesState> = {}): void => handles.update({ ...base, ...patch });
  update();
  return { handles, root: handles.element as unknown as FakeElement, rotations, connects, creates, update };
}

describe("selection handle geometry", () => {
  it("places one anchor at the middle of each side", () => {
    expect(sideAnchor(RECT, "top")).toEqual({ x: 200, y: 100 });
    expect(sideAnchor(RECT, "right")).toEqual({ x: 300, y: 150 });
    expect(sideAnchor(RECT, "bottom")).toEqual({ x: 200, y: 200 });
    expect(sideAnchor(RECT, "left")).toEqual({ x: 100, y: 150 });
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

  it("restores the committed rotation when a gesture is cancelled", () => {
    const { root, rotations, handles } = build({ rotation: 20 });
    byLabel(root, "Rotate").dispatch("pointerdown", { clientX: 200, clientY: 250, pointerId: 1 });
    handles.handlePointerMove({ clientX: 400, clientY: 150 });
    handles.cancelGesture();
    expect(rotations[rotations.length - 1]).toEqual({ degrees: 20, commit: true });
  });

  it("reports a connection pulled from a side to its release point", () => {
    const { root, connects, handles } = build();
    bySide(root, "right").dispatch("pointerdown", { clientX: 300, clientY: 150, pointerId: 2 });
    expect(root.getAttribute("data-miro-canvas-connecting")).toBe("right");
    handles.handlePointerUp({ clientX: 640, clientY: 155 });
    expect(connects).toEqual([{ side: "right", point: { x: 640, y: 155 } }]);
    expect(handles.gestureActive).toBe(false);
  });

  it("treats a click on a connection point as creating a connected node", () => {
    const { root, creates, connects, handles } = build();
    bySide(root, "top").dispatch("pointerdown", { clientX: 200, clientY: 100, pointerId: 6 });
    // Released where it started: a click, not a drag.
    handles.handlePointerUp({ clientX: 201, clientY: 101 });
    expect(creates).toEqual(["top"]);
    expect(connects).toEqual([]);
  });

  it("offers one affordance per side, arrowed away from the node", () => {
    const { root } = build();
    expect(bySide(root, "top").textContent).toBe("↑");
    expect(bySide(root, "right").textContent).toBe("→");
    expect(bySide(root, "bottom").textContent).toBe("↓");
    expect(bySide(root, "left").textContent).toBe("←");
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

  it("does not move the frame while a gesture is in flight", () => {
    const { root, update, handles } = build();
    const frame = root.children[0]!;
    byLabel(root, "Rotate").dispatch("pointerdown", { clientX: 200, clientY: 250, pointerId: 5 });
    update({ rect: { left: 900, top: 900, width: 10, height: 10 } });
    expect(frame.style.left).toBe("100px");
    handles.cancelGesture();
    update({ rect: { left: 900, top: 900, width: 10, height: 10 } });
    expect(frame.style.left).toBe("900px");
  });

  it("removes its listeners on dispose", () => {
    const { root, creates, handles } = build();
    handles.dispose();
    bySide(root, "right").dispatch("pointerdown", { clientX: 300, clientY: 150, pointerId: 7 });
    handles.handlePointerUp({ clientX: 300, clientY: 150 });
    expect(creates).toEqual([]);
  });
});
