import { describe, expect, it, vi } from "vitest";

import {
	ADVANCED_CANVAS_CAPABILITIES,
	AdvancedCanvasAdapter,
	createAdvancedCanvasAdapter,
} from "../src/advanced-canvas-adapter";

function revokedProxy<T extends object>(value: T): T {
	const revocable = Proxy.revocable(value, {});
	revocable.revoke();
	return revocable.proxy;
}

describe("AdvancedCanvasAdapter", () => {
	it("is quietly absent when the optional plugin is not installed", () => {
		const adapter = createAdvancedCanvasAdapter({
			plugins: { getPlugin: vi.fn(() => undefined) },
		});

		expect(adapter.status).toBe("absent");
		expect(adapter.present).toBe(false);
		expect(adapter.available).toBe(false);
		expect(adapter.compatible).toBe(true);
		expect(adapter.disabled).toBe(true);
		expect(adapter.diagnostics.some((item) => item.code === "advanced-canvas-absent")).toBe(true);
	});

	it("detects a present plugin through the app registry and reads compatible data", () => {
		const listener = vi.fn();
		const unsubscribe = vi.fn();
		const off = vi.fn();
		const plugin = {
			manifest: { id: "advanced-canvas", version: "6.0.1" },
			metadata: { showMinimap: true },
			events: {
				on: vi.fn(() => unsubscribe),
				off,
			},
		};
		const getPlugin = vi.fn((id: string) => (id === "advanced-canvas" ? plugin : undefined));
		const adapter = createAdvancedCanvasAdapter({ plugins: { getPlugin } });

		expect(adapter.status).toBe("ready");
		expect(adapter.present).toBe(true);
		expect(adapter.available).toBe(true);
		expect(adapter.version).toBe("6.0.1");
		expect(adapter.supports(ADVANCED_CANVAS_CAPABILITIES.metadata)).toBe(true);
		expect(adapter.supports(ADVANCED_CANVAS_CAPABILITIES.events)).toBe(true);
		expect(adapter.getMetadata()).toEqual({ showMinimap: true });

		const dispose = adapter.on("canvas-change", listener);
		expect(dispose).toBeTypeOf("function");
		dispose?.();
		expect(plugin.events.on).toHaveBeenCalledWith("canvas-change", listener);
		// Event APIs that return an unsubscribe callback own the callback's
		// signature; disposing it must not pass the registration arguments again.
		expect(unsubscribe).toHaveBeenCalledTimes(1);
		expect(unsubscribe.mock.calls[0]).toEqual([]);
		expect(off).not.toHaveBeenCalled();
	});

	it("falls back to event removal when registration returns no disposer", () => {
		const listener = vi.fn();
		const off = vi.fn();
		const plugin = {
			manifest: { id: "advanced-canvas" },
			metadata: {},
			events: { on: vi.fn(), off },
		};
		const adapter = createAdvancedCanvasAdapter({ plugin });

		const dispose = adapter.on("canvas-change", listener);
		dispose?.();

		expect(plugin.events.on).toHaveBeenCalledWith("canvas-change", listener);
		expect(off).toHaveBeenCalledWith("canvas-change", listener);
	});

	it("returns false when optional event/control mutations throw", () => {
		const adapter = createAdvancedCanvasAdapter({
			plugin: {
				manifest: { id: "advanced-canvas" },
				registerControl: vi.fn(() => {
					throw new Error("control API moved");
				}),
				events: {
					on: vi.fn(),
					off: vi.fn(() => {
						throw new Error("event API moved");
					}),
				},
			},
		});
		const listener = vi.fn();

		expect(adapter.registerControl("minimap", {})).toBe(false);
		expect(adapter.off("canvas-change", listener)).toBe(false);
		expect(adapter.diagnostics.filter((item) => item.code === "advanced-operation-failed")).toHaveLength(2);
	});

	it("disables only optional integration for an incompatible plugin", () => {
		const adapter = createAdvancedCanvasAdapter({
			plugin: { manifest: { id: "advanced-canvas", version: "future" } },
		});

		expect(adapter.status).toBe("incompatible");
		expect(adapter.available).toBe(false);
		expect(adapter.compatible).toBe(false);
		expect(adapter.diagnostics.some((item) => item.code === "advanced-canvas-incompatible")).toBe(true);
		expect(() => adapter.getMetadata()).not.toThrow();
	});

	it("does not throw while probing a getter from a changed optional API", () => {
		const plugin = {} as Record<string, unknown>;
		Object.defineProperty(plugin, "metadata", {
			get: () => {
				throw new Error("metadata moved");
			},
		});
		Object.defineProperty(plugin, "manifest", {
			value: { id: "advanced-canvas", version: "next" },
		});

		const adapter = new AdvancedCanvasAdapter(plugin);

		expect(() => AdvancedCanvasAdapter.probe(plugin)).not.toThrow();
		expect(adapter.status).toBe("incompatible");
		expect(adapter.diagnostics.some((item) => item.code === "advanced-probe-failed")).toBe(true);
	});

	it("does not call an unsafe array iterator while locating enabled plugins", () => {
		const enabledPlugins: unknown[] = [];
		Object.defineProperty(enabledPlugins, "0", {
			configurable: true,
			get: () => {
				throw new Error("plugin collection changed");
			},
		});
		enabledPlugins.length = 1;

		expect(() =>
			new AdvancedCanvasAdapter({
				plugins: { enabledPlugins },
			}),
		).not.toThrow();
		const probe = AdvancedCanvasAdapter.probe({ plugins: { enabledPlugins } });
		expect(probe.status).toBe("absent");
		expect(probe.diagnostics.some((item) => item.code === "advanced-probe-failed")).toBe(true);
	});

	it("fails closed when enabled-plugin collections are revoked or trap on instanceof", () => {
		const hostilePrototype = new Proxy({}, {
			getPrototypeOf: () => {
				throw new Error("prototype trap");
			},
		});
		const sources = [
			{ plugins: { enabledPlugins: revokedProxy([]) } },
			{ plugins: { enabledPlugins: revokedProxy(new Set()) } },
			{ plugins: { enabledPlugins: hostilePrototype } },
		];

		for (const source of sources) {
			let probe: ReturnType<typeof AdvancedCanvasAdapter.probe> | undefined;
			expect(() => {
				probe = AdvancedCanvasAdapter.probe(source);
			}).not.toThrow();
			expect(probe?.diagnostics.some((item) => item.code === "advanced-probe-failed")).toBe(true);
		}
	});

	it("keeps control checks safe for revoked collections and preserves Set/Map behavior", () => {
		const revokedControls = revokedProxy(new Set(["minimap"]));
		const revokedAdapter = new AdvancedCanvasAdapter({
			plugin: { manifest: { id: "advanced-canvas" }, controls: revokedControls },
		});
		const setAdapter = new AdvancedCanvasAdapter({
			plugin: { manifest: { id: "advanced-canvas" }, controls: new Set(["minimap"]) },
		});
		const mapAdapter = new AdvancedCanvasAdapter({
			plugin: { manifest: { id: "advanced-canvas" }, controls: new Map([["minimap", {}]]) },
		});

		expect(() => revokedAdapter.hasControl("minimap")).not.toThrow();
		expect(revokedAdapter.hasControl("minimap")).toBe(false);
		expect(revokedAdapter.diagnostics.some((item) => item.code === "advanced-probe-failed")).toBe(true);
		expect(setAdapter.hasControl("minimap")).toBe(true);
		expect(mapAdapter.hasControl("minimap")).toBe(true);
	});

	it("keeps every public operation safe after the optional plugin is revoked", () => {
		const plugin = revokedProxy({ manifest: { id: "advanced-canvas" } });
		const adapter = new AdvancedCanvasAdapter({ plugin });
		const revokedOptions = revokedProxy({ pluginId: "advanced-canvas", plugin });
		const optionAdapter = new AdvancedCanvasAdapter({}, revokedOptions);

		expect(() => {
			adapter.read("missing");
			adapter.invoke("missing");
			adapter.readMetadata();
			adapter.getMetadata();
			adapter.on("canvas-change", vi.fn());
			adapter.off("canvas-change", vi.fn());
			adapter.hasControl("minimap");
			adapter.registerControl("minimap", {});
			optionAdapter.readMetadata();
			optionAdapter.hasControl("minimap");
		}).not.toThrow();
		expect(adapter.diagnostics.some((item) => item.code === "advanced-probe-failed")).toBe(true);
		expect(optionAdapter.diagnostics.some((item) => item.code === "advanced-probe-failed")).toBe(true);
	});

	it("does not let a hostile thrown Proxy break optional-plugin diagnostics", () => {
		const thrown = revokedProxy({});
		const adapter = new AdvancedCanvasAdapter({
			plugin: {
				manifest: { id: "advanced-canvas" },
				registerControl: () => {
					throw thrown;
				},
			},
		});

		expect(() => adapter.registerControl("minimap", {})).not.toThrow();
		expect(adapter.diagnostics.some((item) => item.code === "advanced-operation-failed")).toBe(true);
	});
});
