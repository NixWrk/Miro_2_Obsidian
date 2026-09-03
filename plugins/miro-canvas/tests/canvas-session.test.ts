import { describe, expect, it, vi } from "vitest";

import {
	inspectAdvancedCanvas,
	inspectCanvasView,
} from "../src/canvas-session";

describe("canvas session inspection", () => {
	it("reads an ordinary Canvas document without metadata or writes", () => {
		const document = { nodes: [], edges: [] };
		const before = JSON.parse(JSON.stringify(document));
		const getData = vi.fn(() => document);
		const setViewport = vi.fn();
		const requestRender = vi.fn();
		const requestSave = vi.fn();

		const result = inspectCanvasView({
			canvas: { getData, setViewport, requestRender, requestSave },
		});

		expect(result.adapter.status).toBe("ready");
		expect(result.adapter.capabilities).toContain("document");
		expect(result.metadata.status).toBe("absent");
		expect(result.metadata.diagnostics).toEqual([]);
		expect(getData).toHaveBeenCalledTimes(1);
		expect(setViewport).not.toHaveBeenCalled();
		expect(requestRender).not.toHaveBeenCalled();
		expect(requestSave).not.toHaveBeenCalled();
		expect(document).toEqual(before);
		expect(result.metadataRead.status).toBe("available");
	});

	it("accepts valid v1 metadata without creating or persisting defaults", () => {
		const document = {
			nodes: [],
			edges: [],
			miroCanvas: { schemaVersion: 1 },
		};
		const before = JSON.parse(JSON.stringify(document));
		const setViewport = vi.fn();
		const requestSave = vi.fn();
		const result = inspectCanvasView({
			canvas: {
				getData: () => document,
				setViewport,
				requestSave,
			},
		});

		expect(result.metadata.status).toBe("valid");
		expect(result.metadata.metadata?.schemaVersion).toBe(1);
		expect(result.metadata.diagnostics).toEqual([]);
		expect(setViewport).not.toHaveBeenCalled();
		expect(requestSave).not.toHaveBeenCalled();
		expect(document).toEqual(before);
		expect(result.metadataRead.status).toBe("available");
	});

	it("reports invalid and unsupported metadata states", () => {
		const invalid = inspectCanvasView({
			canvas: {
				data: {
					miroCanvas: {
						schemaVersion: 1,
						transform: { scale: 0, offsetX: 0, offsetY: 0 },
					},
				},
			},
		});
		const unsupported = inspectCanvasView({
			canvas: { data: { miroCanvas: { schemaVersion: 2 } } },
		});

		expect(invalid.metadata.status).toBe("invalid");
		expect(invalid.metadata.diagnostics.length).toBeGreaterThan(0);
		expect(unsupported.metadata.status).toBe("unsupported");
		expect(unsupported.metadata.sourceVersion).toBe(2);
	});

	it("fails closed when a native document getter is incompatible", () => {
		const runtime: Record<string, unknown> = {};
		Object.defineProperty(runtime, "getData", {
			get: () => {
				throw new Error("Canvas internals changed");
			},
		});

		const result = inspectCanvasView({ canvas: runtime });

		expect(result.adapter.status).toBe("incompatible");
		expect(result.metadata.status).toBe("invalid");
		expect(result.metadataRead.status).toBe("unavailable");
		expect(result.metadataReadError?.code).toBe("canvas-document-unavailable");
		expect(result.metadata.diagnostics.some((item) => item.code === "metadata-document-unavailable")).toBe(true);
		expect(result.adapter.diagnostics.some((item) => item.code === "native-probe-failed")).toBe(true);
	});
});

describe("optional Advanced Canvas inspection", () => {
	it("reports an absent optional plugin without failing", () => {
		const result = inspectAdvancedCanvas({
			plugins: { getPlugin: vi.fn(() => undefined) },
		});

		expect(result.status).toBe("absent");
		expect(result.present).toBe(false);
		expect(result.available).toBe(false);
	});

	it("disables only an incompatible optional plugin", () => {
		const result = inspectAdvancedCanvas({
			plugin: {
				manifest: { id: "advanced-canvas", version: "future" },
			},
		});

		expect(result.status).toBe("incompatible");
		expect(result.present).toBe(true);
		expect(result.available).toBe(false);
		expect(result.compatible).toBe(false);
	});
});
