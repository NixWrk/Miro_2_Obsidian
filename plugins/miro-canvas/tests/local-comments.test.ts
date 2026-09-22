import { describe, expect, it } from "vitest";

import {
  addLocalComment,
  addReply,
  commentAuthorLabel,
  commentTimeLabel,
  deleteLocalComment,
  deleteLocalReply,
  editLocalComment,
  listCommentThreads,
  reopenComment,
  renameLocalCommentAuthor,
  resolveComment,
} from "../src/local-comments";

const options = {
  idFactory: (kind: "comment" | "reply") => kind === "comment" ? "local-1" : "reply-1",
  now: () => "2026-01-01T00:00:00Z",
  author: { id: "local-user", name: "Alice" },
};

describe("offline local comments", () => {
  it("deletes one local reply without changing the thread or imported evidence", () => {
    const source = {comments: [{id: "source", text: "Evidence", messages: [{id: "imported", text: "Keep"}]}]};
    const base = {miroSource: source, localComments: []};
    const thread = addLocalComment(base, "Local", options);
    const first = addReply(thread.metadata, "local-1", "First", options);
    const second = addReply(first.metadata, "local-1", "Second", {...options, idFactory: () => "reply-2"});
    const before = JSON.stringify(second.metadata);
    const removed = deleteLocalReply(second.metadata, "local-1", "reply-1");
    expect(removed.ok).toBe(true);
    expect(removed.comment?.text).toBe("Local");
    expect(removed.comment?.replies.map(reply => reply.text)).toEqual(["Second"]);
    expect(removed.metadata?.miroSource).toEqual(source);
    expect(JSON.stringify(second.metadata)).toBe(before);
    expect(deleteLocalReply(second.metadata,"source","imported").ok).toBe(false);
  });
  it("renames only the selected local author and preserves all other evidence and timestamps", () => {
    const author = { id: "user", name: "Alice", displayName: "Original", future: { keep: [1] } };
    const reply = { id: "r1", origin: "local", text: "Reply", author,
      createdAt: "old", updatedAt: "later", source: { author: "Original" }, future: [2] };
    const thread = { id: "l1", origin: "local", text: "Opening", author,
      createdAt: "old", updatedAt: "later", resolved: false, replies: [reply], source: { keep: true } };
    const metadata = { schemaVersion: 1, localComments: [thread],
      miroSource: { comments: [{ id: "imported", createdBy: author }] }, future: [3] };
    const before = JSON.stringify(metadata);
    const opening = renameLocalCommentAuthor(metadata, "l1", "l1", "  Bob  ");
    expect(opening.ok).toBe(true);
    expect(opening.changed).toBe(true);
    expect(opening.metadata).toEqual({ ...metadata,
      localComments: [{ ...thread, author: { ...author, name: "Bob" } }] });
    const renamed = renameLocalCommentAuthor(metadata, "l1", "r1", "Carol");
    expect(renamed.metadata).toEqual({ ...metadata,
      localComments: [{ ...thread, replies: [{ ...reply, author: { ...author, name: "Carol" } }] }] });
    expect(renameLocalCommentAuthor(renamed.metadata, "l1", "r1", " Carol ").changed).toBe(false);
    expect(JSON.stringify(metadata)).toBe(before);
    const nameless = { localComments: [{ id: "l1", text: "Opening", replies: [] }] };
    expect(renameLocalCommentAuthor(nameless, "l1", "l1", "Alice").comment?.author).toEqual({ name: "Alice" });
  });

  it("rejects invalid renames and immutable opening/reply authors without changing metadata", () => {
    const metadata = { localComments: [{ id: "l1", text: "Local", replies: [
      { id: "r1", text: "Imported", origin: "imported" },
      { id: "r2", text: "Immutable", immutable: true },
    ] }], miroSource: { comments: [{ id: "source", content: "Original" }] } };
    for (const [thread, message, name, code] of [
      ["source", "source", "Bob", "comment-immutable"],
      ["l1", "r1", "Bob", "comment-immutable"],
      ["l1", "r2", "Bob", "comment-immutable"],
      ["missing", "missing", "Bob", "comment-not-found"],
      ["l1", "missing", "Bob", "comment-not-found"],
      ["l1", "__proto__", "Bob", "id-invalid"],
      ["l1", "l1", " ", "author-invalid"],
      ["l1", "l1", null, "author-invalid"],
    ]) {
      const result = renameLocalCommentAuthor(metadata, thread, message, name);
      expect(result).toMatchObject({ ok: false, changed: false, metadata });
      expect(result.diagnostics[0]?.code).toBe(code);
    }
    expect(renameLocalCommentAuthor(null, "l1", "l1", "Bob").ok).toBe(false);
    expect(renameLocalCommentAuthor({ localComments: {} }, "l1", "l1", "Bob").ok).toBe(false);
    expect(renameLocalCommentAuthor({ localComments: [{ id: "l1", immutable: true }] }, "l1", "l1", "Bob")
      .diagnostics[0]?.code).toBe("comment-immutable");
  });
  it("hides imported threads locally in both metadata input forms without changing evidence", () => {
    const metadata = { schemaVersion: 1, miroSource: { comments: [{ id: "source", content: "Original" }] },
      hiddenImportedComments: ["source"], localComments: [] };
    const before = JSON.stringify(metadata);
    expect(listCommentThreads(metadata)).toEqual([]);
    expect(listCommentThreads({ miroCanvas: metadata })).toEqual([]);
    expect(JSON.stringify(metadata)).toBe(before);
    expect(listCommentThreads({ ...metadata, hiddenImportedComments: [] })).toHaveLength(1);
  });
  it("formats presentation without modifying raw author or timestamp evidence", () => {
    const author = { name: "  Alice  ", displayName: "Other", future: { keep: true } };
    expect(commentAuthorLabel({ author })).toBe("Alice");
    expect(commentAuthorLabel({ author: { displayName: "Bob" } })).toBe("Bob");
    expect(commentAuthorLabel({ author: { id: "user-3" } })).toBe("user-3");
    expect(commentAuthorLabel({})).toBe("Unknown author");
    expect(commentTimeLabel("2026-09-09T13:42:00Z", { locale: "en-GB", timeZone: "UTC" })).toContain("13:42");
    expect(commentTimeLabel("2026-09-09T13:42:00Z", { locale: "en-GB", timeZone: "Europe/Moscow" })).toContain("16:42");
    for (const value of [undefined, null, "", "bad date", 0]) expect(commentTimeLabel(value)).toBe("Time unavailable");
    expect(author).toEqual({ name: "  Alice  ", displayName: "Other", future: { keep: true } });
  });

  it("preserves imported messages and local timestamp history across mutations and reads", () => {
    const imported = { id: "source", content: "Original", createdAt: "2025-12-01T10:00:00Z",
      createdBy: { name: "Source author", future: [1] }, future: { keep: true },
      messages: [{ id: "source-reply", content: "Reply", createdAt: "2025-12-02T11:00:00Z",
        updatedAt: "2025-12-02T12:00:00Z", createdBy: { name: "Reply author" }, history: ["original"] }] };
    const metadata = { schemaVersion: 1, miroSource: { comments: [imported], future: [2] },
      future: { keep: true }, localComments: [] };
    const before = JSON.stringify(metadata);
    const added = addLocalComment(metadata, { text: "Local", history: ["existing"] }, options);
    const replied = addReply(added.metadata, "local-1", { text: "Reply", history: ["reply evidence"] }, {
      ...options, now: () => "2026-01-02T00:00:00Z",
    });
    const edited = editLocalComment(replied.metadata, "local-1", "Edited", {
      ...options, now: () => "2026-01-03T00:00:00Z",
    });
    const threads = listCommentThreads(edited.metadata);
    expect(threads[0]).toMatchObject({ immutable: true, author: imported.createdBy, source: imported });
    expect(threads[0].replies[0]).toMatchObject({ immutable: true,
      createdAt: imported.messages[0].createdAt, updatedAt: imported.messages[0].updatedAt,
      history: ["original"], author: { name: "Reply author" } });
    expect(threads[1]).toMatchObject({ createdAt: options.now(), updatedAt: "2026-01-03T00:00:00Z", history: ["existing"] });
    expect(threads[1].replies[0]).toMatchObject({ createdAt: "2026-01-02T00:00:00Z",
      updatedAt: "2026-01-02T00:00:00Z", history: ["reply evidence"] });
    for (const result of [editLocalComment(edited.metadata, "source", "No"),
      addReply(edited.metadata, "source", "No"), deleteLocalComment(edited.metadata, "source"),
      resolveComment(edited.metadata, "source"), reopenComment(edited.metadata, "source")]) {
      expect(result.ok).toBe(false);
      expect(result.diagnostics[0].code).toBe("comment-immutable");
      expect(result.metadata).toEqual(edited.metadata);
    }
    expect(edited.metadata?.miroSource).toEqual(metadata.miroSource);
    expect(edited.metadata?.future).toEqual(metadata.future);
    expect(JSON.stringify(metadata)).toBe(before);
  });
  it("combines immutable imported threads with local threads and filters by target", () => {
    const source = {
      comments: [{
        id: "miro-1",
        content: "Imported body",
        createdAt: "2025-12-01T00:00:00Z",
        createdBy: { id: "miro-user", name: "Miro User" },
        messages: [{ id: "miro-reply", content: "Imported reply", createdBy: { name: "Miro User" } }],
        position: { type: "item", itemId: "node-1", u: 0.25, v: 0.5 },
        future: { keep: true },
      }],
    };
    const metadata = {
      schemaVersion: 1,
      miroSource: source,
      localComments: [{
        id: "local-existing",
        origin: "local",
        text: "Local body",
        createdAt: "2026-01-01T00:00:00Z",
        resolved: false,
        anchor: { type: "node", nodeId: "node-2", u: 0.5, v: 0.5 },
        localFuture: { keep: true },
      }],
    };
    const before = JSON.parse(JSON.stringify(source));
    const all = listCommentThreads(metadata);
    expect(all).toHaveLength(2);
    expect(all[0]).toMatchObject({ id: "miro-1", origin: "imported", immutable: true, text: "Imported body" });
    expect(all[0]?.replies[0]).toMatchObject({ id: "miro-reply", origin: "imported", immutable: true });
    expect(all[1]).toMatchObject({ id: "local-existing", origin: "local", localFuture: { keep: true } });
    expect(listCommentThreads(metadata, { scope: "selection", selectedElementIds: ["node-1"] })).toHaveLength(1);
    expect(listCommentThreads(metadata, { scope: "selection", selectedElementIds: ["not-selected"] })).toHaveLength(0);
    expect(source).toEqual(before);
  });

  it("supports local create/edit/reply/resolve/reopen/delete with deterministic IDs and timestamps", () => {
    const original = { schemaVersion: 1, settings: { future: { keep: true } }, localComments: [] };
    const added = addLocalComment(original, {
      text: "Hello **Canvas**",
      anchor: { type: "free", x: 10, y: 20 },
      future: { keep: true },
    }, options);
    expect(added.ok).toBe(true);
    expect(original.localComments).toEqual([]);
    expect(added.comment).toMatchObject({
      id: "local-1",
      origin: "local",
      text: "Hello **Canvas**",
      createdAt: "2026-01-01T00:00:00Z",
      future: { keep: true },
    });
    const edited = editLocalComment(added.metadata, "local-1", "Edited", { ...options, now: () => "2026-01-02T00:00:00Z" });
    expect(edited.ok).toBe(true);
    expect(edited.comment).toMatchObject({ text: "Edited", future: { keep: true } });

    const replied = addReply(edited.metadata, "local-1", { text: "Reply", futureReply: { keep: true } }, options);
    expect(replied.ok).toBe(true);
    expect(replied.reply).toMatchObject({ id: "reply-1", origin: "local", text: "Reply", futureReply: { keep: true } });
    expect(replied.comment?.replies).toHaveLength(1);

    const resolved = resolveComment(replied.metadata, "local-1", options);
    expect(resolved.comment).toMatchObject({ resolved: true, resolvedAt: "2026-01-01T00:00:00Z" });
    const reopened = reopenComment(resolved.metadata, "local-1", { ...options, now: () => "2026-01-03T00:00:00Z" });
    expect(reopened.comment?.resolved).toBe(false);
    expect(reopened.comment).not.toHaveProperty("resolvedAt");

    const deleted = deleteLocalComment(reopened.metadata, "local-1");
    expect(deleted.ok).toBe(true);
    expect(deleted.metadata?.localComments).toEqual([]);
    expect((deleted.metadata?.settings as Record<string, unknown>).future).toEqual({ keep: true });
  });

  it("rejects invalid anchors and all mutations of imported threads", () => {
    const metadata = {
      schemaVersion: 1,
      miroSource: { comments: [{ id: "miro-1", content: "Imported" }] },
      localComments: [],
    };
    const invalid = addLocalComment(metadata, { text: "Bad", anchor: { type: "node", nodeId: "n", u: 2, v: 0 } }, options);
    expect(invalid.ok).toBe(false);
    expect(invalid.diagnostics[0]?.code).toBe("anchor-invalid");
    const imported = editLocalComment(metadata, "miro-1", "Nope");
    expect(imported.ok).toBe(false);
    expect(imported.diagnostics[0]?.code).toBe("comment-immutable");
    const importedInLocal = {
      localComments: [{ id: "miro-1", origin: "imported", text: "Imported" }],
    };
    const immutable = editLocalComment(importedInLocal, "miro-1", "Nope");
    expect(immutable.ok).toBe(false);
    expect(immutable.diagnostics[0]?.code).toBe("comment-immutable");
  });
});
