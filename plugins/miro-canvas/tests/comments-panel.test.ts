import { describe, expect, it } from "vitest";

import { CommentsPanel } from "../src/comments-panel";
import type { CommentScope, CommentThread } from "../src/local-comments";

class FakeElement {
  public readonly nodeType = 1;
  public readonly tagName: string;
  public readonly children: FakeElement[] = [];
  public readonly attributes = new Map<string, string>();
  public readonly listeners = new Map<string, Array<(event: unknown) => void>>();
  public parentNode: FakeElement | undefined;
  private content = "";
  public value = "";
  public disabled = false;
  public type = "";
  public className = "";

  public constructor(tagName: string) {
    this.tagName = tagName;
  }

  public get textContent(): string {
    return this.content;
  }

  public set textContent(value: string) {
    this.content = value;
    for (const child of this.children) child.parentNode = undefined;
    this.children.splice(0);
  }

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

  public querySelectorAll(selector: string): FakeElement[] {
    if (selector !== "textarea[data-comment-input]") {
      return [];
    }
    return descendants(this).filter(
      (item) => item.tagName === "textarea" && item.attributes.has("data-comment-input"),
    );
  }

  public addEventListener(name: string, listener: (event: unknown) => void): void {
    const listeners = this.listeners.get(name) ?? [];
    listeners.push(listener);
    this.listeners.set(name, listeners);
  }

  public dispatch(name: string): void {
    for (const listener of this.listeners.get(name) ?? []) {
      listener({ type: name, target: this });
    }
  }

  public remove(): void {
    if (this.parentNode !== undefined) {
      this.parentNode.children.splice(this.parentNode.children.indexOf(this), 1);
    }
  }
}

class FakeDocument {
  public createElement(tagName: string): FakeElement {
    return new FakeElement(tagName);
  }
}

function descendants(root: FakeElement): FakeElement[] {
  return [root, ...root.children.flatMap((child) => descendants(child))];
}

function findByAttribute(root: FakeElement, name: string, value: string): FakeElement {
  const found = descendants(root).find((item) => item.attributes.get(name) === value);
  if (found === undefined) {
    throw new Error(`missing ${name}=${value}`);
  }
  return found;
}

const localThread: CommentThread = {
  id: "local-1",
  origin: "local",
  text: "<img src=x> plain text",
  createdAt: "2026-01-01T00:00:00Z",
  resolved: false,
  replies: [],
  anchor: { type: "free", x: 1, y: 2 },
};

describe("comments panel", () => {
  it("emits add/edit/reply/resolve/filter and anchor callbacks with safe textContent", () => {
    const calls: Array<{ readonly kind: string; readonly args: readonly unknown[] }> = [];
    let scope: CommentScope = "board";
    const host = {
      onAddComment: (text: string, anchor: unknown) => calls.push({ kind: "add", args: [text, anchor] }),
      onEditComment: (id: string, text: string) => calls.push({ kind: "edit", args: [id, text] }),
      onDeleteComment: (id: string) => calls.push({ kind: "delete", args: [id] }),
      onReplyComment: (id: string, text: string) => calls.push({ kind: "reply", args: [id, text] }),
      onResolveComment: (id: string, resolved: boolean) => calls.push({ kind: "resolve", args: [id, resolved] }),
      onFilterChange: (next: CommentScope) => { scope = next; calls.push({ kind: "filter", args: [next] }); },
      onPickAnchor: (kind: string) => calls.push({ kind: "pick", args: [kind] }),
      onSelectTarget: (thread: CommentThread) => calls.push({ kind: "target", args: [thread.id] }),
    };
    const panel = new CommentsPanel(host, { document: new FakeDocument() as unknown as Document });
    const root = panel.element as unknown as FakeElement;
    panel.update({ threads: [localThread], reviewMode: true, anchorDraft: { type: "free", x: 9, y: 8 } });

    const draft = findByAttribute(root, "data-comment-input", "new");
    draft.value = "New comment";
    findByAttribute(root, "data-comment-action", "add-comment").dispatch("click");
    findByAttribute(root, "data-comment-action", "pick-anchor-free").dispatch("click");
    findByAttribute(root, "data-comment-action", "edit-comment").dispatch("click");
    findByAttribute(root, "data-comment-input", "reply-local-1").value = "Reply";
    findByAttribute(root, "data-comment-action", "reply-comment").dispatch("click");
    findByAttribute(root, "data-comment-action", "resolve").dispatch("click");
    findByAttribute(root, "data-comment-action", "select-target").dispatch("click");
    const scopeSelect = descendants(root).find((item) => item.tagName === "select");
    expect(scopeSelect).toBeDefined();
    scopeSelect!.value = "selection";
    scopeSelect!.dispatch("change");

    expect(scope).toBe("selection");
    expect(calls.map((call) => call.kind)).toEqual(["add", "pick", "edit", "reply", "resolve", "target", "filter"]);
    expect(calls[0]?.args).toEqual(["New comment", { type: "free", x: 9, y: 8 }]);
    expect(calls[2]?.args).toEqual(["local-1", "<img src=x> plain text"]);
    expect(findByAttribute(root, "data-comment-id", "local-1").textContent).not.toContain("innerHTML");
  });

  it("keeps imported threads visible but disables mutating controls in review mode", () => {
    const noop = () => undefined;
    const host = {
      onAddComment: noop,
      onEditComment: noop,
      onDeleteComment: noop,
      onReplyComment: noop,
      onResolveComment: noop,
      onFilterChange: noop,
    };
    const panel = new CommentsPanel(host, { document: new FakeDocument() as unknown as Document });
    const imported: CommentThread = { ...localThread, id: "miro-1", origin: "imported", immutable: true };
    const root = panel.element as unknown as FakeElement;
    panel.update({ threads: [imported], reviewMode: true });
    expect(findByAttribute(root, "data-comment-origin", "imported").textContent).toBe("");
    expect(findByAttribute(root, "data-comment-action", "resolve").disabled).toBe(true);
    expect(findByAttribute(root, "data-comment-action", "edit-comment").disabled).toBe(true);
    expect(findByAttribute(root, "data-comment-action", "delete-comment").disabled).toBe(true);
    expect(findByAttribute(root, "data-comment-action", "reply-comment").disabled).toBe(true);
  });

  it("does not rebuild unchanged comment state", () => {
    const noop = () => undefined;
    const panel = new CommentsPanel({
      onAddComment: noop,
      onEditComment: noop,
      onDeleteComment: noop,
      onReplyComment: noop,
      onResolveComment: noop,
      onFilterChange: noop,
    }, { document: new FakeDocument() as unknown as Document });
    const root = panel.element as unknown as FakeElement;
    panel.update({ threads: [localThread] });
    const edit = findByAttribute(root, "data-comment-input", "edit-local-1");
    edit.value = "Cursor stays here";

    panel.update({ threads: [{ ...localThread }] });

    expect(findByAttribute(root, "data-comment-input", "edit-local-1")).toBe(edit);
    expect(edit.value).toBe("Cursor stays here");
  });

  it("preserves dirty drafts on real updates while clean edit fields reflect undo", () => {
    const noop = () => undefined;
    const panel = new CommentsPanel({
      onAddComment: noop,
      onEditComment: noop,
      onDeleteComment: noop,
      onReplyComment: noop,
      onResolveComment: noop,
      onFilterChange: noop,
    }, { document: new FakeDocument() as unknown as Document });
    const root = panel.element as unknown as FakeElement;
    panel.update({ threads: [localThread] });
    findByAttribute(root, "data-comment-input", "edit-local-1").value = "Unsaved edit";
    findByAttribute(root, "data-comment-input", "reply-local-1").value = "Unsaved reply";

    panel.update({ threads: [{ ...localThread, text: "External edit", resolved: true }] });

    expect(findByAttribute(root, "data-comment-input", "edit-local-1").value).toBe("Unsaved edit");
    expect(findByAttribute(root, "data-comment-input", "reply-local-1").value).toBe("Unsaved reply");

    findByAttribute(root, "data-comment-input", "edit-local-1").value = "External edit";
    panel.update({ threads: [{ ...localThread, text: "Undo restored text", resolved: false }] });

    expect(findByAttribute(root, "data-comment-input", "edit-local-1").value).toBe("Undo restored text");
    expect(findByAttribute(root, "data-comment-input", "reply-local-1").value).toBe("Unsaved reply");
  });

  it("clears a reply before a synchronous host refresh", () => {
    const noop = () => undefined;
    let panel: CommentsPanel;
    const host = {
      onAddComment: noop,
      onEditComment: noop,
      onDeleteComment: noop,
      onReplyComment: (_id: string, text: string) => {
        panel.update({
          threads: [{
            ...localThread,
            replies: [{
              id: "reply-1",
              text,
              origin: "local",
              createdAt: "2026-01-01T00:00:01Z",
            }],
          }],
        });
      },
      onResolveComment: noop,
      onFilterChange: noop,
    };
    panel = new CommentsPanel(host, { document: new FakeDocument() as unknown as Document });
    const root = panel.element as unknown as FakeElement;
    panel.update({ threads: [localThread] });
    findByAttribute(root, "data-comment-input", "reply-local-1").value = "One reply";

    findByAttribute(root, "data-comment-action", "reply-comment").dispatch("click");

    expect(findByAttribute(root, "data-comment-input", "reply-local-1").value).toBe("");
    expect(findByAttribute(root, "data-comment-reply-id", "reply-1").textContent).toContain("One reply");
  });
});
