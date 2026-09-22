/**
 * A comment thread the way Miro opens it beside its pin: a resolve switch,
 * each message under its author's initial, name and time, and a reply field.
 * Only local threads take replies or change state; imported Miro threads are
 * retain their exported evidence, with optional display author aliases.
 * The host owns persistence and placement.
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
  readonly onHideImported?: (threadId: string) => void;
  readonly onReply: (threadId: string, text: string, authorName?: string) => void;
  /** Rename a display author; a listed imported opening uses its first reply ID. */
  readonly onRenameAuthor?: (threadId: string, messageId: string, name: string, origin?: CommentOrigin) => void;
  readonly onDeleteReply?: (threadId: string, replyId: string) => void;
  readonly onAppearance?: (threadId: string, origin: CommentOrigin, patch: {color?: string; locked?: boolean}) => void;
  readonly onResolve: (threadId: string, resolved: boolean) => void;
  /** Deletes an editable local thread. Imported Miro evidence is never deleted. */
  readonly onDelete: (threadId: string) => void;
  /** Opens the thread in the full comments panel. */
  readonly onOpenPanel: (threadId: string, origin: CommentOrigin) => void;
  readonly onClose: () => void;
  /** Starts a thread from the text written in a new comment. */
  readonly onCreate?: (text: string, authorName?: string, appearance?: {color: string; locked: boolean}) => void;
  readonly setIcon?: (element: HTMLElement, icon: string) => void;
}

export interface CommentThreadCardOptions {
  /** False in review mode: the thread is shown but not changed. */
  readonly editable: boolean;
  readonly locale?: string;
  readonly authorName?: string;
}

export class CommentThreadCard {
  public readonly element: HTMLElement;
  private thread: CommentThread | undefined;
  private readonly toggle: HTMLButtonElement;
  private readonly list: HTMLElement;
  private readonly composer: HTMLElement;
  private readonly input: HTMLInputElement;
  private readonly authorInput: HTMLInputElement;
  private focusedAuthor: HTMLInputElement | undefined;
  private messageGeneration = 0;
  private messageSignature: string | undefined;
  private readonly send: HTMLButtonElement;
  private readonly note: HTMLElement;
  private readonly panelButton: HTMLButtonElement;
  private readonly deleteButton: HTMLButtonElement;
  private readonly hideImportedButton: HTMLButtonElement;
  private readonly colorInput: HTMLInputElement;
  private readonly lockButton: HTMLButtonElement;
  private composing = false;
  private composingLocked = false;

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
      if (!this.toggle.disabled && this.thread?.origin === "local") this.host.onResolve(this.thread.id, !this.thread.resolved);
    });
    header.appendChild(this.make("span", "miro-canvas-thread__spacer"));
    this.colorInput = header.appendChild(this.make("input", "miro-canvas-thread__color"));
    this.colorInput.type = "color";
    this.colorInput.setAttribute("aria-label", "Comment color");
    this.colorInput.addEventListener("change", () => {
      if (this.thread) this.host.onAppearance?.(this.thread.id, this.thread.origin, {color: this.colorInput.value});
    });
    this.lockButton = header.appendChild(this.button("Lock comment", "miro-canvas-thread__icon", "lock", "🔒"));
    this.lockButton.addEventListener("click", () => {
      if (this.composing) {
        this.composingLocked = !this.composingLocked;
        this.lockButton.setAttribute("aria-pressed", this.composingLocked ? "true" : "false");
      } else if (this.thread) this.host.onAppearance?.(this.thread.id, this.thread.origin, {locked: this.thread.locked !== true});
    });
    const panel = header.appendChild(this.button("Open in comments panel", "miro-canvas-thread__icon", "more-vertical", "⋮"));
    this.panelButton = panel;
    panel.addEventListener("click", () => {
      if (this.thread !== undefined) this.host.onOpenPanel(this.thread.id, this.thread.origin);
    });
    this.deleteButton = header.appendChild(this.button("Delete comment", "miro-canvas-thread__icon", "trash-2", "×"));
    this.deleteButton.addEventListener("click", () => {
      if (this.thread?.origin === "local") this.host.onDelete(this.thread.id);
    });
    this.hideImportedButton = header.appendChild(this.button("Remove imported comment from board", "miro-canvas-thread__icon", "trash-2", "×"));
    this.hideImportedButton.addEventListener("click", () => {
      if (!this.hideImportedButton.disabled && this.thread?.origin === "imported") this.host.onHideImported?.(this.thread.id);
    });
    const close = header.appendChild(this.button("Close", "miro-canvas-thread__icon", "x", "×"));
    close.addEventListener("click", () => this.host.onClose());

    this.list = card.appendChild(this.make("div", "miro-canvas-thread__messages"));
    this.note = card.appendChild(this.make("p", "miro-canvas-thread__note"));
    this.composer = card.appendChild(this.make("form", "miro-canvas-thread__composer"));
    this.authorInput = this.composer.appendChild(this.make("input", "miro-canvas-thread__author-input"));
    this.authorInput.type = "text";
    this.authorInput.placeholder = "Author name";
    this.authorInput.setAttribute("aria-label", "Author name");
    this.input = this.composer.appendChild(this.make("input", "miro-canvas-thread__input") as HTMLInputElement);
    this.input.type = "text";
    this.input.placeholder = "Leave a reply";
    this.input.setAttribute("aria-label", "Reply");
    this.send = this.composer.appendChild(this.button("Send reply", "miro-canvas-thread__icon miro-canvas-thread__send", "send", "➤"));
    this.send.type = "submit";
    this.composer.addEventListener("submit", (event) => {
      event.preventDefault();
      if (this.composer.hidden || this.element.hidden) return;
      const text = this.input.value.trim();
      if (text.length === 0) return;
      const name = this.authorInput.value.trim();
      const author: [string?] = name ? [name] : [];
      if (this.composing) this.host.onCreate?.(text, ...author, {color: this.colorInput.value, locked: this.composingLocked});
      else if (this.thread !== undefined) this.host.onReply(this.thread.id, text, ...author);
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

  /** A new comment with an optional default author, editable before posting. */
  public compose(authorName = ""): void {
    this.composingLocked = false;
    this.lockButton.setAttribute("aria-pressed", "false");
    this.lockButton.setAttribute("aria-label", "Lock comment");
    this.colorInput.value = authorColor(authorName || "Local user");
    this.colorInput.hidden = this.host.onAppearance === undefined;
    this.lockButton.hidden = this.host.onAppearance === undefined;
    this.focusedAuthor = undefined;
    this.messageGeneration += 1;
    this.messageSignature = undefined;
    this.authorInput.value = authorName;
    this.composing = true;
    this.thread = undefined;
    this.element.hidden = false;
    this.element.setAttribute("data-comment-state", "new");
    this.toggle.hidden = true;
    this.panelButton.hidden = true;
    this.deleteButton.hidden = true;
    this.hideImportedButton.hidden = true;
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
    const changed = this.thread?.id !== thread.id || this.thread?.origin !== thread.origin || this.composing;
    this.composing = false;
    this.toggle.hidden = false;
    this.panelButton.hidden = false;
    this.list.hidden = false;
    this.input.placeholder = "Leave a reply";
    this.thread = thread;
    this.element.hidden = false;
    this.element.setAttribute("data-comment-state", thread.resolved ? "resolved" : "open");
    const local = thread.origin === "local";
    const editable = local && !thread.immutable && options.editable;
    const authorEditable = options.editable && (!local || editable) && this.host.onRenameAuthor !== undefined;
    this.toggle.setAttribute("aria-checked", thread.resolved ? "true" : "false");
    this.toggle.disabled = !editable;
    const locked = thread.locked === true;
    const color = typeof thread.color === "string" && /^#[0-9a-f]{6}$/i.test(thread.color) ? thread.color : authorColor(commentAuthorLabel(thread));
    this.colorInput.value = color;
    this.colorInput.hidden = this.host.onAppearance === undefined;
    this.colorInput.disabled = !options.editable;
    this.lockButton.hidden = this.host.onAppearance === undefined;
    this.lockButton.disabled = !options.editable;
    this.lockButton.setAttribute("aria-label", locked ? "Unlock comment" : "Lock comment");
    this.lockButton.setAttribute("aria-pressed", locked ? "true" : "false");
    this.element.style.setProperty("--miro-thread-color", color);
    this.deleteButton.hidden = !local;
    this.deleteButton.disabled = !editable || locked;
    this.hideImportedButton.hidden = local || this.host.onHideImported === undefined;
    this.hideImportedButton.disabled = !options.editable || locked;
    this.composer.hidden = !editable;
    this.note.hidden = local && options.editable;
    this.note.textContent = local ? "Review mode is on; comments are read-only." : "Imported from Miro; read-only.";
    if (!local && authorEditable) this.note.textContent = "Imported from Miro; author names are local display aliases.";
    const messageSignature = JSON.stringify({
      messages: threadMessages(thread),
      authorEditable,
      replyEditable: editable,
      locale: options.locale,
    });
    // Periodic host refreshes must not replace controls underneath the pointer
    // or an author field while it is being edited.
    if ((changed || messageSignature !== this.messageSignature) && (this.focusedAuthor === undefined || !authorEditable || changed)) {
      this.focusedAuthor = undefined;
      this.messageGeneration += 1;
      this.messageSignature = messageSignature;
      while (this.list.firstChild !== null) this.list.removeChild(this.list.firstChild);
      for (const message of threadMessages(thread)) {
        const mutable = !local || message.id === thread.id || thread.replies.some((reply) =>
          reply.id === message.id && reply.origin === "local" && !reply.immutable);
        this.list.appendChild(this.message(message, options.locale, authorEditable && mutable, editable && mutable && message.id !== thread.id));
      }
    }
    if (changed) {
      this.input.value = "";
      this.authorInput.value = options.authorName ?? "";
    }
  }

  public hide(): void {
    this.element.hidden = true;
    this.thread = undefined;
    this.composing = false;
    this.focusedAuthor = undefined;
    this.messageGeneration += 1;
    this.messageSignature = undefined;
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
    this.hide();
    this.element.remove();
  }

  private message(message: ThreadMessage, locale: string | undefined, editable: boolean, deletable: boolean): HTMLElement {
    const item = this.make("div", "miro-canvas-thread__message");
    const head = item.appendChild(this.make("div", "miro-canvas-thread__byline"));
    const avatar = head.appendChild(this.make("span", "miro-canvas-thread__avatar", authorInitial(message.author)));
    avatar.style.setProperty("--miro-avatar", authorColor(message.author));
    if (editable && this.host.onRenameAuthor !== undefined) {
      const author = head.appendChild(this.make("input", "miro-canvas-thread__author"));
      author.type = "text";
      author.value = message.author;
      author.setAttribute("aria-label", "Edit author name");
      const threadId = this.thread!.id;
      const origin = this.thread!.origin;
      const generation = this.messageGeneration;
      let saved = message.author;
      author.addEventListener("focus", () => { this.focusedAuthor = author; });
      author.addEventListener("blur", () => {
        if (this.focusedAuthor === author) this.focusedAuthor = undefined;
        if (generation !== this.messageGeneration) return;
        const name = author.value.trim();
        author.value = name || saved;
        if (!name || name === saved) return;
        saved = name;
        avatar.textContent = authorInitial(name);
        avatar.style.setProperty("--miro-avatar", authorColor(name));
        this.host.onRenameAuthor?.(threadId, message.id, name, origin);
      });
      author.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" && event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        if (event.key === "Escape") author.value = saved;
        author.blur();
      });
    } else head.appendChild(this.make("span", "miro-canvas-thread__author", message.author));
    const time = head.appendChild(this.make("time", "miro-canvas-thread__time", shortTime(message.createdAt, locale)));
    if (message.createdAt !== undefined) time.setAttribute("datetime", message.createdAt);
    if (deletable && this.host.onDeleteReply) {
      const remove = head.appendChild(this.button("Delete reply", "miro-canvas-thread__icon", "trash-2", "×"));
      remove.addEventListener("click", () => {
        if (this.thread && !this.thread.immutable && this.thread.origin === "local") this.host.onDeleteReply?.(this.thread.id, message.id);
      });
    }
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
