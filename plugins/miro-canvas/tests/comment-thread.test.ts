import { describe, expect, it } from "vitest";
import { CommentThreadCard, authorColor, authorInitial, shortTime, threadMessages } from "../src/comment-thread";
import type { CommentThread } from "../src/local-comments";
import { buildSourceScene } from "../src/source-model";

class FakeElement {
  public readonly children: FakeElement[] = [];
  public readonly attributes = new Map<string, string>();
  public readonly listeners = new Map<string, ((event: unknown) => void)[]>();
  public readonly styles = new Map<string, string>();
  public readonly style = { setProperty: (name: string, value: string) => { this.styles.set(name, value); } } as Record<string, unknown>;
  public parentNode: FakeElement | undefined;
  public className = "";
  public textContent = "";
  public hidden = false;
  public disabled = false;
  public type = "";
  public placeholder = "";
  public value = "";
  public offsetWidth = 0;
  public offsetHeight = 0;
  public constructor(public readonly tagName: string) {}
  public get firstChild(): FakeElement | null { return this.children[0] ?? null; }
  public appendChild(child: FakeElement): FakeElement { child.parentNode = this; this.children.push(child); return child; }
  public removeChild(child: FakeElement): FakeElement { this.children.splice(this.children.indexOf(child), 1); child.parentNode = undefined; return child; }
  public remove(): void { this.parentNode?.removeChild(this); }
  public focus(): void { this.fire("focus"); }
  public blur(): void { this.fire("blur"); }
  public setAttribute(name: string, value: string): void { this.attributes.set(name, value); }
  public getAttribute(name: string): string | null { return this.attributes.get(name) ?? null; }
  public addEventListener(name: string, listener: (event: unknown) => void): void {
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), listener]);
  }
  public fire(name: string, props: Record<string, unknown> = {}): { stopped: boolean; prevented: boolean } {
    const state = { stopped: false, prevented: false };
    const event = { ...props, stopPropagation: () => { state.stopped = true; }, preventDefault: () => { state.prevented = true; } };
    for (const listener of this.listeners.get(name) ?? []) listener(event);
    return state;
  }
  public all(): FakeElement[] { return this.children.flatMap((child) => [child, ...child.all()]); }
  public byClass(name: string): FakeElement[] { return this.all().filter((item) => item.className.split(" ").includes(name)); }
  public byLabel(label: string): FakeElement { return this.all().find((item) => item.getAttribute("aria-label") === label)!; }
  public text(): string { return [this.textContent, ...this.children.map((child) => child.text())].join(""); }
}

const fakeDocument = { createElement: (tag: string) => new FakeElement(tag) } as unknown as Document;

const IMPORTED: CommentThread = {
  id: "c1", origin: "imported", immutable: true, resolved: false, text: "комментарий",
  createdAt: "2026-06-11T14:25:00Z", author: { name: "Nikolai Kalmykov" },
  replies: [
    { id: "m1", origin: "imported", text: "комментарий", createdAt: "2026-06-11T14:25:00Z", author: { name: "Nikolai Kalmykov" } },
    { id: "m2", origin: "imported", text: "ответ", createdAt: "2026-06-11T15:02:00Z", author: { name: "Anna Petrova" } },
  ],
};

const LOCAL: CommentThread = {
  id: "l1", origin: "local", resolved: false, text: "Check this", createdAt: "2026-06-12T09:00:00Z",
  author: { name: "Local user" },
  replies: [{ id: "r1", origin: "local", text: "Done", createdAt: "2026-06-12T10:00:00Z", author: { name: "Local user" } }],
};

describe("comment thread messages", () => {
  it("reads an exported thread whose messages open with the comment itself only once", () => {
    expect(threadMessages(IMPORTED).map((message) => [message.author, message.text]))
      .toEqual([["Nikolai Kalmykov", "комментарий"], ["Anna Petrova", "ответ"]]);
    // A thread with text of its own opens with it.
    expect(threadMessages({ ...IMPORTED, text: "Heading" })).toHaveLength(3);
    expect(threadMessages(LOCAL).map((message) => message.text)).toEqual(["Check this", "Done"]);
  });

  it("gives an author a stable initial and colour and stamps times briefly", () => {
    expect(authorInitial(" nikolai")).toBe("N");
    expect(authorInitial("")).toBe("?");
    expect(authorColor("Anna Petrova")).toBe(authorColor("Anna Petrova"));
    expect(authorColor("Anna Petrova")).toMatch(/^#[0-9a-f]{6}$/u);
    expect(shortTime("2026-06-11T14:25:00Z", "en-GB")).toMatch(/^11 Jun, \d\d:25$/u);
    expect(shortTime("not a time")).toBe("");
    expect(shortTime(undefined)).toBe("");
  });
});

describe("comment thread card", () => {
  function setup(rename = false) {
    const calls: unknown[][] = [];
    const card = new CommentThreadCard(fakeDocument, {
      onReply: (...args) => calls.push(["reply", ...args]),
      onResolve: (...args) => calls.push(["resolve", ...args]),
      onDelete: (...args) => calls.push(["delete", ...args]),
      onOpenPanel: (...args) => calls.push(["panel", ...args]),
      onClose: () => calls.push(["close"]),
      onCreate: (...args) => calls.push(["create", ...args]),
      ...(rename ? { onRenameAuthor: (...args: [string, string, string]) => calls.push(["rename", ...args]) } : {}),
    });
    return { card, root: card.element as unknown as FakeElement, calls };
  }

  it("keeps picker input responsive and saves once on change or blur", () => {
    const document = { createElement: (tag: string) => new FakeElement(tag), activeElement: undefined as FakeElement | undefined };
    const changes: unknown[][] = [];
    const previews: unknown[][] = [];
    const card = new CommentThreadCard(document as unknown as Document, {
      onReply: () => {}, onResolve: () => {}, onDelete: () => {}, onOpenPanel: () => {}, onClose: () => {},
      onAppearance: (...args) => changes.push(args),
      onPreviewColor: (...args) => previews.push(args),
    });
    const color = (card.element as unknown as FakeElement).byLabel("Comment color");
    card.show(LOCAL, { editable: true });
    document.activeElement = color;
    color.value = "#405080";
    color.fire("input");
    color.value = "#3f66aa";
    card.show(LOCAL, { editable: true });
    expect(color.value).toBe("#3f66aa");
    color.fire("input");
    expect(changes).toEqual([]);
    expect(previews.at(-1)).toEqual(["l1", "local", "#3f66aa"]);
    color.fire("change");
    expect(changes).toEqual([["l1", "local", { color: "#3f66aa" }]]);
    expect(previews.at(-1)).toEqual(["l1", "local"]);
    card.show({ ...LOCAL, color: "#3f66aa" }, { editable: true });
    color.fire("blur");
    expect(changes).toHaveLength(1);
    color.value = "#123456";
    color.fire("blur");
    expect(changes[1]).toEqual(["l1", "local", { color: "#123456" }]);
  });

  it("passes edited author names for new comments and replies, preserving reply drafts on refresh", () => {
    const { card, root, calls } = setup();
    const form = root.byClass("miro-canvas-thread__composer")[0]!;
    card.compose("Alice");
    expect(root.byLabel("Author name").value).toBe("Alice");
    root.byLabel("Author name").value = "  Bob  ";
    root.byLabel("Reply").value = " Hello ";
    form.fire("submit");
    expect(calls).toEqual([["create", "Hello", "Bob", {color: authorColor("Alice"), locked: false}]]);
    card.show(LOCAL, { editable: true, authorName: "Alice" });
    root.byLabel("Author name").value = " Carol ";
    root.byLabel("Reply").value = "Reply draft";
    card.show(LOCAL, { editable: true, authorName: "Alice" });
    expect(root.byLabel("Author name").value).toBe(" Carol ");
    form.fire("submit");
    expect(calls.at(-1)).toEqual(["reply", "l1", "Reply draft", "Carol"]);
    card.show(LOCAL, { editable: false });
    root.byLabel("Reply").value = "Blocked";
    form.fire("submit");
    expect(calls).toHaveLength(2);
    card.compose();
    expect(root.byLabel("Author name").value).toBe("");
  });

  it("shows the lock state while composing a new comment", () => {
    const { card, root, calls } = setup();
    card.compose("Alice");
    expect(root.getAttribute("data-comment-locked")).toBe("false");
    root.byLabel("Lock comment").fire("click");
    expect(root.getAttribute("data-comment-locked")).toBe("true");
    expect(root.byLabel("Unlock comment").getAttribute("aria-pressed")).toBe("true");
    root.byLabel("Reply").value = "Locked from creation";
    root.byClass("miro-canvas-thread__composer")[0]!.fire("submit");
    expect(calls).toEqual([["create", "Locked from creation", "Alice", {color: authorColor("Alice"), locked: true}]]);
    card.compose("Alice");
    expect(root.getAttribute("data-comment-locked")).toBe("false");
  });

  it("renames opening and reply authors without interrupting a focused edit on refresh", () => {
    const { card, root, calls } = setup(true);
    card.show(LOCAL, { editable: true });
    const author = root.byLabel("Edit author name");
    author.focus();
    author.value = "  Alice  ";
    card.show({ ...LOCAL, resolved: true }, { editable: true });
    expect(root.byLabel("Edit author name")).toBe(author);
    expect(author.value).toBe("  Alice  ");
    author.fire("keydown", { key: "Enter" });
    author.blur();
    expect(calls).toEqual([["rename", "l1", "l1", "Alice", "local"]]);
    expect(root.byClass("miro-canvas-thread__avatar")[0]!.textContent).toBe("A");
    const reply = root.byClass("miro-canvas-thread__author")[1]!;
    reply.focus();
    reply.value = "Bob";
    reply.blur();
    expect(calls.at(-1)).toEqual(["rename", "l1", "r1", "Bob", "local"]);
    reply.focus();
    reply.value = "Cancelled";
    expect(reply.fire("keydown", { key: "Escape" }).stopped).toBe(true);
    expect(reply.value).toBe("Bob");
    reply.value = "  ";
    reply.blur();
    expect(reply.value).toBe("Bob");
    expect(calls).toHaveLength(2);
  });

  it("gates renaming on the callback and local editability, invalidating stale editors", () => {
    const without = setup();
    without.card.show(LOCAL, { editable: true });
    expect(without.root.byLabel("Edit author name")).toBeUndefined();
    const { card, root, calls } = setup(true);
    card.show(LOCAL, { editable: true });
    const author = root.byLabel("Edit author name");
    author.focus();
    author.value = "Stale";
    card.show(LOCAL, { editable: false });
    author.blur();
    expect(root.byLabel("Edit author name")).toBeUndefined();
    card.show(IMPORTED, { editable: true });
    expect(root.byLabel("Edit author name")).toBeDefined();
    card.show({ ...LOCAL, replies: [{ ...LOCAL.replies[0]!, immutable: true }] }, { editable: true });
    expect(root.byClass("miro-canvas-thread__author").map((item) => item.tagName)).toEqual(["input", "span"]);
    const stale = root.byLabel("Edit author name");
    stale.focus();
    stale.value = "Wrong thread";
    card.show({ ...LOCAL, id: "other" }, { editable: true });
    stale.blur();
    expect(calls).toEqual([]);
  });

  it("shows an imported thread read-only and keeps the board's gestures out", () => {
    const { card, root, calls } = setup();
    expect(root.hidden).toBe(true);
    card.show(IMPORTED, { editable: true, locale: "en-GB" });
    expect(root.hidden).toBe(false);
    expect(card.threadId).toBe("c1");
    expect(root.byClass("miro-canvas-thread__message")).toHaveLength(2);
    expect(root.byClass("miro-canvas-thread__avatar").map((item) => item.textContent)).toEqual(["N", "A"]);
    expect(root.byLabel("Resolve").disabled).toBe(true);
    expect(root.byLabel("Delete comment").hidden).toBe(true);
    expect(root.byClass("miro-canvas-thread__composer")[0]!.hidden).toBe(true);
    expect(root.byClass("miro-canvas-thread__note")[0]!.textContent).toBe("Imported from Miro; read-only.");
    expect(root.fire("pointerdown").stopped).toBe(true);
    root.fire("keydown", { key: "Escape" });
    root.byLabel("Open in comments panel").fire("click");
    expect(calls).toEqual([["close"], ["panel", "c1", "imported"]]);
  });

  it("resolves and answers a local thread unless review mode is on", () => {
    const { card, root, calls } = setup();
    card.show(LOCAL, { editable: true });
    const toggle = root.byLabel("Resolve");
    expect(toggle.disabled).toBe(false);
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    toggle.fire("click");
    const input = root.byLabel("Reply");
    input.value = "  Thanks  ";
    const form = root.byClass("miro-canvas-thread__composer")[0]!;
    expect(form.fire("submit").prevented).toBe(true);
    expect(input.value).toBe("");
    input.value = "   ";
    form.fire("submit");
    expect(calls).toEqual([["resolve", "l1", true], ["reply", "l1", "Thanks"]]);
    root.byLabel("Delete comment").fire("click");
    expect(calls.at(-1)).toEqual(["delete", "l1"]);
    card.show({ ...LOCAL, resolved: true }, { editable: false });
    expect(root.getAttribute("data-comment-state")).toBe("resolved");
    expect(root.byLabel("Resolve").disabled).toBe(true);
    expect(root.byLabel("Delete comment").disabled).toBe(true);
    expect(form.hidden).toBe(true);
    expect(root.byClass("miro-canvas-thread__note")[0]!.hidden).toBe(false);
    card.hide();
    expect(card.threadId).toBeUndefined();
  });

  it("locks a thread's replies and edits visibly until it is unlocked", () => {
    const calls: unknown[][] = [];
    const card = new CommentThreadCard(fakeDocument, {
      onReply: (...args) => calls.push(["reply", ...args]),
      onResolve: (...args) => calls.push(["resolve", ...args]),
      onDelete: (...args) => calls.push(["delete", ...args]),
      onOpenPanel: () => {}, onClose: () => {},
      onAppearance: (...args) => calls.push(["appearance", ...args]),
      onRenameAuthor: (...args) => calls.push(["rename", ...args]),
      onDeleteReply: (...args) => calls.push(["delete-reply", ...args]),
    });
    const root = card.element as unknown as FakeElement;
    const form = root.byClass("miro-canvas-thread__composer")[0]!;
    card.show(LOCAL, { editable: true });
    root.byLabel("Lock comment").fire("click");
    expect(calls).toEqual([["appearance", "l1", "local", { locked: true }]]);

    card.show({ ...LOCAL, locked: true }, { editable: true });
    expect(root.getAttribute("data-comment-locked")).toBe("true");
    expect(root.byLabel("Unlock comment").getAttribute("aria-pressed")).toBe("true");
    expect(root.byClass("miro-canvas-thread__note")[0]!.textContent).toContain("Unlock to reply");
    expect(form.hidden).toBe(true);
    expect(root.byLabel("Resolve").disabled).toBe(true);
    expect(root.byLabel("Delete comment").disabled).toBe(true);
    expect(root.byLabel("Comment color").disabled).toBe(true);
    expect(root.byLabel("Edit author name")).toBeUndefined();
    expect(root.byLabel("Delete reply")).toBeUndefined();
    root.byLabel("Reply").value = "Blocked";
    form.fire("submit");
    root.byLabel("Resolve").fire("click");
    root.byLabel("Delete comment").fire("click");
    root.byLabel("Comment color").value = "#123456";
    root.byLabel("Comment color").fire("change");
    expect(calls).toHaveLength(1);

    root.byLabel("Unlock comment").fire("click");
    expect(calls.at(-1)).toEqual(["appearance", "l1", "local", { locked: false }]);
    card.show(LOCAL, { editable: true });
    expect(root.getAttribute("data-comment-locked")).toBe("false");
    expect(form.hidden).toBe(false);
    expect(root.byLabel("Resolve").disabled).toBe(false);
    expect(root.byLabel("Edit author name")).toBeDefined();
    expect(root.byLabel("Delete reply")).toBeDefined();
  });

  it("opens beside its pin and stays inside the board", () => {
    const { card, root } = setup();
    card.show(LOCAL, { editable: true });
    root.offsetWidth = 320;
    root.offsetHeight = 200;
    card.place({ x: 100, y: 100 }, { width: 1000, height: 600 });
    expect([root.style.left, root.style.top]).toEqual(["124px", "76px"]);
    // No room on the right: the card opens to the left of the pin.
    card.place({ x: 900, y: 580 }, { width: 1000, height: 600 });
    expect([root.style.left, root.style.top]).toEqual(["556px", "392px"]);
  });
});

describe("converted comment nodes", () => {
  it("shows a thread a converter left on the board under the comment's id", () => {
    const scene = buildSourceScene({
      nodes: [{ id: "comment-1", type: "text", text: "Comment | Open", x: 0, y: 0, width: 300, height: 200 }],
      miroSource: {
        items: [],
        comments: [{
          id: "comment-1", createdAt: "2026-06-11T14:25:00Z", createdBy: { id: "u1", name: "Nikolai" }, resolved: true,
          messages: [{ id: "m1", content: "<b>hi</b>", createdAt: "2026-06-11T14:25:00Z", createdBy: { id: "u1", name: "Nikolai" } }],
        }, { id: "unplaced", messages: [] }],
      },
    });
    const node = scene.items.get("comment-1");
    expect(node).toMatchObject({ kind: "text", sourceId: "comment-1" });
    expect(node?.structured?.comment?.resolved).toBe(true);
    expect(node?.structured?.comment?.messages.map((message) => message.author)).toEqual(["Nikolai"]);
    expect(scene.items.has("unplaced")).toBe(false);
  });
});
