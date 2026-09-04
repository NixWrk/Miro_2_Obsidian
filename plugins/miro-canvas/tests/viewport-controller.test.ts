import { describe, expect, it, vi } from "vitest";

import {
	CANVAS_CAPABILITIES,
} from "../src/canvas-adapter";
import {
	DEFAULT_MIN_ZOOM,
	ViewportController,
	createViewportController,
	probeViewportController,
} from "../src/viewport-controller";

function runtimeWithViewport(initial = { x: 0, y: 0, zoom: 1, width: 800, height: 600 }) {
	let viewport = { ...initial };
	const setViewport = vi.fn((next: typeof viewport) => {
		viewport = { ...next };
		return true;
	});
	return {
		runtime: {
		getViewport: vi.fn(() => viewport),
		setViewport,
	},
		get viewport() {
			return viewport;
		},
		setViewport,
	};
}

describe("ViewportController", () => {
	it("probes a native viewport without writing while it is constructed", () => {
		const fixture = runtimeWithViewport();
		const controller = createViewportController(fixture.runtime);

		expect(controller.status).toBe("ready");
		expect(controller.capabilities).toContain(CANVAS_CAPABILITIES.viewport);
		expect(controller.capabilities).toContain(CANVAS_CAPABILITIES.viewportMutation);
		expect(fixture.setViewport).not.toHaveBeenCalled();
		expect(controller.getViewport()).toMatchObject({ x: 0, y: 0, zoom: 1 });
	});

	it("supports a wide zoom range and clamps zoom in/out/reset", () => {
		const fixture = runtimeWithViewport({ x: 0, y: 0, zoom: 1, width: 800, height: 600 });
		const controller = new ViewportController(fixture.runtime);

		expect(controller.zoomOut(100)).toBe(true);
		expect(fixture.viewport.zoom).toBe(DEFAULT_MIN_ZOOM);
		expect(controller.zoomIn(100)).toBe(true);
		expect(fixture.viewport.zoom).toBe(controller.maxZoom);
		expect(controller.resetZoom()).toBe(true);
		expect(fixture.viewport.zoom).toBe(1);
	});

	it("keeps a cursor anchor stationary while zooming", () => {
		const fixture = runtimeWithViewport({ x: 0, y: 0, zoom: 1, width: 800, height: 600 });
		const controller = new ViewportController(fixture.runtime);

		// The board point at screen (600, 300) is (600, 300) before zoom.
		expect(controller.zoomTo(2, { x: 600, y: 300 })).toBe(true);
		expect(fixture.viewport).toMatchObject({ x: -600, y: -300, zoom: 2 });
	});

	it("fits content and preserves the native transform contract", () => {
		const fixture = runtimeWithViewport({ x: 0, y: 0, zoom: 1, width: 1000, height: 800 });
		const controller = new ViewportController(fixture.runtime, { fitPadding: 0 });

		expect(controller.fitToBounds({ x: -100, y: -50, width: 200, height: 100 })).toBe(true);
		expect(fixture.viewport).toMatchObject({ zoom: 5, x: 500, y: 400 });
	});

	it("handles pan and plain/modified wheel without touching persistence", () => {
		const fixture = runtimeWithViewport({ x: 0, y: 0, zoom: 1, width: 800, height: 600 });
		const requestSave = vi.fn();
		const controller = new ViewportController({ ...fixture.runtime, requestSave });

		expect(controller.panBy(10, 20)).toBe(true);
		expect(fixture.viewport).toMatchObject({ x: 10, y: 20, zoom: 1 });
		expect(controller.handleWheel({ deltaX: 5, deltaY: 10 })).toBe(true);
		expect(fixture.viewport).toMatchObject({ x: 15, y: 30, zoom: 1 });
		expect(controller.handleWheel({ deltaY: -240, ctrlKey: true, offsetX: 400, offsetY: 300 })).toBe(true);
		expect(fixture.viewport.zoom).toBe(2);
		expect(requestSave).not.toHaveBeenCalled();
	});

	it("uses the native tx/ty center camera and log2 zoom contract", () => {
		class NativeCanvas {
			tx = 10;
			ty = 20;
			tZoom = 0;
			// Native Canvas stores zoom as tZoom (log2); scale is linear.
			zoom = 0;
			scale = 1;
			canvasRect = { width: 800, height: 600 };
			setViewport(tx: number, ty: number, tZoom: number): void {
				this.tx = tx;
				this.ty = ty;
				this.tZoom = tZoom;
				this.zoom = tZoom;
				this.scale = 2 ** tZoom;
			}
		}

		const runtime = new NativeCanvas();
		const controller = createViewportController(runtime, { fitPadding: 0 });
		expect(controller.coordinateMode).toBe("center");
		expect(controller.getViewport()).toMatchObject({ x: 10, y: 20, zoom: 1 });
		expect(controller.panBy(80, 40)).toBe(true);
		expect(runtime.tx).toBe(90);
		expect(runtime.ty).toBe(60);
		expect(controller.zoomOut(100)).toBe(true);
		expect(runtime.tZoom).toBe(-4);
		expect(runtime.zoom).toBe(-4);
		expect(runtime.scale).toBe(2 ** -4);
		expect(controller.zoomIn(100)).toBe(true);
		expect(runtime.tZoom).toBe(1);
		expect(runtime.zoom).toBe(1);
		expect(runtime.scale).toBe(2);
		expect(controller.fitToBounds({ x: -100, y: -50, width: 200, height: 100 }, { width: 1000, height: 800 })).toBe(true);
		expect(runtime.tx).toBe(0);
		expect(runtime.ty).toBe(0);
		expect(runtime.zoom).toBe(1);
		expect(runtime.scale).toBe(2);
		controller.dispose();
		expect(controller.available).toBe(false);
	});

	it("keeps capability probing read-only for a native camera", () => {
		class NativeCanvas {
			tx = 0;
			ty = 0;
			tZoom = 0;
			zoom = 0;
			setViewport(): void { /* native shape only */ }
		}
		const runtime = new NativeCanvas();
		const original = NativeCanvas.prototype.setViewport;
		const probe = probeViewportController(runtime);
		expect(probe.available).toBe(true);
		expect(NativeCanvas.prototype.setViewport).toBe(original);
		expect(runtime.setViewport).toBe(original);
	});

	it("fails closed for absent, read-only, invalid, and revoked runtimes", () => {
		const absent = probeViewportController(undefined);
		expect(absent.available).toBe(false);
		expect(new ViewportController(undefined).zoomIn()).toBe(false);

		const readOnly = new ViewportController({ getViewport: () => ({ x: 0, y: 0, zoom: 1 }) });
		expect(readOnly.status).not.toBe("ready");
		expect(readOnly.panBy(1, 1)).toBe(false);

		const invalid = runtimeWithViewport({ x: Number.NaN, y: 0, zoom: 1, width: 800, height: 600 });
		const invalidController = new ViewportController(invalid.runtime);
		expect(invalidController.getViewport()).toBeUndefined();
		expect(invalidController.zoomIn()).toBe(false);

		const revocable = Proxy.revocable({ getViewport: () => ({ x: 0, y: 0, zoom: 1 }), setViewport: vi.fn() }, {});
		revocable.revoke();
		const revokedController = new ViewportController(revocable.proxy);
		expect(() => {
			revokedController.getViewport();
			revokedController.zoomIn();
			revokedController.handleWheel({ deltaY: 1 });
		}).not.toThrow();
		expect(revokedController.available).toBe(false);
	});
});
