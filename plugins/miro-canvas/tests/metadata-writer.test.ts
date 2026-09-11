import { describe, expect, it, vi } from "vitest";

import {
	MetadataWriter,
	createMetadataWriter,
	type MetadataDocumentStore,
} from "../src/metadata-writer";

function clone<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}

function equal(left: unknown, right: unknown): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}

class MemoryStore implements MetadataDocumentStore {
	public current: Record<string, unknown>;
	public readonly commits: Array<{
		next: Record<string, unknown>;
		expected: Record<string, unknown>;
	}> = [];
	public commitHook: ((next: Record<string, unknown>) => void) | undefined;
	public rejectNext = false;

	public constructor(document: Record<string, unknown>) {
		this.current = clone(document);
	}

	public readDocument(): unknown {
		return this.current;
	}

	public commitDocument(
		nextDocument: Readonly<Record<string, unknown>>,
		expectedDocument: Readonly<Record<string, unknown>>,
	): boolean {
		const next = clone(nextDocument);
		const expected = clone(expectedDocument);
		this.commits.push({ next, expected });
		if (this.rejectNext || !equal(this.current, expected)) {
			this.rejectNext = false;
			return false;
		}
		this.current = next;
		this.commitHook?.(this.current);
		return true;
	}
}

function setComment(text: string) {
	return (draft: Record<string, unknown>) => {
		draft.localComments = [{ id: "local-1", text }];
	};
}

describe("MetadataWriter", () => {
	it("reads metadata without writing during construction or inspection", () => {
		const store = new MemoryStore({ nodes: [], edges: [] });
		const writer = createMetadataWriter(store);

		expect(writer.readMetadata()?.status).toBe("absent");
		expect(store.commits).toHaveLength(0);
	});

	it("creates and writes metadata only after an explicit action", () => {
		const source = { items: [{ id: "miro-1", data: { content: "keep" } }] };
		const store = new MemoryStore({ nodes: [{ id: "node-1" }], edges: [], miroSource: source });
		const writer = new MetadataWriter(store);

		const write = writer.write("add-comment", setComment("hello"));

		expect(write).toMatchObject({ ok: true, status: "applied", action: "add-comment" });
		expect(store.commits).toHaveLength(1);
		expect(store.current.miroCanvas).toMatchObject({
			schemaVersion: 1,
			localComments: [{ id: "local-1", text: "hello" }],
		});
		expect(store.current.miroSource).toEqual(source);
		expect(writer.undoDepth).toBe(1);
		expect(writer.redoDepth).toBe(0);
	});

	it("refuses malformed existing metadata and does not call the host", () => {
		const store = new MemoryStore({
			nodes: [],
			edges: [],
			miroCanvas: { schemaVersion: 1, zOrder: ["ok", 4] },
		});
		const writer = new MetadataWriter(store);

		const write = writer.write("bad-base", setComment("blocked"));

		expect(write.status).toBe("rejected");
		expect(write.diagnostics.map((item) => item.code)).toContain("current-metadata-invalid");
		expect(store.commits).toHaveLength(0);
	});

	it("does not commit a no-op action", () => {
		const store = new MemoryStore({
			nodes: [],
			edges: [],
			miroCanvas: { schemaVersion: 1, localComments: [] },
		});
		const writer = new MetadataWriter(store);

		const write = writer.write("noop", () => undefined);

		expect(write).toMatchObject({ ok: true, status: "noop" });
		expect(store.commits).toHaveLength(0);
		expect(writer.undoDepth).toBe(0);
	});

	it("validates the candidate before attempting a host write", () => {
		const store = new MemoryStore({ nodes: [], edges: [] });
		const writer = new MetadataWriter(store);

		const write = writer.write("invalid", (draft) => {
			draft.schemaVersion = 2;
		});

		expect(write.status).toBe("rejected");
		expect(write.diagnostics.map((item) => item.code)).toContain("metadata-validation-failed");
		expect(store.commits).toHaveLength(0);
	});

	it("rolls back when a host partially commits and then throws", () => {
		const before = { nodes: [], edges: [], miroSource: { items: [{ id: "source" }] } };
		const store = new MemoryStore(before);
		let firstCommit = true;
		const normalCommit = store.commitDocument.bind(store);
		store.commitDocument = (next, expected) => {
			if (firstCommit) {
				firstCommit = false;
				store.current = clone(next);
				throw new Error("disk write interrupted");
			}
			return normalCommit(next, expected);
		};
		const writer = new MetadataWriter(store);

		const write = writer.write("partial", setComment("must recover"));

		expect(write.status).toBe("rejected");
		expect(write.diagnostics.map((item) => item.code)).toContain("host-commit-failed");
		expect(store.current).toEqual(before);
		expect(writer.undoDepth).toBe(0);
		expect(store.commits).toHaveLength(1);
	});

	it("rolls back a host that changes miroSource or otherwise commits the wrong document", () => {
		const before = { nodes: [], edges: [], miroSource: { items: [{ id: "source", keep: true }] } };
		const store = new MemoryStore(before);
		let firstCommit = true;
		const normalCommit = store.commitDocument.bind(store);
		store.commitDocument = (next, expected) => {
			if (firstCommit) {
				firstCommit = false;
				const tampered = clone(next);
				(tampered.miroSource as Record<string, unknown>).keep = false;
				store.current = tampered;
				return true;
			}
			return normalCommit(next, expected);
		};
		const writer = new MetadataWriter(store);

		const write = writer.write("tampered", setComment("must recover"));

		expect(write.status).toBe("rejected");
		expect(write.diagnostics.map((item) => item.code)).toContain("host-commit-verification-failed");
		expect(write.diagnostics.find((item) => item.code === "host-commit-verification-failed")?.message)
			.toContain("(miroSource changed)");
		expect(store.current).toEqual(before);
		expect(store.commits).toHaveLength(1);
	});

	it("rolls back a host that drops an unknown root while preserving plugin metadata", () => {
		const before = { nodes: [], edges: [], futureRoot: { keep: true } };
		const store = new MemoryStore(before);
		let firstCommit = true;
		const normalCommit = store.commitDocument.bind(store);
		store.commitDocument = (next, expected) => {
			if (firstCommit) {
				firstCommit = false;
				const tampered = clone(next) as Record<string, unknown>;
				delete tampered.futureRoot;
				store.current = tampered;
				return true;
			}
			return normalCommit(next, expected);
		};
		const writer = new MetadataWriter(store);

		const write = writer.write("rotation", (draft) => {
			draft.localOverrides = { node: { rotation: 17 } };
		});

		expect(write.status).toBe("rejected");
		expect(write.diagnostics.find((item) => item.code === "host-commit-verification-failed")?.message)
			.toContain("(root keys changed)");
		expect(store.current).toEqual(before);
		expect(writer.undoDepth).toBe(0);
	});

	it("preserves exact snapshots through undo and redo", () => {
		const source = { items: [{ id: "source", nested: [1, { keep: true }] }] };
		const initial = { nodes: [{ id: "node" }], edges: [], miroSource: source };
		const store = new MemoryStore(initial);
		const writer = new MetadataWriter(store);

		writer.write("comment", setComment("one"));
		const after = clone(store.current);
		const undo = writer.undo();
		const afterUndo = clone(store.current);
		const redo = writer.redo();

		expect(undo).toMatchObject({ ok: true, status: "applied" });
		expect(afterUndo).toEqual(initial);
		expect(redo).toMatchObject({ ok: true, status: "applied" });
		expect(store.current).toEqual(after);
		expect(store.current.miroSource).toEqual(source);
		expect(store.commits).toHaveLength(3);
		expect(store.commits[1]?.expected).toEqual(after);
		expect(store.commits[1]?.next).toEqual(initial);
		expect(store.commits[2]?.expected).toEqual(initial);
		expect(store.commits[2]?.next).toEqual(after);
	});

	it("invalidates redo after a divergent explicit edit", () => {
		const store = new MemoryStore({ nodes: [], edges: [] });
		const writer = new MetadataWriter(store);

		writer.write("first", setComment("one"));
		writer.undo();
		const divergent = writer.write("divergent", setComment("two"));
		const redo = writer.redo();

		expect(divergent.status).toBe("applied");
		expect(writer.canRedo).toBe(false);
		expect(redo.status).toBe("noop");
		expect(store.current.miroCanvas).toMatchObject({ localComments: [{ text: "two" }] });
	});

	it("refuses stale undo after an external document edit and clears unsafe history", () => {
		const store = new MemoryStore({ nodes: [], edges: [] });
		const writer = new MetadataWriter(store);

		writer.write("first", setComment("one"));
		store.current = { nodes: [{ id: "external" }], edges: [] };
		const undo = writer.undo();

		expect(undo.status).toBe("rejected");
		expect(undo.diagnostics.map((item) => item.code)).toContain("history-conflict");
		expect(writer.canUndo).toBe(false);
		expect(writer.canRedo).toBe(false);
		expect(store.current).toEqual({ nodes: [{ id: "external" }], edges: [] });
	});

	it("rejects reentrant actions while the host transaction is in progress", () => {
		const store = new MemoryStore({ nodes: [], edges: [] });
		const writer = new MetadataWriter(store);
		let nested: ReturnType<MetadataWriter["write"]> | undefined;
		store.commitHook = () => {
			nested = writer.write("nested", setComment("nested"));
		};

		const outer = writer.write("outer", setComment("outer"));

		expect(outer.status).toBe("applied");
		expect(nested).toMatchObject({ status: "rejected", ok: false });
		expect(nested?.diagnostics.map((item) => item.code)).toContain("writer-reentrant");
		expect(writer.undoDepth).toBe(1);
	});

	it("fails closed for an uncloneable document before mutation", () => {
		const store: MetadataDocumentStore = {
			readDocument: vi.fn(() => ({ nodes: [], edges: [], invalid: BigInt(1) })),
			commitDocument: vi.fn(() => true),
		};
		const writer = new MetadataWriter(store);

		const write = writer.write("blocked", setComment("blocked"));

		expect(write.status).toBe("rejected");
		expect(write.diagnostics.map((item) => item.code)).toContain("document-read-failed");
		expect(store.commitDocument).not.toHaveBeenCalled();
	});
});
