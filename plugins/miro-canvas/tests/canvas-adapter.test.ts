import { describe, expect, it, vi } from "vitest";

import {
	CANVAS_CAPABILITIES,
	CanvasAdapter,
	createCanvasAdapter,
} from "../src/canvas-adapter";

function revokedProxy<T extends object>(value: T): T {
	const revocable = Proxy.revocable(value, {});
	revocable.revoke();
	return revocable.proxy;
}

describe("CanvasAdapter", () => {
	it("exposes only recognised capabilities for a valid native runtime", () => {
		const node = { id: "node-1" };
		const edge = { id: "edge-1" };
		const runtime = {
			wrapperEl: { dataset: { canvas: "native" } },
			nodes: new Map([[node.id, node]]),
			edges: new Set([edge]),
			viewport: { x: -100, y: 40, zoom: 2, width: 800, height: 600 },
			selection: new Set([node]),
			setViewport: vi.fn(),
			requestRender: vi.fn(),
			requestSave: vi.fn(),
		};

		const adapter = createCanvasAdapter({ canvas: runtime });

		expect(adapter.status).toBe("ready");
		expect(adapter.available).toBe(true);
		expect(adapter.supports(CANVAS_CAPABILITIES.scene)).toBe(true);
		expect(adapter.supports(CANVAS_CAPABILITIES.viewport)).toBe(true);
		expect(adapter.getNodes()).toEqual([node]);
		expect(adapter.getEdges()).toEqual([edge]);
		expect(adapter.getSelection()).toEqual([node]);
		expect(adapter.getViewport()).toMatchObject({
			x: -100,
			y: 40,
			zoom: 2,
			width: 800,
			height: 600,
		});
		expect(adapter.getRootElement()).toBe(runtime.wrapperEl);
		expect(adapter.setViewport({ x: 1, y: 2, zoom: 1 })).toBe(true);
		expect(runtime.setViewport).toHaveBeenCalledWith({ x: 1, y: 2, zoom: 1 });
		expect(adapter.requestRender()).toBe(true);
		expect(adapter.requestSave()).toBe(true);
		expect(adapter.diagnostics).toEqual([]);
	});

	it("returns false when a mutating or cleanup operation throws", () => {
		const runtime = {
			setViewport: vi.fn(() => {
				throw new Error("viewport API moved");
			}),
			requestRender: vi.fn(() => {
				throw new Error("render API moved");
			}),
			requestSave: vi.fn(() => {
				throw new Error("save API moved");
			}),
			on: vi.fn(),
			off: vi.fn(() => {
				throw new Error("event API moved");
			}),
		};
		const adapter = new CanvasAdapter({ canvas: runtime });

		expect(adapter.setViewport({ x: 1, y: 2, zoom: 1 })).toBe(false);
		expect(adapter.requestRender()).toBe(false);
		expect(adapter.requestSave()).toBe(false);
		expect(adapter.off("canvas-change", vi.fn())).toBe(false);
		expect(adapter.diagnostics.filter((item) => item.code === "native-operation-failed")).toHaveLength(4);
	});

	it("fails closed for throwing array values and bounds hostile iterators", () => {
		const throwingNodes: unknown[] = [];
		Object.defineProperty(throwingNodes, "0", {
			configurable: true,
			get: () => {
				throw new Error("node collection changed");
			},
		});
		throwingNodes.length = 1;
		const throwingAdapter = new CanvasAdapter({ canvas: { nodes: throwingNodes } });

		expect(() => throwingAdapter.getNodes()).not.toThrow();
		expect(throwingAdapter.getNodes()).toBeUndefined();
		expect(throwingAdapter.diagnostics.some((item) => item.code === "native-probe-failed")).toBe(true);

		let nextCalls = 0;
		const infiniteValues = {
			values: () => ({
				next: () => {
					nextCalls += 1;
					return { done: false, value: nextCalls };
				},
			}),
		};
		const boundedAdapter = new CanvasAdapter({ canvas: { nodes: infiniteValues } });

		let boundedNodes: readonly unknown[] | undefined;
		expect(() => {
			boundedNodes = boundedAdapter.getNodes();
		}).not.toThrow();
		expect(boundedNodes).toBeUndefined();
		expect(nextCalls).toBeLessThanOrEqual(100_000);
		expect(boundedAdapter.diagnostics.some((item) => item.code === "native-collection-limit-reached")).toBe(true);
	});

	it("starts safely when no native view is available", () => {
		const adapter = new CanvasAdapter(undefined);

		expect(adapter.status).toBe("unavailable");
		expect(adapter.available).toBe(false);
		expect(adapter.disabled).toBe(true);
		expect(adapter.getNodes()).toBeUndefined();
		expect(adapter.diagnostics.some((item) => item.code === "native-canvas-missing")).toBe(true);
	});

	it("fails closed for a changed or unrecognised native shape", () => {
		const adapter = new CanvasAdapter({ canvas: {} });

		expect(adapter.status).toBe("incompatible");
		expect(adapter.available).toBe(false);
		expect(adapter.compatible).toBe(false);
		expect(adapter.diagnostics.some((item) => item.code === "native-canvas-incompatible")).toBe(true);
	});

	it("turns throwing private getters into diagnostics instead of exceptions", () => {
		const runtime = {} as Record<string, unknown>;
		Object.defineProperty(runtime, "viewport", {
			get: () => {
				throw new Error("private field changed");
			},
		});

		const adapter = new CanvasAdapter({ canvas: runtime });

		expect(() => adapter.getViewport()).not.toThrow();
		expect(adapter.diagnostics.some((item) => item.code === "native-probe-failed")).toBe(true);
	});

	it("fails closed when collection brand checks see revoked or hostile Proxies", () => {
		const hostilePrototype = new Proxy({}, {
			getPrototypeOf: () => {
				throw new Error("prototype trap");
			},
		});
		const adapter = new CanvasAdapter({
			canvas: {
				nodes: revokedProxy([]),
				edges: revokedProxy(new Map()),
				selection: hostilePrototype,
			},
		});

		let values: readonly unknown[] | undefined;
		expect(() => {
			adapter.getNodes();
			adapter.getEdges();
			values = adapter.getSelection();
		}).not.toThrow();
		expect(values).toBeUndefined();
		expect(adapter.diagnostics.some((item) => item.code === "native-probe-failed")).toBe(true);
	});

	it("keeps every public operation safe after the native runtime is revoked", () => {
		const runtime = revokedProxy({
			requestSave: () => true,
		});
		const adapter = new CanvasAdapter({ canvas: runtime });
		const revokedOptions = revokedProxy({
			requiredCapabilities: [CANVAS_CAPABILITIES.document],
		});
		const optionAdapter = new CanvasAdapter({ canvas: { nodes: [] } }, revokedOptions);

		expect(() => {
			adapter.read("missing");
			adapter.invoke("missing");
			adapter.getRootElement();
			adapter.getNodes();
			adapter.getEdges();
			adapter.getScene();
			adapter.getDocument();
			adapter.getViewport();
			adapter.setViewport(revokedProxy({ zoom: 1 }));
			adapter.getSelection();
			adapter.requestRender();
			adapter.requestSave();
			adapter.on("canvas-change", vi.fn());
			adapter.off("canvas-change", vi.fn());
			optionAdapter.getNodes();
		}).not.toThrow();
		expect(adapter.diagnostics.some((item) => item.code === "native-probe-failed")).toBe(true);
		expect(optionAdapter.diagnostics.some((item) => item.code === "native-probe-failed")).toBe(true);
	});

	it("does not let a hostile thrown Proxy break error diagnostics", () => {
		const thrown = revokedProxy({});
		const adapter = new CanvasAdapter({
			canvas: {
				requestSave: () => {
					throw thrown;
				},
			},
		});

		expect(() => adapter.requestSave()).not.toThrow();
		expect(adapter.diagnostics.some((item) => item.code === "native-operation-failed")).toBe(true);
	});

	it("reports required capabilities without making startup throw", () => {
		const adapter = new CanvasAdapter(
			{ canvas: { nodes: [] } },
			{ requiredCapabilities: [CANVAS_CAPABILITIES.viewportMutation] },
		);

		expect(adapter.available).toBe(true);
		expect(adapter.supports(CANVAS_CAPABILITIES.viewportMutation)).toBe(false);
		expect(adapter.diagnostics.some((item) => item.capability === CANVAS_CAPABILITIES.viewportMutation)).toBe(true);
	});

	it("reads the native document through getData before the data field", () => {
		const document = { nodes: [{ id: "node" }], edges: [], miroCanvas: { schemaVersion: 1 } };
		const getData = vi.fn(() => document);
		const adapter = new CanvasAdapter({ canvas: { getData, data: { stale: true } } });

		expect(adapter.status).toBe("ready");
		expect(adapter.supports(CANVAS_CAPABILITIES.document)).toBe(true);
		expect(adapter.getDocument()).toBe(document);
		expect(getData).toHaveBeenCalledTimes(1);
		expect(adapter.diagnostics).toEqual([]);
	});

	it("falls back to the compatible data field when getData is absent", () => {
		const document = { nodes: [], edges: [] };
		const adapter = createCanvasAdapter({ canvas: { data: document } });

		expect(adapter.supports(CANVAS_CAPABILITIES.document)).toBe(true);
		expect(adapter.getDocument()).toBe(document);
	});

	it("fails closed with a diagnostic when the document getter is missing or throws", () => {
		const missing = new CanvasAdapter({ canvas: { nodes: [] } });
		expect(missing.getDocument()).toBeUndefined();
		expect(missing.diagnostics.some((item) => item.capability === CANVAS_CAPABILITIES.document)).toBe(true);

		const runtime = {} as Record<string, unknown>;
		Object.defineProperty(runtime, "getData", {
			get: () => {
				throw new Error("document method moved");
			},
		});
		const broken = new CanvasAdapter({ canvas: runtime });

		expect(() => broken.getDocument()).not.toThrow();
		expect(broken.getDocument()).toBeUndefined();
		expect(broken.diagnostics.some((item) => item.code === "native-probe-failed")).toBe(true);
	});
});
