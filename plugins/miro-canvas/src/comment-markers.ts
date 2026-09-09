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

export interface CommentMarker {
  /** Origin is part of the key: imported and local IDs can coincide. */
  readonly key: string;
  readonly threadId: string;
  readonly origin: CommentOrigin;
  readonly anchorType: "board" | "node" | "image" | "edge";
  readonly state: "open" | "resolved";
  readonly point: AnchorPoint;
  readonly label: string;
  readonly replyCount: number;
}

export interface CommentMarkersState extends CommentListOptions {
  readonly threads: readonly CommentThread[];
  readonly geometry: AnchorGeometry;
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
    markers.push(Object.freeze({
      key: JSON.stringify([thread.origin, thread.id]),
      threadId: thread.id,
      origin: thread.origin,
      anchorType: anchor.type === "free" ? "board" : anchor.type,
      state: thread.resolved ? "resolved" : "open",
      point: Object.freeze({ x: point.x, y: point.y }),
      label: `${status} comment by ${commentAuthorLabel(thread)}, ${commentTimeLabel(thread.createdAt, display)}: ${thread.text}. ${thread.replies.length} replies. Open thread`,
      replyCount: thread.replies.length,
    }));
  }
  return { markers: Object.freeze(markers), diagnostics: Object.freeze(diagnostics) };
}

export interface CommentMarkersHost {
  readonly onOpenThread: (threadId: string, origin: CommentOrigin) => void;
}

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

  public update(state: CommentMarkersState): CommentMarkersModel {
    const model = buildCommentMarkers(state, this.options);
    if (this.destroyed) return model;
    const keys = new Set(model.markers.map((marker) => marker.key));
    for (const [key, entry] of this.entries) {
      if (!keys.has(key)) {
        entry.dispose();
        entry.button.remove();
        this.entries.delete(key);
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
        const open = (event: Event) => {
          event.stopPropagation();
          this.host.onOpenThread(marker.threadId, marker.origin);
        };
        // Keep Canvas drag/selection and hotkeys out of marker activation.
        const isolatedEvents = ["pointerdown", "mousedown", "dblclick", "keydown", "keyup"];
        for (const name of isolatedEvents) button.addEventListener(name, stop);
        button.addEventListener("click", open);
        entry = { button, dispose: () => {
          for (const name of isolatedEvents) button.removeEventListener(name, stop);
          button.removeEventListener("click", open);
        } };
        this.entries.set(marker.key, entry);
        this.element.appendChild(button);
      }
      const button = entry.button;
      button.setAttribute("data-comment-id", marker.threadId);
      button.setAttribute("data-comment-origin", marker.origin);
      button.setAttribute("data-comment-anchor", marker.anchorType);
      button.setAttribute("data-comment-state", marker.state);
      button.setAttribute("aria-label", marker.label);
      button.title = marker.label;
      button.textContent = marker.state === "resolved" ? "✓" : "●";
      button.style.left = `${marker.point.x}px`;
      button.style.top = `${marker.point.y}px`;
    }
    return model;
  }

  public destroy(): void {
    this.destroyed = true;
    for (const entry of this.entries.values()) entry.dispose();
    this.entries.clear();
    this.element.remove();
  }
}
