import { describe, expect, it } from "vitest";

import {
	MinimapModel,
	buildMinimapModel,
	computeContentBounds,
	viewportToBoardRect,
} from "../src/minimap-model";

describe("MinimapModel", () => {
	it("covers negative node coordinates and edge endpoints in one map", () => {
		const model = buildMinimapModel(
			{
				nodes: [
					{ id: "a", x: -100, y: -50, width: 100, height: 80 },
					{ id: "b", x: 300, y: 200, width: 50, height: 40 },
				],
				edges: [{ id: "edge", from: "a", to: "b" }],
			},
			{ x: 0, y: 0, zoom: 1, width: 800, height: 600 },
			{ width: 400, height: 200, padding: 0 },
		);

		expect(model.hasContent).toBe(true);
		expect(model.contentBounds).toEqual({ x: -100, y: -50, width: 450, height: 290 });
		expect(model.nodeItems).toHaveLength(2);
		expect(model.edgeItems).toHaveLength(1);
		expect(model.viewportBounds).toEqual({ x: 0, y: 0, width: 800, height: 600 });
		expect(model.viewportRect?.width).toBeGreaterThan(0);
	});

	it("draws native runtime edges, whose ends hold the node objects themselves", () => {
		const a = { id: "a", x: 0, y: 0, width: 100, height: 80 };
		const b = { id: "b", x: 300, y: 200, width: 100, height: 80 };
		const model = buildMinimapModel(
			{
				nodes: [a, b],
				edges: [{ id: "edge", from: { node: a, side: "right", end: "none" }, to: { node: b, side: "left", end: "arrow" } }],
			},
			{ x: 0, y: 0, zoom: 1, width: 800, height: 600 },
			{ width: 400, height: 200, padding: 0 },
		);

		expect(model.edgeItems).toHaveLength(1);
		expect(model.diagnostics.map((item) => item.message)).not.toContain("A scene edge had no finite endpoints.");
	});

	it("maps viewport transforms exactly and keeps zoom for click/drag navigation", () => {
		const model = new MinimapModel(
			[{ x: 0, y: 0, width: 1000, height: 1000 }],
			{
				width: 500,
				height: 500,
				padding: 0,
				viewport: { x: 0, y: 0, zoom: 2, width: 400, height: 200 },
			},
		);
		const boardCenter = model.viewportGeometry?.center;
		expect(boardCenter).toEqual({ x: 100, y: 50 });
		const centerPoint = model.boardToMap({ x: 500, y: 500 });
		expect(centerPoint).toBeDefined();
		const clicked = model.clickToViewport(centerPoint!);
		expect(clicked).toMatchObject({ zoom: 2, x: -800, y: -900 });
		const dragged = model.dragToViewport({ x: 100, y: 100 }, { x: 120, y: 130 });
		expect(dragged?.zoom).toBe(2);
		expect(dragged?.x).toBe(-80);
		expect(dragged?.y).toBe(-120);
	});

	it("accepts explicit center-mode cameras", () => {
		const model = new MinimapModel(
			[{ x: 0, y: 0, width: 100, height: 100 }],
			{
				width: 200,
				height: 200,
				coordinateMode: "center",
				viewport: { x: 50, y: 50, zoom: 2, width: 100, height: 80 },
			},
		);
		expect(model.viewportBounds).toEqual({ x: 25, y: 30, width: 50, height: 40 });
		const target = model.clickToViewport({ x: 100, y: 100 });
		expect(target).toMatchObject({ x: 50, y: 50, zoom: 2 });
	});

	it("reads geometry from native Canvas element getData records", () => {
		const model = new MinimapModel(
			{
				nodes: new Map([
					["node", { id: "node", getData: () => ({ x: -20, y: 30, width: 40, height: 50 }) }],
				]),
				edges: [],
			},
			{ viewport: { tx: 0, ty: 0, tZoom: 0, width: 200, height: 100 } },
		);
		expect(model.hasContent).toBe(true);
		expect(model.nodeItems).toHaveLength(1);
		expect(model.nodeItems[0]?.bounds).toEqual({ x: -20, y: 30, width: 40, height: 50 });
		expect(model.coordinateMode).toBe("center");
	});

	it("returns finite geometry for empty, invalid, huge, and hostile data", () => {
		const empty = new MinimapModel({ nodes: [], edges: [] });
		expect(empty.hasContent).toBe(false);
		expect(empty.diagnostics).toEqual([]);
		expect(Number.isFinite(empty.scale)).toBe(true);

		const huge = new MinimapModel([
			{ x: Number.MAX_VALUE, y: -Number.MAX_VALUE, width: Number.MAX_VALUE, height: Number.MAX_VALUE },
			{ x: Number.NaN, y: 1, width: 2, height: 2 },
		]);
		expect(Number.isFinite(huge.bounds.x)).toBe(true);
		expect(Number.isFinite(huge.bounds.width)).toBe(true);
		expect(huge.diagnostics.length).toBeGreaterThan(0);

		const revoked = Proxy.revocable({ nodes: [], edges: [] }, {});
		revoked.revoke();
		expect(() => new MinimapModel(revoked.proxy)).not.toThrow();

		let calls = 0;
		const hostile = {
			values: () => ({ next: () => ({ done: false, value: { x: calls++, y: 0, width: 1, height: 1 } }) }),
		};
		const result = computeContentBounds({ nodes: hostile }, { maxItems: 3 });
		expect(result.nodes).toHaveLength(0);
		expect(result.diagnostics.some((item) => item.code === "collection-limit")).toBe(true);
	});

	it("rejects invalid viewport dimensions instead of inventing a frame", () => {
		expect(viewportToBoardRect({ x: 0, y: 0, zoom: 1 })).toBeUndefined();
		const model = buildMinimapModel([{ x: 0, y: 0, width: 10, height: 10 }], { viewport: { x: 0, y: 0, zoom: 1 } });
		expect(model.viewportRect).toBeUndefined();
	});
});
