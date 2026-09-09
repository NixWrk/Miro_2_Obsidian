/**
 * Selection handles drawn over the Canvas: a rotation grip, one connection
 * point per side, and a quick-create arrow.
 *
 * The native Canvas keeps its own resize handles and selection outline.  This
 * overlay only adds the affordances it does not have, reports finished
 * gestures to its host, and owns no persistence: a rotation is previewed here
 * and written by the host through the guarded authoring transaction.
 *
 * All geometry arrives already resolved in viewport pixels, so this module can
 * be exercised without a layout engine.
 */

export type HandleSide = "top" | "right" | "bottom" | "left";

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
}

export interface SelectionHandlesActions {
  /** Called continuously while dragging, then once with `commit` true. */
  readonly onRotate: (degrees: number, commit: boolean) => void;
  /** A connection was pulled from `side` and released at a viewport point. */
  readonly onConnect: (side: HandleSide, point: { readonly x: number; readonly y: number }) => void;
  /** The quick-create arrow was released; the host places the new node. */
  readonly onCreateConnected: (side: HandleSide) => void;
}

export interface SelectionHandlesOptions {
  readonly document?: Document;
  readonly className?: string;
  /** Rotation snaps to this many degrees while Shift is held. */
  readonly snapDegrees?: number;
}

const SIDES: readonly HandleSide[] = ["top", "right", "bottom", "left"];
const DEFAULT_SNAP = 15;

/** Center of one side of a rectangle, in the rectangle's own space. */
export function sideAnchor(rect: HandleRect, side: HandleSide): { readonly x: number; readonly y: number } {
  switch (side) {
    case "top": return { x: rect.left + rect.width / 2, y: rect.top };
    case "right": return { x: rect.left + rect.width, y: rect.top + rect.height / 2 };
    case "bottom": return { x: rect.left + rect.width / 2, y: rect.top + rect.height };
    case "left": return { x: rect.left, y: rect.top + rect.height / 2 };
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
  button.title = title;
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
  readonly rotate: HTMLButtonElement;
  readonly create: HTMLButtonElement;
  readonly connectors: Readonly<Record<HandleSide, HTMLButtonElement>>;
}

export class SelectionHandles {
  public readonly element: HTMLElement;
  private readonly document: Document | undefined;
  private readonly actions: SelectionHandlesActions;
  private readonly snapDegrees: number;
  private readonly listeners: Array<() => void> = [];
  private readonly refs: HandleRefs | undefined;
  private state: SelectionHandlesState = { rotation: 0, editable: false, isEdge: false, selectedIds: [] };
  private rotating = false;
  /** Difference between the pointer angle and the rotation when the drag began. */
  private rotationOffset = 0;
  private dragSide: HandleSide | undefined;

  public constructor(actions: SelectionHandlesActions, options: SelectionHandlesOptions = {}) {
    this.actions = actions;
    this.snapDegrees = options.snapDegrees ?? DEFAULT_SNAP;
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
    const connectors = {} as Record<HandleSide, HTMLButtonElement>;
    for (const side of SIDES) {
      const dot = frame.appendChild(makeGrip(document, `miro-canvas-handle--connect miro-canvas-handle--${side}`, "", `Drag a connection from the ${side}`));
      dot.setAttribute("data-handle-side", side);
      this.listen(dot, "pointerdown", (event) => this.beginConnect(side, event));
      connectors[side] = dot;
    }
    const rotate = frame.appendChild(makeGrip(document, "miro-canvas-handle--rotate", "↻", "Rotate"));
    this.listen(rotate, "pointerdown", (event) => this.beginRotate(event));
    const create = frame.appendChild(makeGrip(document, "miro-canvas-handle--create", "→", "Create a connected node"));
    this.listen(create, "click", () => {
      if (this.state.editable) this.actions.onCreateConnected("right");
    });
    return { frame, rotate, create, connectors };
  }

  private listen(target: EventTarget, type: string, handler: EventListener): void {
    target.addEventListener(type, handler);
    this.listeners.push(() => target.removeEventListener(type, handler));
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

  private beginRotate(event: unknown): void {
    const rect = this.state.rect;
    if (!this.state.editable || rect === undefined) return;
    const point = pointOf(event);
    if (point === undefined) return;
    (event as Event).preventDefault?.();
    this.capture(event);
    this.rotating = true;
    this.rotationOffset = this.state.rotation - pointerAngle(rect, point);
    this.element.setAttribute("data-miro-canvas-rotating", "true");
  }

  private beginConnect(side: HandleSide, event: unknown): void {
    if (!this.state.editable || this.state.isEdge) return;
    (event as Event).preventDefault?.();
    this.capture(event);
    this.dragSide = side;
    this.element.setAttribute("data-miro-canvas-connecting", side);
  }

  /** The host forwards document-level pointer events so a drag can leave the grip. */
  public handlePointerMove(event: unknown): void {
    const rect = this.state.rect;
    if (!this.rotating || rect === undefined) return;
    const point = pointOf(event);
    if (point === undefined) return;
    const shift = (event as { shiftKey?: unknown }).shiftKey === true;
    const degrees = normalizeAngle(pointerAngle(rect, point) + this.rotationOffset, shift ? this.snapDegrees : 0);
    this.actions.onRotate(degrees, false);
  }

  public handlePointerUp(event: unknown): void {
    const rect = this.state.rect;
    if (this.rotating && rect !== undefined) {
      const point = pointOf(event);
      const shift = (event as { shiftKey?: unknown }).shiftKey === true;
      const degrees = point === undefined
        ? this.state.rotation
        : normalizeAngle(pointerAngle(rect, point) + this.rotationOffset, shift ? this.snapDegrees : 0);
      this.actions.onRotate(degrees, true);
    }
    if (this.dragSide !== undefined) {
      const point = pointOf(event);
      if (point !== undefined) this.actions.onConnect(this.dragSide, point);
    }
    this.cancelGesture();
  }

  /** Losing the pointer must not leave a half-applied preview behind. */
  public cancelGesture(): void {
    if (this.rotating) {
      this.actions.onRotate(this.state.rotation, true);
    }
    this.rotating = false;
    this.dragSide = undefined;
    this.element.removeAttribute?.("data-miro-canvas-rotating");
    this.element.removeAttribute?.("data-miro-canvas-connecting");
  }

  public get gestureActive(): boolean {
    return this.rotating || this.dragSide !== undefined;
  }

  public update(state: SelectionHandlesState): void {
    const previous = this.state;
    this.state = state;
    const refs = this.refs;
    if (refs === undefined) return;
    // A gesture in flight owns the frame; a mid-drag refresh must not move it.
    if (this.gestureActive && previous.rect !== undefined) return;
    const visible = state.rect !== undefined && state.selectedIds.length === 1;
    this.element.hidden = !visible;
    if (!visible || state.rect === undefined) return;
    const style = refs.frame.style;
    style.left = `${state.rect.left}px`;
    style.top = `${state.rect.top}px`;
    style.width = `${state.rect.width}px`;
    style.height = `${state.rect.height}px`;
    style.transform = state.rotation === 0 ? "none" : `rotate(${state.rotation}deg)`;
    this.element.setAttribute("data-miro-canvas-editable", state.editable ? "true" : "false");
    refs.rotate.hidden = state.isEdge || !state.editable;
    refs.create.hidden = state.isEdge || !state.editable;
    for (const side of SIDES) {
      refs.connectors[side].hidden = state.isEdge || !state.editable;
    }
  }

  public dispose(): void {
    for (const remove of this.listeners.splice(0)) {
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
