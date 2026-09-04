/**
 * Framework-free camera operations for the native Canvas adapter.
 *
 * Obsidian does not expose a stable camera API.  The controller therefore
 * talks to the existing `CanvasAdapter` boundary only; it never reaches into
 * a private runtime itself and never writes a file.  All operations are
 * best-effort and fail closed when the runtime no longer has a recognised
 * viewport or mutation capability.
 */

import {
	CANVAS_CAPABILITIES,
	CanvasAdapter,
	createCanvasAdapter,
	type CanvasViewport,
} from "./canvas-adapter";

export const DEFAULT_MIN_ZOOM = 2 ** -12;
export const DEFAULT_MAX_ZOOM = 2 ** 8;
export const DEFAULT_RESET_ZOOM = 1;
/** Four zoom steps double/halve the camera. */
export const DEFAULT_ZOOM_STEP = 2 ** 0.25;
export const MAX_SAFE_CAMERA_COORDINATE = Number.MAX_SAFE_INTEGER;

// Names used by a few integrations and by the old zoom-unlock plugin.
export const DEFAULT_ZOOM_MIN = DEFAULT_MIN_ZOOM;
export const DEFAULT_ZOOM_MAX = DEFAULT_MAX_ZOOM;
export const VIEWPORT_MIN_ZOOM = DEFAULT_MIN_ZOOM;
export const VIEWPORT_MAX_ZOOM = DEFAULT_MAX_ZOOM;

export type ViewportCoordinateMode = "transform" | "center";

/** A camera transform.  In transform mode x/y are screen translations. */
export interface ViewportTransform {
	readonly x: number;
	readonly y: number;
	readonly zoom: number;
	readonly width?: number;
	readonly height?: number;
	readonly [key: string]: unknown;
}

export type ViewportState = ViewportTransform;

export interface ViewportSize {
	readonly width: number;
	readonly height: number;
}

export interface ViewportZoomLimits {
	readonly minZoom: number;
	readonly maxZoom: number;
}

export interface ViewportControllerOptions extends Partial<ViewportZoomLimits> {
	/** Multiplicative factor for one zoomIn/zoomOut step. */
	readonly zoomStep?: number;
	readonly resetZoom?: number;
	readonly coordinateMode?: ViewportCoordinateMode;
	/** Alias accepted for callers that call the mode a viewport origin. */
	readonly viewportMode?: ViewportCoordinateMode;
	readonly viewportOrigin?: ViewportCoordinateMode;
	/** Enable the reversible native tZoom unclamp patch (default: true). */
	readonly patchNativeCamera?: boolean;
	readonly viewportSize?: ViewportSize;
	readonly getViewportSize?: () => ViewportSize | undefined;
	readonly contentBounds?: unknown;
	readonly getContentBounds?: () => unknown;
	/** Extra fit padding in screen pixels. */
	readonly fitPadding?: number;
}

export type ViewportDiagnosticLevel = "info" | "warning" | "error";

export interface ViewportDiagnostic {
	readonly code: string;
	readonly level: ViewportDiagnosticLevel;
	readonly message: string;
	readonly capability?: string;
}

export type ViewportControllerStatus = "ready" | "unavailable" | "incompatible";

export interface ViewportCapabilityProbe {
	readonly status: ViewportControllerStatus;
	readonly state: ViewportControllerStatus;
	readonly available: boolean;
	readonly compatible: boolean;
	readonly viewport: boolean;
	readonly viewportMutation: boolean;
	readonly capabilities: ReadonlySet<string>;
	readonly coordinateMode?: ViewportCoordinateMode;
	readonly diagnostics: readonly ViewportDiagnostic[];
}

/**
 * The smallest adapter surface needed by this module.  CanvasAdapter is the
 * normal implementation, while this interface makes the math easy to use in
 * tests and with a future adapter that has the same safe boundary.
 */
export interface ViewportAdapterLike {
	readonly status?: string;
	readonly capabilities?: ReadonlySet<string> | readonly string[];
	readonly diagnostics?: readonly ViewportDiagnostic[];
	getViewport(): unknown;
	setViewport(viewport: ViewportTransform): boolean;
	dispose?(): void;
	supports?(capability: string): boolean;
}

type UnknownRecord = Record<PropertyKey, unknown>;

const NO_VALUE = Symbol("viewport-no-value");

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

function numberOrUndefined(value: unknown): number | undefined {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		return undefined;
	}
	return value === 0 ? 0 : value;
}

function clampCoordinate(value: number): number {
	if (value === 0) {
		return 0;
	}
	if (value > MAX_SAFE_CAMERA_COORDINATE) {
		return MAX_SAFE_CAMERA_COORDINATE;
	}
	if (value < -MAX_SAFE_CAMERA_COORDINATE) {
		return -MAX_SAFE_CAMERA_COORDINATE;
	}
	return value;
}

function clampPositive(value: number, min: number, max: number): number {
	if (!Number.isFinite(value)) {
		return min;
	}
	return Math.min(max, Math.max(min, value));
}

function readMode(options: unknown): ViewportCoordinateMode {
	return configuredMode(options) ?? "transform";
}

function configuredMode(options: unknown): ViewportCoordinateMode | undefined {
	for (const key of ["coordinateMode", "viewportMode", "viewportOrigin"] as const) {
		const value = safeRead(options, key);
		if (value === "center" || value === "transform") {
			return value;
		}
	}
	return undefined;
}

function copyViewport(value: unknown): Record<string, unknown> {
	const result: Record<string, unknown> = {};
	if (!isObject(value)) {
		return result;
	}
	try {
		for (const key of Reflect.ownKeys(value)) {
			if (typeof key !== "string") {
				continue;
			}
			const entry = safeRead(value, key);
			if (entry !== NO_VALUE) {
				result[key] = entry;
			}
		}
	} catch {
		// A hostile/revoked proxy is intentionally copied as an empty object.
	}
	return result;
}

function normalizeViewport(value: unknown, minZoom: number, maxZoom: number): ViewportTransform | undefined {
	if (!isObject(value)) {
		return undefined;
	}
	const x = numberOrUndefined(safeRead(value, "x"));
	const y = numberOrUndefined(safeRead(value, "y"));
	const zoom = numberOrUndefined(safeRead(value, "zoom"))
		?? numberOrUndefined(safeRead(value, "scale"));
	if (x === undefined || y === undefined || zoom === undefined || zoom <= 0) {
		return undefined;
	}
	const result = copyViewport(value);
	result.x = clampCoordinate(x);
	result.y = clampCoordinate(y);
	result.zoom = clampPositive(zoom, minZoom, maxZoom);
	for (const key of ["width", "height"] as const) {
		const size = numberOrUndefined(safeRead(value, key));
		if (size !== undefined && size > 0) {
			result[key] = Math.min(size, MAX_SAFE_CAMERA_COORDINATE);
		} else {
			delete result[key];
		}
	}
	return result as ViewportTransform;
}

function diagnostic(
	code: string,
	message: string,
	level: ViewportDiagnosticLevel = "warning",
	capability?: string,
): ViewportDiagnostic {
	return { code, level, message, ...(capability === undefined ? {} : { capability }) };
}

function safeDiagnostics(source: unknown): readonly ViewportDiagnostic[] {
	const value = safeRead(source, "diagnostics");
	if (value === NO_VALUE || value === undefined || value === null) {
		return [];
	}
	const result: ViewportDiagnostic[] = [];
	try {
		if (!Array.isArray(value)) {
			return result;
		}
		const length = Math.min(value.length, 10_000);
		for (let index = 0; index < length; index += 1) {
			const item = value[index];
			if (isObject(item)) {
				const code = safeRead(item, "code");
				const message = safeRead(item, "message");
				if (typeof code === "string" && typeof message === "string") {
					const level = safeRead(item, "level");
					const capability = safeRead(item, "capability");
					result.push({
						code,
						message,
						level: level === "info" || level === "error" ? level : "warning",
						...(typeof capability === "string" ? { capability } : {}),
					});
				}
			}
		}
	} catch {
		return result;
	}
	return result;
}

function capabilitiesFromAdapter(source: unknown): Set<string> {
	const result = new Set<string>();
	const raw = safeRead(source, "capabilities");
	if (raw !== NO_VALUE && raw !== undefined && raw !== null) {
		try {
			if (raw instanceof Set || raw instanceof Map) {
				for (const value of raw.keys()) {
					if (typeof value === "string") {
						result.add(value);
					}
				}
			} else if (Array.isArray(raw)) {
				for (let index = 0; index < Math.min(raw.length, 10_000); index += 1) {
					const value = raw[index];
					if (typeof value === "string") {
						result.add(value);
					}
				}
			}
		} catch {
			// Capability sets are advisory; failed reads stay fail-closed.
		}
	}
	const supports = safeRead(source, "supports");
	if (typeof supports === "function") {
		for (const capability of [CANVAS_CAPABILITIES.viewport, CANVAS_CAPABILITIES.viewportMutation]) {
			try {
				if (Reflect.apply(supports, source, [capability]) === true) {
					result.add(capability);
				}
			} catch {
				// Keep the capability absent.
			}
		}
	}
	return result;
}

function isCanvasAdapter(value: unknown): value is CanvasAdapter {
	try {
		return value instanceof CanvasAdapter;
	} catch {
		return false;
	}
}

function looksLikeViewportAdapter(value: unknown): value is ViewportAdapterLike {
	return typeof safeRead(value, "getViewport") === "function"
		&& typeof safeRead(value, "setViewport") === "function";
}

function resolveAdapter(source: unknown, patchNativeCamera = true): ViewportAdapterLike | undefined {
	if (isCanvasAdapter(source)) {
		return source;
	}
	if (looksLikeViewportAdapter(source)) {
		return source;
	}
	try {
		return createCanvasAdapter(source, { patchNativeCamera });
	} catch {
		return undefined;
	}
}

interface ProbeContext {
	readonly adapter?: ViewportAdapterLike;
	readonly capabilities: Set<string>;
	readonly diagnostics: ViewportDiagnostic[];
	readonly coordinateMode?: ViewportCoordinateMode;
}

function probeAdapter(source: unknown, patchNativeCamera = true): ProbeContext {
	const adapter = resolveAdapter(source, patchNativeCamera);
	const diagnostics = [...safeDiagnostics(adapter)];
	if (adapter === undefined) {
		diagnostics.push(diagnostic("viewport-adapter-unavailable", "The native Canvas viewport adapter could not be created.", "info"));
		return { adapter, capabilities: new Set(), diagnostics };
	}
	const capabilities = capabilitiesFromAdapter(adapter);
	// A structural test double may not expose capability metadata.  Presence of
	// both safe methods is sufficient for that narrow adapter boundary.
	// CanvasAdapter always exposes safe method names, even when it wraps an
	// absent/incompatible runtime.  Only a non-CanvasAdapter structural test
	// double gets this narrow fallback; absence must remain unavailable.
	if (!isCanvasAdapter(adapter) && capabilities.size === 0 && looksLikeViewportAdapter(adapter)) {
		capabilities.add(CANVAS_CAPABILITIES.viewport);
		capabilities.add(CANVAS_CAPABILITIES.viewportMutation);
	}
	const hasViewport = capabilities.has(CANVAS_CAPABILITIES.viewport);
	const hasMutation = capabilities.has(CANVAS_CAPABILITIES.viewportMutation);
	if (!hasViewport) {
		diagnostics.push(diagnostic(
			"viewport-capability-unavailable",
			"The native Canvas viewport is unavailable; navigation is disabled.",
			"warning",
			CANVAS_CAPABILITIES.viewport,
		));
	}
	if (!hasMutation) {
		diagnostics.push(diagnostic(
			"viewport-mutation-unavailable",
			"The native Canvas viewport mutation API is unavailable; navigation is disabled.",
			"warning",
			CANVAS_CAPABILITIES.viewportMutation,
		));
	}
	let coordinateMode: ViewportCoordinateMode | undefined;
	const camera = safeRead(adapter, "camera");
	const cameraMode = safeRead(camera, "coordinateMode");
	if (cameraMode === "center" || cameraMode === "transform") {
		coordinateMode = cameraMode;
	}
	return { adapter, capabilities, diagnostics, ...(coordinateMode === undefined ? {} : { coordinateMode }) };
}

function probeStatus(context: ProbeContext): ViewportCapabilityProbe {
	const viewport = context.capabilities.has(CANVAS_CAPABILITIES.viewport);
	const viewportMutation = context.capabilities.has(CANVAS_CAPABILITIES.viewportMutation);
	let status: ViewportControllerStatus;
	if (context.adapter === undefined) {
		status = "unavailable";
	} else if (viewport && viewportMutation) {
		status = "ready";
	} else {
		const adapterStatus = safeRead(context.adapter, "status");
		status = adapterStatus === "unavailable" ? "unavailable" : "incompatible";
	}
	return {
		status,
		state: status,
		available: status === "ready",
		compatible: status !== "incompatible",
		viewport,
		viewportMutation,
		capabilities: new Set(context.capabilities),
		...(context.coordinateMode === undefined ? {} : { coordinateMode: context.coordinateMode }),
		diagnostics: [...context.diagnostics],
	};
}

export function probeViewportController(source: unknown): ViewportCapabilityProbe {
	// Probing is a read-only capability check.  A controller instance opts into
	// the scoped native patch when it is actually used for navigation.
	return probeStatus(probeAdapter(source, false));
}

export const probeViewport = probeViewportController;
export const probeCanvasViewport = probeViewportController;

function readOptionsNumber(options: unknown, key: PropertyKey): number | undefined {
	return numberOrUndefined(safeRead(options, key));
}

function readOptionsBoolean(options: unknown, key: PropertyKey): boolean | undefined {
	const value = safeRead(options, key);
	return value === true || value === false ? value : undefined;
}

function validLimits(options: unknown): ViewportZoomLimits {
	const configuredMin = readOptionsNumber(options, "minZoom");
	const configuredMax = readOptionsNumber(options, "maxZoom");
	let minZoom = configuredMin !== undefined && configuredMin > 0 ? configuredMin : DEFAULT_MIN_ZOOM;
	let maxZoom = configuredMax !== undefined && configuredMax > 0 ? configuredMax : DEFAULT_MAX_ZOOM;
	if (minZoom > maxZoom) {
		[minZoom, maxZoom] = [maxZoom, minZoom];
	}
	// Avoid an unusable range when hostile input supplied a denormalized value.
	minZoom = clampPositive(minZoom, Number.MIN_VALUE, Number.MAX_VALUE);
	maxZoom = clampPositive(maxZoom, minZoom, Number.MAX_VALUE);
	return { minZoom, maxZoom };
}

function finiteSteps(value: unknown): number {
	const numeric = numberOrUndefined(value);
	if (numeric === undefined || numeric === 0) {
		return 1;
	}
	// Keep malformed/unbounded input finite, but allow the full configured
	// range to be traversed: from 2^-12 to 2^8 is 80 quarter-steps.
	return Math.min(1024, Math.max(1, Math.floor(Math.abs(numeric))));
}

function normalizeSize(value: unknown): ViewportSize | undefined {
	if (!isObject(value)) {
		return undefined;
	}
	const width = numberOrUndefined(safeRead(value, "width"));
	const height = numberOrUndefined(safeRead(value, "height"));
	if (width === undefined || height === undefined || width <= 0 || height <= 0) {
		return undefined;
	}
	return {
		width: Math.min(width, MAX_SAFE_CAMERA_COORDINATE),
		height: Math.min(height, MAX_SAFE_CAMERA_COORDINATE),
	};
}

function pointNumber(value: unknown, key: string): number | undefined {
	if (!isObject(value)) {
		return undefined;
	}
	return numberOrUndefined(safeRead(value, key));
}

export interface ViewportPoint {
	readonly x: number;
	readonly y: number;
}

function normalizePoint(value: unknown): ViewportPoint | undefined {
	const x = pointNumber(value, "x");
	const y = pointNumber(value, "y");
	return x === undefined || y === undefined ? undefined : { x, y };
}

export class ViewportController {
	public readonly kind = "viewport-controller" as const;
	private readonly adapter: ViewportAdapterLike | undefined;
	private readonly capabilitySet: Set<string>;
	private readonly diagnosticList: ViewportDiagnostic[];
	private readonly diagnosticKeys: Set<string>;
	private readonly coordinateModeValue: ViewportCoordinateMode;
	private readonly minZoomValue: number;
	private readonly maxZoomValue: number;
	private readonly resetZoomLevel: number;
	private readonly zoomStepValue: number;
	private readonly options: unknown;
	private readonly initialStatus: ViewportCapabilityProbe;
	private disposed = false;

	public constructor(source: unknown, options: ViewportControllerOptions = {}) {
		this.options = options;
		const context = probeAdapter(source, readOptionsBoolean(options, "patchNativeCamera") ?? true);
		this.adapter = context.adapter;
		this.capabilitySet = new Set(context.capabilities);
		this.diagnosticList = [...context.diagnostics];
		this.diagnosticKeys = new Set(this.diagnosticList.map((item) => this.diagnosticKey(item)));
		const limits = validLimits(options);
		this.minZoomValue = limits.minZoom;
		this.maxZoomValue = limits.maxZoom;
		const configuredReset = readOptionsNumber(options, "resetZoom");
		this.resetZoomLevel = clampPositive(
			configuredReset !== undefined && configuredReset > 0 ? configuredReset : DEFAULT_RESET_ZOOM,
			this.minZoomValue,
			this.maxZoomValue,
		);
		const configuredStep = readOptionsNumber(options, "zoomStep");
		this.zoomStepValue = configuredStep !== undefined && configuredStep > 1 && Number.isFinite(configuredStep)
			? Math.min(configuredStep, 16)
			: DEFAULT_ZOOM_STEP;
		// An explicit option is authoritative.  Otherwise use the adapter's
		// feature-detected native semantics (`tx`/`ty` are a board center), and
		// keep transform mode for generic adapter objects.
		this.coordinateModeValue = configuredMode(options) ?? context.coordinateMode ?? "transform";
		this.initialStatus = probeStatus({
			adapter: this.adapter,
			capabilities: this.capabilitySet,
			diagnostics: this.diagnosticList,
		});
	}

	public static probe(source: unknown): ViewportCapabilityProbe {
		return probeViewportController(source);
	}

	public get status(): ViewportControllerStatus {
		return this.disposed ? "unavailable" : this.initialStatus.status;
	}

	public get state(): ViewportControllerStatus {
		return this.status;
	}

	public get available(): boolean {
		return !this.disposed && this.initialStatus.available;
	}

	public get compatible(): boolean {
		return !this.disposed && this.initialStatus.compatible;
	}

	public get disabled(): boolean {
		return !this.available;
	}

	public get capabilities(): ReadonlySet<string> {
		return new Set(this.capabilitySet);
	}

	public get diagnostics(): readonly ViewportDiagnostic[] {
		return [...this.diagnosticList];
	}

	public get capabilityProbe(): ViewportCapabilityProbe {
		return {
			...this.initialStatus,
			status: this.status,
			state: this.status,
			available: this.available,
			compatible: this.compatible,
			capabilities: new Set(this.capabilitySet),
			diagnostics: [...this.diagnosticList],
		};
	}

	public get minZoom(): number {
		return this.minZoomValue;
	}

	public get maxZoom(): number {
		return this.maxZoomValue;
	}

	public get resetZoomValue(): number {
		return this.resetZoomLevel;
	}

	public get zoomStep(): number {
		return this.zoomStepValue;
	}

	public get coordinateMode(): ViewportCoordinateMode {
		return this.coordinateModeValue;
	}

	/** Release the adapter's reversible native camera patch. */
	public dispose(): void {
		if (this.disposed) {
			return;
		}
		this.disposed = true;
		const dispose = safeRead(this.adapter, "dispose");
		if (typeof dispose !== "function") {
			return;
		}
		try {
			Reflect.apply(dispose, this.adapter, []);
		} catch {
			this.addDiagnostic(diagnostic("viewport-dispose-failed", "Releasing the native Canvas camera failed."));
		}
	}

	private diagnosticKey(item: ViewportDiagnostic): string {
		return `${item.code}:${item.capability ?? ""}:${item.message}`;
	}

	private addDiagnostic(item: ViewportDiagnostic): void {
		const key = this.diagnosticKey(item);
		if (!this.diagnosticKeys.has(key)) {
			this.diagnosticKeys.add(key);
			this.diagnosticList.push(item);
		}
	}

	private readCurrent(): ViewportTransform | undefined {
		if (this.adapter === undefined || !this.capabilitySet.has(CANVAS_CAPABILITIES.viewport)) {
			this.addDiagnostic(diagnostic(
				"viewport-capability-unavailable",
				"The native Canvas viewport is unavailable; navigation is disabled.",
				"warning",
				CANVAS_CAPABILITIES.viewport,
			));
			return undefined;
		}
		const result = safeCall(this.adapter, "getViewport", []);
		if (!result.ok) {
			this.addDiagnostic(diagnostic(
				"viewport-read-failed",
				"Reading the native Canvas viewport failed; navigation is disabled.",
				"warning",
				CANVAS_CAPABILITIES.viewport,
			));
			return undefined;
		}
		const viewport = normalizeViewport(result.value, this.minZoomValue, this.maxZoomValue);
		if (viewport === undefined) {
			this.addDiagnostic(diagnostic(
				"viewport-invalid",
				"The native Canvas returned an invalid viewport; navigation is disabled.",
				"warning",
				CANVAS_CAPABILITIES.viewport,
			));
		}
		return viewport;
	}

	/** Read a safe, normalized snapshot of the native camera. */
	public getViewport(): ViewportTransform | undefined {
		return this.readCurrent();
	}

	public readViewport(): ViewportTransform | undefined {
		return this.getViewport();
	}

	public get currentViewport(): ViewportTransform | undefined {
		return this.getViewport();
	}

	private configuredViewportSize(): ViewportSize | undefined {
		const callback = safeRead(this.options, "getViewportSize");
		if (typeof callback === "function") {
			try {
				const result = Reflect.apply(callback, this.options, []);
				const normalized = normalizeSize(result);
				if (normalized !== undefined) {
					return normalized;
				}
			} catch {
				this.addDiagnostic(diagnostic("viewport-size-read-failed", "Reading the Canvas viewport size failed."));
			}
		}
		return normalizeSize(safeRead(this.options, "viewportSize"));
	}

	private sizeFor(viewport: ViewportTransform): ViewportSize | undefined {
		const fromViewport = normalizeSize(viewport);
		return fromViewport ?? this.configuredViewportSize();
	}

	private apply(viewport: ViewportTransform, action: string): boolean {
		if (this.adapter === undefined || !this.capabilitySet.has(CANVAS_CAPABILITIES.viewportMutation)) {
			this.addDiagnostic(diagnostic(
				"viewport-mutation-unavailable",
				`Cannot ${action}: the native Canvas viewport mutation API is unavailable.`,
				"warning",
				CANVAS_CAPABILITIES.viewportMutation,
			));
			return false;
		}
		const result = safeCall(this.adapter, "setViewport", [viewport]);
		if (!result.ok || result.value === false) {
			this.addDiagnostic(diagnostic(
				"viewport-mutation-failed",
				`Cannot ${action}: the native Canvas viewport mutation failed.`,
				"warning",
				CANVAS_CAPABILITIES.viewportMutation,
			));
			return false;
		}
		return true;
	}

	/** Set a camera while clamping zoom and rejecting invalid coordinates. */
	public setViewport(viewport: unknown): boolean {
		const current = this.readCurrent();
		if (current === undefined) {
			return false;
		}
		const normalized = normalizeViewport(viewport, this.minZoomValue, this.maxZoomValue);
		if (normalized === undefined) {
			this.addDiagnostic(diagnostic("viewport-invalid", "The requested viewport is invalid; no camera change was made."));
			return false;
		}
		return this.apply(normalized, "set the viewport");
	}

	private viewportWithZoom(
		viewport: ViewportTransform,
		zoom: number,
		anchor?: ViewportPoint,
	): ViewportTransform {
		const nextZoom = clampPositive(zoom, this.minZoomValue, this.maxZoomValue);
		const result = copyViewport(viewport);
		const size = this.sizeFor(viewport);
		const point = normalizePoint(anchor);
		if (point !== undefined && size !== undefined) {
			const screenX = point.x;
			const screenY = point.y;
			if (this.coordinateModeValue === "center") {
				const boardX = viewport.x + (screenX - size.width / 2) / viewport.zoom;
				const boardY = viewport.y + (screenY - size.height / 2) / viewport.zoom;
				result.x = clampCoordinate(boardX - (screenX - size.width / 2) / nextZoom);
				result.y = clampCoordinate(boardY - (screenY - size.height / 2) / nextZoom);
			} else {
				const boardX = (screenX - viewport.x) / viewport.zoom;
				const boardY = (screenY - viewport.y) / viewport.zoom;
				result.x = clampCoordinate(screenX - boardX * nextZoom);
				result.y = clampCoordinate(screenY - boardY * nextZoom);
			}
		}
		result.zoom = nextZoom;
		return result as ViewportTransform;
	}

	private zoomAfterSteps(zoom: number, steps: number, direction: 1 | -1): number {
		// Work in the native camera's logarithmic domain.  Multiplying a tiny
		// value by `zoomStep ** steps` is both less accurate and can overflow for
		// hostile step counts before the final clamp gets a chance to run.
		const currentTZoom = Math.log2(zoom);
		const stepTZoom = Math.log2(this.zoomStepValue);
		const targetTZoom = currentTZoom + direction * stepTZoom * finiteSteps(steps);
		const minTZoom = Math.log2(this.minZoomValue);
		const maxTZoom = Math.log2(this.maxZoomValue);
		const bounded = Math.min(maxTZoom, Math.max(minTZoom, targetTZoom));
		const result = 2 ** bounded;
		return Number.isFinite(result) && result > 0
			? result
			: direction > 0 ? this.maxZoomValue : this.minZoomValue;
	}

	/** Set an explicit zoom, optionally keeping a screen point stationary. */
	public zoomTo(zoom: number, anchor?: ViewportPoint): boolean {
		const current = this.readCurrent();
		if (current === undefined || !Number.isFinite(zoom) || zoom <= 0) {
			this.addDiagnostic(diagnostic("zoom-invalid", "The requested zoom is invalid; no camera change was made."));
			return false;
		}
		return this.apply(this.viewportWithZoom(current, zoom, anchor), "change zoom");
	}

	public setZoom(zoom: number, anchor?: ViewportPoint): boolean {
		return this.zoomTo(zoom, anchor);
	}

	public zoomIn(steps = 1, anchor?: ViewportPoint): boolean {
		const current = this.readCurrent();
		if (current === undefined) {
			return false;
		}
		return this.apply(
			this.viewportWithZoom(current, this.zoomAfterSteps(current.zoom, steps, 1), anchor),
			"zoom in",
		);
	}

	public zoomOut(steps = 1, anchor?: ViewportPoint): boolean {
		const current = this.readCurrent();
		if (current === undefined) {
			return false;
		}
		return this.apply(
			this.viewportWithZoom(current, this.zoomAfterSteps(current.zoom, steps, -1), anchor),
			"zoom out",
		);
	}

	public resetZoom(anchor?: ViewportPoint): boolean {
		return this.zoomTo(this.resetZoomLevel, anchor);
	}

	public reset(anchor?: ViewportPoint): boolean {
		return this.resetZoom(anchor);
	}

	/**
	 * Pan by screen pixels by default.  The transform mode mirrors native
	 * Canvas affine translation; center mode converts screen distance to board
	 * units.  Callers that already have board units can pass `"board"`.
	 */
	public panBy(deltaX: number, deltaY: number, space: "screen" | "board" = "screen"): boolean {
		const current = this.readCurrent();
		if (current === undefined || !Number.isFinite(deltaX) || !Number.isFinite(deltaY)) {
			this.addDiagnostic(diagnostic("pan-invalid", "The requested pan is invalid; no camera change was made."));
			return false;
		}
		const scale = space === "board" ? 1 : current.zoom;
		const result = copyViewport(current);
		if (this.coordinateModeValue === "center") {
			result.x = clampCoordinate(current.x + deltaX / scale);
			result.y = clampCoordinate(current.y + deltaY / scale);
		} else {
			result.x = clampCoordinate(current.x + (space === "board" ? deltaX * current.zoom : deltaX));
			result.y = clampCoordinate(current.y + (space === "board" ? deltaY * current.zoom : deltaY));
		}
		return this.apply(result as ViewportTransform, "pan");
	}

	public pan(deltaX: number, deltaY: number, space: "screen" | "board" = "screen"): boolean {
		return this.panBy(deltaX, deltaY, space);
	}

	public panScreen(deltaX: number, deltaY: number): boolean {
		return this.panBy(deltaX, deltaY, "screen");
	}

	private eventValue(event: unknown, key: PropertyKey): unknown {
		return safeRead(event, key);
	}

	/**
	 * Keep the browser's familiar contract: plain wheel pans, Ctrl/Cmd-wheel
	 * zooms around the cursor, and the method only reports whether it handled a
	 * finite event.  It does not call preventDefault or touch persistence.
	 */
	public handleWheel(event: unknown): boolean {
		const deltaY = numberOrUndefined(this.eventValue(event, "deltaY"));
		const rawDeltaX = numberOrUndefined(this.eventValue(event, "deltaX")) ?? 0;
		if (deltaY === undefined || !Number.isFinite(rawDeltaX)) {
			return false;
		}
		const deltaMode = this.eventValue(event, "deltaMode");
		const size = this.configuredViewportSize();
		const multiplier = deltaMode === 1 ? 16 : deltaMode === 2 ? (size?.height ?? 800) : 1;
		const adjustedY = deltaY * multiplier;
		const adjustedX = rawDeltaX * multiplier;
		const ctrl = this.eventValue(event, "ctrlKey") === true;
		const meta = this.eventValue(event, "metaKey") === true;
		if (ctrl || meta) {
			const anchor = normalizePoint({
				x: numberOrUndefined(this.eventValue(event, "offsetX"))
					?? numberOrUndefined(this.eventValue(event, "clientX")),
				y: numberOrUndefined(this.eventValue(event, "offsetY"))
					?? numberOrUndefined(this.eventValue(event, "clientY")),
			});
			const factor = Math.pow(2, -adjustedY / 240);
			return this.zoomTo((this.getViewport()?.zoom ?? this.resetZoomLevel) * factor, anchor);
		}
		const shift = this.eventValue(event, "shiftKey") === true;
		return this.panBy(shift && adjustedX === 0 ? adjustedY : adjustedX, shift && adjustedX === 0 ? 0 : adjustedY);
	}

	public onWheel(event: unknown): boolean {
		return this.handleWheel(event);
	}

	public wheel(event: unknown): boolean {
		return this.handleWheel(event);
	}

	private resolveSize(viewport: ViewportTransform, explicit?: unknown): ViewportSize | undefined {
		return normalizeSize(explicit) ?? this.sizeFor(viewport);
	}

	private resolveBounds(explicit?: unknown): { x: number; y: number; width: number; height: number } | undefined {
		let source = explicit !== undefined ? explicit : safeRead(this.options, "contentBounds");
		if (source === NO_VALUE || source === undefined) {
			const getter = safeRead(this.options, "getContentBounds");
			if (typeof getter === "function") {
				try {
					source = Reflect.apply(getter, this.options, []);
				} catch {
					this.addDiagnostic(diagnostic("content-bounds-read-failed", "Reading content bounds failed; fit was skipped."));
					return undefined;
				}
			}
		}
		if (!isObject(source)) {
			return undefined;
		}
		const x = numberOrUndefined(safeRead(source, "x"));
		const y = numberOrUndefined(safeRead(source, "y"));
		const width = numberOrUndefined(safeRead(source, "width"));
		const height = numberOrUndefined(safeRead(source, "height"));
		if (x === undefined || y === undefined || width === undefined || height === undefined || width < 0 || height < 0) {
			return undefined;
		}
		return {
			x: clampCoordinate(x),
			y: clampCoordinate(y),
			width: Math.min(width, MAX_SAFE_CAMERA_COORDINATE),
			height: Math.min(height, MAX_SAFE_CAMERA_COORDINATE),
		};
	}

	/** Fit a content rectangle into the current/configured screen viewport. */
	public fitToBounds(bounds?: unknown, viewportSize?: unknown): boolean {
		const current = this.readCurrent();
		const content = this.resolveBounds(bounds);
		if (current === undefined || content === undefined) {
			this.addDiagnostic(diagnostic("fit-unavailable", "Fit requires a valid viewport and content bounds; no camera change was made."));
			return false;
		}
		const size = this.resolveSize(current, viewportSize);
		if (size === undefined) {
			this.addDiagnostic(diagnostic("viewport-size-unavailable", "Fit requires a valid Canvas viewport size; no camera change was made."));
			return false;
		}
		const paddingValue = readOptionsNumber(this.options, "fitPadding");
		const padding = paddingValue !== undefined && paddingValue >= 0 && Number.isFinite(paddingValue)
			? Math.min(paddingValue, Math.min(size.width, size.height) / 2)
			: 32;
		const availableWidth = Math.max(1, size.width - padding * 2);
		const availableHeight = Math.max(1, size.height - padding * 2);
		const contentWidth = Math.max(content.width, Number.MIN_VALUE);
		const contentHeight = Math.max(content.height, Number.MIN_VALUE);
		const fittedZoom = clampPositive(
			Math.min(availableWidth / contentWidth, availableHeight / contentHeight),
			this.minZoomValue,
			this.maxZoomValue,
		);
		const centerX = content.x + content.width / 2;
		const centerY = content.y + content.height / 2;
		const result = copyViewport(current);
		result.zoom = fittedZoom;
		if (this.coordinateModeValue === "center") {
			result.x = clampCoordinate(centerX);
			result.y = clampCoordinate(centerY);
		} else {
			result.x = clampCoordinate(size.width / 2 - centerX * fittedZoom);
			result.y = clampCoordinate(size.height / 2 - centerY * fittedZoom);
		}
		return this.apply(result as ViewportTransform, "fit the board");
	}

	public fitToContent(bounds?: unknown, viewportSize?: unknown): boolean {
		return this.fitToBounds(bounds, viewportSize);
	}

	public fit(bounds?: unknown, viewportSize?: unknown): boolean {
		return this.fitToBounds(bounds, viewportSize);
	}

	public fitBoard(bounds?: unknown, viewportSize?: unknown): boolean {
		return this.fitToBounds(bounds, viewportSize);
	}

	/** Convert a screen point to board coordinates using the current camera. */
	public screenToBoard(point: ViewportPoint): ViewportPoint | undefined {
		const viewport = this.readCurrent();
		const size = viewport === undefined ? undefined : this.sizeFor(viewport);
		const normalizedPoint = normalizePoint(point);
		if (viewport === undefined || normalizedPoint === undefined) {
			return undefined;
		}
		if (this.coordinateModeValue === "center" && size !== undefined) {
			return {
				x: clampCoordinate(viewport.x + (normalizedPoint.x - size.width / 2) / viewport.zoom),
				y: clampCoordinate(viewport.y + (normalizedPoint.y - size.height / 2) / viewport.zoom),
			};
		}
		return {
			x: clampCoordinate((normalizedPoint.x - viewport.x) / viewport.zoom),
			y: clampCoordinate((normalizedPoint.y - viewport.y) / viewport.zoom),
		};
	}

	public boardToScreen(point: ViewportPoint): ViewportPoint | undefined {
		const viewport = this.readCurrent();
		const size = viewport === undefined ? undefined : this.sizeFor(viewport);
		const normalizedPoint = normalizePoint(point);
		if (viewport === undefined || normalizedPoint === undefined) {
			return undefined;
		}
		if (this.coordinateModeValue === "center" && size !== undefined) {
			return {
				x: (normalizedPoint.x - viewport.x) * viewport.zoom + size.width / 2,
				y: (normalizedPoint.y - viewport.y) * viewport.zoom + size.height / 2,
			};
		}
		return {
			x: normalizedPoint.x * viewport.zoom + viewport.x,
			y: normalizedPoint.y * viewport.zoom + viewport.y,
		};
	}
}

export function createViewportController(
	source: unknown,
	options: ViewportControllerOptions = {},
): ViewportController {
	return new ViewportController(source, options);
}

export const createCanvasViewportController = createViewportController;
export const createNativeViewportController = createViewportController;
export const ViewportControllerAdapter = ViewportController;
