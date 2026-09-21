/**
 * A comment thread the way Miro opens it beside its pin: a resolve switch,
 * each message under its author's initial, name and time, and a reply field.
 * Only local threads take replies or change state; imported Miro threads are
 * shown as they were exported.  The host owns persistence and placement.
 */
import { commentAuthorLabel, type CommentOrigin, type CommentThread } from "./local-comments";
import { TOOLTIP_DELAY } from "./tooltips";

export interface ThreadMessage {
  readonly id: string;
  readonly author: string;
  readonly text: string;
  readonly createdAt?: string;
}

const AVATAR_COLORS = ["#7b2fbe", "#2f5fd0", "#138a5b", "#d9601a", "#c6334a", "#11808f", "#8c4bd6", "#5b6472"] as const;

/**
 * Whether an exported Miro thread lists its opening message among its
 * messages; it then has no text of its own apart from that message's, and
 * showing both would show the comment twice.
 */
export function openingIsListed(thread: CommentThread): boolean {
  const first = thread.replies[0];
  return thread.origin === "imported" && first !== undefined && first.text === thread.text
    && (thread.createdAt === undefined || !first.createdAt || first.createdAt === thread.createdAt);
}

/** Every message of a thread in reading order, the opening one first. */
export function threadMessages(thread: CommentThread): readonly ThreadMessage[] {
  const listed = openingIsListed(thread);
  const opening: ThreadMessage[] = listed
    ? []
    : [{ id: thread.id, author: commentAuthorLabel(thread), text: thread.text,
      ...(thread.createdAt === undefined ? {} : { createdAt: thread.createdAt }) }];
  return [
    ...opening,
    ...thread.replies.map((reply) => ({
      id: reply.id, author: commentAuthorLabel(reply), text: reply.text,
      ...(reply.createdAt ? { createdAt: reply.createdAt } : {}),
    })),
  ];
}

/** The letter Miro shows in an author's avatar. */
export function authorInitial(name: string): string {
  const letter = [...name.trim()][0];
  return letter === undefined ? "?" : letter.toLocaleUpperCase();
}

/** The colours chosen for authors in the settings, which win over the ones made up for them. */
let chosenColors: Readonly<Record<string, string>> = {};

/** Colour authors as the settings say; anyone not named keeps a colour made up from the name. */
export function setAuthorColors(colors: Readonly<Record<string, string>>): void {
  chosenColors = colors;
}

/** A stable avatar colour per author: the one chosen for them, or one made up from the name. */
export function authorColor(name: string): string {
  const chosen = chosenColors[name];
  if (chosen !== undefined) return chosen;
  let hash = 0;
  for (const char of name) hash = (hash * 31 + char.codePointAt(0)!) >>> 0;
  return AVATAR_COLORS[hash % AVATAR_COLORS.length]!;
}

/** Miro's short stamp, such as "11 Jun, 14:25"; nothing for an unreadable time. */
export function shortTime(value: string | undefined, locale?: string): string {
  if (value === undefined) return "";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  const day = new Intl.DateTimeFormat(locale, { day: "numeric", month: "short" }).format(date);
  const time = new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" }).format(date);
  return `${day}, ${time}`;
}

export interface CommentThreadCardHost {
  readonly onReply: (threadId: string, text: string) => void;
  readonly onResolve: (threadId: string, resolved: boolean) => void;
  /** Opens the thread in the full comments panel. */
  readonly onOpenPanel: (threadId: string, origin: CommentOrigin) => void;
  readonly onClose: () => void;
  /** Starts a thread from the text written in a new comment. */
  readonly onCreate?: (text: string) => void;
  readonly setIcon?: (element: HTMLElement, icon: string) => void;
}

export interface CommentThreadCardOptions {
  /** False in review mode: the thread is shown but not changed. */
  readonly editable: boolean;
  readonly locale?: string;
}

export class CommentThreadCard {
  public readonly element: HTMLElement;
  private thread: CommentThread | undefined;
  private readonly toggle: HTMLButtonElement;
  private readonly list: HTMLElement;
  private readonly composer: HTMLElement;
  private readonly input: HTMLInputElement;
  private readonly send: HTMLButtonElement;
  private readonly note: HTMLElement;
  private readonly panelButton: HTMLButtonElement;
  private composing = false;

  public constructor(private readonly document: Document, private readonly host: CommentThreadCardHost) {
    const card = this.make("div", "miro-canvas-thread");
    card.setAttribute("role", "dialog");
    card.setAttribute("aria-label", "Comment thread");
    card.hidden = true;

    const header = card.appendChild(this.make("div", "miro-canvas-thread__header"));
    this.toggle = header.appendChild(this.button("Resolve", "miro-canvas-thread__resolve"));
    this.toggle.setAttribute("role", "switch");
    this.toggle.appendChild(this.make("span", "miro-canvas-thread__switch"));
    this.toggle.appendChild(this.make("span", "miro-canvas-thread__resolve-label", "Resolve"));
    this.toggle.addEventListener("click", () => {
      if (this.thread !== undefined) this.host.onResolve(this.thread.id, !this.thread.resolved);
    });
    header.appendChild(this.make("span", "miro-canvas-thread__spacer"));
    const panel = header.appendChild(this.button("Open in comments panel", "miro-canvas-thread__icon", "more-vertical", "⋮"));
    this.panelButton = panel;
    panel.addEventListener("click", () => {
      if (this.thread !== undefined) this.host.onOpenPanel(this.thread.id, this.thread.origin);
    });
    const close = header.appendChild(this.button("Close", "miro-canvas-thread__icon", "x", "×"));
    close.addEventListener("click", () => this.host.onClose());

    this.list = card.appendChild(this.make("div", "miro-canvas-thread__messages"));
    this.note = card.appendChild(this.make("p", "miro-canvas-thread__note"));
    this.composer = card.appendChild(this.make("form", "miro-canvas-thread__composer"));
    this.input = this.composer.appendChild(this.make("input", "miro-canvas-thread__input") as HTMLInputElement);
    this.input.type = "text";
    this.input.placeholder = "Leave a reply";
    this.input.setAttribute("aria-label", "Reply");
    this.send = this.composer.appendChild(this.button("Send reply", "miro-canvas-thread__icon miro-canvas-thread__send", "send", "➤"));
    this.send.type = "submit";
    this.composer.addEventListener("submit", (event) => {
      event.preventDefault();
      const text = this.input.value.trim();
      if (text.length === 0) return;
      if (this.composing) this.host.onCreate?.(text);
      else if (this.thread !== undefined) this.host.onReply(this.thread.id, text);
      else return;
      this.input.value = "";
    });
    // The board must not start a drag, select or take the keys typed here.
    for (const type of ["pointerdown", "mousedown", "dblclick", "wheel", "keydown", "keyup"]) {
      card.addEventListener(type, (event) => {
        if (type === "keydown" && (event as KeyboardEvent).key === "Escape") this.host.onClose();
        event.stopPropagation();
      });
    }
    this.element = card;
  }

  public get threadId(): string | undefined {
    return this.element.hidden ? undefined : this.thread?.id;
  }

  /** A new comment: only its text field, until it is written. */
  public compose(): void {
    this.composing = true;
    this.thread = undefined;
    this.element.hidden = false;
    this.element.setAttribute("data-comment-state", "new");
    this.toggle.hidden = true;
    this.panelButton.hidden = true;
    this.note.hidden = true;
    this.composer.hidden = false;
    this.input.placeholder = "Add a comment";
    this.input.value = "";
    while (this.list.firstChild !== null) this.list.removeChild(this.list.firstChild);
    this.list.hidden = true;
    this.input.focus?.();
  }

  public get composingComment(): boolean {
    return this.composing && !this.element.hidden;
  }

  public show(thread: CommentThread, options: CommentThreadCardOptions): void {
    const changed = this.thread?.id !== thread.id || this.composing;
    this.composing = false;
    this.toggle.hidden = false;
    this.panelButton.hidden = false;
    this.list.hidden = false;
    this.input.placeholder = "Leave a reply";
    this.thread = thread;
    this.element.hidden = false;
    this.element.setAttribute("data-comment-state", thread.resolved ? "resolved" : "open");
    const local = thread.origin === "local";
    const editable = local && options.editable;
    this.toggle.setAttribute("aria-checked", thread.resolved ? "true" : "false");
    this.toggle.disabled = !editable;
    this.composer.hidden = !editable;
    this.note.hidden = local && options.editable;
    this.note.textContent = local ? "Review mode is on; comments are read-only." : "Imported from Miro; read-only.";
    while (this.list.firstChild !== null) this.list.removeChild(this.list.firstChild);
    for (const message of threadMessages(thread)) this.list.appendChild(this.message(message, options.locale));
    if (changed) this.input.value = "";
  }

  public hide(): void {
    this.element.hidden = true;
    this.thread = undefined;
    this.composing = false;
  }

  /** Places the card beside a pin, kept inside the given area. */
  public place(point: { readonly x: number; readonly y: number }, area: { readonly width: number; readonly height: number }): void {
    const width = this.element.offsetWidth || 320;
    const height = this.element.offsetHeight || 200;
    const right = point.x + 24 + width <= area.width;
    const left = right ? point.x + 24 : Math.max(8, point.x - 24 - width);
    const top = Math.min(Math.max(8, point.y - 24), Math.max(8, area.height - height - 8));
    this.element.style.left = `${Math.round(left)}px`;
    this.element.style.top = `${Math.round(top)}px`;
  }

  public destroy(): void {
    this.element.remove();
  }

  private message(message: ThreadMessage, locale: string | undefined): HTMLElement {
    const item = this.make("div", "miro-canvas-thread__message");
    const head = item.appendChild(this.make("div", "miro-canvas-thread__byline"));
    const avatar = head.appendChild(this.make("span", "miro-canvas-thread__avatar", authorInitial(message.author)));
    avatar.style.setProperty("--miro-avatar", authorColor(message.author));
    head.appendChild(this.make("span", "miro-canvas-thread__author", message.author));
    const time = head.appendChild(this.make("time", "miro-canvas-thread__time", shortTime(message.createdAt, locale)));
    if (message.createdAt !== undefined) time.setAttribute("datetime", message.createdAt);
    item.appendChild(this.make("div", "miro-canvas-thread__text", message.text));
    return item;
  }

  private make<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
    const element = this.document.createElement(tag);
    element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  }

  private button(label: string, className: string, icon?: string, glyph?: string): HTMLButtonElement {
    const element = this.make("button", `miro-canvas-thread__button ${className}`);
    element.type = "button";
    element.setAttribute("aria-label", label);
    element.setAttribute("data-tooltip-delay", TOOLTIP_DELAY);
    if (icon !== undefined) {
      if (this.host.setIcon !== undefined) this.host.setIcon(element, icon);
      else element.textContent = glyph ?? "";
    }
    return element;
  }
}
