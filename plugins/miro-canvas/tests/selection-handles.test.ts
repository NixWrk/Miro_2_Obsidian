import { describe, expect, it } from "vitest";

import {
  SelectionHandles,
  ROTATE_LABEL,
  magnetAngle,
  normalizeAngle,
  nearestSide,
  rightAngleStep,
  pointerAngle,
  resizeCursor,
  resizeRect,
  sideAnchor,
  type HandleRect,
  type HandleSide,
  type HandlePosition,
  type RouteGrip,
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

  public createElementNS(_namespace: string, tagName: string): FakeElement {
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
  const resizes: Array<{ rect: HandleRect; commit: boolean }> = [];
  let resizeCancellations = 0;
  const reshapes: Array<{ edgeId: string; grip: RouteGrip; point: { x: number; y: number } }> = [];
  const previews: Array<{ edgeId: string; grip: RouteGrip; point: { x: number; y: number } }> = [];
  const straightened: Array<{ edgeId: string; grip: RouteGrip }> = [];
  const handles = new SelectionHandles({
    previewRoute: (edgeId, grip, point) => {
      previews.push({ edgeId, grip, point: { x: point.x, y: point.y } });
      return [{ x: 0, y: 0 }, { x: point.x, y: point.y }, { x: 50, y: 50 }];
    },
    onReshape: (edgeId, grip, point) => { reshapes.push({ edgeId, grip, point: { x: point.x, y: point.y } }); },
    onStraighten: (edgeId, grip) => { straightened.push({ edgeId, grip }); },
    onResize: (rect, commit) => { resizes.push({ rect, commit }); },
    onCancelResize: () => { resizeCancellations += 1; },
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
  return {
    handles, root: handles.element as unknown as FakeElement, rotations, connects, creates, moves, resizes, update,
    reshapes, previews, straightened,
    cancellations: () => cancellations, resizeCancellations: () => resizeCancellations,
  };
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

  it("draws a turn near a multiple of 45 degrees onto it and leaves any other angle free", () => {
    expect(magnetAngle(43)).toBe(45);
    expect(magnetAngle(-88)).toBe(-90);
    expect(magnetAngle(3.5)).toBe(0);
    expect(magnetAngle(182)).toBe(-180);
    expect(magnetAngle(30)).toBe(30);
    expect(magnetAngle(50)).toBe(50);
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
    byLabel(root, ROTATE_LABEL).dispatch("pointerdown", { clientX: 200, clientY: 250, pointerId: 1 });
    expect(root.getAttribute("data-miro-canvas-rotating")).toBe("true");
    expect(handles.gestureActive).toBe(true);
    expect(rotations).toEqual([]);
  });

  it("keeps the grab offset so rotation does not jump on the first move", () => {
    const { root, rotations, handles } = build({ rotation: 45 });
    byLabel(root, ROTATE_LABEL).dispatch("pointerdown", { clientX: 200, clientY: 250, pointerId: 1 });
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
    byLabel(root, ROTATE_LABEL).dispatch("pointerdown", { clientX: 200, clientY: 250, pointerId: 1 });
    handles.handlePointerMove({ clientX: 260, clientY: 245, shiftKey: true });
    expect(Number.isInteger(rotations[0]!.degrees / 15)).toBe(true);
  });

  it("cancels a preview without committing it", () => {
    const { root, rotations, handles, cancellations } = build({ rotation: 20 });
    byLabel(root, ROTATE_LABEL).dispatch("pointerdown", { clientX: 200, clientY: 250, pointerId: 1 });
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
    expect(byLabel(root, ROTATE_LABEL).hidden).toBe(true);
    bySide(root, "right").dispatch("pointerdown", { clientX: 300, clientY: 150, pointerId: 3 });
    handles.handlePointerUp({ clientX: 500, clientY: 150 });
    expect(connects).toEqual([]);
    update({ isEdge: false, editable: false });
    byLabel(root, ROTATE_LABEL).dispatch("pointerdown", { clientX: 200, clientY: 250, pointerId: 4 });
    expect(rotations).toEqual([]);
  });

  it("keeps the geometry a gesture started with only while none is reported", () => {
    const { root, update, handles } = build();
    const frame = root.children[0]!;
    byLabel(root, ROTATE_LABEL).dispatch("pointerdown", { clientX: 200, clientY: 250, pointerId: 5 });
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
    byLabel(root, ROTATE_LABEL).dispatch("pointerdown", { clientX: 200, clientY: 250, pointerId: 13 });
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

  it("wrap the lower left corner of the box the node covers, whatever its angle", () => {
    const { root, update } = build();
    const bar = byClass(root, "miro-canvas-handles__rotate-bar");
    // Not inside the frame, which turns with the node.
    expect(bar.parentNode).toBe(root);
    expect(bar.hidden).toBe(false);
    // RECT is 200 x 100 at (100, 100): its lower left corner is (100, 200).
    expect(bar.style.left).toBe("100px");
    expect(bar.style.top).toBe("200px");
    // The free grip sits in the corner, the clockwise turn above it and the
    // other turn beside it.
    expect(bar.children.map((child) => child.getAttribute("aria-label"))).toEqual([
      "Turn to the next right angle", ROTATE_LABEL, "Turn to the previous right angle",
    ]);
    // Turned a quarter, the node covers 100 x 200 around (200, 150).
    update({ rotation: 90 });
    expect(Number.parseFloat(bar.style.left)).toBeCloseTo(150);
    expect(Number.parseFloat(bar.style.top)).toBeCloseTo(250);
    // Upside down the corner is where it was upright - not up by the toolbar.
    update({ rotation: 180 });
    expect(Number.parseFloat(bar.style.left)).toBeCloseTo(100);
    expect(Number.parseFloat(bar.style.top)).toBeCloseTo(200);
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

describe("resizing the box a node is drawn in", () => {
  const box = { left: 100, top: 100, width: 200, height: 100 };
  const close = (rect: HandleRect, expected: HandleRect): void => {
    for (const key of ["left", "top", "width", "height"] as const) expect(rect[key], key).toBeCloseTo(expected[key]);
  };
  const corner = (rect: HandleRect, rotation: number, sx: number, sy: number) => {
    const radians = rotation * Math.PI / 180;
    const x = sx * rect.width / 2, y = sy * rect.height / 2;
    return {
      x: rect.left + rect.width / 2 + x * Math.cos(radians) - y * Math.sin(radians),
      y: rect.top + rect.height / 2 + x * Math.sin(radians) + y * Math.cos(radians),
    };
  };

  it("stretches along one axis from a side and keeps the opposite side", () => {
    close(resizeRect(box, 0, "right", { x: 350, y: 999 }, { uniform: true }), { left: 100, top: 100, width: 250, height: 100 });
    close(resizeRect(box, 0, "top", { x: -5, y: 60 }, { uniform: true }), { left: 100, top: 60, width: 200, height: 140 });
    close(resizeRect(box, 0, "left", { x: 150, y: 0 }, { uniform: true }), { left: 150, top: 100, width: 150, height: 100 });
  });

  it("scales evenly from a corner and keeps the opposite corner", () => {
    const grown = resizeRect(box, 0, "bottom-right", { x: 500, y: 200 }, { uniform: true });
    expect(grown.width / grown.height).toBeCloseTo(2);
    expect(grown.left).toBeCloseTo(100);
    expect(grown.top).toBeCloseTo(100);
    expect(grown.width).toBeGreaterThan(200);
    const shrunk = resizeRect(box, 0, "top-left", { x: 200, y: 150 }, { uniform: true });
    close(shrunk, { left: 200, top: 150, width: 100, height: 50 });
  });

  it("lets a corner change both sides freely when asked", () => {
    close(resizeRect(box, 0, "bottom-right", { x: 400, y: 300 }, { uniform: false }), { left: 100, top: 100, width: 300, height: 200 });
  });

  it("resizes a turned node along its own sides and keeps its far corner in place", () => {
    for (const rotation of [30, 90, -135]) {
      const fixed = corner(box, rotation, -1, -1);
      const pulled = corner(box, rotation, 1, 1);
      // Pull the corner further out along the node's own diagonal.
      const out = { x: fixed.x + (pulled.x - fixed.x) * 1.5, y: fixed.y + (pulled.y - fixed.y) * 1.5 };
      const rect = resizeRect(box, rotation, "bottom-right", out, { uniform: true });
      expect(rect.width, String(rotation)).toBeCloseTo(300);
      expect(rect.height, String(rotation)).toBeCloseTo(150);
      const after = corner(rect, rotation, -1, -1);
      expect(after.x, String(rotation)).toBeCloseTo(fixed.x);
      expect(after.y, String(rotation)).toBeCloseTo(fixed.y);
    }
    // A side of a turned node moves only along the node's own axis.
    const fixedSide = corner(box, 90, -1, 0);
    const rect = resizeRect(box, 90, "right", { x: 250, y: 350 }, { uniform: true });
    expect(rect.width).toBeCloseTo(300);
    expect(rect.height).toBeCloseTo(100);
    const after = corner(rect, 90, -1, 0);
    expect(after.x).toBeCloseTo(fixedSide.x);
    expect(after.y).toBeCloseTo(fixedSide.y);
  });

  it("never shrinks below the smallest size, even past the fixed corner", () => {
    const side = resizeRect(box, 0, "right", { x: 0, y: 0 }, { uniform: true, minSize: 20 });
    close(side, { left: 100, top: 100, width: 20, height: 100 });
    const evenly = resizeRect(box, 0, "bottom-right", { x: 0, y: 0 }, { uniform: true, minSize: 20 });
    expect(evenly.height).toBeCloseTo(20);
    expect(evenly.width).toBeCloseTo(40);
    expect(evenly.left).toBeCloseTo(100);
  });

  it("points each cursor along its grip as the node turns", () => {
    expect(resizeCursor("right", 0)).toBe("ew-resize");
    expect(resizeCursor("top", 0)).toBe("ns-resize");
    expect(resizeCursor("top-left", 0)).toBe("nwse-resize");
    expect(resizeCursor("top-right", 0)).toBe("nesw-resize");
    expect(resizeCursor("right", 90)).toBe("ns-resize");
    expect(resizeCursor("right", 45)).toBe("nwse-resize");
    expect(resizeCursor("bottom-left", -90)).toBe("nwse-resize");
  });

  const grip = (root: FakeElement, handle: string): FakeElement =>
    descendants(root).find((item) => item.attributes.get("data-resize") === handle)!;

  it("draws a dashed box with a grip on every corner and side", () => {
    const { root, update } = build({ rotation: 90 });
    const frame = root.children[0]!;
    expect(frame.getAttribute("data-miro-canvas-resizable")).toBe("true");
    const grips = descendants(frame).filter((item) => item.attributes.has("data-resize"));
    expect(grips.map((item) => item.attributes.get("data-resize")).sort()).toEqual(
      ["bottom", "bottom-left", "bottom-right", "left", "right", "top", "top-left", "top-right"],
    );
    expect(grip(root, "right").style.cursor).toBe("ns-resize");
    update({ editable: false });
    expect(frame.getAttribute("data-miro-canvas-resizable")).toBe("false");
    expect(grips.every((item) => item.hidden)).toBe(true);
    update({ isEdge: true, editable: true });
    expect(grips.every((item) => item.hidden)).toBe(true);
  });

  it("previews a resize, keeps showing it over stale reports, and commits once", () => {
    const { root, handles, resizes, update } = build();
    grip(root, "right").dispatch("pointerdown", { clientX: 300, clientY: 150, pointerId: 1 });
    handles.handlePointerMove({ clientX: 302, clientY: 150 });
    expect(resizes).toEqual([]);
    handles.handlePointerMove({ clientX: 350, clientY: 150 });
    expect(resizes).toHaveLength(1);
    expect(resizes[0]!.commit).toBe(false);
    expect(resizes[0]!.rect.width).toBeCloseTo(250);
    // The host still reports the old box until it saves.
    update();
    expect(root.children[0]!.style.width).toBe("250px");
    handles.handlePointerUp({ clientX: 360, clientY: 150 });
    expect(resizes[1]!.commit).toBe(true);
    expect(resizes[1]!.rect.width).toBeCloseTo(260);
    expect(handles.gestureActive).toBe(false);
    expect(root.getAttribute("data-miro-canvas-resizing")).toBeNull();
  });

  it("scales evenly unless Shift is held", () => {
    const { root, handles, resizes } = build();
    grip(root, "bottom-right").dispatch("pointerdown", { clientX: 300, clientY: 200, pointerId: 1 });
    handles.handlePointerMove({ clientX: 400, clientY: 210 });
    expect(resizes[0]!.rect.width / resizes[0]!.rect.height).toBeCloseTo(2);
    handles.handlePointerMove({ clientX: 400, clientY: 210, shiftKey: true });
    expect(resizes[1]!.rect.width).toBeCloseTo(300);
    expect(resizes[1]!.rect.height).toBeCloseTo(110);
  });

  it("writes nothing for a press and puts a cancelled preview back", () => {
    const { root, handles, resizes, resizeCancellations } = build();
    grip(root, "left").dispatch("pointerdown", { clientX: 100, clientY: 150, pointerId: 1 });
    handles.handlePointerUp({ clientX: 101, clientY: 150 });
    expect(resizes).toEqual([]);
    expect(resizeCancellations()).toBe(0);
    grip(root, "left").dispatch("pointerdown", { clientX: 100, clientY: 150, pointerId: 1 });
    handles.handlePointerMove({ clientX: 50, clientY: 150 });
    handles.cancelGesture();
    expect(resizeCancellations()).toBe(1);
    expect(resizes.filter((item) => item.commit)).toEqual([]);
    expect(root.children[0]!.style.width).toBe("200px");
  });

  it("does not start on a locked node", () => {
    const { root, handles, resizes } = build({ editable: false });
    grip(root, "left").dispatch("pointerdown", { clientX: 100, clientY: 150, pointerId: 1 });
    expect(handles.gestureActive).toBe(false);
    handles.handlePointerMove({ clientX: 50, clientY: 150 });
    expect(resizes).toEqual([]);
  });
});

describe("reshaping a connector", () => {
  const GRIPS: readonly RouteGrip[] = [
    { kind: "insert", index: 0, x: 40, y: 20 },
    { kind: "waypoint", index: 0, x: 80, y: 60 },
    { kind: "insert", index: 1, x: 120, y: 30 },
  ];
  const edge = (overrides: Partial<SelectionHandlesState> = {}) => build({
    isEdge: true, selectedIds: ["e1"], rect: undefined,
    endpoints: { from: { x: 0, y: 0 }, to: { x: 160, y: 0 } }, routeGrips: GRIPS, ...overrides,
  });
  const grips = (root: FakeElement): FakeElement[] => descendants(root).filter((item) => item.attributes.has("data-route-grip"));

  it("draws a grip at every place the route can be grabbed", () => {
    const { root, update } = edge();
    const drawn = grips(root);
    expect(drawn.map((item) => item.attributes.get("data-route-grip"))).toEqual(["insert", "waypoint", "insert"]);
    expect(drawn.map((item) => [item.style.left, item.style.top])).toEqual([["40px", "20px"], ["80px", "60px"], ["120px", "30px"]]);
    expect(drawn[1]!.className).toContain("miro-canvas-handle--route-waypoint");
    // Moved grips of the same kinds are reused, not rebuilt.
    update({ routeGrips: GRIPS.map((grip) => ({ ...grip, x: grip.x + 5 })) });
    expect(grips(root)[0]).toBe(drawn[0]);
    expect(drawn[0]!.style.left).toBe("45px");
    update({ routeGrips: [{ kind: "segment", index: 1, axis: "x", x: 10, y: 10 }] });
    expect(grips(root).map((item) => item.attributes.get("data-route-axis"))).toEqual(["x"]);
  });

  it("shows no grips on a node, a locked connector or a multiple selection", () => {
    const { root, update } = edge();
    update({ editable: false });
    expect(grips(root)).toHaveLength(0);
    update({ editable: true, selectedIds: ["e1", "e2"] });
    expect(grips(root)).toHaveLength(0);
    update({ selectedIds: ["n1"], isEdge: false, rect: RECT });
    expect(grips(root)).toHaveLength(0);
  });

  it("previews the dragged shape and writes it once on release", () => {
    const { root, handles, reshapes, previews } = edge();
    const insert = grips(root)[2]!;
    insert.dispatch("pointerdown", { clientX: 120, clientY: 30, pointerId: 1 });
    expect(handles.gestureActive).toBe(true);
    expect(root.getAttribute("data-miro-canvas-reshaping")).toBe("insert");
    handles.handlePointerMove({ clientX: 121, clientY: 30 });
    expect(previews).toEqual([]);
    handles.handlePointerMove({ clientX: 130, clientY: 70 });
    expect(previews).toEqual([{ edgeId: "e1", grip: GRIPS[2], point: { x: 130, y: 70 } }]);
    expect(insert.style.left).toBe("130px");
    const preview = descendants(root).find((item) => item.tagName === "path")!;
    expect(preview.getAttribute("d")).toBe("M 0 0 L 130 70 L 50 50");
    handles.handlePointerUp({ clientX: 140, clientY: 80 });
    expect(reshapes).toEqual([{ edgeId: "e1", grip: GRIPS[2], point: { x: 140, y: 80 } }]);
    expect(handles.gestureActive).toBe(false);
    expect(preview.getAttribute("d")).toBeNull();
    expect(root.getAttribute("data-miro-canvas-reshaping")).toBeNull();
  });

  it("leaves the route alone when a grip is only pressed, and puts a cancelled grip back", () => {
    const { root, handles, reshapes } = edge();
    const waypoint = grips(root)[1]!;
    waypoint.dispatch("pointerdown", { clientX: 80, clientY: 60, pointerId: 1 });
    handles.handlePointerUp({ clientX: 81, clientY: 60 });
    expect(reshapes).toEqual([]);
    waypoint.dispatch("pointerdown", { clientX: 80, clientY: 60, pointerId: 1 });
    handles.handlePointerMove({ clientX: 200, clientY: 200 });
    expect(waypoint.style.left).toBe("200px");
    handles.cancelGesture();
    expect(waypoint.style.left).toBe("80px");
    expect(reshapes).toEqual([]);
  });

  it("straightens a bend on double-click, but not the middle of a stretch", () => {
    const { root, straightened, update } = edge();
    grips(root)[0]!.dispatch("dblclick");
    grips(root)[1]!.dispatch("dblclick");
    expect(straightened).toEqual([{ edgeId: "e1", grip: GRIPS[1] }]);
    // Grips rebuilt for another route drop the old grips' listeners.
    const old = grips(root)[1]!;
    update({ routeGrips: [{ kind: "segment", index: 0, axis: "y", x: 0, y: 0 }] });
    old.dispatch("dblclick");
    expect(straightened).toHaveLength(1);
  });
});

describe("where a dragged end lands", () => {
  it("draws the dragged end where the host would place it, not under the pointer", () => {
    const landings: unknown[] = [];
    const handles = new SelectionHandles({
      onRotate: () => {}, onCancelRotation: () => {}, onConnect: () => {}, onCreateConnected: () => {},
      onMoveEndpoint: () => {},
      previewEnd: (gesture, point) => { landings.push(gesture); return { x: point.x - 7, y: 300 }; },
    }, { document: new FakeDocument() as unknown as Document });
    const endpoints = { from: { x: 120, y: 80 }, to: { x: 420, y: 160 } };
    handles.update({ rotation: 0, editable: true, isEdge: true, selectedIds: ["e1"], endpoints });
    const root = handles.element as unknown as FakeElement;
    const grip = descendants(root).find((item) => item.attributes.get("data-connector-end") === "to")!;
    grip.dispatch("pointerdown", { clientX: 420, clientY: 160, pointerId: 41 });
    handles.handlePointerMove({ clientX: 500, clientY: 205 });
    expect(grip.style.left).toBe("493px");
    expect(grip.style.top).toBe("300px");
    expect(landings).toEqual([{ kind: "end", edgeId: "e1", end: "to" }]);
  });
});
