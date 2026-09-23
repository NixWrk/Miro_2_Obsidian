/** Detached comment marker geometry and DOM. The host owns mounting and refreshes. */
import { resolveAnchor, type AnchorGeometry, type AnchorPoint } from "./anchors";
import {
  commentAuthorLabel,
  commentTimeLabel,
  filterCommentThreads,
  type CommentDisplayOptions,
  type CommentListOptions,
  type CommentOrigin,
  type CommentThread,
} from "./local-comments";
import { authorColor, authorInitial, threadMessages } from "./comment-thread";
import { TOOLTIP_DELAY } from "./tooltips";

export interface CommentMarker {
  /** Origin is part of the key: imported and local IDs can coincide. */
  readonly key: string;
  readonly threadId: string;
  readonly origin: CommentOrigin;
  readonly anchorType: "board" | "node" | "image" | "edge" | "comment";
  readonly state: "open" | "resolved";
  readonly point: AnchorPoint;
  readonly label: string;
  readonly replyCount: number;
  /** The opening author's initial and colour, which the pin shows as Miro's does. */
  readonly initial: string;
  readonly color: string;
  readonly locked?: boolean;
}

export interface CommentMarkersState extends CommentListOptions {
  readonly threads: readonly CommentThread[];
  readonly geometry: AnchorGeometry;
  readonly selectedKeys?: ReadonlySet<string>;
  /** Board coordinates for threads without an anchor. Omit to leave them in the panel. */
  readonly boardPoint?: AnchorPoint;
  /** Convert board coordinates to overlay pixels, including the current pan and zoom. */
  readonly boardToViewport?: (point: AnchorPoint) => AnchorPoint;
}

export interface CommentMarkerDiagnostic {
  readonly threadId: string;
  readonly origin: CommentOrigin;
  readonly code: string;
  readonly message: string;
}

export interface CommentMarkersModel {
  readonly markers: readonly CommentMarker[];
  readonly diagnostics: readonly CommentMarkerDiagnostic[];
}

/** Resolve positions anew after geometry/viewport changes; never write into a thread. */
export function buildCommentMarkers(
  state: CommentMarkersState,
  display: CommentDisplayOptions = {},
): CommentMarkersModel {
  const markers: CommentMarker[] = [];
  const diagnostics: CommentMarkerDiagnostic[] = [];
  for (const thread of filterCommentThreads(state.threads, state)) {
    const anchor = thread.anchor ?? (state.boardPoint === undefined
      ? undefined : { type: "free" as const, ...state.boardPoint });
    if (anchor === undefined) continue;
    const resolved = resolveAnchor(anchor, state.geometry);
    if (!resolved.valid || resolved.point === undefined) {
      diagnostics.push(...resolved.diagnostics.map((item) => ({
        threadId: thread.id, origin: thread.origin, code: item.code, message: item.message,
      })));
      continue;
    }
    const boardPoint = { x: resolved.point.x, y: resolved.point.y };
    const point = state.boardToViewport?.(boardPoint) ?? boardPoint;
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
      diagnostics.push({ threadId: thread.id, origin: thread.origin,
        code: "projection-invalid", message: "Comment marker position must be finite." });
      continue;
    }
    const status = thread.resolved ? "Resolved" : "Open";
    // An exported thread lists its opening message among its messages.
    const messages = threadMessages(thread);
    const author = messages[0]?.author ?? commentAuthorLabel(thread);
    const replyCount = Math.max(0, messages.length - 1);
    markers.push(Object.freeze({
      key: JSON.stringify([thread.origin, thread.id]),
      threadId: thread.id,
      origin: thread.origin,
      anchorType: anchor.type === "free" ? "board" : anchor.type,
      state: thread.resolved ? "resolved" : "open",
      point: Object.freeze({ x: point.x, y: point.y }),
      label: `${thread.locked === true ? "Locked " : ""}${status} comment by ${author}, ${commentTimeLabel(thread.createdAt, display)}: ${messages[0]?.text ?? thread.text}. ${replyCount} replies. Open thread`,
      replyCount,
      initial: authorInitial(author),
      color: typeof thread.color === "string" && /^#[0-9a-f]{6}$/i.test(thread.color) ? thread.color : authorColor(author),
      locked: thread.locked === true,
    }));
  }
  return { markers: Object.freeze(markers), diagnostics: Object.freeze(diagnostics) };
}

export interface CommentMarkersHost {
  readonly onOpenThread: (threadId: string, origin: CommentOrigin) => void;
  /** A pin was dragged and let go at a point in the window; without it pins stay put. */
  readonly onMoveThread?: (threadId: string, origin: CommentOrigin, point: { readonly x: number; readonly y: number }) => void;
  readonly onPreviewThreadMove?: (threadId: string, origin: CommentOrigin, point: { readonly x: number; readonly y: number }) => void;
  readonly onCancelThreadMove?: () => void;
}

/** How far a pin must be pulled before a press becomes a drag rather than a click. */
const DRAG_THRESHOLD = 4;

export interface CommentMarkersOptions extends CommentDisplayOptions {
  readonly document?: Document;
}

interface MarkerElement {
  readonly button: HTMLButtonElement;
  readonly dispose: () => void;
}

/**
 * Mount `element` in a positioned, untransformed Canvas viewport overlay.
 * Call update after thread, geometry, pan or zoom changes. Buttons stay a fixed
 * pixel size; native button activation supports mouse, Enter and Space.
 */
export class CommentMarkers {
  public readonly element: HTMLElement;
  private readonly document: Document;
  private readonly entries = new Map<string, MarkerElement>();
  private readonly previewColors = new Map<string, string>();
  /** The marker each pin shows now, which its listeners read. */
  private readonly current = new WeakMap<HTMLButtonElement, CommentMarker>();
  /** Pins being dragged, which stay under the pointer until let go. */
  private readonly dragging = new WeakSet<HTMLButtonElement>();
  private destroyed = false;

  public constructor(private readonly host: CommentMarkersHost, private readonly options: CommentMarkersOptions = {}) {
    const dom = options.document ?? (typeof document === "undefined" ? undefined : document);
    if (dom === undefined) throw new Error("CommentMarkers requires a Document.");
    this.document = dom;
    this.element = dom.createElement("div");
    this.element.className = "miro-canvas-comment-markers";
    this.element.setAttribute("role", "group");
    this.element.setAttribute("aria-label", "Canvas comments");
    Object.assign(this.element.style, { position: "absolute", inset: "0", pointerEvents: "none" });
  }

  /** Paint a pin immediately while its native color picker is moving. No board write. */
  public previewColor(threadId: string, origin: CommentOrigin, color?: string): void {
    const key = JSON.stringify([origin, threadId]);
    if (color !== undefined && /^#[0-9a-f]{6}$/i.test(color)) this.previewColors.set(key, color);
    else this.previewColors.delete(key);
    const entry = this.entries.get(key);
    const current = entry === undefined ? undefined : this.markerOf(entry.button);
    if (entry && current) entry.button.style.setProperty?.("--miro-avatar", this.previewColors.get(key) ?? current.color);
  }

  public update(state: CommentMarkersState): CommentMarkersModel {
    const model = buildCommentMarkers(state, this.options);
    if (this.destroyed) return model;
    const keys = new Set(model.markers.map((marker) => marker.key));
    for (const [key, entry] of this.entries) {
      if (!keys.has(key)) {
        entry.dispose();
        entry.button.remove();
        this.entries.delete(key);
        this.previewColors.delete(key);
      }
    }
    for (const marker of model.markers) {
      let entry = this.entries.get(marker.key);
      if (entry === undefined) {
        const button = this.document.createElement("button");
        button.type = "button";
        button.className = "miro-canvas-comment-marker";
        Object.assign(button.style, {
          position: "absolute", pointerEvents: "auto", transform: "translate(-50%, -50%)",
          minWidth: "32px", minHeight: "32px", borderRadius: "50%",
        });
        const stop = (event: Event) => event.stopPropagation();
        let dragged = false;
        let cancelDrag: (() => void) | undefined;
        const open = (event: Event) => {
          event.stopPropagation();
          // The click that ends a drag does not open the thread as well.
          if (dragged) {
            dragged = false;
            return;
          }
          const current = this.markerOf(button);
          if (current !== undefined) this.host.onOpenThread(current.threadId, current.origin);
        };
        // A pin is picked up and put down elsewhere, as in Miro: it follows
        // the pointer, and the host decides what it lands on.
        const press = (event: Event) => {
          const pointer = event as PointerEvent;
          if (this.host.onMoveThread === undefined || pointer.button !== 0 || this.markerOf(button)?.locked) return;
          const view = this.document.defaultView;
          if (view === null) return;
          // A second press or disposal cannot leave listeners from the first
          // gesture behind on the window.
          cancelDrag?.();
          const picked=this.markerOf(button);
          if(picked===undefined)return;
          pointer.preventDefault();
          pointer.stopPropagation();
          // Own the first press before focus changes or periodic rendering can
          // hand the gesture back to Canvas. A click still opens on release.
          this.dragging.add(button);
          try { button.setPointerCapture?.(pointer.pointerId); } catch { /* Synthetic events have no active pointer. */ }
          const start = { x: pointer.clientX, y: pointer.clientY };
          const origin = { left: parseFloat(button.style.left) || 0, top: parseFloat(button.style.top) || 0 };
          const windowPoint = (x: number, y: number) => {
            const overlay = this.element.getBoundingClientRect?.();
            return {
              x: (overlay?.left ?? 0) + picked.point.x + x - start.x,
              y: (overlay?.top ?? 0) + picked.point.y + y - start.y,
            };
          };
          let moving = false;
          const move = (moved: Event) => {
            const at = moved as PointerEvent;
            if(at.pointerId!==pointer.pointerId)return;
            const dx = at.clientX - start.x, dy = at.clientY - start.y;
            if (!moving && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
            moving = true;
            this.dragging.add(button);
            button.setAttribute("data-comment-dragging", "true");
            button.style.left = `${origin.left + dx}px`;
            button.style.top = `${origin.top + dy}px`;
            this.host.onPreviewThreadMove?.(picked.threadId, picked.origin, windowPoint(at.clientX, at.clientY));
          };
          const stopListening = () => {
            view.removeEventListener("pointermove", move, true);
            view.removeEventListener("pointerup", up, true);
            view.removeEventListener("pointercancel", cancel, true);
            view.removeEventListener("blur", cancel, true);
            cancelDrag = undefined;
            try { if(button.hasPointerCapture?.(pointer.pointerId))button.releasePointerCapture(pointer.pointerId); } catch { /* The host may already have released it. */ }
          };
          const reset = () => {
            stopListening();
            this.dragging.delete(button);
            button.setAttribute("data-comment-dragging", "false");
            if (moving) this.host.onCancelThreadMove?.();
            const current = this.markerOf(button);
            if (current !== undefined) {
              button.style.left = `${current.point.x}px`;
              button.style.top = `${current.point.y}px`;
            }
          };
          const cancel = () => reset();
          const up = (released: Event) => {
            if((released as PointerEvent).pointerId!==pointer.pointerId)return;
            stopListening();
            this.dragging.delete(button);
            button.setAttribute("data-comment-dragging", "false");
            if (!moving) return;
            // Only the click the release itself makes is swallowed.
            dragged = true;
            view.setTimeout(() => { dragged = false; }, 0);
            const at = released as PointerEvent;
            // The pin's point moves as far as the pointer did, wherever on the
            // pin it was taken hold of.
            this.host.onMoveThread?.(picked.threadId, picked.origin, windowPoint(at.clientX, at.clientY));
          };
          cancelDrag = cancel;
          view.addEventListener("pointermove", move, true);
          view.addEventListener("pointerup", up, true);
          view.addEventListener("pointercancel", cancel, true);
          view.addEventListener("blur", cancel, true);
        };
        // Keep Canvas drag/selection and hotkeys out of marker activation.
        const isolatedEvents = ["pointerdown", "mousedown", "dblclick", "keydown", "keyup"];
        for (const name of isolatedEvents) button.addEventListener(name, stop);
        button.addEventListener("pointerdown", press);
        button.addEventListener("click", open);
        entry = { button, dispose: () => {
          cancelDrag?.();
          for (const name of isolatedEvents) button.removeEventListener(name, stop);
          button.removeEventListener("pointerdown", press);
          button.removeEventListener("click", open);
        } };
        this.entries.set(marker.key, entry);
        this.element.appendChild(button);
      }
      const button = entry.button;
      this.current.set(button, marker);
      // A pin being dragged stays under the pointer until it is let go.
      if (this.dragging.has(button)) continue;
      button.setAttribute("data-comment-id", marker.threadId);
      button.setAttribute("data-comment-origin", marker.origin);
      button.setAttribute("data-comment-anchor", marker.anchorType);
      button.setAttribute("data-comment-state", marker.state);
      button.setAttribute("data-comment-locked", marker.locked ? "true" : "false");
      button.setAttribute("data-comment-selected", state.selectedKeys?.has(`${marker.origin}:${marker.threadId}`) ? "true" : "false");
      button.setAttribute("data-comment-has-replies", marker.replyCount > 0 ? "true" : "false");
      button.setAttribute("aria-label", marker.label);
      button.setAttribute("data-tooltip-delay", TOOLTIP_DELAY);
      // A pin shows who started the thread; a badge counts its messages.
      button.textContent = marker.state === "resolved" ? "✓" : marker.initial;
      button.style.setProperty?.("--miro-avatar", this.previewColors.get(marker.key) ?? marker.color);
      button.setAttribute("data-comment-count", String(marker.replyCount + 1));
      button.style.left = `${marker.point.x}px`;
      button.style.top = `${marker.point.y}px`;
    }
    return model;
  }

  private markerOf(button: HTMLButtonElement): CommentMarker | undefined {
    return this.current.get(button);
  }

  public destroy(): void {
    this.destroyed = true;
    for (const entry of this.entries.values()) entry.dispose();
    this.entries.clear();
    this.previewColors.clear();
    this.element.remove();
  }
}
