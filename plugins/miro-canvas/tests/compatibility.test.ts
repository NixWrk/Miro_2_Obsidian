import { describe, expect, it, vi } from "vitest";

import {
	COMPATIBILITY_MODES,
	runCompatibilityMatrix,
	runCompatibilityScenario,
	type CompatibilityFixture,
} from "../src/compatibility";

function fixture(): CompatibilityFixture {
	const document = {
		nodes: [{ id: "node-1", type: "text", text: "native" }],
		edges: [],
		miroCanvas: {
			schemaVersion: 1,
			unknownFutureField: { keep: [1, 2, 3] },
		},
		advancedUnknownDocumentField: {
			array: ["a", { b: true }],
		},
	};
	const advancedMetadata = {
		version: 7,
		unknownAdvancedField: { keep: "byte-for-byte" },
	};
	const advancedPlugin = {
		manifest: { id: "advanced-canvas", version: "6.0.1" },
		metadata: advancedMetadata,
		controls: new Map([["advanced-canvas.minimap", { id: "advanced-canvas.minimap" }]]),
	};
	const runtime = {
		wrapperEl: { dataset: { canvas: "native" } },
		getData: vi.fn(() => document),
		nodes: new Map([["node-1", document.nodes[0]]]),
		edges: new Set(),
		viewport: { x: -10, y: 25, zoom: 1.5 },
		selection: new Set([document.nodes[0]]),
	};
	return {
		nativeView: { canvas: runtime },
		advancedPlugin,
		miroCanvasControls: ["miro-canvas.status"],
	};
}

describe("compatibility matrix", () => {
	it("runs all four M0 modes without changing Canvas or Advanced metadata bytes", () => {
		const report = runCompatibilityMatrix(fixture());

		expect(report.modes).toEqual([
			COMPATIBILITY_MODES.nativeOnly,
			COMPATIBILITY_MODES.miroCanvasOnly,
			COMPATIBILITY_MODES.advancedCanvasOnly,
			COMPATIBILITY_MODES.bothPlugins,
		]);
		expect(report.passed).toBe(true);
		expect(report.hasDegradedScenarios).toBe(false);
		expect(report.diagnostics).toEqual([]);

		for (const scenario of report.scenarios) {
			expect(scenario.status).toBe("pass");
			expect(scenario.passed).toBe(true);
			expect(scenario.coreOperational).toBe(true);
			expect(scenario.native.documentReadable).toBe(true);
			expect(scenario.native.documentByteEquivalent).toBe(true);
			expect(scenario.native.unknownMetadataByteEquivalent).toBe(true);
			if (
				scenario.mode === COMPATIBILITY_MODES.nativeOnly ||
				scenario.mode === COMPATIBILITY_MODES.miroCanvasOnly
			) {
				expect(scenario.advanced.metadataByteEquivalent).toBe("unknown");
			} else {
				expect(scenario.advanced.metadataByteEquivalent).toBe(true);
			}
			expect(scenario.ownership.duplicateControlIds).toEqual([]);
			expect(scenario.consoleErrors).toEqual([]);
			expect(scenario.executionErrors).toEqual([]);
		}

		const advanced = report.scenarios.find(
				(scenario) => scenario.mode === COMPATIBILITY_MODES.advancedCanvasOnly,
			);
		expect(advanced?.advanced.metadataReadable).toBe(true);
		expect(advanced?.advanced.metadataBytesBefore).toBe(advanced?.advanced.metadataBytesAfter);
		expect(advanced?.advanced.optionalIntegrationDisabled).toBe(false);
	});

	it("reports duplicate control ownership only when both integrations claim one", () => {
		const report = runCompatibilityMatrix({
			...fixture(),
			miroCanvasControls: ["shared-control"],
			advancedCanvasControls: ["shared-control", "advanced-only-control"],
		});

		const both = report.scenarios.find(
			(scenario) => scenario.mode === COMPATIBILITY_MODES.bothPlugins,
		);
		expect(report.passed).toBe(false);
		expect(both?.status).toBe("fail");
		expect(both?.passed).toBe(false);
		expect(both?.ownership.duplicateControlIds).toEqual(["shared-control"]);
		expect(both?.diagnostics.some((item) => item.code === "duplicate-control-ownership")).toBe(true);
	});

	it("degrades optional Advanced integration without blocking native Canvas", () => {
		const report = runCompatibilityMatrix({
			nativeView: fixture().nativeView,
		});

		const advanced = report.scenarios.find(
			(scenario) => scenario.mode === COMPATIBILITY_MODES.advancedCanvasOnly,
		);
		expect(report.passed).toBe(true);
		expect(report.hasDegradedScenarios).toBe(true);
		expect(advanced?.status).toBe("degraded");
		expect(advanced?.coreOperational).toBe(true);
		expect(advanced?.optionalIntegrationGraceful).toBe(true);
		expect(advanced?.advanced.status).toBe("absent");
		expect(advanced?.advanced.optionalIntegrationDisabled).toBe(true);
		expect(advanced?.advanced.metadataByteEquivalent).toBe("unknown");
	});

	it("degrades an incompatible optional plugin and keeps the native report usable", () => {
		const report = runCompatibilityMatrix({
			nativeView: fixture().nativeView,
			advancedPlugin: { manifest: { id: "advanced-canvas", version: "future" } },
		});

		const both = report.scenarios.find(
			(scenario) => scenario.mode === COMPATIBILITY_MODES.bothPlugins,
		);
		expect(report.passed).toBe(true);
		expect(both?.status).toBe("degraded");
		expect(both?.coreOperational).toBe(true);
		expect(both?.optionalIntegrationGraceful).toBe(true);
		expect(both?.advanced.status).toBe("incompatible");
		expect(both?.advanced.optionalIntegrationDisabled).toBe(true);
		expect(both?.advanced.metadataByteEquivalent).toBe("unknown");
		expect(both?.diagnostics.some((item) => item.code === "advanced-integration-disabled")).toBe(true);
	});

	it("allows bytes to change only when the caller supplies an explicit mutation", () => {
		const scenario = runCompatibilityScenario(
			COMPATIBILITY_MODES.miroCanvasOnly,
			fixture(),
			{
				explicitMutation: ({ document }) => {
					(document as { miroCanvas: { explicit: boolean } }).miroCanvas.explicit = true;
				},
			},
		);

		expect(scenario.native.documentByteEquivalent).toBe(false);
		expect(scenario.native.unknownMetadataByteEquivalent).toBe(false);
		expect(scenario.advanced.metadataByteEquivalent).toBe("unknown");
		expect(scenario.diagnostics.some((item) => item.code === "document-mutated-during-read")).toBe(false);
		expect(scenario.passed).toBe(true);
	});

	it("reacquires detached native snapshots after read-only probes", () => {
		const firstDocument = {
			nodes: [],
			edges: [],
			miroCanvas: { schemaVersion: 1, revision: 1 },
		};
		const secondDocument = {
			nodes: [],
			edges: [],
			miroCanvas: { schemaVersion: 1, revision: 2 },
		};
		let reads = 0;
		const getData = vi.fn(() => (reads++ === 0 ? firstDocument : secondDocument));
		const scenario = runCompatibilityScenario(COMPATIBILITY_MODES.nativeOnly, {
			nativeView: {
				canvas: {
					getData,
					nodes: [],
					edges: [],
					viewport: { x: 0, y: 0, zoom: 1 },
				},
			},
		});

		expect(getData).toHaveBeenCalledTimes(2);
		expect(scenario.native.documentByteEquivalent).toBe(false);
		expect(scenario.native.unknownMetadataByteEquivalent).toBe(false);
		expect(scenario.diagnostics.some((item) => item.code === "document-mutated-during-read")).toBe(true);
		expect(scenario.consoleErrors).toEqual([]);
		expect(scenario.executionErrors).toEqual([]);
	});

	it("does not claim Advanced metadata was preserved when it is unreadable", () => {
		const unreadableMetadata: Record<string, unknown> = {};
		unreadableMetadata.self = unreadableMetadata;
		const scenario = runCompatibilityScenario(COMPATIBILITY_MODES.advancedCanvasOnly, {
			nativeView: fixture().nativeView,
			advancedPlugin: {
				manifest: { id: "advanced-canvas", version: "6.0.1" },
				metadata: unreadableMetadata,
			},
		});

		expect(scenario.advanced.status).toBe("ready");
		expect(scenario.advanced.metadataReadable).toBe(false);
		expect(scenario.advanced.metadataByteEquivalent).toBe("unknown");
		expect(scenario.status).toBe("degraded");
		expect(scenario.passed).toBe(true);
		expect(scenario.diagnostics.some((item) => item.code === "advanced-metadata-not-readable")).toBe(true);
		expect(scenario.diagnostics.some((item) => item.code === "advanced-metadata-unverifiable")).toBe(true);
	});

	it("reports externally captured console errors separately and fails the scenario", () => {
		const scenario = runCompatibilityScenario(COMPATIBILITY_MODES.nativeOnly, {
			nativeView: fixture().nativeView,
			consoleErrors: ["native renderer error"],
			captureConsoleErrors: () => ["hook error", "native renderer error"],
		});

		expect(scenario.consoleErrors).toEqual(["native renderer error", "hook error"]);
		expect(scenario.executionErrors).toEqual([]);
		expect(scenario.status).toBe("fail");
		expect(scenario.passed).toBe(false);
		expect(scenario.diagnostics.some((item) => item.code === "console-errors-detected")).toBe(true);
	});

	it("keeps runner exceptions out of the external console-error channel", () => {
		const scenario = runCompatibilityScenario(COMPATIBILITY_MODES.nativeOnly, fixture(), {
			explicitMutation: () => {
				throw new Error("mutation callback failed");
			},
		});

		expect(scenario.consoleErrors).toEqual([]);
		expect(scenario.executionErrors).toHaveLength(1);
		expect(scenario.status).toBe("fail");
		expect(scenario.diagnostics.some((item) => item.code === "explicit-mutation-failed")).toBe(true);
	});

	it("fails closed when the native document cannot be read", () => {
		const scenario = runCompatibilityScenario(COMPATIBILITY_MODES.nativeOnly, {
			nativeView: { canvas: { nodes: [] } },
		});

		expect(scenario.status).toBe("fail");
		expect(scenario.passed).toBe(false);
		expect(scenario.coreOperational).toBe(false);
		expect(scenario.native.documentReadable).toBe(false);
		expect(scenario.diagnostics.some((item) => item.code === "document-not-readable")).toBe(true);
	});
});
