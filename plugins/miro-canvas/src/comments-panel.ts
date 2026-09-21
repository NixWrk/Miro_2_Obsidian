/**
 * Small dependency-free comments panel.  It owns only DOM presentation and
 * emits explicit callbacks; comment persistence is delegated to the host.
 */

import {
  commentAuthorLabel,
  commentTimeLabel,
  filterCommentThreads,
  type CommentDisplayOptions,
  type CommentReply,
  type CommentScope,
  type CommentThread,
} from "./local-comments";
import type { CanvasAnchor } from "./anchors";
import { openingIsListed } from "./comment-thread";

export interface CommentsPanelState {
  readonly threads: readonly CommentThread[];
  readonly scope?: CommentScope;
  readonly selectedElementIds?: readonly string[];
  readonly includeResolved?: boolean;
  readonly reviewMode?: boolean;
  readonly anchorDraft?: CanvasAnchor;
  readonly diagnostics?: readonly string[];
}

export interface CommentsPanelHost {
  readonly onAddComment: (text: string, anchor?: CanvasAnchor) => void;
  readonly onEditComment: (id: string, text: string) => void;
  readonly onDeleteComment: (id: string) => void;
  readonly onReplyComment: (id: string, text: string) => void;
  readonly onResolveComment: (id: string, resolved: boolean) => void;
  readonly onFilterChange: (scope: CommentScope) => void;
  readonly onPickAnchor?: (kind: "free" | "selection" | "node" | "image" | "edge") => void;
  readonly onSelectTarget?: (thread: CommentThread) => void;
}

export interface CommentsPanelOptions extends CommentDisplayOptions {
  readonly document?: Document;
  readonly title?: string;
  readonly className?: string;
}

interface PanelRefs {
  readonly scope: HTMLSelectElement;
  readonly draft: HTMLTextAreaElement;
  readonly add: HTMLButtonElement;
  readonly list: HTMLElement;
  readonly status: HTMLElement;
}

const INPUT_BASELINE_ATTRIBUTE = "data-comment-baseline";

function hasDocument(value: unknown): value is Document {
  return value !== null && typeof value === "object"
    && typeof (value as { createElement?: unknown }).createElement === "function";
}

function append<T extends Node>(parent: Node, child: T): T {
  parent.appendChild(child);
  return child;
}

function make<K extends keyof HTMLElementTagNameMap>(document: Document, tag: K, text?: unknown): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (text !== undefined) {
    element.textContent = typeof text === "string" ? text : String(text);
  }
  return element;
}

function button(document: Document, label: string, action: string): HTMLButtonElement {
  const element = make(document, "button", label);
  element.type = "button";
  element.setAttribute("data-comment-action", action);
  element.setAttribute("aria-label", label);
  return element;
}

function inputText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function anchorLabel(anchor: CanvasAnchor | undefined): string {
  if (anchor === undefined) {
    return "No anchor";
  }
  if (anchor.type === "free") {
    return `Free point (${anchor.x}, ${anchor.y})`;
  }
  if (anchor.type === "edge") {
    return `Edge ${anchor.edgeId} at ${anchor.t}`;
  }
  return `${anchor.type === "image" ? "Image" : "Node"} ${anchor.nodeId} at (${anchor.u}, ${anchor.v})`;
}

function threadRenderKey(thread: CommentThread): readonly unknown[] {
  return [
    thread.id,
    thread.origin,
    thread.text,
    thread.createdAt ?? null,
    thread.updatedAt ?? null,
    thread.resolved,
    thread.immutable === true,
    commentAuthorLabel(thread),
    anchorLabel(thread.anchor),
    thread.replies.map((reply) => [
      reply.id,
      reply.text,
      commentAuthorLabel(reply),
      reply.createdAt,
      reply.updatedAt ?? null,
    ]),
  ];
}

/** A reusable DOM panel for board-wide and selection-filtered local comments. */
export class CommentsPanel {
  public readonly element: HTMLElement;
  private readonly document: Document | undefined;
  private readonly host: CommentsPanelHost;
  private readonly displayOptions: CommentDisplayOptions;
  private readonly refs: PanelRefs | undefined;
  private state: CommentsPanelState = { threads: [] };
  private renderKey: string | undefined;

  public constructor(host: CommentsPanelHost, options: CommentsPanelOptions = {}) {
    this.host = host;
    this.displayOptions = options;
    this.document = options.document ?? (typeof document !== "undefined" ? document : undefined);
    if (!hasDocument(this.document)) {
      this.element = {} as HTMLElement;
      return;
    }
    this.element = make(this.document, "section");
    this.element.className = options.className ?? "miro-canvas-comments-panel";
    this.element.setAttribute("aria-label", options.title ?? "Comments");
    this.refs = this.build();
  }

  private build(): PanelRefs {
    const document = this.document!;
    const heading = make(document, "h2", "Comments");
    heading.className = "miro-canvas-comments-panel__title";
    append(this.element, heading);
    const controls = append(this.element, make(document, "div"));
    controls.className = "miro-canvas-comments-panel__composer";
    controls.setAttribute("data-comment-region", "controls");
    const scope = make(document, "select");
    scope.className = "miro-canvas-comments-panel__scope";
    scope.setAttribute("aria-label", "Comment scope");
    for (const [value, label] of [["board", "Board"], ["selection", "Selection"]] as const) {
      const option = make(document, "option", label);
      option.value = value;
      append(scope, option);
    }
    scope.addEventListener("change", () => {
      this.host.onFilterChange(scope.value === "selection" ? "selection" : "board");
    });
    append(controls, scope);

    const anchorButtons = append(controls, make(document, "div"));
    anchorButtons.className = "miro-canvas-comments-panel__anchor-actions";
    for (const [kind, label] of [
      ["free", "Pick coordinates"],
      ["selection", "Use selection"],
    ] as const) {
      const pick = button(document, label, `pick-anchor-${kind}`);
      pick.addEventListener("click", () => this.host.onPickAnchor?.(kind));
      append(anchorButtons, pick);
    }
    const draft = make(document, "textarea");
    draft.className = "miro-canvas-comments-panel__draft";
    draft.setAttribute("aria-label", "New comment");
    draft.setAttribute("data-comment-input", "new");
    append(controls, draft);
    const add = button(document, "Add comment", "add-comment");
    add.className = "miro-canvas-comments-panel__add";
    add.addEventListener("click", () => {
      const text = inputText(draft.value);
      if (text.length > 0) {
        this.host.onAddComment(text, this.state.anchorDraft);
        draft.value = "";
      }
    });
    append(controls, add);

    const status = append(this.element, make(document, "div"));
    status.className = "miro-canvas-comments-panel__status";
    status.setAttribute("role", "status");
    const list = append(this.element, make(document, "div"));
    list.className = "miro-canvas-comments-panel__list";
    list.setAttribute("data-comment-region", "list");
    return { scope, draft, add, list, status };
  }

  private renderMessageHeader(message: CommentThread | CommentReply): HTMLElement {
    const document = this.document!;
    const header = make(document, "header");
    header.className = "miro-canvas-comment-card__header";
    const author = append(header, make(document, "strong", commentAuthorLabel(message)));
    author.className = "miro-canvas-comment-card__author";
    for (const [kind, value] of [["created", message.createdAt], ["updated", message.updatedAt]] as const) {
      if (kind === "updated" && (!value || value === message.createdAt)) continue;
      const label = commentTimeLabel(value, this.displayOptions);
      const time = append(header, make(document, "time", kind === "updated" ? `Updated ${label}` : label));
      time.className = "miro-canvas-comment-card__time";
      time.setAttribute("data-comment-time", kind);
      if (typeof value === "string" && value) {
        time.setAttribute("title", value);
        if (Number.isFinite(new Date(value).getTime())) time.setAttribute("datetime", value);
      }
    }
    return header;
  }

  private renderThread(thread: CommentThread): HTMLElement {
    const document = this.document!;
    const card = make(document, "article");
    card.className = "miro-canvas-comment-card";
    card.setAttribute("data-comment-id", thread.id);
    card.setAttribute("data-comment-origin", thread.origin);
    append(card, this.renderMessageHeader(thread));
    const body = append(card, make(document, "p", thread.text));
    body.className = "miro-canvas-comment-card__body";
    const actions = append(card, make(document, "div"));
    actions.className = "miro-canvas-comment-card__actions";
    const state = append(actions, make(document, "small", thread.resolved ? "Resolved" : "Open"));
    state.className = "miro-canvas-comment-card__state";
    const anchor = thread.anchor;
    const target = button(document, anchorLabel(anchor), "select-target");
    target.className = "miro-canvas-comment-card__anchor";
    target.disabled = this.host.onSelectTarget === undefined;
    target.addEventListener("click", () => this.host.onSelectTarget?.(thread));
    append(actions, target);

    const resolve = button(document, thread.resolved ? "Reopen" : "Resolve", thread.resolved ? "reopen" : "resolve");
    resolve.className = "miro-canvas-comment-card__resolve";
    resolve.disabled = thread.origin === "imported" || thread.immutable === true;
    resolve.addEventListener("click", () => this.host.onResolveComment(thread.id, !thread.resolved));
    append(actions, resolve);

    const editor = append(card, make(document, "details"));
    editor.className = "miro-canvas-comment-card__editor";
    const editToggle = append(editor, make(document, "summary", "Edit"));
    editToggle.className = "miro-canvas-comment-card__edit-toggle";
    const edit = make(document, "textarea");
    edit.value = thread.text;
    edit.setAttribute("aria-label", `Edit comment ${thread.id}`);
    edit.setAttribute("data-comment-input", `edit-${thread.id}`);
    edit.setAttribute(INPUT_BASELINE_ATTRIBUTE, thread.text);
    edit.disabled = thread.origin === "imported" || thread.immutable === true;
    append(editor, edit);
    const save = button(document, "Save edit", "edit-comment");
    save.disabled = edit.disabled;
    save.addEventListener("click", () => {
      const text = inputText(edit.value);
      if (text.length > 0) {
        this.host.onEditComment(thread.id, text);
      }
    });
    append(editor, save);
    const remove = button(document, "Delete", "delete-comment");
    remove.disabled = save.disabled;
    remove.addEventListener("click", () => this.host.onDeleteComment(thread.id));
    append(editor, remove);

    const replies = append(card, make(document, "div"));
    replies.className = "miro-canvas-comment-card__replies";
    replies.setAttribute("data-comment-region", "replies");
    // The opening message is the card's own text, even where an export lists
    // it among the replies.
    for (const reply of openingIsListed(thread) ? thread.replies.slice(1) : thread.replies) {
      const row = append(replies, make(document, "article"));
      row.className = "miro-canvas-comment-card__reply";
      row.setAttribute("data-comment-reply-id", reply.id);
      append(row, this.renderMessageHeader(reply));
      const body = append(row, make(document, "p", reply.text));
      body.className = "miro-canvas-comment-card__body";
    }
    const replyComposer = append(card, make(document, "div"));
    replyComposer.className = "miro-canvas-comment-card__reply-composer";
    const replyInput = make(document, "textarea");
    replyInput.setAttribute("aria-label", `Reply to ${thread.id}`);
    replyInput.setAttribute("data-comment-input", `reply-${thread.id}`);
    replyInput.setAttribute(INPUT_BASELINE_ATTRIBUTE, "");
    replyInput.disabled = thread.origin === "imported" || thread.immutable === true;
    append(replyComposer, replyInput);
    const replyButton = button(document, "Reply", "reply-comment");
    replyButton.disabled = replyInput.disabled;
    replyButton.addEventListener("click", () => {
      const text = inputText(replyInput.value);
      if (text.length > 0) {
        replyInput.value = "";
        this.host.onReplyComment(thread.id, text);
      }
    });
    append(replyComposer, replyButton);
    return card;
  }

  /** Refresh the panel from detached state; review mode never disables comments. */
  public update(state: CommentsPanelState): void {
    this.state = state;
    if (this.refs === undefined || !hasDocument(this.document)) {
      return;
    }
    const scope = state.scope ?? "board";
    const threads = filterCommentThreads(state.threads, {
      scope,
      selectedElementIds: state.selectedElementIds,
      includeResolved: state.includeResolved,
    });
    const nextRenderKey = JSON.stringify([
      scope,
      state.reviewMode === true,
      anchorLabel(state.anchorDraft),
      state.diagnostics ?? [],
      state.threads.length,
      threads.map(threadRenderKey),
    ]);
    if (nextRenderKey === this.renderKey) {
      return;
    }

    const inputValues = new Map<string, string>();
    for (const input of Array.from(this.refs.list.querySelectorAll<HTMLTextAreaElement>("textarea[data-comment-input]"))) {
      const key = input.getAttribute("data-comment-input");
      const baseline = input.getAttribute(INPUT_BASELINE_ATTRIBUTE) ?? "";
      if (key !== null && input.value !== baseline) {
        inputValues.set(key, input.value);
      }
    }
    this.refs.scope.value = scope;
    this.refs.add.disabled = false;
    this.refs.draft.disabled = false;
    this.refs.status.textContent = state.reviewMode === true
      ? `Review mode: comments remain available (${state.threads.length})`
      : `${state.threads.length} comment thread(s)`;
    if (state.anchorDraft !== undefined) {
      this.refs.status.textContent += `; ${anchorLabel(state.anchorDraft)}`;
    }
    if (state.diagnostics !== undefined && state.diagnostics.length > 0) {
      this.refs.status.textContent += `; ${state.diagnostics.join("; ")}`;
    }
    this.refs.list.textContent = "";
    for (const thread of threads) {
      append(this.refs.list, this.renderThread(thread));
    }
    for (const input of Array.from(this.refs.list.querySelectorAll<HTMLTextAreaElement>("textarea[data-comment-input]"))) {
      const key = input.getAttribute("data-comment-input");
      if (key !== null && inputValues.has(key)) {
        input.value = inputValues.get(key)!;
      }
    }
    this.renderKey = nextRenderKey;
  }

  /** Bring a marker-selected thread into view without changing stored data. */
  public focusThread(threadId: string, origin: CommentThread["origin"]): boolean {
    const list = this.refs?.list;
    if (list === undefined) return false;
    let match: HTMLElement | undefined;
    for (const child of Array.from(list.children ?? [])) {
      const element = child as HTMLElement;
      if (element.getAttribute?.("data-comment-id") === threadId
        && element.getAttribute?.("data-comment-origin") === origin) {
        match = element;
        break;
      }
    }
    if (match === undefined) return false;
    for (const child of Array.from(list.children ?? [])) {
      (child as HTMLElement).removeAttribute?.("data-comment-active");
    }
    match.setAttribute("data-comment-active", "true");
    match.scrollIntoView?.({ block: "nearest" });
    (match.querySelector?.("button") as HTMLButtonElement | null)?.focus?.();
    return true;
  }

  public destroy(): void {
    this.element.remove();
  }
}

export const LocalCommentsPanel = CommentsPanel;
