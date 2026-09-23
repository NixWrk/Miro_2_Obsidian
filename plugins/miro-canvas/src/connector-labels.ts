/**
 * Labels on connectors - native edges and the board's own alike - placed at
 * a share of the route's length, dragged along it and edited in place.
 *
 * Native Canvas puts an edge's label at the middle of its own curve, which is
 * not where the plugin draws the edge once it reshapes it; the native label is
 * hidden while this one stands in for it, and shown again when it goes.
 *
 * The labels live in native Canvas's moving layer, in board units, and wear
 * native Canvas's own label class: they look, scale and are edited exactly
 * as an edge's label is, pan and zoom with the board for nothing, and are
 * placed again only when a route or a label changes.
 */

import { pointOnPolyline, type AnchorPoint } from "./anchors";
import { nearestRouteFraction } from "./board-connectors";

export interface ConnectorLabel {
  readonly id: string;
  readonly text: string;
  /** The route, in board units. */
  readonly points: readonly AnchorPoint[];
  /** Where the label sits, as a share of the route's length. */
  readonly t: number;
  /** The connector's colour, which an edited label is outlined in. */
  readonly color?: string;
  /** Native Canvas's own label for the edge, hidden while this one shows. */
  readonly native?: HTMLElement;
}

export interface ConnectorLabelsHost {
  readonly editable: (id: string) => boolean;
  readonly move: (id: string, t: number) => void;
  readonly edit: (id: string, text: string) => void;
  /** A label was clicked: its connector is selected, as a click on native Canvas's label selects the edge. */
  readonly select: (id: string, add: boolean) => void;
  /** The board point under a point in the window. */
  readonly board: (point: AnchorPoint) => AnchorPoint | undefined;
}

interface Entry {
  readonly wrapper: HTMLDivElement;
  readonly label: HTMLDivElement;
  readonly native?: HTMLElement;
  readonly nativeVisibility?: string;
  item: ConnectorLabel;
}

/** How far a label must be pulled, in window pixels, before a press becomes a drag. */
const DRAG_THRESHOLD = 3;

export class ConnectorLabels {
  public readonly element: HTMLDivElement;
  private readonly entries = new Map<string, Entry>();
  /** Routes being reshaped right now, which a label follows before the drag ends. */
  private readonly previews = new Map<string, readonly AnchorPoint[]>();
  private dragging: string | undefined;
  private editing: string | undefined;

  public constructor(private readonly document: Document, private readonly host: ConnectorLabelsHost) {
    this.element = document.createElement("div");
    this.element.className = "miro-canvas-connector-labels";
  }

  /** Show these labels, and only these; an empty text keeps the label ready to be written. */
  public update(items: readonly ConnectorLabel[]): void {
    const wanted = new Set(items.map((item) => item.id));
    for (const id of [...this.entries.keys()]) if (!wanted.has(id) && id !== this.editing) this.remove(id);
    for (const item of items) {
      let entry = this.entries.get(item.id);
      if (entry !== undefined && entry.native !== item.native && item.id !== this.editing) {
        this.remove(item.id);
        entry = undefined;
      }
      if (entry === undefined) entry = this.add(item);
      entry.item = item;
      if (item.color === undefined) entry.wrapper.style.removeProperty("--canvas-color");
      else entry.wrapper.style.setProperty("--canvas-color", item.color);
      if (item.id === this.editing) continue;
      if (entry.label.textContent !== item.text) entry.label.textContent = item.text;
      entry.wrapper.hidden = item.text === "";
      if (this.dragging !== item.id) this.place(entry, this.previews.get(item.id) ?? item.points);
    }
  }

  /** A route being reshaped: its label moves with it before the pointer is let go. */
  public preview(id: string, points: readonly AnchorPoint[]): void {
    this.previews.set(id, points);
    const entry = this.entries.get(id);
    if (entry !== undefined) this.place(entry, points);
  }

  public clearPreview(id: string): void {
    this.previews.delete(id);
    const entry = this.entries.get(id);
    if (entry !== undefined) this.place(entry, entry.item.points);
  }

  /**
   * Edit a label in place, empty or not, as native Canvas edits an edge's:
   * Enter keeps the text, Shift+Enter breaks the line, Escape puts it back.
   * False when there is no label to edit.
   */
  public edit(id: string): boolean {
    const entry = this.entries.get(id);
    if (entry === undefined || this.editing !== undefined || !this.host.editable(id)) return false;
    const { wrapper, label } = entry;
    const before = entry.item.text;
    this.editing = id;
    wrapper.hidden = false;
    label.contentEditable = "true";
    label.classList.add("is-editing");
    let done = false;
    const finish = (save: boolean): void => {
      if (done) return;
      done = true;
      label.removeEventListener("keydown", key, true);
      label.removeEventListener("blur", blur);
      this.document.removeEventListener("pointerdown", outside, true);
      label.contentEditable = "false";
      label.classList.remove("is-editing");
      this.editing = undefined;
      const text = (label.innerText ?? label.textContent ?? "").replace(/\n$/u, "");
      if (save && text !== before) {
        this.host.edit(id, text);
        return;
      }
      label.textContent = before;
      wrapper.hidden = before === "";
    };
    // The board must not take the keys a label is written with; once it is
    // written, they go back to the board.
    const key = (event: KeyboardEvent): void => {
      event.stopPropagation();
      const keep = event.key === "Enter" && !event.shiftKey ? true : event.key === "Escape" ? false : undefined;
      if (keep === undefined) return;
      event.preventDefault();
      finish(keep);
      (this.element.closest(".canvas-wrapper") as HTMLElement | null)?.focus({ preventScroll: true });
    };
    const blur = (): void => finish(true);
    // A press anywhere else ends the writing, even one the board keeps focus from.
    const outside = (event: PointerEvent): void => {
      if (!label.contains(event.target as Node | null)) finish(true);
    };
    label.addEventListener("keydown", key, true);
    label.addEventListener("blur", blur);
    this.document.addEventListener("pointerdown", outside, true);
    label.focus();
    const selection = this.document.defaultView?.getSelection();
    if (selection !== null && selection !== undefined) {
      const range = this.document.createRange();
      range.selectNodeContents(label);
      selection.removeAllRanges();
      selection.addRange(range);
    }
    return true;
  }

  public dispose(): void {
    this.editing = undefined;
    for (const id of [...this.entries.keys()]) this.remove(id);
    this.element.remove();
  }

  private add(item: ConnectorLabel): Entry {
    const wrapper = this.document.createElement("div");
    wrapper.className = "miro-canvas-connector-label";
    wrapper.setAttribute("data-connector-id", item.id);
    const label = wrapper.appendChild(this.document.createElement("div"));
    label.className = "canvas-path-label";
    const placeholder = item.native?.querySelector(".canvas-path-label")?.getAttribute("data-placeholder");
    label.setAttribute("data-placeholder", placeholder ?? "Add text…");
    wrapper.addEventListener("pointerdown", (event) => this.drag(event, item.id));
    wrapper.addEventListener("dblclick", (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.edit(item.id);
    });
    this.element.appendChild(wrapper);
    const entry: Entry = {
      wrapper, label, item,
      ...(item.native === undefined ? {} : { native: item.native, nativeVisibility: item.native.style.visibility }),
    };
    if (item.native !== undefined) item.native.style.visibility = "hidden";
    this.entries.set(item.id, entry);
    return entry;
  }

  private remove(id: string): void {
    const entry = this.entries.get(id);
    if (entry === undefined) return;
    this.previews.delete(id);
    if (entry.native !== undefined) entry.native.style.visibility = entry.nativeVisibility ?? "";
    entry.wrapper.remove();
    this.entries.delete(id);
  }

  /** Put a label at its share of a route, in board units. */
  private place(entry: Entry, points: readonly AnchorPoint[], t = entry.item.t): void {
    const at = pointOnPolyline(points, t);
    if (at === undefined) return;
    entry.wrapper.style.transform = `translate(${round(at.x)}px, ${round(at.y)}px)`;
  }

  /**
   * A label is slid along its route, never off it; a click selects its
   * connector; while it is written, a press places the caret.
   */
  private drag(event: PointerEvent, id: string): void {
    event.stopPropagation();
    const entry = this.entries.get(id);
    const view = this.document.defaultView;
    if (this.editing === id || event.button !== 0 || entry === undefined || view === null) return;
    event.preventDefault();
    if (!this.host.editable(id)) {
      this.host.select(id, event.shiftKey);
      return;
    }
    this.dragging = id;
    let t = entry.item.t, moved = false;
    const move = (next: PointerEvent): void => {
      if (next.pointerId !== event.pointerId) return;
      moved ||= Math.hypot(next.clientX - event.clientX, next.clientY - event.clientY) > DRAG_THRESHOLD;
      const at = moved ? this.host.board({ x: next.clientX, y: next.clientY }) : undefined;
      if (at === undefined) return;
      t = nearestRouteFraction(entry.item.points, at);
      this.place(entry, entry.item.points, t);
    };
    const end = (): void => {
      view.removeEventListener("pointermove", move, true);
      view.removeEventListener("pointerup", up, true);
      view.removeEventListener("pointercancel", cancel, true);
      this.dragging = undefined;
    };
    const cancel = (): void => {
      end();
      this.place(entry, entry.item.points);
    };
    const up = (released: PointerEvent): void => {
      if (released.pointerId !== event.pointerId) return;
      move(released);
      end();
      if (moved) this.host.move(id, t);
      else this.host.select(id, event.shiftKey);
    };
    view.addEventListener("pointermove", move, true);
    view.addEventListener("pointerup", up, true);
    view.addEventListener("pointercancel", cancel, true);
  }
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
