/**
 * Selection handles drawn over the Canvas: the dashed box a node is drawn in,
 * with resize grips on its corners and sides, a rotation grip, and one
 * combined connect/quick-create affordance on every side.
 *
 * The box turns with the node, so resizing works in the node's own frame: a
 * corner scales the node evenly and a side stretches it along one axis, while
 * the opposite corner or side stays where it is.  The overlay reports
 * gestures to its host and owns no persistence: a rotation is previewed here
 * and written by the host through one guarded metadata transaction, and a
 * resize is previewed and written by the host through native Canvas.
 *
 * All geometry arrives already resolved in viewport pixels, so this module can
 * be exercised without a layout engine.
 */

import { contourPoint, shapeOutline } from "./shape-geometry";

export type HandleSide = "top" | "right" | "bottom" | "left";
export const HANDLE_POSITIONS = [0.5] as const;
export type HandlePosition = (typeof HANDLE_POSITIONS)[number];

interface ShapePointLike {
  readonly x: number;
  readonly y: number;
}

export interface HandleRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

export interface SelectionHandlesState {
  /** Viewport rectangle of the selection, before rotation. */
  readonly rect?: HandleRect;
  readonly rotation: number;
  readonly editable: boolean;
  /** A connector has no sides to pull from and no shape to rotate. */
  readonly isEdge: boolean;
  readonly selectedIds: readonly string[];
  /** Shape kind used to place connection points on the visible contour. */
  readonly shape?: string;
  /** Viewport position of the overlay origin; pointer events use window coordinates. */
  readonly origin?: ShapePointLike;
  /** Overlay-local ends of a selected connector, where its end grips sit. */
  readonly endpoints?: { readonly from?: ShapePointLike; readonly to?: ShapePointLike };
  /** The smallest width or height a resize may reach, in viewport pixels. */
  readonly minSize?: number;
  /** Overlay-local places where a selected connector's route can be reshaped. */
  readonly routeGrips?: readonly RouteGrip[];
  /** A line drawn on its own, whose ends hold on to nothing. */
  readonly freeEnds?: boolean;
}

/**
 * A place on a connector's route: a waypoint, the middle of a stretch that
 * gains a waypoint when dragged, or an elbowed segment that moves square to
 * itself along `axis`.
 */
export interface RouteGrip {
  readonly kind: "waypoint" | "insert" | "segment";
  readonly index: number;
  readonly x: number;
  readonly y: number;
  readonly axis?: "x" | "y";
}

/** A grip on the box a node is drawn in: a side stretches, a corner scales. */
export type ResizeHandle =
  | "top" | "right" | "bottom" | "left"
  | "top-left" | "top-right" | "bottom-right" | "bottom-left";

export const RESIZE_HANDLES: readonly ResizeHandle[] = [
  "top-left", "top", "top-right", "right", "bottom-right", "bottom", "bottom-left", "left",
];

/** Which way each grip pulls the box, in the node's own unturned frame. */
const RESIZE_SIGNS: Readonly<Record<ResizeHandle, readonly [number, number]>> = Object.freeze({
  top: [0, -1], right: [1, 0], bottom: [0, 1], left: [-1, 0],
  "top-left": [-1, -1], "top-right": [1, -1], "bottom-right": [1, 1], "bottom-left": [-1, 1],
});

export interface ResizeOptions {
  /** A corner keeps the proportions; false lets it change both sides freely. */
  readonly uniform: boolean;
  readonly minSize?: number;
}

/**
 * The unturned box a node takes when one of its grips is dragged to `pointer`.
 *
 * The pointer is read in the node's own frame, about its centre, so a turned
 * node grows along its own sides.  The grip's opposite - the far corner, or
 * the middle of the far side - keeps its place on screen, which moves the
 * centre; the result is the box around that new centre that the host turns
 * by the same angle.  A corner scales evenly by projecting the pointer onto
 * the box's diagonal, and nothing shrinks below `minSize`.
 */
export function resizeRect(
  start: HandleRect,
  rotation: number,
  handle: ResizeHandle,
  pointer: ShapePointLike,
  options: ResizeOptions,
): HandleRect {
  const [sx, sy] = RESIZE_SIGNS[handle];
  const least = Math.max(1, options.minSize ?? 1);
  const radians = rotation * Math.PI / 180;
  const cos = Math.cos(radians), sin = Math.sin(radians);
  const cx = start.left + start.width / 2, cy = start.top + start.height / 2;
  const dx = pointer.x - cx, dy = pointer.y - cy;
  const qx = dx * cos + dy * sin, qy = -dx * sin + dy * cos;
  // The point that stays put, in the unturned frame about the old centre.
  const ax = -sx * start.width / 2, ay = -sy * start.height / 2;
  let width = start.width, height = start.height;
  if (sx !== 0 && sy !== 0 && options.uniform) {
    const along = ((qx - ax) * sx * start.width + (qy - ay) * sy * start.height)
      / (start.width ** 2 + start.height ** 2);
    const scale = Math.max(along, least / start.width, least / start.height);
    width = start.width * scale;
    height = start.height * scale;
  } else {
    if (sx !== 0) width = Math.max(least, sx * (qx - ax));
    if (sy !== 0) height = Math.max(least, sy * (qy - ay));
  }
  const lx = sx === 0 ? 0 : ax + sx * width / 2;
  const ly = sy === 0 ? 0 : ay + sy * height / 2;
  const ncx = cx + lx * cos - ly * sin;
  const ncy = cy + lx * sin + ly * cos;
  return { left: ncx - width / 2, top: ncy - height / 2, width, height };
}

/** The resize cursor that points along a grip once the node is turned. */
export function resizeCursor(handle: ResizeHandle, rotation: number): string {
  const [sx, sy] = RESIZE_SIGNS[handle];
  const angle = ((Math.atan2(sy, sx) * 180 / Math.PI + rotation) % 180 + 180) % 180;
  const step = Math.round(angle / 45) % 4;
  return ["ew-resize", "nwse-resize", "ns-resize", "nesw-resize"][step]!;
}

export type ConnectorEnd = "from" | "to";

/** A connector gesture in progress, as the host needs it to place the end being dragged. */
export type ConnectorGesture =
  | { readonly kind: "connect"; readonly sourceId: string; readonly side: HandleSide; readonly position: HandlePosition }
  | { readonly kind: "end"; readonly edgeId: string; readonly end: ConnectorEnd };

export interface SelectionHandlesActions {
  /** Called continuously while dragging, then once with `commit` true. */
  readonly onRotate: (degrees: number, commit: boolean) => void;
  /** Discard an in-flight preview without creating a history entry. */
  readonly onCancelRotation: () => void;
  /** A connection was pulled from `side` and released at a viewport point. */
  readonly onConnect: (
    sourceId: string,
    side: HandleSide,
    position: HandlePosition,
    point: { readonly x: number; readonly y: number },
  ) => void;
  /** A connection point was clicked rather than dragged. */
  readonly onCreateConnected: (sourceId: string, side: HandleSide, position: HandlePosition) => void;
  /**
   * The node was resized to an unturned overlay-local box: continuously while
   * dragging, then once with `commit` true.
   */
  readonly onResize?: (rect: HandleRect, commit: boolean) => void;
  /** Put back a resize preview that was not committed. */
  readonly onCancelResize?: () => void;
  /**
   * The route a connector would take with `grip` dragged to a viewport point,
   * as overlay-local points, so the drag shows the shape it will leave.
   */
  readonly previewRoute?: (edgeId: string, grip: RouteGrip, point: { readonly x: number; readonly y: number }) =>
    readonly { readonly x: number; readonly y: number }[] | undefined;
  /** A route grip was dragged and released at a viewport point. */
  readonly onReshape?: (edgeId: string, grip: RouteGrip, point: { readonly x: number; readonly y: number }) => void;
  /** A waypoint or segment was double-clicked: take that bend out. */
  readonly onStraighten?: (edgeId: string, grip: RouteGrip) => void;
  /** An end of the selected connector was dragged and released at a viewport point. */
  readonly onMoveEndpoint?: (edgeId: string, end: ConnectorEnd, point: { readonly x: number; readonly y: number }) => void;
  /**
   * Where the end being dragged would land for a viewport point - attached to
   * a nearby outline, snapped to a key point, or free.  The preview draws the
   * end there, so what the drag shows is what the drop does.
   */
  readonly previewEnd?: (
    gesture: ConnectorGesture,
    point: { readonly x: number; readonly y: number },
  ) => { readonly x: number; readonly y: number } | undefined;
}

export interface SelectionHandlesOptions {
  readonly document?: Document;
  readonly className?: string;
  /** Rotation snaps to this many degrees while Shift is held. */
  readonly snapDegrees?: number;
  /** Movement under this many pixels counts as a click, not a drag. */
  readonly dragThreshold?: number;
}

const SIDES: readonly HandleSide[] = ["top", "right", "bottom", "left"];
const DEFAULT_SNAP = 15;
const DEFAULT_DRAG_THRESHOLD = 4;
/** Each connection point becomes an arrow pointing away from the node. */
const SIDE_ARROWS: Readonly<Record<HandleSide, string>> = Object.freeze({
  top: "↑", right: "→", bottom: "↓", left: "←",
});

/** A point along one side of a rectangle, in the rectangle's own space. */
export function sideAnchor(
  rect: HandleRect,
  side: HandleSide,
  position: number = 0.5,
): { readonly x: number; readonly y: number } {
  switch (side) {
    case "top": return { x: rect.left + rect.width * position, y: rect.top };
    case "right": return { x: rect.left + rect.width, y: rect.top + rect.height * position };
    case "bottom": return { x: rect.left + rect.width * position, y: rect.top + rect.height };
    case "left": return { x: rect.left, y: rect.top + rect.height * position };
  }
}

/** The side a point lies towards, used to place a quick-created node. */
export function nearestSide(rect: HandleRect, point: { readonly x: number; readonly y: number }): HandleSide {
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  const dx = point.x - cx;
  const dy = point.y - cy;
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? "right" : "left";
  return dy >= 0 ? "bottom" : "top";
}

/**
 * Angle of a pointer around the rectangle center, in degrees, measured so that
 * a grip below the center reads as the current rotation rather than an offset.
 */
export function pointerAngle(rect: HandleRect, point: { readonly x: number; readonly y: number }): number {
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  return Math.atan2(point.y - cy, point.x - cx) * 180 / Math.PI;
}

/**
 * The next right angle from `degrees` in a direction: +1 clockwise, -1 the
 * other way.  An angle already on a right angle moves a full quarter.
 */
export function rightAngleStep(degrees: number, direction: 1 | -1): number {
  const quarters = degrees / 90;
  const nearest = Math.round(quarters);
  const aligned = Math.abs(quarters - nearest) < 1e-6;
  const target = direction > 0
    ? (aligned ? nearest + 1 : Math.ceil(quarters))
    : (aligned ? nearest - 1 : Math.floor(quarters));
  return normalizeAngle(target * 90);
}

/**
 * Normalize to [-180, 180) and snap when asked, matching the range the
 * authoring layer stores so a committed rotation is not renormalized to a
 * different-looking value.
 */
export function normalizeAngle(degrees: number, snap = 0): number {
  const snapped = snap > 0 ? Math.round(degrees / snap) * snap : degrees;
  const wrapped = ((snapped + 180) % 360 + 360) % 360 - 180;
  return Object.is(wrapped, -0) ? 0 : wrapped;
}

function hasDocument(value: unknown): value is Document {
  return value !== null && typeof value === "object"
    && typeof (value as { createElement?: unknown }).createElement === "function";
}

function make<K extends keyof HTMLElementTagNameMap>(
  document: Document, tag: K, className: string, label?: string,
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  element.className = className;
  if (label !== undefined) element.textContent = label;
  return element;
}

function makeGrip(document: Document, className: string, glyph: string, title: string): HTMLButtonElement {
  const button = make(document, "button", `miro-canvas-handle ${className}`, glyph);
  button.type = "button";
  // Obsidian renders a tooltip from aria-label; a title would duplicate it.
  button.setAttribute("aria-label", title);
  return button;
}

function pointOf(event: unknown): { readonly x: number; readonly y: number } | undefined {
  const record = event as { clientX?: unknown; clientY?: unknown } | null;
  const x = typeof record?.clientX === "number" ? record.clientX : undefined;
  const y = typeof record?.clientY === "number" ? record.clientY : undefined;
  return x === undefined || y === undefined ? undefined : { x, y };
}

interface HandleRefs {
  readonly frame: HTMLElement;
  readonly resizers: readonly HTMLElement[];
  /** Where a connector's route grips are drawn, rebuilt when their number or kinds change. */
  readonly routeLayer: HTMLElement;
  /** The rotation grip and the two right-angle turns, kept upright below the node. */
  readonly rotateBar: HTMLElement;
  readonly rotate: HTMLButtonElement;
  readonly connectors: readonly HTMLButtonElement[];
  readonly ends: Readonly<Record<ConnectorEnd, HTMLButtonElement>>;
  /** The line drawn while a connector or one of its ends is being pulled. */
  readonly preview?: SVGPathElement;
}

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";

function makePreview(document: Document, root: HTMLElement): SVGPathElement | undefined {
  if (typeof (document as { createElementNS?: unknown }).createElementNS !== "function") return undefined;
  const svg = document.createElementNS(SVG_NAMESPACE, "svg");
  svg.setAttribute("class", "miro-canvas-handles__preview");
  const path = document.createElementNS(SVG_NAMESPACE, "path");
  svg.appendChild(path);
  root.appendChild(svg as unknown as HTMLElement);
  return path;
}

/** The viewport centre of an element, when the host can measure it. */
function centreOf(element: unknown): ShapePointLike | undefined {
  const measure = (element as { getBoundingClientRect?: () => DOMRect } | null)?.getBoundingClientRect;
  if (typeof measure !== "function") return undefined;
  try {
    const rect = measure.call(element);
    return Number.isFinite(rect.left) && Number.isFinite(rect.top)
      ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
      : undefined;
  } catch {
    return undefined;
  }
}

export class SelectionHandles {
  public readonly element: HTMLElement;
  private readonly document: Document | undefined;
  private readonly actions: SelectionHandlesActions;
  private readonly snapDegrees: number;
  private readonly dragThreshold: number;
  private readonly listeners: Array<() => void> = [];
  /** Listeners on route grips, dropped whenever the grips are rebuilt. */
  private readonly routeListeners: Array<() => void> = [];
  private readonly refs: HandleRefs | undefined;
  private state: SelectionHandlesState = { rotation: 0, editable: false, isEdge: false, selectedIds: [] };
  private rotating = false;
  /** Difference between the pointer angle and the rotation when the drag began. */
  private rotationOffset = 0;
  private dragSide: HandleSide | undefined;
  private dragPosition: HandlePosition | undefined;
  private dragSourceId: string | undefined;
  private dragOrigin: { readonly x: number; readonly y: number } | undefined;
  /** Overlay-local point the pulled connector starts from, for its preview. */
  private dragStart: ShapePointLike | undefined;
  /** The end of the selected connector being moved, if one is. */
  private endDrag: { readonly edgeId: string; readonly end: ConnectorEnd; readonly origin: ShapePointLike } | undefined;
  /** A route grip being dragged. */
  private routeDrag: {
    readonly edgeId: string;
    readonly grip: RouteGrip;
    /** The grip under the pointer; a press on the line itself has none. */
    readonly element?: HTMLElement;
    readonly origin: ShapePointLike;
    moved: boolean;
  } | undefined;
  /** A resize in progress: the grip, the box and angle it started from, and the box it shows now. */
  private resizeDrag: {
    readonly handle: ResizeHandle;
    readonly start: HandleRect;
    readonly rotation: number;
    readonly origin: ShapePointLike;
    rect: HandleRect;
    moved: boolean;
  } | undefined;

  public constructor(actions: SelectionHandlesActions, options: SelectionHandlesOptions = {}) {
    this.actions = actions;
    this.snapDegrees = options.snapDegrees ?? DEFAULT_SNAP;
    this.dragThreshold = options.dragThreshold ?? DEFAULT_DRAG_THRESHOLD;
    this.document = options.document ?? (typeof document !== "undefined" ? document : undefined);
    if (!hasDocument(this.document)) {
      this.element = {} as HTMLElement;
      return;
    }
    const root = make(this.document, "div", options.className ?? "miro-canvas-handles");
    root.setAttribute("data-miro-canvas-handles", "true");
    root.hidden = true;
    this.element = root;
    this.refs = this.build(root);
  }

  private build(root: HTMLElement): HandleRefs {
    const document = this.document!;
    const frame = root.appendChild(make(document, "div", "miro-canvas-handles__frame"));
    // Resize grips come first so the connection points, drawn later, stay on
    // top where a side's middle holds both.
    const resizers = RESIZE_HANDLES.map((handle) => {
      const corner = handle.includes("-");
      const grip = frame.appendChild(make(
        document, "div", `miro-canvas-resizer miro-canvas-resizer--${corner ? "corner" : "side"} miro-canvas-resizer--${handle}`,
      ));
      grip.setAttribute("data-resize", handle);
      // A side explains itself by its cursor; a hint there would sit under the drag.
      if (corner) grip.setAttribute("aria-label", "Drag to scale evenly; hold Shift to change both sides freely");
      this.listen(grip, "pointerdown", (event) => this.beginResize(handle, event));
      return grip;
    });
    const connectors: HTMLButtonElement[] = [];
    for (const side of SIDES) {
      for (const position of HANDLE_POSITIONS) {
        const dot = frame.appendChild(makeGrip(
          document,
          `miro-canvas-handle--connect miro-canvas-handle--${side}`,
          SIDE_ARROWS[side],
          `Click to add a connected node ${side}, or drag to connect`,
        ));
        dot.setAttribute("data-handle-side", side);
        dot.setAttribute("data-handle-position", String(position));
        this.listen(dot, "pointerdown", (event) => this.beginConnect(side, position, event));
        connectors.push(dot);
      }
    }
    // The rotation controls live outside the turning frame: turned with the
    // node, a grip at one corner ended up under the formatting toolbar once
    // the node was upside down.  They wrap the lower left corner as an L -
    // the free grip in the corner, a clockwise turn above it, an
    // anticlockwise turn beside it.
    const rotateBar = root.appendChild(make(document, "div", "miro-canvas-handles__rotate-bar"));
    const turnOn = rotateBar.appendChild(makeGrip(
      document, "miro-canvas-handle--turn miro-canvas-handle--turn-next", "↷", "Turn to the next right angle",
    ));
    const rotate = rotateBar.appendChild(makeGrip(document, "miro-canvas-handle--rotate", "↻", "Rotate"));
    const turnBack = rotateBar.appendChild(makeGrip(
      document, "miro-canvas-handle--turn miro-canvas-handle--turn-back", "↶", "Turn to the previous right angle",
    ));
    this.listen(rotate, "pointerdown", (event) => this.beginRotate(event));
    this.listen(turnBack, "click", () => this.turn(-1));
    this.listen(turnOn, "click", () => this.turn(1));
    const end = (which: ConnectorEnd): HTMLButtonElement => {
      const grip = root.appendChild(makeGrip(
        document,
        "miro-canvas-handle--endpoint",
        "",
        "Drag to move this end anywhere on a node's outline",
      ));
      grip.setAttribute("data-connector-end", which);
      grip.hidden = true;
      this.listen(grip, "pointerdown", (event) => this.beginEndDrag(which, event));
      return grip;
    };
    const ends = { from: end("from"), to: end("to") };
    const routeLayer = root.appendChild(make(document, "div", "miro-canvas-handles__route"));
    const preview = makePreview(document, root);
    return { frame, resizers, routeLayer, rotateBar, rotate, connectors, ends, ...(preview === undefined ? {} : { preview }) };
  }

  private listen(target: EventTarget, type: string, handler: EventListener): void {
    target.addEventListener(type, handler);
    this.listeners.push(() => target.removeEventListener(type, handler));
  }

  private listenRoute(target: EventTarget, type: string, handler: EventListener): void {
    target.addEventListener(type, handler);
    this.routeListeners.push(() => target.removeEventListener(type, handler));
  }

  /** Pointer capture keeps the gesture alive when it leaves the small grip. */
  private capture(event: unknown): void {
    const target = event as { pointerId?: unknown; target?: { setPointerCapture?: (id: number) => void } };
    const id = target.pointerId;
    if (typeof id !== "number") return;
    try {
      target.target?.setPointerCapture?.(id);
    } catch {
      // A host without pointer capture still receives the document listeners.
    }
  }

  private local(point: ShapePointLike): ShapePointLike {
    const origin = this.state.origin;
    return origin === undefined ? point : { x: point.x - origin.x, y: point.y - origin.y };
  }

  private beginRotate(event: unknown): void {
    const rect = this.state.rect;
    if (!this.state.editable || rect === undefined) return;
    const point = pointOf(event);
    if (point === undefined) return;
    (event as Event).preventDefault?.();
    this.capture(event);
    this.rotating = true;
    this.rotationOffset = this.state.rotation - pointerAngle(rect, this.local(point));
    this.element.setAttribute("data-miro-canvas-rotating", "true");
  }

  private beginConnect(side: HandleSide, position: HandlePosition, event: unknown): void {
    if (!this.state.editable || this.state.isEdge) return;
    const sourceId = this.state.selectedIds[0];
    if (sourceId === undefined) return;
    (event as Event).preventDefault?.();
    this.capture(event);
    this.dragSide = side;
    this.dragPosition = position;
    this.dragSourceId = sourceId;
    this.dragOrigin = pointOf(event);
    const start = centreOf((event as { currentTarget?: unknown; target?: unknown }).currentTarget
      ?? (event as { target?: unknown }).target) ?? this.dragOrigin;
    this.dragStart = start === undefined ? undefined : this.local(start);
    this.element.setAttribute("data-miro-canvas-connecting", side);
  }

  private beginResize(handle: ResizeHandle, event: unknown): void {
    const rect = this.state.rect;
    const origin = pointOf(event);
    if (!this.state.editable || this.state.isEdge || rect === undefined || origin === undefined
      || this.state.selectedIds.length !== 1 || this.actions.onResize === undefined) return;
    (event as Event).preventDefault?.();
    (event as Event).stopPropagation?.();
    this.capture(event);
    this.resizeDrag = { handle, start: rect, rotation: this.state.rotation, origin, rect, moved: false };
    this.element.setAttribute("data-miro-canvas-resizing", handle);
  }

  private beginRouteDrag(grip: RouteGrip, element: HTMLElement, event: unknown): void {
    const edgeId = this.state.selectedIds[0];
    const origin = pointOf(event);
    if (!this.state.editable || !this.state.isEdge || edgeId === undefined || origin === undefined) return;
    (event as Event).preventDefault?.();
    (event as Event).stopPropagation?.();
    this.capture(event);
    this.routeDrag = { edgeId, grip, element, origin, moved: false };
    this.element.setAttribute("data-miro-canvas-reshaping", grip.kind);
  }

  /**
   * Reshape a connector from a press on its line, as if the grip it stands
   * for had been grabbed.  The host has already checked that the connector
   * may change; the drag previews and commits like any grip.
   */
  public grabRoute(edgeId: string, grip: RouteGrip, event: unknown): boolean {
    const origin = pointOf(event);
    if (origin === undefined || this.gestureActive) return false;
    this.routeDrag = { edgeId, grip, origin, moved: false };
    this.element.setAttribute("data-miro-canvas-reshaping", grip.kind);
    // The connector may only now be selected; the preview must show regardless.
    this.element.hidden = false;
    return true;
  }

  /** Draw the grips a selected connector's route offers, reusing elements while their kinds match. */
  private placeRouteGrips(state: SelectionHandlesState, shown: boolean): void {
    const refs = this.refs;
    if (refs === undefined) return;
    const grips = shown ? state.routeGrips ?? [] : [];
    const layer = refs.routeLayer;
    const signature = grips.map((grip) => `${grip.kind}:${grip.index}:${grip.axis ?? ""}`).join(" ");
    if (layer.getAttribute("data-grips") !== signature) {
      layer.setAttribute("data-grips", signature);
      for (const remove of this.routeListeners.splice(0)) remove();
      for (const child of Array.from(layer.children ?? [])) child.remove?.();
      for (const grip of grips) {
        const title = grip.kind === "insert"
          ? "Drag to bend the line here"
          : grip.kind === "waypoint"
            ? "Drag to move this bend; double-click to remove it"
            : "Drag to move this segment; double-click to straighten the line";
        const element = layer.appendChild(makeGrip(this.document!, `miro-canvas-handle--route miro-canvas-handle--route-${grip.kind}`, "", title));
        element.setAttribute("data-route-grip", grip.kind);
        element.setAttribute("data-route-index", String(grip.index));
        if (grip.axis !== undefined) element.setAttribute("data-route-axis", grip.axis);
        this.listenRoute(element, "pointerdown", (event) => this.beginRouteDrag(grip, element, event));
        if (grip.kind !== "insert") {
          this.listenRoute(element, "dblclick", (event) => {
            const edgeId = this.state.selectedIds[0];
            if (!this.state.editable || edgeId === undefined) return;
            (event as Event).preventDefault?.();
            (event as Event).stopPropagation?.();
            this.actions.onStraighten?.(edgeId, grip);
          });
        }
      }
    }
    const elements = Array.from(layer.children ?? []) as HTMLElement[];
    grips.forEach((grip, index) => {
      const element = elements[index];
      if (element === undefined) return;
      element.style.left = `${grip.x}px`;
      element.style.top = `${grip.y}px`;
    });
  }

  /** Turn the node to the next right angle in one step, as one write. */
  private turn(direction: 1 | -1): void {
    if (!this.state.editable || this.state.isEdge || this.gestureActive) return;
    this.actions.onRotate(rightAngleStep(this.state.rotation, direction), true);
  }

  private beginEndDrag(end: ConnectorEnd, event: unknown): void {
    const edgeId = this.state.selectedIds[0];
    const origin = pointOf(event);
    if (!this.state.editable || !this.state.isEdge || edgeId === undefined || origin === undefined) return;
    (event as Event).preventDefault?.();
    this.capture(event);
    this.endDrag = { edgeId, end, origin };
    this.element.setAttribute("data-miro-canvas-moving-end", end);
  }

  /** Draw the line a pulled connector would follow, or hide it. */
  private showPreview(from: ShapePointLike | undefined, to: ShapePointLike | undefined): void {
    this.showPreviewLine(from === undefined || to === undefined ? undefined : [from, to]);
  }

  private showPreviewLine(points: readonly ShapePointLike[] | undefined): void {
    const path = this.refs?.preview;
    if (path === undefined) return;
    if (points === undefined || points.length < 2) {
      path.removeAttribute("d");
      return;
    }
    path.setAttribute("d", points.map((point, index) => `${index === 0 ? "M" : "L"} ${point.x} ${point.y}`).join(" "));
  }

  /** The host forwards document-level pointer events so a drag can leave the grip. */
  public handlePointerMove(event: unknown): void {
    const point = pointOf(event);
    const reshape = this.routeDrag;
    if (point !== undefined && reshape !== undefined) {
      if (!reshape.moved && Math.hypot(point.x - reshape.origin.x, point.y - reshape.origin.y) < this.dragThreshold) return;
      reshape.moved = true;
      const local = this.local(point);
      if (reshape.element !== undefined) {
        reshape.element.style.left = `${local.x}px`;
        reshape.element.style.top = `${local.y}px`;
      }
      this.showPreviewLine(this.actions.previewRoute?.(reshape.edgeId, reshape.grip, point));
      return;
    }
    const resize = this.resizeDrag;
    if (point !== undefined && resize !== undefined) {
      if (!resize.moved && Math.hypot(point.x - resize.origin.x, point.y - resize.origin.y) < this.dragThreshold) return;
      resize.moved = true;
      resize.rect = resizeRect(resize.start, resize.rotation, resize.handle, this.local(point), {
        uniform: (event as { shiftKey?: unknown }).shiftKey !== true,
        ...(this.state.minSize === undefined ? {} : { minSize: this.state.minSize }),
      });
      this.showResize(resize.rect, resize.rotation);
      this.actions.onResize?.(resize.rect, false);
      return;
    }
    if (point !== undefined && this.dragSide !== undefined && this.dragOrigin !== undefined
      && this.dragSourceId !== undefined && this.dragPosition !== undefined) {
      const moved = Math.hypot(point.x - this.dragOrigin.x, point.y - this.dragOrigin.y);
      const landed = moved < this.dragThreshold ? undefined : this.actions.previewEnd?.(
        { kind: "connect", sourceId: this.dragSourceId, side: this.dragSide, position: this.dragPosition }, point,
      ) ?? point;
      this.showPreview(landed === undefined ? undefined : this.dragStart, landed === undefined ? undefined : this.local(landed));
    }
    if (point !== undefined && this.endDrag !== undefined) {
      const grip = this.refs?.ends[this.endDrag.end];
      const landed = this.actions.previewEnd?.({ kind: "end", edgeId: this.endDrag.edgeId, end: this.endDrag.end }, point) ?? point;
      const local = this.local(landed);
      if (grip !== undefined) {
        grip.style.left = `${local.x}px`;
        grip.style.top = `${local.y}px`;
      }
      const other = this.state.endpoints?.[this.endDrag.end === "from" ? "to" : "from"];
      this.showPreview(other, local);
    }
    const rect = this.state.rect;
    if (!this.rotating || rect === undefined) return;
    if (point === undefined) return;
    const shift = (event as { shiftKey?: unknown }).shiftKey === true;
    const degrees = normalizeAngle(pointerAngle(rect, this.local(point)) + this.rotationOffset, shift ? this.snapDegrees : 0);
    this.actions.onRotate(degrees, false);
  }

  public handlePointerUp(event: unknown): void {
    const reshape = this.routeDrag;
    if (reshape !== undefined) {
      const point = pointOf(event);
      this.routeDrag = undefined;
      if (reshape.moved && point !== undefined) this.actions.onReshape?.(reshape.edgeId, reshape.grip, point);
    }
    const resize = this.resizeDrag;
    if (resize !== undefined) {
      const point = pointOf(event);
      if (resize.moved && point !== undefined) {
        resize.rect = resizeRect(resize.start, resize.rotation, resize.handle, this.local(point), {
          uniform: (event as { shiftKey?: unknown }).shiftKey !== true,
          ...(this.state.minSize === undefined ? {} : { minSize: this.state.minSize }),
        });
        this.resizeDrag = undefined;
        this.actions.onResize?.(resize.rect, true);
      }
    }
    const rect = this.state.rect;
    if (this.rotating && rect !== undefined) {
      const point = pointOf(event);
      const shift = (event as { shiftKey?: unknown }).shiftKey === true;
      const degrees = point === undefined
        ? this.state.rotation
        : normalizeAngle(pointerAngle(rect, this.local(point)) + this.rotationOffset, shift ? this.snapDegrees : 0);
      this.rotating = false;
      this.actions.onRotate(degrees, true);
    }
    if (this.dragSourceId !== undefined && this.dragSide !== undefined && this.dragPosition !== undefined) {
      const point = pointOf(event);
      const origin = this.dragOrigin;
      const moved = point === undefined || origin === undefined
        ? 0
        : Math.hypot(point.x - origin.x, point.y - origin.y);
      // Movement alone decides: a press that never moved is a click, however
      // long it was held.  Treating a slow click as a drag stopped the point
      // from adding a node at all, and holding still cannot connect anything
      // because the only thing under the pointer is the node it started on.
      if (moved < this.dragThreshold) this.actions.onCreateConnected(this.dragSourceId, this.dragSide, this.dragPosition);
      else if (point !== undefined) this.actions.onConnect(this.dragSourceId, this.dragSide, this.dragPosition, point);
    }
    const endDrag = this.endDrag;
    if (endDrag !== undefined) {
      const point = pointOf(event);
      // A press on an end that never moved leaves it where it is.
      if (point !== undefined && Math.hypot(point.x - endDrag.origin.x, point.y - endDrag.origin.y) >= this.dragThreshold) {
        this.endDrag = undefined;
        this.actions.onMoveEndpoint?.(endDrag.edgeId, endDrag.end, point);
      }
    }
    this.cancelGesture();
  }

  /** Losing the pointer must not leave a half-applied preview behind. */
  public cancelGesture(): void {
    if (this.rotating) {
      this.actions.onCancelRotation();
    }
    const resize = this.resizeDrag;
    this.resizeDrag = undefined;
    this.element.removeAttribute?.("data-miro-canvas-resizing");
    const reshape = this.routeDrag;
    this.routeDrag = undefined;
    this.element.removeAttribute?.("data-miro-canvas-reshaping");
    // A dragged route grip that was not committed goes back where the route is.
    if (reshape !== undefined) this.placeRouteGrips(this.state, this.routeGripsShown(this.state));
    if (resize !== undefined) {
      if (resize.moved) this.actions.onCancelResize?.();
      this.showResize(resize.start, resize.rotation);
    }
    this.rotating = false;
    this.dragSide = undefined;
    this.dragPosition = undefined;
    this.dragSourceId = undefined;
    this.dragOrigin = undefined;
    this.dragStart = undefined;
    const endDrag = this.endDrag;
    this.endDrag = undefined;
    this.showPreview(undefined, undefined);
    this.element.removeAttribute?.("data-miro-canvas-rotating");
    this.element.removeAttribute?.("data-miro-canvas-connecting");
    this.element.removeAttribute?.("data-miro-canvas-moving-end");
    // A dragged end grip that was not committed goes back where the end is.
    if (endDrag !== undefined) this.placeEnds(this.state);
  }

  public get gestureActive(): boolean {
    return this.rotating || this.dragSide !== undefined || this.endDrag !== undefined
      || this.resizeDrag !== undefined || this.routeDrag !== undefined;
  }

  private routeGripsShown(state: SelectionHandlesState): boolean {
    return state.isEdge && state.editable && state.selectedIds.length === 1;
  }

  /** Show and place the end grips of a selected connector. */
  private placeEnds(state: SelectionHandlesState): void {
    const refs = this.refs;
    if (refs === undefined) return;
    const shown = this.routeGripsShown(state);
    for (const end of ["from", "to"] as const) {
      const grip = refs.ends[end];
      const at = state.endpoints?.[end];
      grip.hidden = !shown || at === undefined;
      grip.setAttribute("aria-label", state.freeEnds === true ? "Drag to move this end" : "Drag to move this end anywhere on a node's outline");
      if (at === undefined) continue;
      grip.style.left = `${at.x}px`;
      grip.style.top = `${at.y}px`;
    }
  }

  /**
   * Pin the rotation controls to the lower left corner of the box the turned
   * node covers on screen.  That corner never turns and never reaches the
   * formatting toolbar above the node, whatever the angle.
   */
  private placeRotateBar(bar: HTMLElement, rect: HandleRect, rotation: number): void {
    const radians = rotation * Math.PI / 180;
    const cos = Math.abs(Math.cos(radians)), sin = Math.abs(Math.sin(radians));
    const halfWidth = (rect.width * cos + rect.height * sin) / 2;
    const halfHeight = (rect.width * sin + rect.height * cos) / 2;
    bar.style.left = `${rect.left + rect.width / 2 - halfWidth}px`;
    bar.style.top = `${rect.top + rect.height / 2 + halfHeight}px`;
  }

  /** Draw the box a resize would give, with the controls that hang off it. */
  private showResize(rect: HandleRect, rotation: number): void {
    const refs = this.refs;
    if (refs === undefined) return;
    this.placeFrame(refs.frame, rect);
    refs.frame.style.transform = rotation === 0 ? "none" : `rotate(${rotation}deg)`;
    this.placeRotateBar(refs.rotateBar, rect, rotation);
  }

  /** Point every resize cursor along its grip as the node is turned. */
  private placeResizers(resizers: readonly HTMLElement[], rotation: number): void {
    for (const grip of resizers) {
      const handle = grip.getAttribute("data-resize") as ResizeHandle | null;
      if (handle !== null) grip.style.cursor = resizeCursor(handle, rotation);
    }
  }

  /** Position and size the frame over the node it belongs to. */
  private placeFrame(frame: HTMLElement, rect: HandleRect): void {
    frame.style.left = `${rect.left}px`;
    frame.style.top = `${rect.top}px`;
    frame.style.width = `${rect.width}px`;
    frame.style.height = `${rect.height}px`;
  }

  public update(state: SelectionHandlesState): void {
    const previous = this.state;
    // A gesture must not lose the geometry it started with - pressing the
    // rotation grip can clear the Canvas selection, and the refresh that
    // follows reports none - but it must still follow geometry that is
    // reported.  Freezing it outright left the frame wherever the node had
    // been at the last refresh, so a pan just before the gesture parked the
    // handles away from the node and they appeared to turn about their own
    // point until the drag ended.
    this.state = this.gestureActive
      ? {
          ...state,
          rect: state.rect ?? previous.rect,
          selectedIds: state.selectedIds.length > 0 ? state.selectedIds : previous.selectedIds,
          shape: state.shape ?? previous.shape,
          origin: state.origin ?? previous.origin,
          endpoints: state.endpoints ?? previous.endpoints,
        }
      : state;
    const refs = this.refs;
    if (refs === undefined) return;
    // A gesture keeps the handles it started with rather than hiding them, but
    // it still tracks where the node is: writing only the angle left the frame
    // at the position of the last refresh before the drag.
    // A resize shows the box it is making, not the one the host still reports.
    if (this.resizeDrag !== undefined) {
      this.showResize(this.resizeDrag.rect, this.resizeDrag.rotation);
      return;
    }
    if (this.gestureActive && previous.rect !== undefined) {
      const rect = this.state.rect;
      if (rect !== undefined) this.placeFrame(refs.frame, rect);
      refs.frame.style.transform = this.state.rotation === 0 ? "none" : `rotate(${this.state.rotation}deg)`;
      return;
    }
    // A dragged end or route grip stays under the pointer until the drag ends.
    if (this.endDrag !== undefined || this.routeDrag !== undefined) return;
    const single = state.selectedIds.length === 1;
    const visible = state.rect !== undefined && single && !state.isEdge;
    const endsVisible = state.isEdge && single && state.endpoints !== undefined;
    this.element.hidden = !visible && !endsVisible;
    refs.frame.hidden = !visible;
    this.placeEnds(state);
    this.placeRouteGrips(state, this.routeGripsShown(state) && state.endpoints !== undefined);
    this.element.setAttribute("data-miro-canvas-editable", state.editable ? "true" : "false");
    refs.rotate.hidden = state.isEdge || !state.editable;
    refs.rotateBar.hidden = !visible || state.isEdge || !state.editable;
    for (const connector of refs.connectors) connector.hidden = state.isEdge || !state.editable;
    const resizable = state.editable && !state.isEdge && this.actions.onResize !== undefined;
    for (const grip of refs.resizers) grip.hidden = !resizable;
    refs.frame.setAttribute("data-miro-canvas-resizable", resizable ? "true" : "false");
    if (!visible || state.rect === undefined) return;
    this.placeFrame(refs.frame, state.rect);
    refs.frame.style.transform = state.rotation === 0 ? "none" : `rotate(${state.rotation}deg)`;
    this.placeRotateBar(refs.rotateBar, state.rect, state.rotation);
    this.placeResizers(refs.resizers, state.rotation);
    const outline = shapeOutline(state.shape);
    for (const connector of refs.connectors) {
      const side = connector.getAttribute("data-handle-side") as HandleSide | null;
      const position = Number(connector.getAttribute("data-handle-position"));
      if (side === null || !Number.isFinite(position)) continue;
      const boxPoint = sideAnchor({ left: 0, top: 0, width: 100, height: 100 }, side, position);
      const point = contourPoint(outline, boxPoint);
      connector.style.left = `${point.x}%`;
      connector.style.top = `${point.y}%`;
    }
  }

  public dispose(): void {
    for (const remove of [...this.listeners.splice(0), ...this.routeListeners.splice(0)]) {
      try {
        remove();
      } catch {
        // The host document may already be gone with its pane.
      }
    }
    try {
      this.element.remove?.();
    } catch {
      // A detached overlay needs no removal.
    }
  }
}
