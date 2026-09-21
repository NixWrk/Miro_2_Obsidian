import { describe, expect, it, vi } from "vitest";

import {
	createCanvasAuthoring,
	probeCanvasAuthoring,
	type ChangeZOrderInput,
	type CanvasShapeAction,
	type UpdateRotationInput,
	type CreateItemInput,
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
		const current = this.getData();
		this.data = clone(current);
		if (addHistory === true) {
			this.history.splice(this.historyIndex + 1);
			this.history.push(clone(current));
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

function endpointDocument(): CanvasDocument {
	return {
		nodes: [
			{ id: "a", type: "text", x: 0, y: 0, width: 100, height: 80, text: "A", futureNode: { keep: "a" } },
			{ id: "b", type: "text", x: 200, y: 0, width: 100, height: 80, text: "B" },
			{ id: "c", type: "text", x: 400, y: 0, width: 100, height: 80, text: "C" },
		],
		edges: [
			{ id: "e1", fromNode: "a", fromSide: "right", toNode: "b", toSide: "left", futureEdge: { keep: true } },
		],
		miroSource: { board: "source", nested: { keep: true } },
		futureRootField: { untouched: true },
		miroCanvas: {
			schemaVersion: 1,
			futureMetadataField: ["keep"],
			localOverrides: { e1: { futureOverrideField: { keep: true } } },
		},
	};
}

function layerDocument(): CanvasDocument {
	return {
		nodes: [
			{ id: "a", type: "text", x: 0, y: 0, width: 100, height: 80, text: "A", futureNode: { keep: "a" } },
			{ id: "b", type: "text", x: 200, y: 0, width: 100, height: 80, text: "B", futureNode: { keep: "b" } },
			{ id: "c", type: "text", x: 400, y: 0, width: 100, height: 80, text: "C" },
		],
		edges: [{ id: "e1", fromNode: "a", toNode: "b", futureEdge: { keep: true } }],
		miroSource: { board: "source", zOrder: ["source-a", "source-b"], nested: { keep: true } },
		futureRootField: { untouched: true },
		miroCanvas: {
			schemaVersion: 1,
			bindings: {
				a: { sourceId: "source-a", role: "item" },
				b: { sourceId: "source-b", role: "item" },
			},
			zOrder: ["a", "b", "c", "e1"],
			localOverrides: {
				b: { futureOverrideField: { keep: true } },
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

	it("refuses native readonly creation and connector edits before import or history mutation", () => {
		const createRuntime = new NativeGraph(initialDocument());
		Object.defineProperty(createRuntime, "readonly", { configurable: true, value: true });
		const createBefore = createRuntime.getData();
		const createHistoryBefore = clone(createRuntime.history);
		const createResult = createCanvasAuthoring(createRuntime).createShape(action({ id: "readonly-shape" }));

		expect(createResult.ok).toBe(false);
		expect(createResult.diagnostics.map((item) => item.code)).toContain("native-runtime-readonly");
		expect(createRuntime.getData()).toEqual(createBefore);
		expect(createRuntime.history).toEqual(createHistoryBefore);
		expect(createRuntime.importDataSpy).not.toHaveBeenCalled();
		expect(createRuntime.requestSaveSpy).not.toHaveBeenCalled();

		const endpointRuntime = new NativeGraph(endpointDocument());
		Object.defineProperty(endpointRuntime, "readonly", { configurable: true, value: true });
		const endpointBefore = endpointRuntime.getData();
		const endpointHistoryBefore = clone(endpointRuntime.history);
		const endpointResult = createCanvasAuthoring(endpointRuntime).updateConnectorEndpoint({
			edgeId: "e1",
			end: "from",
			anchor: { type: "free", x: 10, y: 20 },
		});

		expect(endpointResult.ok).toBe(false);
		expect(endpointResult.diagnostics.map((item) => item.code)).toContain("native-runtime-readonly");
		expect(endpointRuntime.getData()).toEqual(endpointBefore);
		expect(endpointRuntime.history).toEqual(endpointHistoryBefore);
		expect(endpointRuntime.importDataSpy).not.toHaveBeenCalled();
		expect(endpointRuntime.requestSaveSpy).not.toHaveBeenCalled();
	});

	it("fails closed when native readonly state is unreadable", () => {
		const runtime = new NativeGraph(initialDocument());
		Object.defineProperty(runtime, "readonly", {
			configurable: true,
			get: () => { throw new Error("readonly unavailable"); },
		});
		const before = runtime.getData();
		const result = createCanvasAuthoring(runtime).createShape(action({ id: "unreadable-readonly" }));

		expect(result.ok).toBe(false);
		expect(result.diagnostics.map((item) => item.code)).toContain("native-readonly-read-failed");
		expect(runtime.getData()).toEqual(before);
		expect(runtime.importDataSpy).not.toHaveBeenCalled();
		expect(runtime.requestSaveSpy).not.toHaveBeenCalled();
	});

	it("updates a connector endpoint in one native history entry and replays it through undo/redo", () => {
		const initial = endpointDocument();
		const runtime = new NativeGraph(initial);
		const authoring = createCanvasAuthoring(runtime);

		const result = authoring.updateConnectorEndpoint({
			edgeId: "e1",
			end: "from",
			anchor: { type: "node", nodeId: "c", u: 0.9, v: 0.5 },
		});

		expect(result.ok).toBe(true);
		expect(runtime.requestSaveSpy).toHaveBeenCalledTimes(1);
		expect(runtime.requestSaveSpy).toHaveBeenCalledWith(true);
		expect(runtime.history).toHaveLength(2);
		const applied = runtime.getData();
		expect((applied.edges as CanvasDocument[])[0]).toMatchObject({
			id: "e1", fromNode: "c", fromSide: "right", futureEdge: { keep: true },
		});
		expect((applied.nodes as CanvasDocument[])[0]).toMatchObject({ futureNode: { keep: "a" } });
		expect(applied.futureRootField).toEqual({ untouched: true });
		expect(applied.miroSource).toEqual(initial.miroSource);
		expect((applied.miroCanvas as CanvasDocument).futureMetadataField).toEqual(["keep"]);
		expect(((applied.miroCanvas as CanvasDocument).localOverrides as CanvasDocument).e1).toMatchObject({
			futureOverrideField: { keep: true },
			connectorAnchors: { from: { type: "node", nodeId: "c", u: 0.9, v: 0.5 } },
		});

		runtime.undo();
		expect(runtime.getData()).toEqual(initial);
		runtime.redo();
		expect(runtime.getData()).toEqual(applied);
	});

	it("rejects stale, review-mode, and locked connector edits before native history mutation", () => {
		const staleRuntime = new NativeGraph(endpointDocument());
		const staleAuthoring = createCanvasAuthoring(staleRuntime);
		const expected = staleAuthoring.readSnapshot();
		staleRuntime.importData({ ...endpointDocument(), futureExternal: true }, true);
		const stale = staleAuthoring.updateConnectorEndpoint({
			edgeId: "e1", end: "from", anchor: { type: "free", x: 10, y: 20 },
		}, expected);
		expect(stale.ok).toBe(false);
		expect(stale.diagnostics.map((item) => item.code)).toContain("stale-document");
		expect(staleRuntime.importDataSpy).toHaveBeenCalledTimes(1);
		expect(staleRuntime.requestSaveSpy).not.toHaveBeenCalled();

		const reviewDocument = endpointDocument();
		(reviewDocument.miroCanvas as CanvasDocument).settings = { reviewMode: true };
		const reviewRuntime = new NativeGraph(reviewDocument);
		const review = createCanvasAuthoring(reviewRuntime).updateConnectorEndpoint({
			edgeId: "e1", end: "from", anchor: { type: "free", x: 10, y: 20 },
		});
		expect(review.ok).toBe(false);
		expect(review.diagnostics.map((item) => item.code)).toContain("reconnect-blocked-review");
		expect(reviewRuntime.importDataSpy).not.toHaveBeenCalled();
		expect(reviewRuntime.requestSaveSpy).not.toHaveBeenCalled();

		const lockedDocument = endpointDocument();
		(((lockedDocument.miroCanvas as CanvasDocument).localOverrides as CanvasDocument).e1 as CanvasDocument).locked = true;
		const lockedRuntime = new NativeGraph(lockedDocument);
		const locked = createCanvasAuthoring(lockedRuntime).updateConnectorEndpoint({
			edgeId: "e1", end: "from", anchor: { type: "free", x: 10, y: 20 },
		});
		expect(locked.ok).toBe(false);
		expect(locked.diagnostics.map((item) => item.code)).toContain("reconnect-blocked-lock");
		expect(lockedRuntime.importDataSpy).not.toHaveBeenCalled();
		expect(lockedRuntime.requestSaveSpy).not.toHaveBeenCalled();
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

	it("normalizes finite rotations, preserves metadata, and replays rotation through native undo/redo", () => {
		const cases = [
			[0, 0],
			[360, 0],
			[180, -180],
			[-180, -180],
			[540, -180],
			[-540, -180],
			[-190, 170],
			[190, -170],
		] as const;
		for (const [rotation, expected] of cases) {
			const initial = initialDocument();
			const runtime = new NativeGraph(initial);
			const result = createCanvasAuthoring(runtime).updateRotation({ id: "existing", rotation });
			expect(result.ok).toBe(true);
			const applied = runtime.getData();
			const override = (((applied.miroCanvas as CanvasDocument).localOverrides as CanvasDocument).existing as CanvasDocument);
			expect(override.rotation).toBe(expected);
			if (expected === 0) {
				expect(Object.is(override.rotation, -0)).toBe(false);
			}
			expect(override).toMatchObject({ typography: { fontSize: 18 }, futureOverrideField: { keep: true } });
			expect(applied.miroSource).toEqual(initial.miroSource);
			expect(applied.futureRootField).toEqual(initial.futureRootField);
			expect(applied.nodes).toEqual(initial.nodes);
			expect(applied.edges).toEqual(initial.edges);
			expect(runtime.requestSaveSpy).toHaveBeenCalledTimes(1);
			expect(runtime.history).toHaveLength(2);
		}

		const initial = initialDocument();
		const runtime = new NativeGraph(initial);
		const result = createCanvasAuthoring(runtime).updateRotation({ id: "existing", rotation: 90 });
		expect(result.ok).toBe(true);
		const applied = runtime.getData();
		runtime.undo();
		expect(runtime.getData()).toEqual(initial);
		runtime.redo();
		expect(runtime.getData()).toEqual(applied);
	});

	it("rejects invalid or missing rotations and skips native history for a normalized noop", () => {
		for (const input of [
			{ id: "existing", rotation: Number.NaN },
			{ id: "existing", rotation: Number.POSITIVE_INFINITY },
			{ id: "missing", rotation: 10 },
		] as UpdateRotationInput[]) {
			const runtime = new NativeGraph(initialDocument());
			const result = createCanvasAuthoring(runtime).updateRotation(input);
			expect(result.ok).toBe(false);
			expect(runtime.importDataSpy).not.toHaveBeenCalled();
			expect(runtime.requestSaveSpy).not.toHaveBeenCalled();
		}

		const document = initialDocument();
		(((document.miroCanvas as CanvasDocument).localOverrides as CanvasDocument).existing as CanvasDocument).rotation = -170;
		const runtime = new NativeGraph(document);
		const result = createCanvasAuthoring(runtime).updateRotation({ id: "existing", rotation: 190 });
		expect(result.ok).toBe(true);
		expect(result.diagnostics.map((item) => item.code)).toContain("rotation-noop");
		expect(runtime.importDataSpy).not.toHaveBeenCalled();
		expect(runtime.requestSaveSpy).not.toHaveBeenCalled();
		expect(runtime.history).toHaveLength(1);
	});

	it("supports every z-order direction and treats front/back bounds as noops", () => {
		const cases: Array<[ChangeZOrderInput, string[]]> = [
			[{ id: "b", direction: "front" }, ["a", "c", "e1", "b"]],
			[{ id: "b", direction: "back" }, ["b", "a", "c", "e1"]],
			[{ id: "b", direction: "forward" }, ["a", "c", "b", "e1"]],
			[{ id: "b", direction: "backward" }, ["b", "a", "c", "e1"]],
		];
		for (const [input, expected] of cases) {
			const runtime = new NativeGraph(layerDocument());
			const result = createCanvasAuthoring(runtime).changeZOrder(input);
			expect(result.ok).toBe(true);
			expect((runtime.getData().miroCanvas as CanvasDocument).zOrder).toEqual(expected);
			expect(runtime.requestSaveSpy).toHaveBeenCalledTimes(1);
			expect(runtime.history).toHaveLength(2);
		}

		for (const input of [
			{ id: "e1", direction: "front" },
			{ id: "e1", direction: "forward" },
			{ id: "a", direction: "back" },
			{ id: "a", direction: "backward" },
		] as ChangeZOrderInput[]) {
			const runtime = new NativeGraph(layerDocument());
			const result = createCanvasAuthoring(runtime).changeZOrder(input);
			expect(result.ok).toBe(true);
			expect(result.diagnostics.map((item) => item.code)).toContain("z-order-noop");
			expect(runtime.importDataSpy).not.toHaveBeenCalled();
			expect(runtime.requestSaveSpy).not.toHaveBeenCalled();
			expect(runtime.history).toHaveLength(1);
		}
	});

	it("preserves unknown z-order entries and source-ID bindings while using native order for missing graph entries", () => {
		const initial = layerDocument();
		(initial.miroCanvas as CanvasDocument).zOrder = [
			"unknown-left",
			"a",
			"source-b",
			"unknown-mid",
			"c",
			"unknown-right",
		];
		const sourceBefore = clone(initial.miroSource);
		const runtime = new NativeGraph(initial);
		const result = createCanvasAuthoring(runtime).changeZOrder({ id: "b", direction: "front" });

		expect(result.ok).toBe(true);
		expect(result.diagnostics.map((item) => item.code)).toContain("z-order-source-limited-fallback");
		const applied = runtime.getData();
		expect((applied.miroCanvas as CanvasDocument).zOrder).toEqual([
			"unknown-left",
			"a",
			"c",
			"unknown-mid",
			"e1",
			"unknown-right",
			"source-b",
		]);
		expect(applied.miroSource).toEqual(sourceBefore);
		expect(applied.futureRootField).toEqual(initial.futureRootField);
		expect(applied.nodes).toEqual(initial.nodes);
		expect(applied.edges).toEqual(initial.edges);
		expect((applied.miroCanvas as CanvasDocument).bindings).toEqual((initial.miroCanvas as CanvasDocument).bindings);
		expect((applied.miroCanvas as CanvasDocument).futureMetadataField).toEqual(["keep"]);
	});

	it("uses native graph order when no explicit z-order exists and replays the transaction through undo/redo", () => {
		const initial = layerDocument();
		delete (initial.miroCanvas as CanvasDocument).zOrder;
		const runtime = new NativeGraph(initial);
		const result = createCanvasAuthoring(runtime).changeZOrder({ id: "b", direction: "forward" });

		expect(result.ok).toBe(true);
		expect(result.diagnostics.map((item) => item.code)).toContain("z-order-source-limited-fallback");
		const applied = runtime.getData();
		expect((applied.miroCanvas as CanvasDocument).zOrder).toEqual(["a", "c", "b", "e1"]);
		expect(runtime.history).toHaveLength(2);
		runtime.undo();
		expect(runtime.getData()).toEqual(initial);
		runtime.redo();
		expect(runtime.getData()).toEqual(applied);
	});

	it("applies stale, review, lock, readonly, and source-ID collision guards to M3 graph transactions", () => {
		const staleRuntime = new NativeGraph(layerDocument());
		const staleAuthoring = createCanvasAuthoring(staleRuntime);
		const expected = staleAuthoring.readSnapshot();
		staleRuntime.importData({ ...layerDocument(), externalEdit: true }, true);
		const stale = staleAuthoring.updateRotation({ id: "a", rotation: 15 }, expected);
		expect(stale.ok).toBe(false);
		expect(stale.diagnostics.map((item) => item.code)).toContain("stale-document");
		expect(staleRuntime.requestSaveSpy).not.toHaveBeenCalled();

		const reviewDocument = layerDocument();
		(reviewDocument.miroCanvas as CanvasDocument).settings = { reviewMode: true };
		for (const run of [
			(authoring: ReturnType<typeof createCanvasAuthoring>) => authoring.updateRotation({ id: "b", rotation: 15 }),
			(authoring: ReturnType<typeof createCanvasAuthoring>) => authoring.changeZOrder({ id: "b", direction: "front" }),
		]) {
			const runtime = new NativeGraph(reviewDocument);
			const result = run(createCanvasAuthoring(runtime));
			expect(result.ok).toBe(false);
			expect(result.diagnostics.some((item) => item.code.endsWith("blocked-review"))).toBe(true);
			expect(runtime.importDataSpy).not.toHaveBeenCalled();
		}

		const lockedDocument = layerDocument();
		(((lockedDocument.miroCanvas as CanvasDocument).localOverrides as CanvasDocument).b as CanvasDocument).locked = true;
		for (const run of [
			(authoring: ReturnType<typeof createCanvasAuthoring>) => authoring.updateRotation({ id: "b", rotation: 15 }),
			(authoring: ReturnType<typeof createCanvasAuthoring>) => authoring.changeZOrder({ id: "b", direction: "front" }),
		]) {
			const runtime = new NativeGraph(lockedDocument);
			const result = run(createCanvasAuthoring(runtime));
			expect(result.ok).toBe(false);
			expect(result.diagnostics.some((item) => item.code.endsWith("blocked-lock"))).toBe(true);
			expect(runtime.importDataSpy).not.toHaveBeenCalled();
		}

		for (const run of [
			(authoring: ReturnType<typeof createCanvasAuthoring>) => authoring.updateRotation({ id: "b", rotation: 15 }),
			(authoring: ReturnType<typeof createCanvasAuthoring>) => authoring.changeZOrder({ id: "b", direction: "front" }),
		]) {
			const runtime = new NativeGraph(layerDocument());
			Object.defineProperty(runtime, "readonly", { configurable: true, value: true });
			const result = run(createCanvasAuthoring(runtime));
			expect(result.ok).toBe(false);
			expect(result.diagnostics.map((item) => item.code)).toContain("native-runtime-readonly");
			expect(runtime.importDataSpy).not.toHaveBeenCalled();
			expect(runtime.requestSaveSpy).not.toHaveBeenCalled();
		}

		const collisionDocument = layerDocument();
		(collisionDocument.miroCanvas as CanvasDocument).bindings = {
			a: { sourceId: "b", role: "item" },
			b: { sourceId: "source-b", role: "item" },
		};
		const collisionRuntime = new NativeGraph(collisionDocument);
		const collision = createCanvasAuthoring(collisionRuntime).changeZOrder({ id: "a", direction: "front" });
		expect(collision.ok).toBe(false);
		expect(collision.diagnostics.map((item) => item.code)).toContain("z-order-id-collision");
		expect(collisionRuntime.importDataSpy).not.toHaveBeenCalled();
	});

	it("rolls back a z-order transaction when the native history save fails", () => {
		const initial = layerDocument();
		const runtime = new NativeGraph(initial);
		runtime.throwOnSave = true;
		const result = createCanvasAuthoring(runtime).changeZOrder({ id: "b", direction: "front" });

		expect(result.ok).toBe(false);
		expect(result.diagnostics.map((item) => item.code)).toContain("native-history-failed");
		expect(runtime.getData()).toEqual(initial);
		expect(runtime.requestSaveSpy).toHaveBeenCalledTimes(1);
		expect(runtime.history).toHaveLength(1);
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

	it("styles a multi-selection in one undoable transaction and preserves source evidence", () => {
		const initial = endpointDocument();
		const runtime = new NativeGraph(initial);
		const authoring = createCanvasAuthoring(runtime);
		const result = authoring.updateElementStyles([
			{ id: "a", borderWidth: 3, colors: { fill: "#ffeeaa" } },
			{ id: "b", borderWidth: 3, colors: { fill: "#ffeeaa" } },
		]);

		expect(result.ok).toBe(true);
		expect(runtime.requestSaveSpy).toHaveBeenCalledTimes(1);
		expect(runtime.history).toHaveLength(2);
		const applied = runtime.getData();
		const overrides = (applied.miroCanvas as CanvasDocument).localOverrides as Record<string, CanvasDocument>;
		expect(overrides.a).toMatchObject({ borderWidth: 3, colors: { fill: "#ffeeaa" } });
		expect(overrides.b).toMatchObject({ borderWidth: 3, colors: { fill: "#ffeeaa" } });
		expect(applied.miroSource).toEqual(initial.miroSource);
		expect(applied.futureRootField).toEqual(initial.futureRootField);
		runtime.undo();
		expect(runtime.getData()).toEqual(initial);
		runtime.redo();
		expect(runtime.getData()).toEqual(applied);
	});

	it("stores a connector's waypoints, replaces them whole and refuses malformed ones", () => {
		const runtime = new NativeGraph(endpointDocument());
		const authoring = createCanvasAuthoring(runtime);
		const overrides = () => ((runtime.getData().miroCanvas as CanvasDocument).localOverrides as Record<string, CanvasDocument>);
		const bent = authoring.updateElementStyles([
			{ id: "e1", connector: { route: "straight", waypoints: [{ x: 150.123, y: -40 }, { x: 170, y: 60 }] } },
		]);
		expect(bent.ok).toBe(true);
		expect(overrides().e1).toMatchObject({
			futureOverrideField: { keep: true },
			connector: { route: "straight", waypoints: [{ x: 150.12, y: -40 }, { x: 170, y: 60 }] },
		});
		expect(authoring.updateElementStyles([{ id: "e1", connector: { waypoints: [] } }]).ok).toBe(true);
		expect((overrides().e1!.connector as CanvasDocument).waypoints).toEqual([]);
		expect((overrides().e1!.connector as CanvasDocument).route).toBe("straight");
		for (const waypoints of [[{ x: 1, y: Number.NaN }], [{ x: 1 }], "nope", Array.from({ length: 65 }, () => ({ x: 0, y: 0 }))]) {
			const refused = authoring.updateElementStyles([{ id: "e1", connector: { waypoints } as never }]);
			expect(refused.ok).toBe(false);
		}
		expect((overrides().e1!.connector as CanvasDocument).waypoints).toEqual([]);
	});

	it("gives a shape to a card that only holds text, and not to a sticky", () => {
		const runtime = new NativeGraph({
			nodes: [
				{ id: "card", type: "text", text: "<div><p><strong>Card</strong></p></div>", x: 0, y: 0, width: 200, height: 100 },
				{ id: "note", type: "text", text: "note", x: 300, y: 0, width: 200, height: 200 },
			],
			edges: [],
			miroCanvas: { schemaVersion: 1, localOverrides: { card: { colors: { fill: "#ffeeaa" } }, note: { item: { type: "sticky_note" } } } },
		});
		const authoring = createCanvasAuthoring(runtime);
		expect(authoring.updateElementStyles([{ id: "card", shape: "ellipse" }]).ok).toBe(true);
		const overrides = (runtime.getData().miroCanvas as CanvasDocument).localOverrides as Record<string, CanvasDocument>;
		expect(overrides.card).toMatchObject({ colors: { fill: "#ffeeaa" }, shape: { kind: "ellipse" } });
		const refused = authoring.updateElementStyles([{ id: "note", shape: "ellipse" }]);
		expect(refused.ok).toBe(false);
		expect(refused.diagnostics.map((item) => item.code)).toContain("element-style-target-invalid");
	});

	it("adds pasted nodes and connectors with their records in one undoable step", () => {
		const initial = {
			nodes: [{ id: "old", type: "text", text: "old", x: 0, y: 0, width: 100, height: 100 }],
			edges: [],
			miroCanvas: { schemaVersion: 1 },
		};
		const runtime = new NativeGraph(initial);
		const authoring = createCanvasAuthoring(runtime);
		const result = authoring.insertGraph({
			nodes: [
				{ id: "n1", type: "text", text: "", x: 200, y: 0, width: 200, height: 200 },
				{ id: "n2", type: "file", file: "Assets/photo.png", x: 500, y: 0, width: 400, height: 300 },
			],
			edges: [{ id: "e1", fromNode: "n1", toNode: "old" }],
			overrides: { n1: { item: { type: "sticky_note", color: "yellow" } }, stray: { rotation: 5 } },
			bindings: { n2: { sourceId: "miro-image", role: "copy" } },
		});
		expect(result.ok).toBe(true);
		const applied = runtime.getData();
		expect((applied.nodes as CanvasDocument[]).map((node) => node.id)).toEqual(["old", "n1", "n2"]);
		const metadata = applied.miroCanvas as CanvasDocument;
		expect((metadata.localOverrides as CanvasDocument).n1).toEqual({ item: { type: "sticky_note", color: "yellow" } });
		// A record for something not pasted is not written.
		expect(metadata.localOverrides as CanvasDocument).not.toHaveProperty("stray");
		expect(metadata.bindings).toEqual({ n2: { sourceId: "miro-image", role: "copy" } });
		runtime.undo();
		expect(runtime.getData()).toEqual(initial);
		for (const bad of [
			{ nodes: [], edges: [] },
			{ nodes: [{ id: "old", type: "text", x: 0, y: 0, width: 1, height: 1 }], edges: [] },
			{ nodes: [{ id: "n3", type: "text", x: 0, y: 0, width: 1, height: 1 }], edges: [{ id: "e2", fromNode: "n3", toNode: "nowhere" }] },
		]) expect(authoring.insertGraph(bad as never).ok).toBe(false);
	});

	it("rejects a multi-selection style atomically when one target is locked", () => {
		const initial = endpointDocument();
		((initial.miroCanvas as CanvasDocument).localOverrides as Record<string, CanvasDocument>).b = { locked: true };
		const runtime = new NativeGraph(initial);
		const result = createCanvasAuthoring(runtime).updateElementStyles([
			{ id: "a", borderWidth: 3 },
			{ id: "b", borderWidth: 3 },
		]);

		expect(result.ok).toBe(false);
		expect(result.diagnostics.map((item) => item.code)).toContain("element-style-blocked-lock");
		expect(runtime.importDataSpy).not.toHaveBeenCalled();
		expect(runtime.requestSaveSpy).not.toHaveBeenCalled();
		expect(runtime.getData()).toEqual(initial);
	});
});

describe("connector creation", () => {
	function host(document: Record<string, unknown>) {
		const graph = new NativeGraph(document);
		return { graph, authoring: createCanvasAuthoring({ canvas: graph }) };
	}
	const board = () => ({
		nodes: [
			{ id: "a", type: "text", text: "a", x: 0, y: 0, width: 100, height: 80 },
			{ id: "b", type: "text", text: "b", x: 300, y: 0, width: 100, height: 80 },
		],
		edges: [],
	});

	it("adds one native edge between two nodes", () => {
		const { graph, authoring } = host(board());
		const result = authoring.createConnector({ fromNode: "a", toNode: "b" });
		expect(result.status).toBe("applied");
		expect(result.edgeId).toBeTruthy();
		expect(graph.getData().edges).toEqual([
			{ id: result.edgeId, fromNode: "a", fromSide: "right", toNode: "b", toSide: "left", toEnd: "arrow" },
		]);
		// The edge is native data only; no plugin metadata is invented for it.
		expect(graph.getData()).not.toHaveProperty("miroCanvas");
	});

	it("honors explicit sides and rejects an unsupported one", () => {
		const { graph, authoring } = host(board());
		expect(authoring.createConnector({ fromNode: "a", toNode: "b", fromSide: "bottom", toSide: "top" }).status).toBe("applied");
		expect((graph.getData().edges as Record<string, unknown>[])[0]).toMatchObject({ fromSide: "bottom", toSide: "top" });
		const rejected = authoring.createConnector({ fromNode: "a", toNode: "b", fromSide: "middle" as never });
		expect(rejected.status).toBe("rejected");
		expect(rejected.diagnostics.some((item) => item.code === "connector-side-invalid")).toBe(true);
	});

	it("stores precise perimeter anchors in the same native history entry", () => {
		const { graph, authoring } = host(board());
		const result = authoring.createConnector({
			fromNode: "a", toNode: "b",
			fromAnchor: { type: "node", nodeId: "a", u: 1, v: 0.2 },
			toAnchor: { type: "node", nodeId: "b", u: 0, v: 0.8 },
		});
		expect(result.status).toBe("applied");
		expect(graph.requestSaveSpy).toHaveBeenCalledTimes(1);
		const data = graph.getData();
		expect(data.edges).toEqual([
			{ id: result.edgeId, fromNode: "a", fromSide: "right", toNode: "b", toSide: "left", toEnd: "arrow" },
		]);
		const metadata = data.miroCanvas as { localOverrides: Record<string, { connectorAnchors: unknown }> };
		expect(metadata.localOverrides[result.edgeId!].connectorAnchors).toEqual({
			from: { type: "node", nodeId: "a", u: 1, v: 0.2 },
			to: { type: "node", nodeId: "b", u: 0, v: 0.8 },
		});
	});

	it("refuses a missing, repeated or self-referencing endpoint", () => {
		const { graph, authoring } = host(board());
		for (const input of [
			{ fromNode: "a", toNode: "a" },
			{ fromNode: "a", toNode: "missing" },
			{ fromNode: "", toNode: "b" },
		]) {
			expect(authoring.createConnector(input).status).toBe("rejected");
		}
		expect(graph.getData().edges).toEqual([]);
	});

	it("refuses to connect a locked node or to write in review mode", () => {
		const locked = { ...board(), miroCanvas: { schemaVersion: 1, settings: {}, localOverrides: { b: { locked: true } } } };
		expect(host(locked).authoring.createConnector({ fromNode: "a", toNode: "b" }).status).toBe("rejected");
		const review = { ...board(), miroCanvas: { schemaVersion: 1, settings: { reviewMode: true }, localOverrides: {} } };
		expect(host(review).authoring.createConnector({ fromNode: "a", toNode: "b" }).status).toBe("rejected");
	});

	it("preserves miroSource and unknown document fields", () => {
		const { graph, authoring } = host({
			...board(),
			miroSource: { items: [{ id: "a" }] },
			futureRoot: { keep: true },
		});
		expect(authoring.createConnector({ fromNode: "a", toNode: "b" }).status).toBe("applied");
		const data = graph.getData();
		expect(data.miroSource).toEqual({ items: [{ id: "a" }] });
		expect(data.futureRoot).toEqual({ keep: true });
	});
});

describe("host JSON normalization", () => {
	it("accepts additive native defaults while preserving every requested graph and source field", () => {
		class DefaultingGraph extends NativeGraph {
			public override importData(document: CanvasDocument, rebuild: boolean): void {
				super.importData(document, rebuild);
				for (const node of this.nodes.values()) {
					if (!("color" in node)) node.color = "";
				}
				for (const edge of this.edges.values()) {
					if (!("label" in edge)) edge.label = "";
				}
			}
		}
		const initial = initialDocument();
		const graph = new DefaultingGraph(initial);
		const result = createCanvasAuthoring({ canvas: graph }).createShape(action({ id: "normalized" }));
		expect(result.status).toBe("applied");
		expect(result.diagnostics.map((item) => item.code)).toContain("native-graph-normalized");
		expect(graph.getData()).toHaveProperty("nodes.0.text", "keep");
		expect(graph.getData()).toHaveProperty("nodes.1.color", "");
		expect(graph.getData().miroSource).toEqual(initial.miroSource);
		expect(graph.getData().futureRootField).toEqual(initial.futureRootField);
	});

	it("accepts optional values that native Canvas leaves undefined", () => {
		class UndefinedFieldGraph extends NativeGraph {
			public override getData(): Record<string, unknown> {
				const document = super.getData();
				const nodes = document.nodes as Record<string, unknown>[];
				nodes[0]!.subpath = undefined;
				return document;
			}
		}
		const graph = new UndefinedFieldGraph({
			nodes: [
				{ id: "a", type: "file", file: "note.md", x: 0, y: 0, width: 100, height: 80 },
				{ id: "b", type: "text", text: "b", x: 300, y: 0, width: 100, height: 80 },
			],
			edges: [],
		});
		const authoring = createCanvasAuthoring({ canvas: graph });
		expect(authoring.probe().status).toBe("ready");
		expect(authoring.createConnector({ fromNode: "a", toNode: "b" }).status).toBe("applied");
		expect(graph.requestSaveSpy).toHaveBeenCalledWith(true);
	});
});

describe("native root metadata rebuilds", () => {
	it("creates a connected node and edge when importData drops unknown root keys", () => {
		class RootDroppingGraph extends NativeGraph {
			public dropRootMetadata = true;

			public override importData(document: CanvasDocument, rebuild: boolean): void {
				super.importData(document, rebuild);
				if (!this.dropRootMetadata) return;
				for (const node of this.nodes.values()) {
					if (!("color" in node)) node.color = "";
				}
				for (const key of Object.keys(this.data)) {
					if (key !== "nodes" && key !== "edges") delete this.data[key];
				}
			}
		}
		const initial = initialDocument();
		const runtime = new RootDroppingGraph(initial);
		const authoring = createCanvasAuthoring({ canvas: runtime });
		const shape = authoring.createShape(action({ id: "connected" }));
		expect(shape.status).toBe("applied");
		expect(shape.diagnostics.map((item) => item.code)).toContain("native-import-root-metadata-restored");
		const connector = authoring.createConnector({ fromNode: "existing", toNode: "connected" });
		expect(connector.status).toBe("applied");
		const data = runtime.getData();
		expect((data.nodes as CanvasDocument[]).map((node) => node.id)).toContain("connected");
		expect((data.edges as CanvasDocument[]).some((edge) => edge.fromNode === "existing" && edge.toNode === "connected")).toBe(true);
		expect(data.miroSource).toEqual(initial.miroSource);
		expect(data.futureRootField).toEqual(initial.futureRootField);
		expect(data).toHaveProperty("miroCanvas.localOverrides.connected.shape.kind", "diamond");
		expect(runtime.requestSaveSpy).toHaveBeenCalledTimes(2);
		expect(runtime.history).toHaveLength(3);
		expect(runtime.history[2]).toMatchObject({
			miroSource: initial.miroSource,
			futureRootField: initial.futureRootField,
		});
		const final = runtime.getData();
		runtime.dropRootMetadata = false;
		runtime.undo();
		expect((runtime.getData().edges as CanvasDocument[]).some((edge) => edge.toNode === "connected")).toBe(false);
		expect(runtime.getData().miroSource).toEqual(initial.miroSource);
		runtime.undo();
		expect(runtime.getData()).toEqual(initial);
		runtime.redo();
		runtime.redo();
		expect(runtime.getData()).toEqual(final);
	});

	it("still rejects and rolls back a rebuild that changed graph content", () => {
		class GraphChangingHost extends NativeGraph {
			private imports = 0;

			public override importData(document: CanvasDocument, rebuild: boolean): void {
				super.importData(document, rebuild);
				this.imports += 1;
				if (this.imports !== 1) return;
				const existing = this.nodes.get("existing");
				if (existing !== undefined) existing.x = 999;
			}
		}
		const initial = initialDocument();
		const runtime = new GraphChangingHost(initial);
		const result = createCanvasAuthoring({ canvas: runtime }).createShape(action({ id: "must-rollback" }));
		expect(result.status).toBe("rejected");
		expect(runtime.requestSaveSpy).not.toHaveBeenCalled();
		expect(runtime.getData()).toEqual(initial);
	});

	it("rejects an unrecognized additive graph field as a concurrent host mutation", () => {
		class UnknownAddingHost extends NativeGraph {
			private imports = 0;

			public override importData(document: CanvasDocument, rebuild: boolean): void {
				super.importData(document, rebuild);
				this.imports += 1;
				if (this.imports === 1) this.nodes.get("existing")!.futureHostMutation = { unsafe: true };
			}
		}
		const initial = initialDocument();
		const runtime = new UnknownAddingHost(initial);
		const result = createCanvasAuthoring({ canvas: runtime }).createShape(action({ id: "must-rollback" }));
		expect(result.status).toBe("rejected");
		expect(result.diagnostics.find((item) => item.code === "native-import-verification-failed")?.message)
			.toContain("nodes existing gained futureHostMutation");
		expect(runtime.requestSaveSpy).not.toHaveBeenCalled();
		expect(runtime.getData()).toEqual(initial);
	});
});

/**
 * Obsidian 1.13.7's Canvas, as its own code behaves:
 *
 * - getData() spreads the root data it holds and lists nodes by z-index;
 * - importData() rebuilds nodes and edges only - root keys keep whatever the
 *   canvas held before - rounds node geometry and gives a new node the top
 *   z-index;
 * - an edge leaves out an end equal to the default (none at the start, an
 *   arrow at the end), and a node or edge leaves out an empty colour;
 * - requestSave() takes getData() as the new root data.
 */
class ObsidianCanvas {
	public data: CanvasDocument;
	public readonly nodes = new Map<string, { zIndex: number; fields: CanvasDocument }>();
	public readonly edges = new Map<string, CanvasDocument>();
	public readonly history: CanvasDocument[] = [];
	public readonly requestSaveSpy = vi.fn();
	private zIndexCounter = 0;

	public constructor(document: CanvasDocument) {
		this.data = clone(document);
		this.importData(clone(document), true);
		this.history.push(this.getData());
	}

	public getData(): CanvasDocument {
		const nodes = [...this.nodes.values()].sort((a, b) => a.zIndex - b.zIndex).map((node) => {
			const { color, ...rest } = node.fields;
			return clone({ ...rest, ...(color ? { color } : {}) });
		});
		const edges = [...this.edges.values()].map((edge) => {
			const { fromEnd, toEnd, color, label, ...rest } = edge;
			return clone({
				...rest,
				...(fromEnd !== undefined && fromEnd !== "none" ? { fromEnd } : {}),
				...(toEnd !== undefined && toEnd !== "arrow" ? { toEnd } : {}),
				...(color ? { color } : {}),
				...(label ? { label } : {}),
			});
		});
		return { ...clone(this.data), nodes, edges };
	}

	public importData(document: CanvasDocument, clear: boolean): void {
		const seen = new Set<string>();
		let last = 0;
		for (const item of document.nodes as CanvasDocument[]) {
			const id = String(item.id);
			let node = this.nodes.get(id);
			if (node === undefined) {
				node = { zIndex: -1, fields: {} };
				this.nodes.set(id, node);
			}
			const round = (value: unknown): unknown => typeof value === "number" ? Math.round(value) : value;
			node.fields = { ...clone(item), x: round(item.x), y: round(item.y), width: round(item.width), height: round(item.height) };
			seen.add(id);
			if (node.zIndex < last) node.zIndex = ++this.zIndexCounter;
			last = node.zIndex;
		}
		if (clear) for (const id of [...this.nodes.keys()]) if (!seen.has(id)) this.nodes.delete(id);
		const kept = new Set<string>();
		for (const item of document.edges as CanvasDocument[]) {
			const id = String(item.id);
			if (!this.nodes.has(String(item.fromNode)) || !this.nodes.has(String(item.toNode))) {
				this.edges.delete(id);
				continue;
			}
			this.edges.set(id, clone(item));
			kept.add(id);
		}
		if (clear) for (const id of [...this.edges.keys()]) if (!kept.has(id)) this.edges.delete(id);
	}

	public requestSave(addHistory?: boolean): void {
		this.requestSaveSpy(addHistory);
		this.data = this.getData();
		if (addHistory === true) this.history.push(clone(this.data));
	}
}

describe("Obsidian's own import semantics", () => {
	it("creates a connected node and its connector although import keeps the old root metadata", () => {
		const initial: CanvasDocument = {
			...endpointDocument(),
			miroCanvas: { schemaVersion: 1, localOverrides: { a: { rotation: 12 } } },
		};
		const canvas = new ObsidianCanvas(initial);
		const authoring = createCanvasAuthoring({ canvas });
		// Geometry off the pixel grid, as a node placed beside a rotated one gets.
		const shape = authoring.createShape(action({ id: "beside", x: 520.4, y: -0.6, width: 100.2, height: 79.7 }));
		expect(shape.status).toBe("applied");
		expect(shape.diagnostics.map((item) => item.code)).toContain("native-import-root-metadata-restored");
		const connector = authoring.createConnector({
			fromNode: "c", toNode: "beside",
			fromAnchor: { type: "node", nodeId: "c", u: 1, v: 0.5 },
		});
		expect(connector.status).toBe("applied");

		const data = canvas.getData();
		expect((data.nodes as CanvasDocument[]).find((node) => node.id === "beside"))
			.toMatchObject({ x: 520, y: -1, width: 100, height: 80 });
		// The host stores the default arrow end by leaving it out.
		expect((data.edges as CanvasDocument[]).find((edge) => edge.id === connector.edgeId))
			.toEqual({ id: connector.edgeId, fromNode: "c", fromSide: "right", toNode: "beside", toSide: "left" });
		expect(data).toHaveProperty("miroCanvas.localOverrides.beside.shape.kind", "diamond");
		expect(data).toHaveProperty("miroCanvas.localOverrides.a.rotation", 12);
		expect(data).toHaveProperty(`miroCanvas.localOverrides.${connector.edgeId}.connectorAnchors.from.u`, 1);
		expect(data.miroSource).toEqual(initial.miroSource);
		// One history entry per transaction, each carrying its metadata.
		expect(canvas.history).toHaveLength(3);
		expect(canvas.history[1]).toHaveProperty("miroCanvas.localOverrides.beside.shape.kind", "diamond");
	});

	it("names the field a host changed instead of refusing without a reason", () => {
		class TextRewritingCanvas extends ObsidianCanvas {
			public override importData(document: CanvasDocument, clear: boolean): void {
				super.importData(document, clear);
				const created = this.nodes.get("rewritten");
				if (created !== undefined) created.fields.text = "something else";
			}
		}
		const canvas = new TextRewritingCanvas(endpointDocument());
		const result = createCanvasAuthoring({ canvas }).createShape(action({ id: "rewritten" }));
		expect(result.status).toBe("rejected");
		expect(result.diagnostics.find((item) => item.code === "native-import-verification-failed")?.message)
			.toContain("(nodes rewritten changed text)");
		expect(canvas.getData().nodes).toHaveLength(3);
	});
});

describe("item creation", () => {
	function itemAction(overrides: Partial<CreateItemInput> = {}): CreateItemInput {
		return {
			item: { type: "sticky_note", color: "light_yellow" },
			x: 40,
			y: 60,
			width: 200,
			height: 200,
			...overrides,
		};
	}

	/** The result carries the whole document back, not the node by itself. */
	function nodeOf(document: Readonly<Record<string, unknown>> | undefined, id: string): CanvasDocument | undefined {
		return (document?.nodes as CanvasDocument[] | undefined)?.find((item) => item.id === id);
	}

	it("creates a sticky note as one rounded-geometry text node, keeps its colour in local overrides, and uses a single history step", () => {
		const runtime = new NativeGraph({ nodes: [], edges: [] });
		const authoring = createCanvasAuthoring(runtime);

		const result = authoring.createItem(itemAction({
			id: "sticky-1", x: 10.4, y: -0.6, width: 200.2, height: 199.7, text: "Idea",
		}));

		expect(result.ok).toBe(true);
		expect(result.status).toBe("applied");
		expect(result.nodeId).toBe("sticky-1");
		expect(nodeOf(result.document, "sticky-1")).toMatchObject({
			type: "text", x: 10, y: -1, width: 200, height: 200, text: "Idea",
		});
		expect(runtime.getData()).toHaveProperty("miroCanvas.localOverrides.sticky-1.item", { type: "sticky_note", color: "light_yellow" });
		// One native import and one history save, as createShape's own transaction does.
		expect(runtime.importDataSpy).toHaveBeenCalledTimes(1);
		expect(runtime.importDataSpy).toHaveBeenCalledWith(expect.any(Object), true);
		expect(runtime.requestSaveSpy).toHaveBeenCalledTimes(1);
		expect(runtime.requestSaveSpy).toHaveBeenCalledWith(true);
		expect(runtime.history).toHaveLength(2);
	});

	it("creates a frame as a group node carrying its label, and records the frame type in local overrides", () => {
		const runtime = new NativeGraph({ nodes: [], edges: [] });
		const authoring = createCanvasAuthoring(runtime);

		const result = authoring.createItem(itemAction({
			id: "frame-1", item: { type: "frame" }, label: "Sprint backlog", width: 640, height: 400,
		}));

		expect(result.ok).toBe(true);
		expect(nodeOf(result.document, "frame-1")).toMatchObject({ type: "group", label: "Sprint backlog" });
		expect(runtime.getData()).toHaveProperty("miroCanvas.localOverrides.frame-1.item", { type: "frame" });
	});

	it("creates a link node with its web address and no local override for it", () => {
		const runtime = new NativeGraph({ nodes: [], edges: [] });
		const authoring = createCanvasAuthoring(runtime);

		const result = authoring.createItem(itemAction({
			id: "link-1", item: { type: "link" }, url: "https://example.test/doc",
		}));

		expect(result.ok).toBe(true);
		expect(nodeOf(result.document, "link-1")).toMatchObject({ type: "link", url: "https://example.test/doc" });
		expect(runtime.getData()).not.toHaveProperty("miroCanvas.localOverrides.link-1");
	});

	it("rejects a link address that is not on the web, and imports nothing", () => {
		const runtime = new NativeGraph({ nodes: [], edges: [] });
		const authoring = createCanvasAuthoring(runtime);

		for (const url of ["javascript:alert(1)", "ftp://x"]) {
			expect(authoring.createItem(itemAction({ item: { type: "link" }, url })).ok).toBe(false);
		}
		expect(runtime.importDataSpy).not.toHaveBeenCalled();
		expect(runtime.getData().nodes).toEqual([]);
	});

	it("rejects a type the board tools do not make, a non-positive size, and a non-finite position, importing nothing", () => {
		const runtime = new NativeGraph({ nodes: [], edges: [] });
		const authoring = createCanvasAuthoring(runtime);

		expect(authoring.createItem(itemAction({ item: { type: "bogus" } as never })).ok).toBe(false);
		expect(authoring.createItem(itemAction({ width: 0 })).ok).toBe(false);
		expect(authoring.createItem(itemAction({ height: -10 })).ok).toBe(false);
		expect(authoring.createItem(itemAction({ x: Number.NaN })).ok).toBe(false);
		expect(authoring.createItem(itemAction({ y: Number.POSITIVE_INFINITY })).ok).toBe(false);
		expect(runtime.importDataSpy).not.toHaveBeenCalled();
		expect(runtime.getData().nodes).toEqual([]);
	});
});

describe("deleteItems", () => {
	function multiEdgeDocument(): CanvasDocument {
		return {
			nodes: [
				{ id: "a", type: "text", x: 0, y: 0, width: 100, height: 80, text: "A" },
				{ id: "b", type: "text", x: 200, y: 0, width: 100, height: 80, text: "B" },
				{ id: "c", type: "text", x: 400, y: 0, width: 100, height: 80, text: "C" },
			],
			edges: [
				{ id: "e1", fromNode: "a", toNode: "b" },
				{ id: "e2", fromNode: "b", toNode: "c" },
				{ id: "e3", fromNode: "a", toNode: "c" },
			],
			miroCanvas: {
				schemaVersion: 1,
				localOverrides: {
					b: { rotation: 34 },
					e1: { connectorAnchors: { from: { type: "free", x: 1, y: 2 } } },
				},
			},
		};
	}

	it("removes a node, every edge that ended on it, and its local overrides in one import and one history step", () => {
		const runtime = new NativeGraph(multiEdgeDocument());
		const authoring = createCanvasAuthoring(runtime);

		const result = authoring.deleteItems({ ids: ["b"] });

		expect(result.ok).toBe(true);
		expect(result.status).toBe("applied");
		const data = runtime.getData();
		expect((data.nodes as CanvasDocument[]).map((node) => node.id)).toEqual(["a", "c"]);
		expect((data.edges as CanvasDocument[]).map((edge) => edge.id)).toEqual(["e3"]);
		expect((data.miroCanvas as CanvasDocument).localOverrides).toEqual({});
		expect(runtime.importDataSpy).toHaveBeenCalledTimes(1);
		expect(runtime.importDataSpy).toHaveBeenCalledWith(expect.any(Object), true);
		expect(runtime.requestSaveSpy).toHaveBeenCalledTimes(1);
		expect(runtime.requestSaveSpy).toHaveBeenCalledWith(true);
		expect(runtime.history).toHaveLength(2);
	});

	it("rejects an id that does not exist and an empty id list, importing nothing", () => {
		const runtime = new NativeGraph(multiEdgeDocument());
		const authoring = createCanvasAuthoring(runtime);

		const missing = authoring.deleteItems({ ids: ["missing"] });
		expect(missing.ok).toBe(false);
		expect(missing.diagnostics.map((item) => item.code)).toContain("delete-node-missing");

		const empty = authoring.deleteItems({ ids: [] });
		expect(empty.ok).toBe(false);
		expect(empty.diagnostics.map((item) => item.code)).toContain("delete-ids-invalid");

		expect(runtime.importDataSpy).not.toHaveBeenCalled();
		expect(runtime.getData().nodes).toHaveLength(3);
	});

	it("deletes a drawing made with createItem along with its stroke override", () => {
		const runtime = new NativeGraph({ nodes: [], edges: [] });
		const authoring = createCanvasAuthoring(runtime);
		const stroke = { color: "#1a1a1a", width: 5, box: { width: 40, height: 20 }, points: [0, 0, 20, 10, 40, 20] };

		const created = authoring.createItem({
			item: { type: "drawing", stroke },
			x: 0, y: 0, width: 200, height: 200,
		});
		expect(created.ok).toBe(true);
		const id = created.nodeId!;
		expect(runtime.getData()).toHaveProperty(`miroCanvas.localOverrides.${id}.item.stroke`, stroke);

		const result = authoring.deleteItems({ ids: [id] });

		expect(result.ok).toBe(true);
		expect(runtime.getData().nodes).toEqual([]);
		expect(runtime.getData()).not.toHaveProperty(`miroCanvas.localOverrides.${id}`);
	});
});

describe("changeItems", () => {
	const STROKE = { color: "#1a1a1a", width: 4, box: { width: 100, height: 20 }, points: [0, 10, 100, 10] };
	function drawings(lockSecond = false): CanvasDocument {
		return {
			nodes: [
				{ id: "d1", type: "text", x: 0, y: 0, width: 100, height: 20, text: "" },
				{ id: "d2", type: "text", x: 0, y: 40, width: 100, height: 20, text: "" },
			],
			edges: [],
			miroCanvas: {
				schemaVersion: 1,
				localOverrides: {
					d1: { item: { type: "drawing", stroke: STROKE } },
					d2: { item: { type: "drawing", stroke: STROKE }, ...(lockSecond ? { locked: true } : {}) },
				},
			},
		};
	}

	it("trims one drawing and removes another in one import and one history step", () => {
		const runtime = new NativeGraph(drawings());
		const authoring = createCanvasAuthoring(runtime);
		const trimmed = { ...STROKE, points: [0, 10, 40, 10, 60, 10, 100, 10], breaks: [2] };

		const result = authoring.changeItems({ updates: [{ id: "d1", item: { type: "drawing", stroke: trimmed } }], removals: ["d2"] });

		expect(result.ok).toBe(true);
		const data = runtime.getData();
		expect((data.nodes as CanvasDocument[]).map((node) => node.id)).toEqual(["d1"]);
		const overrides = (data.miroCanvas as CanvasDocument).localOverrides as CanvasDocument;
		expect(Object.keys(overrides)).toEqual(["d1"]);
		expect((overrides.d1 as CanvasDocument).item).toEqual({ type: "drawing", stroke: trimmed });
		expect(runtime.importDataSpy).toHaveBeenCalledTimes(1);
		expect(runtime.history).toHaveLength(2);
	});

	it("refuses the whole change when any part of it is not allowed, and changes nothing", () => {
		const runtime = new NativeGraph(drawings(true));
		const authoring = createCanvasAuthoring(runtime);
		const before = JSON.stringify(runtime.getData());
		const trimmed = { ...STROKE, points: [0, 10, 40, 10] };

		const result = authoring.changeItems({ updates: [{ id: "d1", item: { type: "drawing", stroke: trimmed } }], removals: ["d2"] });

		expect(result.ok).toBe(false);
		expect(runtime.importDataSpy).not.toHaveBeenCalled();
		expect(JSON.stringify(runtime.getData())).toBe(before);
	});

	it("refuses an item named both to rewrite and to remove", () => {
		const runtime = new NativeGraph(drawings());
		const authoring = createCanvasAuthoring(runtime);
		const result = authoring.changeItems({ updates: [{ id: "d1", item: { type: "drawing", stroke: STROKE } }], removals: ["d1"] });
		expect(result.ok).toBe(false);
		expect(result.diagnostics.map((item) => item.code)).toContain("item-change-conflict");
		expect(runtime.importDataSpy).not.toHaveBeenCalled();
	});
});
