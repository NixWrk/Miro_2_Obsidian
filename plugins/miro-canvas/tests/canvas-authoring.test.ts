import { describe, expect, it, vi } from "vitest";

import {
	createCanvasAuthoring,
	probeCanvasAuthoring,
	type CanvasShapeAction,
} from "../src/canvas-authoring";

type CanvasDocument = Record<string, unknown>;

function clone<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * This mock mirrors the important native behavior: getData() rebuilds the
 * nodes/edges arrays from runtime maps, and importData() is what rebuilds
 * those maps.  Replacing `data` alone would therefore lose graph items.
 */
class NativeGraph {
	public data: CanvasDocument;
	public nodes = new Map<string, CanvasDocument>();
	public edges = new Map<string, CanvasDocument>();
	public readonly history: CanvasDocument[] = [];
	public historyIndex = -1;
	public readonly importDataSpy = vi.fn();
	public readonly requestSaveSpy = vi.fn();
	public throwOnImport = false;
	public throwOnSave = false;
	public malformedAfterImport = false;

	public constructor(document: CanvasDocument) {
		this.data = clone(document);
		this.rebuildRuntime(this.data);
		this.history.push(this.getData());
		this.historyIndex = 0;
	}

	public getData(): CanvasDocument {
		if (this.malformedAfterImport) {
			return { broken: true };
		}
		return {
			...clone(this.data),
			nodes: [...this.nodes.values()].map((node) => clone(node)),
			edges: [...this.edges.values()].map((edge) => clone(edge)),
		};
	}

	public importData(document: CanvasDocument, rebuild: boolean): void {
		this.importDataSpy(document, rebuild);
		this.data = clone(document);
		if (rebuild) {
			this.rebuildRuntime(this.data);
		}
		if (this.throwOnImport) {
			throw new Error("import failed");
		}
	}

	public requestSave(addHistory?: boolean): void {
		this.requestSaveSpy(addHistory);
		if (this.throwOnSave) {
			throw new Error("save failed");
		}
		if (addHistory === true) {
			this.history.splice(this.historyIndex + 1);
			this.history.push(this.getData());
			this.historyIndex = this.history.length - 1;
		}
	}

	public undo(): void {
		if (this.historyIndex <= 0) {
			return;
		}
		this.historyIndex -= 1;
		this.importData(this.history[this.historyIndex]!, true);
	}

	public redo(): void {
		if (this.historyIndex >= this.history.length - 1) {
			return;
		}
		this.historyIndex += 1;
		this.importData(this.history[this.historyIndex]!, true);
	}

	private rebuildRuntime(document: CanvasDocument): void {
		const nodes = Array.isArray(document.nodes) ? document.nodes : [];
		const edges = Array.isArray(document.edges) ? document.edges : [];
		this.nodes = new Map(nodes.map((node) => [String((node as CanvasDocument).id), clone(node as CanvasDocument)]));
		this.edges = new Map(edges.map((edge) => [String((edge as CanvasDocument).id), clone(edge as CanvasDocument)]));
	}
}

function action(overrides: Partial<CanvasShapeAction> = {}): CanvasShapeAction {
	return {
		text: "Created shape",
		shape: "diamond",
		x: 10,
		y: -20,
		width: 160,
		height: 80,
		...overrides,
	};
}

function initialDocument(): CanvasDocument {
	return {
		nodes: [{ id: "existing", type: "text", x: 0, y: 0, width: 100, height: 50, text: "keep" }],
		edges: [{ id: "edge-1", fromNode: "existing", toNode: "existing" }],
		miroSource: { board: "source", nested: { keep: true } },
		futureRootField: { untouched: true },
		miroCanvas: {
			schemaVersion: 1,
			localOverrides: {
				existing: { typography: { fontSize: 18 }, futureOverrideField: { keep: true } },
			},
			futureMetadataField: ["keep"],
		},
	};
}

describe("CanvasAuthoring", () => {
	it("requires the verified native graph/history shape without mutating during probe", () => {
		const runtime = new NativeGraph(initialDocument());
		const probe = probeCanvasAuthoring({ canvas: runtime });

		expect(probe.status).toBe("ready");
		expect(probe.available).toBe(true);
		expect(probe.capabilities).toEqual(new Set([
			"document-read",
			"graph-import",
			"history-save",
			"whole-document-transaction",
		]));
		expect(runtime.importDataSpy).not.toHaveBeenCalled();
		expect(runtime.requestSaveSpy).not.toHaveBeenCalled();
	});

	it("creates an editable text fallback, records shape metadata, and rebuilds native maps", () => {
		const runtime = new NativeGraph(initialDocument());
		const authoring = createCanvasAuthoring({ canvas: runtime });

		const result = authoring.createShape(action({ shape: "star" }));

		expect(result.ok).toBe(true);
		expect(result.status).toBe("applied");
		expect(result.nodeId).toMatch(/^miro-canvas-node-\d+$/);
		expect(result.node).toMatchObject({
			id: result.nodeId,
			type: "text",
			text: "Created shape",
			x: 10,
			y: -20,
			width: 160,
			height: 80,
		});
		expect(runtime.nodes.get(result.nodeId!)).toEqual(result.node);
		expect(runtime.getData()).toMatchObject({
			futureRootField: { untouched: true },
			miroSource: initialDocument().miroSource,
			miroCanvas: {
				futureMetadataField: ["keep"],
				localOverrides: {
					existing: { futureOverrideField: { keep: true } },
					[result.nodeId!]: { shape: { kind: "star", fallback: "text" } },
				},
			},
		});
		expect(runtime.importDataSpy).toHaveBeenCalledTimes(1);
		expect(runtime.importDataSpy).toHaveBeenCalledWith(expect.any(Object), true);
		expect(runtime.requestSaveSpy).toHaveBeenCalledTimes(1);
		expect(runtime.requestSaveSpy).toHaveBeenCalledWith(true);
	});

	it("provides detached read and preview results without a native write", () => {
		const runtime = new NativeGraph(initialDocument());
		const authoring = createCanvasAuthoring(runtime);
		const before = authoring.readSnapshot();
		const preview = authoring.previewShape(action({ shape: "ellipse" }));

		expect(before.ok).toBe(true);
		expect(before.nodes).toHaveLength(1);
		expect(preview).toMatchObject({ ok: true, status: "preview", node: { type: "text", text: "Created shape" } });
		expect(runtime.importDataSpy).not.toHaveBeenCalled();
		expect(runtime.requestSaveSpy).not.toHaveBeenCalled();
		(preview.document!.nodes as Array<CanvasDocument>).push({ id: "detached", type: "text" });
		expect(runtime.nodes.has("detached")).toBe(false);
	});

	it("uses one native history snapshot that the mock undo/redo can replay", () => {
		const runtime = new NativeGraph({ nodes: [], edges: [] });
		const authoring = createCanvasAuthoring(runtime);
		const result = authoring.createShape(action({ id: "shape-1", shape: "rectangle" }));

		expect(result.ok).toBe(true);
		expect(runtime.history).toHaveLength(2); // initial snapshot + one authoring action
		expect(runtime.requestSaveSpy).toHaveBeenCalledTimes(1);
		runtime.undo();
		expect(runtime.getData().nodes).toEqual([]);
		runtime.redo();
		expect(runtime.getData().nodes).toContainEqual(expect.objectContaining({ id: "shape-1", type: "text" }));
	});

	it("rejects an explicit stale CAS token before native import", () => {
		const runtime = new NativeGraph(initialDocument());
		const authoring = createCanvasAuthoring(runtime);
		const expected = authoring.readSnapshot();
		runtime.importData({ ...initialDocument(), nodes: [...(initialDocument().nodes as unknown[]), { id: "external" }] }, true);

		const result = authoring.createShape(action(), expected);

		expect(result.ok).toBe(false);
		expect(result.diagnostics.map((item) => item.code)).toContain("stale-document");
		expect(runtime.importDataSpy).toHaveBeenCalledTimes(1); // only the external edit
		expect(runtime.requestSaveSpy).not.toHaveBeenCalled();
	});

	it("preserves source and unknown metadata while adding the local override", () => {
		const runtime = new NativeGraph(initialDocument());
		const sourceBefore = clone(initialDocument().miroSource);
		const authoring = createCanvasAuthoring(runtime);
		const result = authoring.createShape(action({ id: "new-shape", locked: true }));

		expect(result.ok).toBe(true);
		expect(runtime.getData().miroSource).toEqual(sourceBefore);
		expect(runtime.getData().futureRootField).toEqual({ untouched: true });
		expect((runtime.getData().miroCanvas as CanvasDocument).futureMetadataField).toEqual(["keep"]);
		expect((runtime.getData().miroCanvas as CanvasDocument).localOverrides).toMatchObject({
			["new-shape"]: { locked: true, shape: { kind: "diamond" } },
		});
	});

	it("rolls back a graph that partially imports or whose history save throws", () => {
		const initial = initialDocument();
		const runtime = new NativeGraph(initial);
		let imports = 0;
		runtime.importData = ((document: CanvasDocument, rebuild: boolean) => {
			imports += 1;
			runtime.data = clone(document);
			if (rebuild) {
				runtime.nodes = new Map((document.nodes as CanvasDocument[]).map((node) => [String(node.id), clone(node)]));
				runtime.edges = new Map((document.edges as CanvasDocument[]).map((edge) => [String(edge.id), clone(edge)]));
			}
			if (imports === 1) {
				throw new Error("partial import");
			}
		}) as NativeGraph["importData"];

		const authoring = createCanvasAuthoring(runtime);
		const result = authoring.createShape(action());

		expect(result.ok).toBe(false);
		expect(runtime.getData()).toEqual(initial);
		expect(runtime.requestSaveSpy).not.toHaveBeenCalled();

		const saveRuntime = new NativeGraph(initial);
		saveRuntime.throwOnSave = true;
		const saveResult = createCanvasAuthoring(saveRuntime).createShape(action({ id: "save-fails" }));
		expect(saveResult.ok).toBe(false);
		expect(saveRuntime.getData()).toEqual(initial);
		expect(saveRuntime.requestSaveSpy).toHaveBeenCalledTimes(1);
	});

	it("fails closed for malformed documents, unsupported methods, thenables, review mode, and collisions", () => {
		const unsupported = {
			getData: () => ({ nodes: [], edges: [] }),
			requestSave: vi.fn(),
		};
		expect(probeCanvasAuthoring(unsupported).status).toBe("incompatible");

		const malformed = createCanvasAuthoring({
			getData: () => ({ nodes: [{ id: "duplicate" }, { id: "duplicate" }], edges: [] }),
			importData: vi.fn(),
			requestSave: vi.fn(),
		});
		expect(malformed.createShape(action()).ok).toBe(false);

		const asyncRuntime = {
			getData: () => ({ nodes: [], edges: [] }),
			importData: () => Promise.resolve(),
			requestSave: vi.fn(),
		};
		const asyncResult = createCanvasAuthoring(asyncRuntime).createShape(action());
		expect(asyncResult.ok).toBe(false);
		expect(asyncResult.diagnostics.map((item) => item.code)).toContain("native-import-failed");

		const reviewRuntime = new NativeGraph({
			nodes: [],
			edges: [],
			miroCanvas: { schemaVersion: 1, settings: { reviewMode: true } },
		});
		const reviewResult = createCanvasAuthoring(reviewRuntime).createShape(action());
		expect(reviewResult.ok).toBe(false);
		expect(reviewResult.diagnostics.map((item) => item.code)).toContain("policy-review-mode");
		expect(reviewRuntime.importDataSpy).not.toHaveBeenCalled();

		const collisionRuntime = new NativeGraph({ nodes: [{ id: "fixed" }], edges: [] });
		const collisionResult = createCanvasAuthoring(collisionRuntime).createShape(action({ id: "fixed" }));
		expect(collisionResult.ok).toBe(false);
		expect(collisionResult.diagnostics.map((item) => item.code)).toContain("shape-id-collision");
	});
});
