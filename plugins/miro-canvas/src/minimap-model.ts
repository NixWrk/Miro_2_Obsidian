/**
 * Pure geometry for a Canvas minimap.
 *
 * This module deliberately has no DOM, Obsidian, or persistence dependency.
 * It turns a bounded snapshot of scene geometry into one affine board↔map
 * transform and computes navigation targets from it.  A UI can draw the
 * returned rectangles on one `<canvas>` and call the navigation helpers from
 * mouse, touch, or keyboard handlers.
 */

import type {
	ViewportCoordinateMode,
	ViewportPoint,
	ViewportSize,
	ViewportTransform,
} from "./viewport-controller";

export const DEFAULT_MINIMAP_WIDTH = 240;
export const DEFAULT_MINIMAP_HEIGHT = 160;
export const DEFAULT_MINIMAP_PADDING = 8;
export const DEFAULT_MAX_MINIMAP_ITEMS = 100_000;
export const MAX_MINIMAP_COORDINATE = Number.MAX_SAFE_INTEGER;

export interface MinimapRect {
	readonly x: number;
	readonly y: number;
	readonly width: number;
	readonly height: number;
}

export type CanvasRect = MinimapRect;
export type BoardBounds = MinimapRect;
export type MinimapPoint = ViewportPoint;

export interface MinimapViewportSize extends ViewportSize {}

export interface MinimapSceneItem {
	readonly id?: string;
	readonly kind: "node" | "edge" | "item";
	readonly bounds: MinimapRect;
	readonly mapRect?: MinimapRect;
}

export interface MinimapViewportGeometry {
	readonly boardRect: MinimapRect;
	readonly mapRect: MinimapRect;
	readonly center: MinimapPoint;
	readonly zoom: number;
}

export interface MinimapModelOptions {
	readonly width?: number;
	readonly height?: number;
	readonly mapWidth?: number;
	readonly mapHeight?: number;
	readonly padding?: number;
	readonly maxItems?: number;
	readonly viewport?: unknown;
	readonly viewportSize?: unknown;
	readonly viewportWidth?: number;
	readonly viewportHeight?: number;
	readonly coordinateMode?: ViewportCoordinateMode;
	readonly viewportMode?: ViewportCoordinateMode;
	readonly viewportOrigin?: ViewportCoordinateMode;
	readonly bounds?: unknown;
	readonly contentBounds?: unknown;
}

export interface MinimapDiagnostic {
	readonly code: string;
	readonly message: string;
	readonly level: "info" | "warning";
}

export interface MinimapGeometry {
	readonly width: number;
	readonly height: number;
	readonly padding: number;
	readonly innerRect: MinimapRect;
	readonly bounds: MinimapRect;
	readonly canvasBounds: MinimapRect;
	readonly contentBounds?: MinimapRect;
	readonly hasContent: boolean;
	readonly scale: number;
	readonly offsetX: number;
	readonly offsetY: number;
	readonly coordinateMode: ViewportCoordinateMode;
	readonly items: readonly MinimapSceneItem[];
	readonly nodeItems: readonly MinimapSceneItem[];
	readonly edgeItems: readonly MinimapSceneItem[];
	readonly viewport?: ViewportTransform;
	readonly viewportGeometry?: MinimapViewportGeometry;
	/** Alias used by drawing callers: this is the map-space viewport frame. */
	readonly viewportRect?: MinimapRect;
	readonly viewportBounds?: MinimapRect;
	readonly diagnostics: readonly MinimapDiagnostic[];
}

type UnknownRecord = Record<PropertyKey, unknown>;

const NO_VALUE = Symbol("minimap-no-value");

function isObject(value: unknown): value is UnknownRecord {
	return (typeof value === "object" && value !== null) || typeof value === "function";
}

function safeRead(target: unknown, key: PropertyKey): unknown {
	if (!isObject(target)) {
		return NO_VALUE;
	}
	try {
		return Reflect.get(target, key, target);
	} catch {
		return NO_VALUE;
	}
}

function safeCall(target: unknown, method: PropertyKey, args: readonly unknown[]):
	| { readonly ok: true; readonly value: unknown }
	| { readonly ok: false } {
	const candidate = safeRead(target, method);
	if (typeof candidate !== "function") {
		return { ok: false };
	}
	try {
		return { ok: true, value: Reflect.apply(candidate, target, [...args]) };
	} catch {
		return { ok: false };
	}
}

function isArray(value: unknown): value is readonly unknown[] {
	try {
		return Array.isArray(value);
	} catch {
		return false;
	}
}

function finite(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function coordinate(value: number): number {
	if (value === 0) {
		return 0;
	}
	if (value > MAX_MINIMAP_COORDINATE) {
		return MAX_MINIMAP_COORDINATE;
	}
	if (value < -MAX_MINIMAP_COORDINATE) {
		return -MAX_MINIMAP_COORDINATE;
	}
	return value;
}

function safeAdd(left: number, right: number): number {
	const sum = left + right;
	if (!Number.isFinite(sum)) {
		return right < 0 ? -MAX_MINIMAP_COORDINATE : MAX_MINIMAP_COORDINATE;
	}
	return coordinate(sum);
}

function safeMultiply(left: number, right: number): number {
	const product = left * right;
	if (!Number.isFinite(product)) {
		return product < 0 ? -MAX_MINIMAP_COORDINATE : MAX_MINIMAP_COORDINATE;
	}
	return coordinate(product);
}

function readString(target: unknown, keys: readonly string[]): string | undefined {
	for (const key of keys) {
		const value = safeRead(target, key);
		if (typeof value === "string" && value.length > 0) {
			return value;
		}
	}
	return undefined;
}

function readNumber(target: unknown, keys: readonly string[]): number | undefined {
	for (const key of keys) {
		const value = finite(safeRead(target, key));
		if (value !== undefined) {
			return value;
		}
	}
	return undefined;
}

function normaliseRect(x: number, y: number, width: number, height: number): MinimapRect {
	let left = coordinate(x);
	let top = coordinate(y);
	let right = safeAdd(x, width);
	let bottom = safeAdd(y, height);
	if (right < left) {
		[left, right] = [right, left];
	}
	if (bottom < top) {
		[top, bottom] = [bottom, top];
	}
	return {
		x: left,
		y: top,
		width: Math.max(0, right - left),
		height: Math.max(0, bottom - top),
	};
}

function readPoint(value: unknown, depth = 0): MinimapPoint | undefined {
	if (depth > 4) {
		return undefined;
	}
	if (isArray(value)) {
		try {
			const x = finite(value[0]);
			const y = finite(value[1]);
			return x === undefined || y === undefined ? undefined : { x: coordinate(x), y: coordinate(y) };
		} catch {
			return undefined;
		}
	}
	if (!isObject(value)) {
		return undefined;
	}
	const directX = readNumber(value, ["x", "left"]);
	const directY = readNumber(value, ["y", "top"]);
	if (directX !== undefined && directY !== undefined) {
		return { x: coordinate(directX), y: coordinate(directY) };
	}
	for (const key of ["point", "position", "coordinate", "center"] as const) {
		const nested = readPoint(safeRead(value, key), depth + 1);
		if (nested !== undefined) {
			return nested;
		}
	}
	return undefined;
}

/** Read a rectangle from common JSON Canvas/native Canvas geometry shapes. */
export function readMinimapRect(value: unknown, depth = 0): MinimapRect | undefined {
	if (depth > 4) {
		return undefined;
	}
	if (isArray(value)) {
		try {
			const x = finite(value[0]);
			const y = finite(value[1]);
			const width = finite(value[2]);
			const height = finite(value[3]);
			return x === undefined || y === undefined || width === undefined || height === undefined
				? undefined
				: normaliseRect(x, y, width, height);
		} catch {
			return undefined;
		}
	}
	if (!isObject(value)) {
		return undefined;
	}
	// Native Canvas nodes/edges expose their JSON Canvas geometry through the
	// observed `getData()` method rather than enumerable x/y fields.  Read that
	// exact method once, with a depth guard, before trying generic wrappers.
	const dataResult = safeCall(value, "getData", []);
	if (dataResult.ok && dataResult.value !== value) {
		const fromData = readMinimapRect(dataResult.value, depth + 1);
		if (fromData !== undefined) {
			return fromData;
		}
	}

	let x = readNumber(value, ["x", "left"]);
	let y = readNumber(value, ["y", "top"]);
	let width = readNumber(value, ["width", "w"]);
	let height = readNumber(value, ["height", "h"]);
	if (x !== undefined && y !== undefined && width !== undefined && height !== undefined) {
		return normaliseRect(x, y, width, height);
	}

	const right = readNumber(value, ["right"]);
	const bottom = readNumber(value, ["bottom"]);
	if (x !== undefined && y !== undefined && right !== undefined && bottom !== undefined) {
		return normaliseRect(x, y, right - x, bottom - y);
	}

	const center = readPoint(safeRead(value, "center"));
	if (center !== undefined && width !== undefined && height !== undefined) {
		return normaliseRect(center.x - width / 2, center.y - height / 2, width, height);
	}

	for (const key of ["bounds", "boundingBox", "rect", "rectangle", "geometry", "frame"] as const) {
		const nested = readMinimapRect(safeRead(value, key), depth + 1);
		if (nested !== undefined) {
			return nested;
		}
	}
	if (x !== undefined && y !== undefined) {
		return normaliseRect(x, y, 0, 0);
	}
	return undefined;
}

function addDiagnostic(
	list: MinimapDiagnostic[],
	keys: Set<string>,
	code: string,
	message: string,
	level: "info" | "warning" = "warning",
): void {
	const key = `${code}:${message}`;
	if (!keys.has(key)) {
		keys.add(key);
		list.push({ code, message, level });
	}
}

function readCollection(
	value: unknown,
	maxItems: number,
	diagnostics: MinimapDiagnostic[],
	diagnosticKeys: Set<string>,
	label: string,
): readonly unknown[] {
	if (value === NO_VALUE || value === undefined || value === null) {
		return [];
	}
	const result: unknown[] = [];
	try {
		if (isArray(value)) {
			const length = value.length;
			if (!Number.isSafeInteger(length) || length < 0) {
				addDiagnostic(diagnostics, diagnosticKeys, "collection-invalid", `${label} has an invalid length.`);
				return result;
			}
			if (length > maxItems) {
				addDiagnostic(diagnostics, diagnosticKeys, "collection-limit", `${label} exceeded the safety item limit.`);
				return result;
			}
			for (let index = 0; index < length; index += 1) {
				try {
					result.push(value[index]);
				} catch {
					addDiagnostic(diagnostics, diagnosticKeys, "collection-read-failed", `Reading ${label} failed.`);
					return result;
				}
			}
			return result;
		}

		if (value instanceof Map || value instanceof Set) {
			const iterator = value.values();
			for (;;) {
				if (result.length >= maxItems) {
					addDiagnostic(diagnostics, diagnosticKeys, "collection-limit", `${label} exceeded the safety item limit.`);
					return [];
				}
				const step = iterator.next();
				if (step.done === true) {
					return result;
				}
				if (step.done !== false) {
					addDiagnostic(diagnostics, diagnosticKeys, "collection-invalid", `${label} returned an invalid iterator step.`);
					return [];
				}
				result.push(step.value);
			}
		}

		const values = safeRead(value, "values");
		if (typeof values === "function") {
			const iteratorResult = safeCall(value, "values", []);
			if (!iteratorResult.ok) {
				addDiagnostic(diagnostics, diagnosticKeys, "collection-read-failed", `Reading ${label} failed.`);
				return [];
			}
			const iterator = iteratorResult.value;
			if (!isObject(iterator) || typeof safeRead(iterator, "next") !== "function") {
				addDiagnostic(diagnostics, diagnosticKeys, "collection-invalid", `${label} returned an invalid iterator.`);
				return [];
			}
			for (;;) {
				if (result.length >= maxItems) {
					addDiagnostic(diagnostics, diagnosticKeys, "collection-limit", `${label} exceeded the safety item limit.`);
					return [];
				}
				const step = safeCall(iterator, "next", []);
				if (!step.ok || !isObject(step.value)) {
					addDiagnostic(diagnostics, diagnosticKeys, "collection-read-failed", `Reading ${label} failed.`);
					return [];
				}
				const done = safeRead(step.value, "done");
				if (done === true) {
					return result;
				}
				if (done !== false) {
					addDiagnostic(diagnostics, diagnosticKeys, "collection-invalid", `${label} returned an invalid iterator step.`);
					return [];
				}
				const entry = safeRead(step.value, "value");
				if (entry === NO_VALUE) {
					addDiagnostic(diagnostics, diagnosticKeys, "collection-read-failed", `Reading ${label} failed.`);
					return [];
				}
				result.push(entry);
			}
		}

		// Plain object maps are accepted without invoking user-provided forEach.
		const keys = Reflect.ownKeys(value);
		if (keys.length > maxItems) {
			addDiagnostic(diagnostics, diagnosticKeys, "collection-limit", `${label} exceeded the safety item limit.`);
			return [];
		}
		for (const key of keys) {
			if (typeof key === "string") {
				const item = safeRead(value, key);
				if (item !== NO_VALUE) {
					result.push(item);
				}
			}
		}
	} catch {
		addDiagnostic(diagnostics, diagnosticKeys, "collection-read-failed", `Reading ${label} failed.`);
		return [];
	}
	return result;
}

function readSceneValue(scene: unknown, key: string): unknown {
	const direct = safeRead(scene, key);
	if (direct !== NO_VALUE && direct !== undefined) {
		return direct;
	}
	const data = safeRead(scene, "data");
	return safeRead(data, key);
}

function sceneCollections(
	scene: unknown,
	maxItems: number,
	diagnostics: MinimapDiagnostic[],
	diagnosticKeys: Set<string>,
): { readonly nodes: readonly unknown[]; readonly edges: readonly unknown[]; readonly directBounds?: MinimapRect } {
	let source = scene;
	if (isObject(scene) && typeof safeRead(scene, "getScene") === "function") {
		const result = safeCall(scene, "getScene", []);
		if (result.ok && result.value !== undefined) {
			source = result.value;
		} else if (!result.ok) {
			addDiagnostic(diagnostics, diagnosticKeys, "scene-read-failed", "Reading Canvas scene failed.");
		}
	}
	if (isArray(source)) {
		return {
			nodes: readCollection(source, maxItems, diagnostics, diagnosticKeys, "nodes"),
			edges: [],
		};
	}
	const nodes = readCollection(readSceneValue(source, "nodes") ?? readSceneValue(source, "items"), maxItems, diagnostics, diagnosticKeys, "nodes");
	const edges = readCollection(readSceneValue(source, "edges"), maxItems, diagnostics, diagnosticKeys, "edges");
	const directBounds = readMinimapRect(readSceneValue(source, "contentBounds") ?? readSceneValue(source, "bounds"));
	return { nodes, edges, directBounds };
}

function itemId(value: unknown): string | undefined {
	return readString(value, ["id", "nodeId", "edgeId", "key"]);
}

function nodeCenter(rect: MinimapRect): MinimapPoint {
	return { x: safeAdd(rect.x, rect.width / 2), y: safeAdd(rect.y, rect.height / 2) };
}

function endpoint(value: unknown, nodes: ReadonlyMap<string, MinimapRect>): MinimapPoint | undefined {
	if (typeof value === "string") {
		const rect = nodes.get(value);
		return rect === undefined ? undefined : nodeCenter(rect);
	}
	const direct = readPoint(value);
	if (direct !== undefined) {
		return direct;
	}
	if (!isObject(value)) {
		return undefined;
	}
	const id = readString(value, ["nodeId", "id", "source", "target"]);
	if (id !== undefined) {
		const rect = nodes.get(id);
		if (rect !== undefined) {
			return nodeCenter(rect);
		}
	}
	for (const key of ["point", "position", "coordinate", "anchor"] as const) {
		const point = readPoint(safeRead(value, key));
		if (point !== undefined) {
			return point;
		}
	}
	return undefined;
}

function edgeRect(value: unknown, nodes: ReadonlyMap<string, MinimapRect>): MinimapRect | undefined {
	const direct = readMinimapRect(value);
	if (direct !== undefined && (direct.width > 0 || direct.height > 0)) {
		return direct;
	}
	const points: MinimapPoint[] = [];
	if (isObject(value)) {
		for (const key of ["from", "to", "start", "end", "fromNode", "toNode", "source", "target", "startPoint", "endPoint"] as const) {
			const point = endpoint(safeRead(value, key), nodes);
			if (point !== undefined) {
				points.push(point);
			}
		}
		const rawPoints = safeRead(value, "points");
		for (const pointValue of readCollection(rawPoints, 10_000, [], new Set(), "edge points")) {
			const point = endpoint(pointValue, nodes);
			if (point !== undefined) {
				points.push(point);
			}
		}
	}
	if (points.length === 0) {
		return direct;
	}
	let result: MinimapRect | undefined;
	for (const point of points) {
		const pointRect = normaliseRect(point.x, point.y, 0, 0);
		result = result === undefined ? pointRect : unionRects(result, pointRect);
	}
	return result;
}

export function unionRects(left: MinimapRect, right: MinimapRect): MinimapRect {
	const leftRight = safeAdd(left.x, left.width);
	const rightRight = safeAdd(right.x, right.width);
	const leftBottom = safeAdd(left.y, left.height);
	const rightBottom = safeAdd(right.y, right.height);
	const x = Math.min(left.x, right.x);
	const y = Math.min(left.y, right.y);
	const maxX = Math.max(leftRight, rightRight);
	const maxY = Math.max(leftBottom, rightBottom);
	return normaliseRect(x, y, Math.max(0, maxX - x), Math.max(0, maxY - y));
}

export function computeContentBounds(
	scene: unknown,
	options: Pick<MinimapModelOptions, "maxItems" | "bounds" | "contentBounds"> = {},
): {
	readonly bounds?: MinimapRect;
	readonly nodes: readonly MinimapSceneItem[];
	readonly edges: readonly MinimapSceneItem[];
	readonly diagnostics: readonly MinimapDiagnostic[];
} {
	const diagnostics: MinimapDiagnostic[] = [];
	const diagnosticKeys = new Set<string>();
	const configuredLimit = finite(safeRead(options, "maxItems"));
	const maxItems = configuredLimit !== undefined && configuredLimit >= 0
		? Math.min(Math.floor(configuredLimit), DEFAULT_MAX_MINIMAP_ITEMS)
		: DEFAULT_MAX_MINIMAP_ITEMS;
	const collections = sceneCollections(scene, maxItems, diagnostics, diagnosticKeys);
	const parsedNodes: MinimapSceneItem[] = [];
	const nodeRects = new Map<string, MinimapRect>();
	let bounds = readMinimapRect(safeRead(options, "contentBounds")) ?? readMinimapRect(safeRead(options, "bounds"));
	if (bounds === undefined) {
		bounds = collections.directBounds;
	}
	for (const value of collections.nodes) {
		const rect = readMinimapRect(value);
		if (rect === undefined) {
			addDiagnostic(diagnostics, diagnosticKeys, "geometry-invalid", "A scene node had no finite geometry.");
			continue;
		}
		const item: MinimapSceneItem = { kind: "node", bounds: rect };
		const id = itemId(value);
		const withId = id === undefined ? item : { ...item, id };
		parsedNodes.push(withId);
		nodeRects.set(id ?? `#${parsedNodes.length}`, rect);
		bounds = bounds === undefined ? rect : unionRects(bounds, rect);
	}

	const parsedEdges: MinimapSceneItem[] = [];
	for (const value of collections.edges) {
		const rect = edgeRect(value, nodeRects);
		if (rect === undefined) {
			addDiagnostic(diagnostics, diagnosticKeys, "geometry-invalid", "A scene edge had no finite endpoints.");
			continue;
		}
		const item: MinimapSceneItem = { kind: "edge", bounds: rect };
		const id = itemId(value);
		const withId = id === undefined ? item : { ...item, id };
		parsedEdges.push(withId);
		bounds = bounds === undefined ? rect : unionRects(bounds, rect);
	}

	return { bounds, nodes: parsedNodes, edges: parsedEdges, diagnostics };
}

function readMode(options: unknown, viewport: unknown): ViewportCoordinateMode {
	for (const key of ["coordinateMode", "viewportMode", "viewportOrigin"] as const) {
		const value = safeRead(options, key);
		if (value === "center" || value === "transform") {
			return value;
		}
	}
	for (const key of ["coordinateMode", "cameraMode", "viewportMode", "viewportOrigin"] as const) {
		const value = safeRead(viewport, key);
		if (value === "center" || value === "transform") {
			return value;
		}
	}
	// Explicit native center records are unambiguous; x/y-only records mirror
	// the Canvas affine transform used by the adapter.
	return isObject(viewport)
		&& safeRead(viewport, "center") !== NO_VALUE
		&& safeRead(viewport, "center") !== undefined
		? "center"
		: isObject(viewport) && safeRead(viewport, "zoomMode") === "log2"
			? "center"
		: "transform";
}

function normaliseViewport(value: unknown): ViewportTransform | undefined {
	if (!isObject(value)) {
		return undefined;
	}
	const x = finite(safeRead(value, "x")) ?? finite(safeRead(value, "tx"));
	const y = finite(safeRead(value, "y")) ?? finite(safeRead(value, "ty"));
	const tZoom = finite(safeRead(value, "tZoom"));
	const nativeZoom = tZoom === undefined || tZoom < -1022 || tZoom > 1023 ? undefined : 2 ** tZoom;
	const zoom = finite(safeRead(value, "zoom")) ?? finite(safeRead(value, "scale")) ?? nativeZoom;
	if (x === undefined || y === undefined || zoom === undefined || zoom <= 0) {
		return undefined;
	}
	const result: Record<string, unknown> = {};
	try {
		for (const key of Reflect.ownKeys(value)) {
			if (typeof key === "string") {
				const item = safeRead(value, key);
				if (item !== NO_VALUE) {
					result[key] = item;
				}
			}
		}
	} catch {
		// Preserve only the required camera fields for a hostile proxy.
	}
	result.x = coordinate(x);
	result.y = coordinate(y);
	result.zoom = zoom;
	if (tZoom !== undefined && Number.isFinite(nativeZoom) && nativeZoom !== undefined) {
		result.tZoom = tZoom;
		result.tx = result.x;
		result.ty = result.y;
		result.zoomMode = "log2";
		const explicitMode = safeRead(value, "coordinateMode");
		if (explicitMode !== "center" && explicitMode !== "transform") {
			result.coordinateMode = "center";
		}
	}
	for (const key of ["width", "height"] as const) {
		const size = finite(safeRead(value, key));
		if (size !== undefined && size > 0) {
			result[key] = Math.min(size, MAX_MINIMAP_COORDINATE);
		}
	}
	return result as ViewportTransform;
}

function viewportSize(options: unknown, viewport: ViewportTransform | undefined): MinimapViewportSize | undefined {
	const width = finite(viewport === undefined ? undefined : safeRead(viewport, "width"))
		?? finite(safeRead(options, "viewportWidth"))
		?? finite(safeRead(safeRead(options, "viewportSize"), "width"));
	const height = finite(viewport === undefined ? undefined : safeRead(viewport, "height"))
		?? finite(safeRead(options, "viewportHeight"))
		?? finite(safeRead(safeRead(options, "viewportSize"), "height"));
	return width === undefined || height === undefined || width <= 0 || height <= 0
		? undefined
		: { width: Math.min(width, MAX_MINIMAP_COORDINATE), height: Math.min(height, MAX_MINIMAP_COORDINATE) };
}

export interface ViewportGeometryOptions {
	readonly viewportSize?: unknown;
	readonly viewportWidth?: number;
	readonly viewportHeight?: number;
	readonly coordinateMode?: ViewportCoordinateMode;
	readonly viewportMode?: ViewportCoordinateMode;
	readonly viewportOrigin?: ViewportCoordinateMode;
}

/** Convert a native camera transform to a board-space visible rectangle. */
export function viewportToBoardRect(
	viewport: unknown,
	options: ViewportGeometryOptions = {},
): MinimapRect | undefined {
	const value = normaliseViewport(viewport);
	if (value === undefined) {
		return undefined;
	}
	const size = viewportSize(options, value);
	if (size === undefined) {
		return undefined;
	}
	const mode = readMode(options, viewport);
	if (mode === "center") {
		return normaliseRect(
			value.x - size.width / (2 * value.zoom),
			value.y - size.height / (2 * value.zoom),
			size.width / value.zoom,
			size.height / value.zoom,
		);
	}
	return normaliseRect(
		-value.x / value.zoom,
		-value.y / value.zoom,
		size.width / value.zoom,
		size.height / value.zoom,
	);
}

export const viewportToRect = viewportToBoardRect;
export const getViewportBoardRect = viewportToBoardRect;

function safeMapScale(bounds: MinimapRect, inner: MinimapRect): number {
	const width = bounds.width > 0 ? bounds.width : 1;
	const height = bounds.height > 0 ? bounds.height : 1;
	const result = Math.min(inner.width / width, inner.height / height);
	return Number.isFinite(result) && result > 0 ? result : 1;
}

function projectRect(rect: MinimapRect, scale: number, offsetX: number, offsetY: number): MinimapRect {
	return {
		x: safeAdd(offsetX, safeMultiply(rect.x, scale)),
		y: safeAdd(offsetY, safeMultiply(rect.y, scale)),
		width: Math.max(0, safeMultiply(rect.width, scale)),
		height: Math.max(0, safeMultiply(rect.height, scale)),
	};
}

function mapPoint(point: unknown, scale: number, offsetX: number, offsetY: number): MinimapPoint | undefined {
	const value = readPoint(point);
	if (value === undefined) {
		return undefined;
	}
	return {
		x: safeAdd(offsetX, safeMultiply(value.x, scale)),
		y: safeAdd(offsetY, safeMultiply(value.y, scale)),
	};
}

function boardPoint(point: unknown, scale: number, offsetX: number, offsetY: number): MinimapPoint | undefined {
	const value = readPoint(point);
	if (value === undefined || !Number.isFinite(scale) || scale <= 0) {
		return undefined;
	}
	return {
		x: coordinate((value.x - offsetX) / scale),
		y: coordinate((value.y - offsetY) / scale),
	};
}

function cameraAtCenter(
	center: MinimapPoint,
	viewport: ViewportTransform,
	options: ViewportGeometryOptions,
): ViewportTransform {
	const result: Record<string, unknown> = {};
	for (const key of Object.keys(viewport)) {
		const value = safeRead(viewport, key);
		if (value !== NO_VALUE) {
			result[key] = value;
		}
	}
	const mode = readMode(options, viewport);
	const size = viewportSize(options, viewport);
	if (mode === "center") {
		result.x = coordinate(center.x);
		result.y = coordinate(center.y);
	} else if (size !== undefined) {
		result.x = coordinate(size.width / 2 - center.x * viewport.zoom);
		result.y = coordinate(size.height / 2 - center.y * viewport.zoom);
	}
	result.zoom = viewport.zoom;
	if (safeRead(viewport, "zoomMode") === "log2" || finite(safeRead(viewport, "tZoom")) !== undefined) {
		const tZoom = Math.log2(viewport.zoom);
		if (Number.isFinite(tZoom)) {
			result.tZoom = tZoom;
			result.zoomMode = "log2";
		}
	}
	return result as ViewportTransform;
}

function modelOptions(viewportOrOptions: unknown, options: unknown): MinimapModelOptions {
	const candidate = isObject(options) ? options : {};
	const viewportCandidate = isObject(viewportOrOptions)
		&& (finite(safeRead(viewportOrOptions, "zoom")) !== undefined
			|| finite(safeRead(viewportOrOptions, "tZoom")) !== undefined)
		? viewportOrOptions
		: safeRead(candidate, "viewport");
	const result: Record<string, unknown> = {};
	if (isObject(candidate)) {
		try {
			for (const key of Reflect.ownKeys(candidate)) {
				if (typeof key === "string") {
					const value = safeRead(candidate, key);
					if (value !== NO_VALUE) {
						result[key] = value;
					}
				}
			}
		} catch {
			// Keep defaults when options are hostile.
		}
	}
	if (viewportCandidate !== NO_VALUE && viewportCandidate !== undefined) {
		result.viewport = viewportCandidate;
	}
	return result as MinimapModelOptions;
}

function validCanvasSize(options: unknown): { readonly width: number; readonly height: number } {
	const width = finite(safeRead(options, "width")) ?? finite(safeRead(options, "mapWidth")) ?? DEFAULT_MINIMAP_WIDTH;
	const height = finite(safeRead(options, "height")) ?? finite(safeRead(options, "mapHeight")) ?? DEFAULT_MINIMAP_HEIGHT;
	return {
		width: width > 0 ? Math.min(width, MAX_MINIMAP_COORDINATE) : DEFAULT_MINIMAP_WIDTH,
		height: height > 0 ? Math.min(height, MAX_MINIMAP_COORDINATE) : DEFAULT_MINIMAP_HEIGHT,
	};
}

function makeGeometry(scene: unknown, options: MinimapModelOptions): MinimapGeometry {
	const diagnostics: MinimapDiagnostic[] = [];
	const diagnosticKeys = new Set<string>();
	const computed = computeContentBounds(scene, options);
	diagnostics.push(...computed.diagnostics);
	const contentBounds = computed.bounds;
	const hasContent = contentBounds !== undefined;
	const bounds = contentBounds ?? normaliseRect(0, 0, 1, 1);
	const size = validCanvasSize(options);
	const requestedPadding = finite(safeRead(options, "padding"));
	const padding = requestedPadding !== undefined && requestedPadding >= 0
		? Math.min(requestedPadding, Math.min(size.width, size.height) / 2)
		: DEFAULT_MINIMAP_PADDING;
	const innerRect: MinimapRect = {
		x: padding,
		y: padding,
		width: Math.max(1, size.width - padding * 2),
		height: Math.max(1, size.height - padding * 2),
	};
	const scale = safeMapScale(bounds, innerRect);
	const projectedWidth = safeMultiply(bounds.width > 0 ? bounds.width : 1, scale);
	const projectedHeight = safeMultiply(bounds.height > 0 ? bounds.height : 1, scale);
	const offsetX = innerRect.x + (innerRect.width - projectedWidth) / 2 - safeMultiply(bounds.x, scale);
	const offsetY = innerRect.y + (innerRect.height - projectedHeight) / 2 - safeMultiply(bounds.y, scale);
	const mapItems = (items: readonly MinimapSceneItem[], kind: "node" | "edge"): readonly MinimapSceneItem[] => items.map((item) => ({
		...item,
		kind,
		mapRect: projectRect(item.bounds, scale, offsetX, offsetY),
	}));
	const nodeItems = mapItems(computed.nodes, "node");
	const edgeItems = mapItems(computed.edges, "edge");
	const items = [...nodeItems, ...edgeItems];
	const rawViewport = safeRead(options, "viewport");
	const viewport = normaliseViewport(rawViewport);
	if (rawViewport !== NO_VALUE && rawViewport !== undefined && viewport === undefined) {
		addDiagnostic(diagnostics, diagnosticKeys, "viewport-invalid", "The minimap viewport is invalid; its frame is hidden.");
	}
	const coordinateMode = readMode(options, viewport);
	const boardRect = viewportToBoardRect(viewport, {
		viewportSize: safeRead(options, "viewportSize"),
		coordinateMode,
	});
	const viewportGeometry = viewport !== undefined && boardRect !== undefined
		? {
			boardRect,
			mapRect: projectRect(boardRect, scale, offsetX, offsetY),
			center: nodeCenter(boardRect),
			zoom: viewport.zoom,
		}
		: undefined;
	return {
		width: size.width,
		height: size.height,
		padding,
		innerRect,
		bounds,
		canvasBounds: bounds,
		...(contentBounds === undefined ? {} : { contentBounds }),
		hasContent,
		scale,
		offsetX,
		offsetY,
		coordinateMode,
		items,
		nodeItems,
		edgeItems,
		...(viewport === undefined ? {} : { viewport }),
		...(viewportGeometry === undefined
			? {}
			: {
				viewportGeometry,
				viewportRect: viewportGeometry.mapRect,
				viewportBounds: viewportGeometry.boardRect,
			}),
		diagnostics,
	};
}

/** Build one immutable minimap geometry snapshot. */
export function buildMinimapModel(
	scene: unknown,
	viewportOrOptions: unknown = {},
	options: MinimapModelOptions = {},
): MinimapGeometry {
	return makeGeometry(scene, modelOptions(viewportOrOptions, options));
}

export const buildMinimapGeometry = buildMinimapModel;
export const computeMinimapGeometry = buildMinimapModel;

export class MinimapModel {
	private readonly geometry: MinimapGeometry;
	private readonly config: MinimapModelOptions;

	public constructor(sceneOrOptions: unknown = [], options: MinimapModelOptions = {}) {
		let scene = sceneOrOptions;
		let config: MinimapModelOptions = options;
		const wrappedScene = safeRead(sceneOrOptions, "scene");
		if (arguments.length === 1 && wrappedScene !== NO_VALUE && wrappedScene !== undefined) {
			scene = wrappedScene;
			config = modelOptions(sceneOrOptions, sceneOrOptions);
		}
		this.config = config;
		this.geometry = makeGeometry(scene, config);
	}

	public static fromScene(scene: unknown, options: MinimapModelOptions = {}): MinimapModel {
		return new MinimapModel(scene, options);
	}

	public get width(): number { return this.geometry.width; }
	public get height(): number { return this.geometry.height; }
	public get padding(): number { return this.geometry.padding; }
	public get innerRect(): MinimapRect { return this.geometry.innerRect; }
	public get bounds(): MinimapRect { return this.geometry.bounds; }
	public get canvasBounds(): MinimapRect { return this.geometry.canvasBounds; }
	public get contentBounds(): MinimapRect | undefined { return this.geometry.contentBounds; }
	public get hasContent(): boolean { return this.geometry.hasContent; }
	public get scale(): number { return this.geometry.scale; }
	public get offsetX(): number { return this.geometry.offsetX; }
	public get offsetY(): number { return this.geometry.offsetY; }
	public get coordinateMode(): ViewportCoordinateMode { return this.geometry.coordinateMode; }
	public get items(): readonly MinimapSceneItem[] { return this.geometry.items; }
	public get nodeItems(): readonly MinimapSceneItem[] { return this.geometry.nodeItems; }
	public get edgeItems(): readonly MinimapSceneItem[] { return this.geometry.edgeItems; }
	public get viewport(): ViewportTransform | undefined { return this.geometry.viewport; }
	public get viewportGeometry(): MinimapViewportGeometry | undefined { return this.geometry.viewportGeometry; }
	public get viewportRect(): MinimapRect | undefined { return this.geometry.viewportRect; }
	public get viewportBounds(): MinimapRect | undefined { return this.geometry.viewportBounds; }
	public get diagnostics(): readonly MinimapDiagnostic[] { return this.geometry.diagnostics; }

	public boardToMap(point: MinimapPoint): MinimapPoint | undefined {
		return mapPoint(point, this.geometry.scale, this.geometry.offsetX, this.geometry.offsetY);
	}

	public toMap(point: MinimapPoint): MinimapPoint | undefined {
		return this.boardToMap(point);
	}

	public mapToBoard(point: MinimapPoint): MinimapPoint | undefined {
		return boardPoint(point, this.geometry.scale, this.geometry.offsetX, this.geometry.offsetY);
	}

	public fromMap(point: MinimapPoint): MinimapPoint | undefined {
		return this.mapToBoard(point);
	}

	public project(rect: MinimapRect): MinimapRect {
		return projectRect(rect, this.geometry.scale, this.geometry.offsetX, this.geometry.offsetY);
	}

	public viewportForClick(point: MinimapPoint, viewport: unknown = this.geometry.viewport): ViewportTransform | undefined {
		const current = normaliseViewport(viewport);
		const board = this.mapToBoard(point);
		if (current === undefined || board === undefined) {
			return undefined;
		}
		return cameraAtCenter(board, current, {
			viewportSize: safeRead(this.config, "viewportSize"),
			coordinateMode: readMode(this.config, current),
		});
	}

	public clickToViewport(point: MinimapPoint, viewport: unknown = this.geometry.viewport): ViewportTransform | undefined {
		return this.viewportForClick(point, viewport);
	}

	public navigateTo(point: MinimapPoint, viewport: unknown = this.geometry.viewport): ViewportTransform | undefined {
		return this.viewportForClick(point, viewport);
	}

	public viewportForDrag(
		start: MinimapPoint,
		currentPoint: MinimapPoint,
		viewport: unknown = this.geometry.viewport,
	): ViewportTransform | undefined {
		const initial = normaliseViewport(viewport);
		if (initial === undefined || !Number.isFinite(start.x) || !Number.isFinite(start.y)
			|| !Number.isFinite(currentPoint.x) || !Number.isFinite(currentPoint.y)) {
			return undefined;
		}
		const boardDelta = {
			x: (currentPoint.x - start.x) / this.geometry.scale,
			y: (currentPoint.y - start.y) / this.geometry.scale,
		};
		const boardRect = viewportToBoardRect(initial, {
			viewportSize: safeRead(this.config, "viewportSize"),
			coordinateMode: readMode(this.config, initial),
		});
		if (boardRect !== undefined) {
			return cameraAtCenter(
				{
					x: safeAdd(nodeCenter(boardRect).x, boardDelta.x),
					y: safeAdd(nodeCenter(boardRect).y, boardDelta.y),
				},
				initial,
				{
					viewportSize: safeRead(this.config, "viewportSize"),
					coordinateMode: readMode(this.config, initial),
				},
			);
		}
		// Without a viewport size there is no visible center to reconstruct, but
		// translation mode can still move the camera by the pointer delta.
		const result = { ...initial };
		if (readMode(this.config, initial) === "center") {
			result.x = safeAdd(initial.x, boardDelta.x);
			result.y = safeAdd(initial.y, boardDelta.y);
		} else {
			result.x = safeAdd(initial.x, -safeMultiply(boardDelta.x, initial.zoom));
			result.y = safeAdd(initial.y, -safeMultiply(boardDelta.y, initial.zoom));
		}
		return result;
	}

	public dragToViewport(
		start: MinimapPoint,
		currentPoint: MinimapPoint,
		viewport: unknown = this.geometry.viewport,
	): ViewportTransform | undefined {
		return this.viewportForDrag(start, currentPoint, viewport);
	}

	public isInViewport(point: MinimapPoint): boolean {
		const rect = this.geometry.viewportRect;
		return rect !== undefined
			&& Number.isFinite(point.x)
			&& Number.isFinite(point.y)
			&& point.x >= rect.x
			&& point.x <= rect.x + rect.width
			&& point.y >= rect.y
			&& point.y <= rect.y + rect.height;
	}

	public get geometrySnapshot(): MinimapGeometry {
		return this.geometry;
	}
}

export function createMinimapModel(
	scene: unknown,
	options: MinimapModelOptions = {},
): MinimapModel {
	return new MinimapModel(scene, options);
}

export const createMinimapGeometry = buildMinimapModel;
export const makeMinimapModel = createMinimapModel;

/** Pure navigation helpers for code that does not need a model instance. */
export function minimapPointToViewport(
	point: MinimapPoint,
	model: MinimapModel | MinimapGeometry,
	viewport?: unknown,
): ViewportTransform | undefined {
	if (model instanceof MinimapModel) {
		return model.viewportForClick(point, viewport);
	}
	// Use the supplied immutable geometry directly for the affine conversion.
	const board = boardPoint(point, model.scale, model.offsetX, model.offsetY);
	const current = normaliseViewport(viewport ?? model.viewport);
	if (board === undefined || current === undefined) {
		return undefined;
	}
	return cameraAtCenter(board, current, { coordinateMode: model.coordinateMode });
}

export const viewportForMinimapClick = minimapPointToViewport;

export function minimapDragToViewport(
	start: MinimapPoint,
	end: MinimapPoint,
	model: MinimapModel | MinimapGeometry,
	viewport?: unknown,
): ViewportTransform | undefined {
	if (model instanceof MinimapModel) {
		return model.viewportForDrag(start, end, viewport);
	}
	const current = normaliseViewport(viewport ?? model.viewport);
	if (current === undefined || !Number.isFinite(model.scale) || model.scale <= 0) {
		return undefined;
	}
	const deltaX = (end.x - start.x) / model.scale;
	const deltaY = (end.y - start.y) / model.scale;
	const result = { ...current };
	if (model.coordinateMode === "center") {
		result.x = safeAdd(current.x, deltaX);
		result.y = safeAdd(current.y, deltaY);
	} else {
		result.x = safeAdd(current.x, -deltaX * current.zoom);
		result.y = safeAdd(current.y, -deltaY * current.zoom);
	}
	return result;
}

export const viewportForMinimapDrag = minimapDragToViewport;
