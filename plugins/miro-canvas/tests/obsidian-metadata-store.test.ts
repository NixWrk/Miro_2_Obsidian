import { describe, expect, it, vi } from "vitest";

import { MetadataWriter } from "../src/metadata-writer";
import {
	createObsidianMetadataStore,
	type ObsidianMetadataStoreProbe,
} from "../src/obsidian-metadata-store";

function nativeRuntime(document: Record<string, unknown>) {
	return {
		data: document,
		requestSave: vi.fn(),
	};
}

function readyStore(runtime: unknown): ObsidianMetadataStoreProbe {
	const probe = createObsidianMetadataStore({ canvas: runtime });
	expect(probe.status).toBe("ready");
	expect(probe.store).toBeDefined();
	return probe;
}

describe("native Obsidian metadata store", () => {
	it("rejects view-only persistence because it cannot enter native Canvas history", () => {
		const runtime = { data: { nodes: [], edges: [] } };
		const view = { canvas: runtime, requestSave: vi.fn() };
		const probe = createObsidianMetadataStore(view);
		expect(probe.status).toBe("incompatible");
		expect(probe.store).toBeUndefined();
		expect(view.requestSave).not.toHaveBeenCalled();
	});

	it("accepts the Obsidian 1.12.7 canvas.data/requestSave shape without saving on probe", () => {
		const runtime = nativeRuntime({ nodes: [], edges: [] });
		const probe = readyStore(runtime);

		expect(probe.available).toBe(true);
		expect(probe.compatible).toBe(true);
		expect(runtime.requestSave).not.toHaveBeenCalled();
	});

	it("accepts host fields that JSON serialization omits", () => {
		const runtime = nativeRuntime({
			nodes: [{ id: "a", type: "file", file: "note.md", subpath: undefined }],
			edges: [],
		});
		const probe = readyStore(runtime);
		expect(probe.store?.readDocument()).toEqual({
			nodes: [{ id: "a", type: "file", file: "note.md" }],
			edges: [],
		});
		expect(runtime.requestSave).not.toHaveBeenCalled();
	});

	it("names the precondition a rejected commit failed on", () => {
		const cases: readonly (readonly [string, Record<string, unknown>])[] = [
			["canvas-readonly", { data: { nodes: [], edges: [] }, readonly: true, requestSave: vi.fn() }],
			["request-save-asynchronous", { data: { nodes: [], edges: [] }, requestSave: vi.fn(() => Promise.resolve()) }],
			["request-save-refused", { data: { nodes: [], edges: [] }, requestSave: vi.fn(() => false) }],
			["request-save-threw", {
				data: { nodes: [], edges: [] },
				requestSave: vi.fn(() => { throw new Error("host busy"); }),
			}],
		];
		for (const [reason, runtime] of cases) {
			const store = readyStore(runtime).store!;
			const before = { nodes: [], edges: [] };
			expect(store.commitDocument({ ...before, miroCanvas: { schemaVersion: 1 } }, before)).toBe(false);
			expect(store.describeLastCommitFailure?.()).toContain(reason);
			// A refused save must leave the live root exactly as it was found.
			expect(runtime.data).toEqual(before);
		}
	});

	it("reports a stale expected document instead of overwriting a changed root", () => {
		const runtime = nativeRuntime({ nodes: [], edges: [], changed: true });
		const store = readyStore(runtime).store!;
		expect(store.commitDocument({ nodes: [], edges: [], next: true }, { nodes: [], edges: [] })).toBe(false);
		expect(store.describeLastCommitFailure?.()).toBe("document-changed-since-read");
		expect(runtime.requestSave).not.toHaveBeenCalled();
	});

	it("surfaces the store's refusal reason through the writer diagnostic", () => {
		const runtime = { data: { nodes: [], edges: [] }, readonly: true, requestSave: vi.fn() };
		const writer = new MetadataWriter(readyStore(runtime).store!);
		const result = writer.write("appearance", (draft) => ({ ...draft, miroCanvas: { schemaVersion: 1 } }));
		expect(result.status).toBe("rejected");
		expect(result.diagnostics.some((item) => item.message.includes("canvas-readonly"))).toBe(true);
	});

	it("records one native history snapshot that native undo and redo can replay", () => {
		const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
		const initial = { nodes: [], edges: [], keep: { native: true } };
		const history: Array<Record<string, unknown>> = [clone(initial)];
		let historyIndex = 0;
		const runtime = {
			data: clone(initial) as Record<string, unknown>,
			requestSave: vi.fn((addHistory?: boolean) => {
				if (addHistory === true) {
					history.splice(historyIndex + 1);
					history.push(clone(runtime.data));
					historyIndex = history.length - 1;
				}
			}),
			undo: () => {
				if (historyIndex > 0) {
					historyIndex -= 1;
					runtime.data = clone(history[historyIndex]!);
				}
			},
			redo: () => {
				if (historyIndex < history.length - 1) {
					historyIndex += 1;
					runtime.data = clone(history[historyIndex]!);
				}
			},
		};
		const writer = new MetadataWriter(readyStore(runtime).store!);

		expect(writer.write("initialize", () => undefined).status).toBe("applied");
		expect(runtime.requestSave).toHaveBeenCalledTimes(1);
		expect(runtime.requestSave).toHaveBeenCalledWith(true);
		expect(runtime.data).toHaveProperty("miroCanvas.schemaVersion", 1);

		runtime.undo();
		expect(runtime.data).toEqual(initial);
		runtime.redo();
		expect(runtime.data).toHaveProperty("miroCanvas.schemaVersion", 1);
		expect(runtime.data.keep).toEqual({ native: true });
	});

	it("also accepts the unwrapped runtime shape without probing through guessed data APIs", () => {
		const runtime = nativeRuntime({ nodes: [], edges: [] });
		const probe = createObsidianMetadataStore(runtime);

		expect(probe.status).toBe("ready");
		expect(probe.store).toBeDefined();
		expect(runtime.requestSave).not.toHaveBeenCalled();
	});

	it("returns detached data and replaces the root for an exact CAS commit", () => {
		const initial = {
			nodes: [{ id: "native-1", unknown: { keep: true } }],
			edges: [],
			miroSource: { items: [{ id: "source-1" }] },
		};
		const runtime = nativeRuntime(initial);
		const probe = readyStore(runtime);
		const store = probe.store!;
		const observed = store.readDocument() as Record<string, unknown>;

		(observed.nodes as Array<Record<string, unknown>>)[0]!.unknown = { keep: false };
		expect(initial.nodes).toEqual([{ id: "native-1", unknown: { keep: true } }]);

		const next = {
			...initial,
			miroCanvas: { schemaVersion: 1, localComments: [] },
		};
		const expected = store.readDocument() as Record<string, unknown>;
		const oldRoot = runtime.data;

		expect(store.commitDocument(next, expected)).toBe(true);
		expect(runtime.requestSave).toHaveBeenCalledTimes(1);
		expect(runtime.requestSave).toHaveBeenCalledWith(true);
		expect(runtime.data).not.toBe(oldRoot);
		expect(runtime.data).toEqual(next);
		expect(expected).toEqual(initial);
		expect(next.miroSource).toEqual(initial.miroSource);
	});

	it("refuses a stale CAS without replacing data or requesting native history", () => {
		const runtime = nativeRuntime({ nodes: [], edges: [] });
		const store = readyStore(runtime).store!;
		const expected = store.readDocument() as Record<string, unknown>;
		runtime.data = { nodes: [{ id: "external" }], edges: [] };

		expect(store.commitDocument({ nodes: [], edges: [], miroCanvas: { schemaVersion: 1 } }, expected)).toBe(false);
		expect(runtime.data).toEqual({ nodes: [{ id: "external" }], edges: [] });
		expect(runtime.requestSave).not.toHaveBeenCalled();
	});

	it("restores the previous root when requestSave throws", () => {
		const initial = { nodes: [], edges: [], keep: { value: true } };
		const runtime = nativeRuntime(initial);
		runtime.requestSave.mockImplementation(() => {
			throw new Error("native save failed");
		});
		const store = readyStore(runtime).store!;
		const expected = store.readDocument() as Record<string, unknown>;

		expect(store.commitDocument({ ...initial, changed: true }, expected)).toBe(false);
		expect(runtime.data).toEqual(initial);
		expect(runtime.data).not.toBe(initial);
		expect(runtime.requestSave).toHaveBeenCalledTimes(1);
	});

	it("rejects and restores a save that drops another producer's root metadata", () => {
		const initial = { nodes: [], edges: [], futureRoot: { keep: true } };
		const runtime: { data: Record<string, unknown>; requestSave: () => void } = {
			data: initial,
			requestSave: () => {
				runtime.data = {
					nodes: runtime.data.nodes,
					edges: runtime.data.edges,
					miroCanvas: runtime.data.miroCanvas,
				};
			},
		};
		const store = readyStore(runtime).store!;
		const expected = store.readDocument() as Record<string, unknown>;

		expect(store.commitDocument({ ...initial, miroCanvas: { schemaVersion: 1 } }, expected)).toBe(false);
		expect(store.describeLastCommitFailure?.()).toBe("post-save-metadata-lost: root-keys");
		expect(runtime.data).toEqual(initial);
	});

	it("integrates with MetadataWriter while keeping source bytes and native history boundaries", () => {
		const source = { items: [{ id: "source-1", payload: { keep: true } }] };
		const runtime = nativeRuntime({ nodes: [], edges: [], miroSource: source });
		const store = readyStore(runtime).store!;
		const writer = new MetadataWriter(store);

		const write = writer.write("add-comment", (draft) => {
			draft.localComments = [{ id: "local-1", text: "offline" }];
		});
		const undo = writer.undo();
		const redo = writer.redo();

		expect(write.status).toBe("applied");
		expect(undo.status).toBe("applied");
		expect(redo.status).toBe("applied");
		expect(runtime.data.miroSource).toEqual(source);
		expect(runtime.requestSave).toHaveBeenCalledTimes(3);
	});

	it("fails closed for missing, read-only, accessor, and hostile runtime shapes", () => {
		const missing = createObsidianMetadataStore({ getViewType: () => "canvas" });
		expect(missing.status).toBe("unavailable");
		expect(missing.store).toBeUndefined();

		const readOnlyRuntime = { ...nativeRuntime({ nodes: [], edges: [] }), readonly: true };
		const readOnly = readyStore(readOnlyRuntime);
		expect(readOnly.store!.commitDocument({ nodes: [{ id: "blocked" }], edges: [] }, { nodes: [], edges: [] })).toBe(false);
		expect(readOnlyRuntime.requestSave).not.toHaveBeenCalled();

		const accessorRuntime = {
			requestSave: vi.fn(),
		};
		Object.defineProperty(accessorRuntime, "data", {
			configurable: true,
			get: () => ({ nodes: [], edges: [] }),
		});
		const accessor = createObsidianMetadataStore({ canvas: accessorRuntime });
		expect(accessor.status).toBe("incompatible");
		expect(accessor.diagnostics.map((item) => item.code)).toContain("native-data-accessor-unsupported");

		const hostile = {
			get canvas(): unknown {
				throw new Error("private runtime moved");
			},
		};
		const hostileProbe = createObsidianMetadataStore(hostile);
		expect(hostileProbe.status).toBe("incompatible");
		expect(hostileProbe.store).toBeUndefined();

		const setDataOnly = {
			data: { nodes: [], edges: [] },
			setData: vi.fn(),
		};
		const guessed = createObsidianMetadataStore({ canvas: setDataOnly });
		expect(guessed.status).toBe("incompatible");
		expect(guessed.diagnostics.map((item) => item.code)).toContain("native-save-missing");
	});
});

describe("a host that reorders the graph while saving", () => {
  it("accepts a save that kept every node but changed their order", () => {
    const initial = {
      nodes: [
        { id: "a", type: "text", text: "a", x: 0, y: 0, width: 10, height: 10 },
        { id: "b", type: "text", text: "b", x: 20, y: 0, width: 10, height: 10 },
      ],
      edges: [],
    };
    const runtime = {
      data: JSON.parse(JSON.stringify(initial)) as Record<string, unknown>,
      requestSave: vi.fn(function (this: { data: Record<string, unknown> }) {
        // Native Canvas owns the stacking order and rewrites the array; the
        // set of nodes is unchanged.
        const nodes = this.data.nodes as unknown[];
        this.data = { ...this.data, nodes: [...nodes].reverse() };
      }),
    };
    const probe = createObsidianMetadataStore({ canvas: runtime });
    const store = probe.store!;
    const before = store.readDocument() as Record<string, unknown>;
    expect(store.commitDocument({ ...before, miroCanvas: { schemaVersion: 1 } }, before)).toBe(true);
    expect(runtime.data).toHaveProperty("miroCanvas.schemaVersion", 1);
  });

  it("still refuses a save that lost a node", () => {
    const initial = {
      nodes: [{ id: "a", type: "text", text: "a", x: 0, y: 0, width: 10, height: 10 }],
      edges: [],
    };
    const runtime = {
      data: JSON.parse(JSON.stringify(initial)) as Record<string, unknown>,
      requestSave: vi.fn(function (this: { data: Record<string, unknown> }) {
        this.data = { ...this.data, nodes: [{ id: "different", type: "text" }] };
      }),
    };
    const store = createObsidianMetadataStore({ canvas: runtime }).store!;
    const before = store.readDocument() as Record<string, unknown>;
    expect(store.commitDocument({ ...before, miroCanvas: { schemaVersion: 1 } }, before)).toBe(false);
    expect(store.describeLastCommitFailure?.()).toContain("missing after save");
  });
});

describe("a board written by another tool", () => {
  // The converter writes an edge's default arrow and fractional geometry;
  // native Canvas saves neither, which is the host keeping the board.
  function convertedRuntime(normalize: (data: Record<string, any>) => Record<string, any>) {
    const initial = {
      nodes: [{ id: "a", type: "text", text: "a", x: 10.4, y: 0, width: 100, height: 60 }, { id: "b", type: "text", text: "b", x: 200, y: 0, width: 100, height: 60 }],
      edges: [{ id: "e", fromNode: "a", fromSide: "right", toNode: "b", toSide: "left", fromEnd: "none", toEnd: "arrow", label: "" }],
    };
    return {
      data: JSON.parse(JSON.stringify(initial)) as Record<string, unknown>,
      requestSave: vi.fn(function (this: { data: Record<string, any> }) {
        this.data = normalize(JSON.parse(JSON.stringify(this.data)));
      }),
    };
  }
  const asNative = (data: Record<string, any>) => {
    for (const node of data.nodes) node.x = Math.round(node.x);
    for (const edge of data.edges) {
      if (edge.fromEnd === "none") delete edge.fromEnd;
      if (edge.toEnd === "arrow") delete edge.toEnd;
      if (edge.label === "") delete edge.label;
    }
    return data;
  };

  it("accepts a metadata write that native Canvas saves in its own habits", () => {
    const runtime = convertedRuntime(asNative);
    const writer = new MetadataWriter(readyStore(runtime).store!);
    const result = writer.write("probe", (draft) => {
      draft.localOverrides = { a: { rotation: 5 } };
    });
    expect(result.status).toBe("applied");
    expect(runtime.data).toHaveProperty("miroCanvas.localOverrides.a.rotation", 5);
  });

  it("still refuses a save that lost an edge end that was not the default", () => {
    const runtime = convertedRuntime((data) => {
      for (const edge of data.edges) delete edge.fromEnd;
      return data;
    });
    (runtime.data.edges as Record<string, unknown>[])[0]!.fromEnd = "arrow";
    const store = readyStore(runtime).store!;
    const before = store.readDocument() as Record<string, unknown>;
    expect(store.commitDocument({ ...before, miroCanvas: { schemaVersion: 1 } }, before)).toBe(false);
    expect(store.describeLastCommitFailure?.()).toContain("lost fromEnd");
  });
});
