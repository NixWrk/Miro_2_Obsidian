/**
 * A deliberately small, structural boundary around Obsidian's Canvas view.
 *
 * Obsidian does not expose the Canvas runtime internals used by the features
 * this plugin eventually needs.  The shape of those internals can therefore
 * change between Obsidian releases.  This module is the only place where we
 * probe them.  Callers receive a capability set and diagnostics and can keep
 * working when one capability is unavailable.
 *
 * There is intentionally no import from `obsidian` here.  Apart from making
 * this file easy to test, that keeps the adapter useful with a mocked view and
 * prevents private runtime types from leaking into feature modules.
 */

export type AdapterStatus = "ready" | "unavailable" | "incompatible";

/** Explicit name for consumers that want to distinguish adapter status. */
export type CanvasAdapterStatus = AdapterStatus;

export type DiagnosticLevel = "info" | "warning" | "error";

export interface AdapterDiagnostic {
	readonly code: string;
	readonly level: DiagnosticLevel;
	readonly message: string;
	readonly capability?: string;
}

export type CanvasAdapterDiagnostic = AdapterDiagnostic;

/**
 * Capability names are semantic rather than names of Obsidian methods.  This
 * means a future runtime can expose the same capability through a different
 * private method without changing the rest of the plugin.
 */
export const CANVAS_CAPABILITIES = {
	rootElement: "rootElement",
	scene: "scene",
	viewport: "viewport",
	/** The private Obsidian Canvas camera (`tx`, `ty`, `tZoom`). */
	nativeCamera: "nativeCamera",
	document: "document",
	selection: "selection",
	events: "events",
	viewportMutation: "viewportMutation",
	render: "render",
	persistence: "persistence",
} as const;

export type CanvasCapability =
	(typeof CANVAS_CAPABILITIES)[keyof typeof CANVAS_CAPABILITIES];

/** The two camera coordinate contracts understood by the feature modules. */
export type CanvasCoordinateMode = "transform" | "center";

/** Native Canvas stores the zoom as log2 while JSON-facing code uses scale. */
export type CanvasZoomMode = "linear" | "log2";

export interface CanvasCameraFeatures {
	/** `native` is the observed Obsidian private camera; `generic` is an adapter object. */
	readonly kind: "native" | "generic";
	readonly coordinateMode: CanvasCoordinateMode;
	readonly zoomMode: CanvasZoomMode;
	/** The exact call shape used by `CanvasAdapter.setViewport`. */
	readonly mutation: "positional" | "object" | "unsupported";
}

/** A viewport in board coordinates. */
export interface CanvasViewport {
	readonly x: number;
	readonly y: number;
	readonly zoom: number;
	/** Native Canvas' logarithmic zoom, when this is a native camera snapshot. */
	readonly tZoom?: number;
	/** Native aliases retained as evidence, never used as a generic fallback. */
	readonly tx?: number;
	readonly ty?: number;
	readonly coordinateMode?: CanvasCoordinateMode;
	readonly zoomMode?: CanvasZoomMode;
	readonly width?: number;
	readonly height?: number;
	readonly [key: string]: unknown;
}

export interface CanvasScene {
	readonly nodes: readonly unknown[];
	readonly edges: readonly unknown[];
}

export interface CanvasAdapterOptions {
	/**
	 * Additional capabilities required by a caller.  The adapter still starts
	 * in a safe state when they are missing; it only reports the missing ones.
	 */
	readonly requiredCapabilities?: readonly CanvasCapability[];
	/**
	 * Patch the exact native camera method when possible so values below the
	 * stock Canvas clamp remain usable.  The patch is instance-safe and is
	 * restored by `dispose`; `false` is useful for read-only integration tests.
	 */
	readonly patchNativeCamera?: boolean;
}

export interface CanvasAdapterProbe {
	readonly status: AdapterStatus;
	readonly available: boolean;
	readonly compatible: boolean;
	readonly capabilities: ReadonlySet<CanvasCapability>;
	readonly camera?: CanvasCameraFeatures;
	readonly diagnostics: readonly AdapterDiagnostic[];
}

type UnknownRecord = Record<PropertyKey, unknown>;

interface MutableProbe {
	status: AdapterStatus;
	readonly capabilities: Set<CanvasCapability>;
	readonly diagnostics: AdapterDiagnostic[];
	readonly diagnosticKeys: Set<string>;
}

type SafeCallResult =
	| { readonly ok: true; readonly value: unknown }
	| { readonly ok: false };

type SafeReadResult =
	| { readonly ok: true; readonly value: unknown }
	| { readonly ok: false };

const ROOT_KEYS = ["wrapperEl", "containerEl", "rootEl", "canvasEl", "element"] as const;
const SCENE_NODE_KEYS = ["nodes", "getNodes"] as const;
const SCENE_EDGE_KEYS = ["edges", "getEdges"] as const;
// These are the two Canvas runtime names observed across supported Obsidian
// versions.  Keep this list deliberately narrow: a guessed alias could read
// an unrelated plugin object and make metadata persistence unsafe.
const DOCUMENT_METHOD_KEYS = ["getData"] as const;
const DOCUMENT_VALUE_KEYS = ["data"] as const;
const VIEWPORT_METHOD_KEYS = ["getViewport", "getViewportTransform", "getViewBox"] as const;
const VIEWPORT_VALUE_KEYS = ["viewport", "viewBox", "transform"] as const;
const SELECTION_KEYS = ["selection", "selectedNodes", "selectedElements", "getSelection"] as const;
const MAX_COLLECTION_ITEMS = 100_000;

/**
 * These limits are deliberately expressed in native `tZoom` units.  They
 * match the local canvas-zoom-unlock reference (2^-12 through 2^8), while
 * keeping an accidental hostile value from overflowing `2 ** tZoom`.
 */
export const NATIVE_MIN_T_ZOOM = -12;
export const NATIVE_MAX_T_ZOOM = 8;

/**
 * Bounds enforced by the native Canvas render-frame path.  The old
 * zoom-unlock workaround toggled `screenshotting` to skip this clamp, but
 * that flag changes rendering/virtualisation semantics and is deliberately
 * not touched by this adapter.  Native navigation therefore reports and
 * honours this narrower safe range; generic adapters may still use the full
 * controller range.
 */
export const NATIVE_SAFE_MIN_T_ZOOM = -4;
export const NATIVE_SAFE_MAX_T_ZOOM = 1;

const NATIVE_CAMERA_PATCH_KEY = "setViewport" as const;

interface NativeCameraShape {
	readonly tx: number;
	readonly ty: number;
	readonly tZoom: number;
	readonly setViewport: (...args: readonly unknown[]) => unknown;
}

interface NativeCameraPatch {
	/** The one Canvas instance whose method is shadowed. */
	readonly runtime: UnknownRecord;
	/** `true` when setViewport was already an own property. */
	readonly hadOwnMethod: boolean;
	readonly originalDescriptor?: PropertyDescriptor;
	/** The method resolved before this scoped instance patch was installed. */
	readonly originalMethod: (...args: unknown[]) => unknown;
	patchedMethod: (...args: unknown[]) => unknown;
	refCount: number;
}

/**
 * A patch is scoped to one runtime instance.  Never modify the Canvas
 * prototype: a vault can have several panes backed by the same class and a
 * camera workaround must not change another pane's rendering behavior.
 */
const nativeCameraPatches = new WeakMap<object, NativeCameraPatch>();

function isObject(value: unknown): value is UnknownRecord {
	return (typeof value === "object" && value !== null) || typeof value === "function";
}

function describeError(error: unknown): string {
	// A runtime boundary can hand us a revoked Proxy as the thrown value.  Even
	// `error instanceof Error` and `error.message` may execute Proxy traps, so
	// keep diagnostic formatting defensive too.
	try {
		if (typeof error === "string" && error) {
			return error;
		}
		if (isObject(error)) {
			const message = Reflect.get(error, "message", error);
			if (typeof message === "string" && message) {
				return message;
			}
		}
	} catch {
		// Fall through to the stable generic message below.
	}
	return "unknown error";
}

function describePropertyKey(key: PropertyKey): string {
	try {
		return String(key);
	} catch {
		return "<unprintable key>";
	}
}

function addDiagnostic(
	probe: MutableProbe,
	diagnostic: AdapterDiagnostic,
): void {
	const key = `${diagnostic.code}:${diagnostic.capability ?? ""}:${diagnostic.message}`;
	if (probe.diagnosticKeys.has(key)) {
		return;
	}
	probe.diagnosticKeys.add(key);
	probe.diagnostics.push(diagnostic);
}

function warnUnsupported(
	probe: MutableProbe,
	capability: string,
	message = `Canvas capability "${capability}" is unavailable in this runtime.`,
): void {
	addDiagnostic(probe, {
		code: "native-capability-unavailable",
		level: "warning",
		message,
		capability,
	});
}

function safeReadResult(
	target: unknown,
	key: PropertyKey,
	probe: MutableProbe,
	capability?: string,
): SafeReadResult {
	if (!isObject(target)) {
		return { ok: false };
	}
	try {
		return { ok: true, value: Reflect.get(target, key, target) };
	} catch (error) {
		addDiagnostic(probe, {
			code: "native-probe-failed",
			level: "warning",
			message: `Reading Canvas runtime property "${describePropertyKey(key)}" failed: ${describeError(error)}.`,
			capability,
		});
		return { ok: false };
	}
}

function safeRead(
	target: unknown,
	key: PropertyKey,
	probe: MutableProbe,
	capability?: string,
): unknown {
	const result = safeReadResult(target, key, probe, capability);
	return result.ok ? result.value : undefined;
}

function safeCallResult(
	target: unknown,
	method: PropertyKey,
	args: readonly unknown[],
	probe: MutableProbe,
	capability?: string,
): SafeCallResult {
	const candidate = safeRead(target, method, probe, capability);
	if (typeof candidate !== "function") {
		return { ok: false };
	}
	try {
		return { ok: true, value: Reflect.apply(candidate, target, [...args]) };
	} catch (error) {
		addDiagnostic(probe, {
			code: "native-operation-failed",
			level: "warning",
			message: `Calling Canvas runtime method "${describePropertyKey(method)}" failed: ${describeError(error)}.`,
			capability,
		});
		return { ok: false };
	}
}

function safeCall(
	target: unknown,
	method: PropertyKey,
	args: readonly unknown[],
	probe: MutableProbe,
	capability?: string,
): unknown {
	const result = safeCallResult(target, method, args, probe, capability);
	return result.ok ? result.value : undefined;
}

function safeOwnDescriptor(target: object, key: PropertyKey): PropertyDescriptor | undefined {
	try {
		return Object.getOwnPropertyDescriptor(target, key);
	} catch {
		return undefined;
	}
}

function nativeCameraShape(runtime: unknown, probe?: MutableProbe): NativeCameraShape | undefined {
	if (!isObject(runtime)) {
		return undefined;
	}
	const read = (key: PropertyKey): unknown => probe === undefined
		? (() => {
			try {
				return Reflect.get(runtime, key, runtime);
			} catch {
				return undefined;
			}
		})()
		: safeRead(runtime, key, probe, CANVAS_CAPABILITIES.nativeCamera);
	const tx = toFiniteNumber(read("tx"));
	const ty = toFiniteNumber(read("ty"));
	const tZoom = toFiniteNumber(read("tZoom"));
	const setViewport = read("setViewport");
	if (tx === undefined || ty === undefined || tZoom === undefined || typeof setViewport !== "function") {
		return undefined;
	}
	return { tx, ty, tZoom, setViewport: setViewport as (...args: readonly unknown[]) => unknown };
}

function nativeZoomToScale(tZoom: number): number | undefined {
	if (!Number.isFinite(tZoom) || tZoom < -1022 || tZoom > 1023) {
		return undefined;
	}
	const zoom = 2 ** tZoom;
	return Number.isFinite(zoom) && zoom > 0 ? zoom : undefined;
}

function nativeScaleToZoom(zoom: number): number | undefined {
	if (!Number.isFinite(zoom) || zoom <= 0) {
		return undefined;
	}
	const tZoom = Math.log2(zoom);
	return Number.isFinite(tZoom) ? tZoom : undefined;
}

function clampNativeSafeTZoom(tZoom: number): number {
	if (!Number.isFinite(tZoom)) {
		return 0;
	}
	return Math.min(NATIVE_SAFE_MAX_T_ZOOM, Math.max(NATIVE_SAFE_MIN_T_ZOOM, tZoom));
}

function installNativeCameraPatch(
	runtime: unknown,
	probe: MutableProbe,
): (() => void) | undefined {
	if (!isObject(runtime) || nativeCameraShape(runtime, probe) === undefined) {
		return undefined;
	}
	const instance = runtime as UnknownRecord;
	const existing = nativeCameraPatches.get(instance);
	if (existing !== undefined) {
		existing.refCount += 1;
		return () => releaseNativeCameraPatch(existing);
	}

	const current = safeOwnDescriptor(instance, NATIVE_CAMERA_PATCH_KEY);
	if (current !== undefined && (current.get !== undefined || current.set !== undefined || typeof current.value !== "function")) {
		addDiagnostic(probe, {
			code: "native-camera-patch-unavailable",
			level: "warning",
			message: "The native Canvas camera was detected, but its instance setViewport method cannot be patched safely.",
			capability: CANVAS_CAPABILITIES.nativeCamera,
		});
		return undefined;
	}
	if (current !== undefined && current.writable !== true && current.configurable !== true) {
		addDiagnostic(probe, {
			code: "native-camera-patch-unavailable",
			level: "warning",
			message: "The native Canvas camera's own setViewport method is not replaceable safely.",
			capability: CANVAS_CAPABILITIES.nativeCamera,
		});
		return undefined;
	}
	if (current === undefined) {
		let extensible = false;
		try {
			extensible = Object.isExtensible(instance);
		} catch {
			extensible = false;
		}
		if (!extensible) {
			addDiagnostic(probe, {
				code: "native-camera-patch-unavailable",
				level: "warning",
				message: "The native Canvas instance is not extensible, so its camera method cannot be scoped safely.",
				capability: CANVAS_CAPABILITIES.nativeCamera,
			});
			return undefined;
		}
	}

	// Preserve the exact own descriptor when present.  For the usual native
	// class method (inherited from the prototype), create a non-enumerable
	// instance shadow and remove that shadow on dispose.
	const original = (current?.value ?? nativeCameraShape(instance, probe)?.setViewport) as
		((...args: unknown[]) => unknown) | undefined;
	if (typeof original !== "function") {
		return undefined;
	}
	const state: NativeCameraPatch = {
		runtime: instance,
		hadOwnMethod: current !== undefined,
		...(current === undefined ? {} : { originalDescriptor: current }),
		originalMethod: original,
		patchedMethod: (() => undefined) as (...args: unknown[]) => unknown,
		refCount: 1,
	};
	const patchedMethod = function(this: unknown, ...args: unknown[]): unknown {
		const tx = toFiniteNumber(args[0]);
		const ty = toFiniteNumber(args[1]);
		const requestedTZoom = toFiniteNumber(args[2]);
		const boundedTZoom = requestedTZoom === undefined ? undefined : clampNativeSafeTZoom(requestedTZoom);
		const callArgs = boundedTZoom === undefined
			? args
			: [args[0], args[1], boundedTZoom, ...args.slice(3)];
		return Reflect.apply(original, this, callArgs);
	};
	state.patchedMethod = patchedMethod;
	try {
		Object.defineProperty(instance, NATIVE_CAMERA_PATCH_KEY, current === undefined ? {
			configurable: true,
			enumerable: false,
			writable: true,
			value: patchedMethod,
		} : {
			...current,
			value: patchedMethod,
		});
	} catch (error) {
		addDiagnostic(probe, {
			code: "native-camera-patch-unavailable",
			level: "warning",
			message: `The native Canvas camera could not be patched safely: ${describeError(error)}.`,
			capability: CANVAS_CAPABILITIES.nativeCamera,
		});
		return undefined;
	}
	nativeCameraPatches.set(instance, state);
	return () => releaseNativeCameraPatch(state);
}

function releaseNativeCameraPatch(state: NativeCameraPatch): void {
	if (state.refCount <= 0) {
		return;
	}
	state.refCount -= 1;
	if (state.refCount > 0) {
		return;
	}
	try {
		const current = safeOwnDescriptor(state.runtime, NATIVE_CAMERA_PATCH_KEY);
		if (current?.value === state.patchedMethod) {
			if (state.hadOwnMethod && state.originalDescriptor !== undefined) {
				Object.defineProperty(state.runtime, NATIVE_CAMERA_PATCH_KEY, state.originalDescriptor);
			} else {
				Reflect.deleteProperty(state.runtime, NATIVE_CAMERA_PATCH_KEY);
			}
		}
	} catch {
		// Another integration may have replaced the method.  Never clobber it.
	}
	nativeCameraPatches.delete(state.runtime);
}

function firstDefined(
	target: unknown,
	keys: readonly PropertyKey[],
	probe: MutableProbe,
	capability?: string,
): { readonly key: PropertyKey; readonly value: unknown } | undefined {
	for (const key of keys) {
		const value = safeRead(target, key, probe, capability);
		if (value !== undefined) {
			return { key, value };
		}
	}
	return undefined;
}

function nestedValue(
	target: unknown,
	parent: PropertyKey,
	child: PropertyKey,
	probe: MutableProbe,
	capability?: string,
): unknown {
	const parentValue = safeRead(target, parent, probe, capability);
	return safeRead(parentValue, child, probe, capability);
}

function methodExists(
	target: unknown,
	keys: readonly PropertyKey[],
	probe: MutableProbe,
	capability?: string,
): boolean {
	for (const key of keys) {
		if (typeof safeRead(target, key, probe, capability) === "function") {
			return true;
		}
	}
	return false;
}

function valueExists(
	target: unknown,
	keys: readonly PropertyKey[],
	probe: MutableProbe,
	capability?: string,
): boolean {
	return firstDefined(target, keys, probe, capability) !== undefined;
}

type SafeBooleanResult =
	| { readonly ok: true; readonly value: boolean }
	| { readonly ok: false };

function safeIsArray(
	value: unknown,
	probe: MutableProbe,
	capability?: string,
): SafeBooleanResult {
	try {
		return { ok: true, value: Array.isArray(value) };
	} catch (error) {
		addDiagnostic(probe, {
			code: "native-probe-failed",
			level: "warning",
			message: `Checking whether a Canvas value is an array failed: ${describeError(error)}.`,
			capability,
		});
		return { ok: false };
	}
}

function safeInstanceOf(
	value: unknown,
	constructor: Function,
	constructorName: string,
	probe: MutableProbe,
	capability?: string,
): SafeBooleanResult {
	try {
		return { ok: true, value: value instanceof constructor };
	} catch (error) {
		addDiagnostic(probe, {
			code: "native-probe-failed",
			level: "warning",
			message: `Checking whether a Canvas value is a ${constructorName} failed: ${describeError(error)}.`,
			capability,
		});
		return { ok: false };
	}
}

function readRequiredCapabilities(
	options: CanvasAdapterOptions,
	probe: MutableProbe,
): readonly unknown[] {
	const required = safeRead(options, "requiredCapabilities", probe);
	if (required === undefined || required === null) {
		return [];
	}
	const arrayResult = safeIsArray(required, probe);
	if (!arrayResult.ok) {
		return [];
	}
	if (!arrayResult.value) {
		addDiagnostic(probe, {
			code: "native-options-invalid",
			level: "warning",
			message: "Canvas adapter requiredCapabilities must be an array; the requirement list was ignored.",
		});
		return [];
	}
	return readArrayCollection(required as unknown[], probe, "required capabilities") ?? [];
}

function resolveRuntime(view: unknown, probe: MutableProbe): unknown {
	if (!isObject(view)) {
		return undefined;
	}

	let candidateWasProvided = false;
	for (const key of ["canvas", "_canvas", "canvasView", "canvasRuntime"] as const) {
		const candidate = safeRead(view, key, probe);
		if (candidate !== undefined) {
			candidateWasProvided = true;
			if (isObject(candidate)) {
				return candidate;
			}
		}
	}

	// Some tests and a few Obsidian wrappers expose the Canvas object itself as
	// the view.  Accept that shape when at least one known member is present.
	if (
		methodExists(view, [...DOCUMENT_METHOD_KEYS, ...VIEWPORT_METHOD_KEYS, "setViewport", "on"], probe) ||
		valueExists(
			view,
			[
				...SCENE_NODE_KEYS,
				...SCENE_EDGE_KEYS,
				...DOCUMENT_VALUE_KEYS,
				...VIEWPORT_VALUE_KEYS,
				...SELECTION_KEYS,
			],
			probe,
		)
	) {
		return view;
	}

	// Keep this distinction so `{ canvas: {} }` reports an incompatible
	// internal shape while an entirely unrelated/missing view reports absence.
	if (candidateWasProvided) {
		return null;
	}
	return undefined;
}

function detectCapabilities(runtime: unknown, probe: MutableProbe): CanvasCameraFeatures | undefined {
	if (!isObject(runtime)) {
		return undefined;
	}
	const nativeCamera = nativeCameraShape(runtime, probe) !== undefined;
	if (nativeCamera) {
		probe.capabilities.add(CANVAS_CAPABILITIES.nativeCamera);
	}

	if (valueExists(runtime, ROOT_KEYS, probe, CANVAS_CAPABILITIES.rootElement)) {
		probe.capabilities.add(CANVAS_CAPABILITIES.rootElement);
	}

	const nestedData = safeRead(runtime, "data", probe);
	if (
		methodExists(runtime, DOCUMENT_METHOD_KEYS, probe, CANVAS_CAPABILITIES.document) ||
		valueExists(runtime, DOCUMENT_VALUE_KEYS, probe, CANVAS_CAPABILITIES.document)
	) {
		probe.capabilities.add(CANVAS_CAPABILITIES.document);
	}
	const hasNodes =
		valueExists(runtime, SCENE_NODE_KEYS, probe, CANVAS_CAPABILITIES.scene) ||
		valueExists(nestedData, SCENE_NODE_KEYS, probe, CANVAS_CAPABILITIES.scene);
	const hasEdges =
		valueExists(runtime, SCENE_EDGE_KEYS, probe, CANVAS_CAPABILITIES.scene) ||
		valueExists(nestedData, SCENE_EDGE_KEYS, probe, CANVAS_CAPABILITIES.scene);
	if (hasNodes || hasEdges || methodExists(runtime, ["getScene"], probe, CANVAS_CAPABILITIES.scene)) {
		probe.capabilities.add(CANVAS_CAPABILITIES.scene);
	}

	if (
		methodExists(runtime, VIEWPORT_METHOD_KEYS, probe, CANVAS_CAPABILITIES.viewport) ||
		valueExists(runtime, VIEWPORT_VALUE_KEYS, probe, CANVAS_CAPABILITIES.viewport) ||
		["x", "y", "zoom", "scale"].every((key) => safeRead(runtime, key, probe, CANVAS_CAPABILITIES.viewport) !== undefined)
	) {
		probe.capabilities.add(CANVAS_CAPABILITIES.viewport);
	}

	if (valueExists(runtime, SELECTION_KEYS, probe, CANVAS_CAPABILITIES.selection)) {
		probe.capabilities.add(CANVAS_CAPABILITIES.selection);
	}

	if (
		methodExists(runtime, ["on", "addEventListener", "registerEvent"], probe, CANVAS_CAPABILITIES.events)
	) {
		probe.capabilities.add(CANVAS_CAPABILITIES.events);
	}

	if (
		methodExists(
			runtime,
			["setViewport", "setViewportTransform", "setViewBox", "setZoom"],
			probe,
			CANVAS_CAPABILITIES.viewportMutation,
		)
	) {
		probe.capabilities.add(CANVAS_CAPABILITIES.viewportMutation);
	}
	if (nativeCamera) {
		// The exact native `setViewport(tx, ty, tZoom)` method is a stronger
		// mutation signal than the generic alias list above.
		probe.capabilities.add(CANVAS_CAPABILITIES.viewport);
		probe.capabilities.add(CANVAS_CAPABILITIES.viewportMutation);
	}

	if (methodExists(runtime, ["requestRender", "render", "rerender"], probe, CANVAS_CAPABILITIES.render)) {
		probe.capabilities.add(CANVAS_CAPABILITIES.render);
	}

	if (
		methodExists(runtime, ["requestSave", "save", "persist"], probe, CANVAS_CAPABILITIES.persistence)
	) {
		probe.capabilities.add(CANVAS_CAPABILITIES.persistence);
	}
	const hasViewport = probe.capabilities.has(CANVAS_CAPABILITIES.viewport);
	const hasMutation = probe.capabilities.has(CANVAS_CAPABILITIES.viewportMutation);
	if (!nativeCamera && !hasViewport && !hasMutation) {
		return undefined;
	}
	return nativeCamera
		? {
			kind: "native",
			coordinateMode: "center",
			zoomMode: "log2",
			mutation: "positional",
		}
		: {
			kind: "generic",
			coordinateMode: "transform",
			zoomMode: "linear",
			mutation: hasMutation ? "object" : "unsupported",
		};
}

function hasUsableRuntime(runtime: unknown, probe: MutableProbe): boolean {
	if (!isObject(runtime)) {
		return false;
	}
	return probe.capabilities.size > 0;
}

function createProbe(view: unknown, options: CanvasAdapterOptions = {}): CanvasAdapterProbe & {
	readonly runtime: unknown;
	readonly camera?: CanvasCameraFeatures;
} {
	const probe: MutableProbe = {
		status: "unavailable",
		capabilities: new Set<CanvasCapability>(),
		diagnostics: [],
		diagnosticKeys: new Set<string>(),
	};

	const runtime = resolveRuntime(view, probe);
	let camera: CanvasCameraFeatures | undefined;
	if (runtime === undefined) {
		addDiagnostic(probe, {
			code: "native-canvas-missing",
			level: "info",
			message: "No native Obsidian Canvas runtime was supplied; native capabilities are disabled.",
		});
	} else if (runtime === null) {
		probe.status = "incompatible";
		addDiagnostic(probe, {
			code: "native-canvas-incompatible",
			level: "warning",
			message: "The supplied Canvas view has an unrecognised native runtime shape; native capabilities are disabled.",
		});
	} else {
		camera = detectCapabilities(runtime, probe);
		if (hasUsableRuntime(runtime, probe)) {
			probe.status = "ready";
		} else {
			probe.status = "incompatible";
			addDiagnostic(probe, {
				code: "native-canvas-incompatible",
				level: "warning",
				message: "The supplied Canvas runtime exposes no recognised capabilities; native integration is disabled.",
			});
		}
	}

	for (const capability of readRequiredCapabilities(options, probe)) {
		if (!probe.capabilities.has(capability as CanvasCapability)) {
			const capabilityName = typeof capability === "string" ? capability : describePropertyKey(capability as PropertyKey);
			warnUnsupported(probe, capabilityName, `Required Canvas capability "${capabilityName}" is unavailable.`);
		}
	}

	return {
		status: probe.status,
		available: probe.status === "ready",
		compatible: probe.status !== "incompatible",
		capabilities: new Set(probe.capabilities),
		diagnostics: [...probe.diagnostics],
		runtime,
		...(camera === undefined ? {} : { camera }),
	};
}

function toFiniteNumber(value: unknown): number | undefined {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		return undefined;
	}
	return value === 0 ? 0 : value;
}

function readNumber(
	target: unknown,
	keys: readonly PropertyKey[],
	probe: MutableProbe,
	capability: string,
): number | undefined {
	for (const key of keys) {
		const value = toFiniteNumber(safeRead(target, key, probe, capability));
		if (value !== undefined) {
			return value;
		}
	}
	return undefined;
}

function normalizeViewport(raw: unknown, probe: MutableProbe): CanvasViewport | undefined {
	if (!isObject(raw)) {
		return undefined;
	}

	const center = safeRead(raw, "center", probe, CANVAS_CAPABILITIES.viewport);
	const x =
		readNumber(raw, ["x", "offsetX", "left"], probe, CANVAS_CAPABILITIES.viewport) ??
		readNumber(center, ["x"], probe, CANVAS_CAPABILITIES.viewport);
	const y =
		readNumber(raw, ["y", "offsetY", "top"], probe, CANVAS_CAPABILITIES.viewport) ??
		readNumber(center, ["y"], probe, CANVAS_CAPABILITIES.viewport);
	const zoom = readNumber(raw, ["zoom", "scale"], probe, CANVAS_CAPABILITIES.viewport);
	if (x === undefined || y === undefined || zoom === undefined || zoom <= 0) {
		return undefined;
	}

	const width = readNumber(raw, ["width", "viewportWidth"], probe, CANVAS_CAPABILITIES.viewport);
	const height = readNumber(raw, ["height", "viewportHeight"], probe, CANVAS_CAPABILITIES.viewport);
	let copied: Record<string, unknown> = {};
	try {
		copied = { ...raw };
	} catch (error) {
		addDiagnostic(probe, {
			code: "native-read-failed",
			level: "warning",
			message: `Copying the native Canvas viewport failed: ${describeError(error)}.`,
			capability: CANVAS_CAPABILITIES.viewport,
		});
	}
	const result: Record<string, unknown> = { ...copied, x, y, zoom };
	if (width !== undefined) {
		result.width = width;
	}
	if (height !== undefined) {
		result.height = height;
	}
	return result as CanvasViewport;
}

function nativeViewportSize(
	runtime: unknown,
	probe: MutableProbe,
): { readonly width?: number; readonly height?: number } {
	const canvasRect = safeRead(runtime, "canvasRect", probe, CANVAS_CAPABILITIES.nativeCamera);
	let width = readNumber(canvasRect, ["width"], probe, CANVAS_CAPABILITIES.nativeCamera);
	let height = readNumber(canvasRect, ["height"], probe, CANVAS_CAPABILITIES.nativeCamera);
	if (width === undefined || height === undefined) {
		const root = firstDefined(runtime, ROOT_KEYS, probe, CANVAS_CAPABILITIES.rootElement)?.value;
		const getBoundingClientRect = safeRead(root, "getBoundingClientRect", probe, CANVAS_CAPABILITIES.rootElement);
		if (typeof getBoundingClientRect === "function") {
			const rect = safeCall(root, "getBoundingClientRect", [], probe, CANVAS_CAPABILITIES.rootElement);
			width ??= readNumber(rect, ["width"], probe, CANVAS_CAPABILITIES.rootElement);
			height ??= readNumber(rect, ["height"], probe, CANVAS_CAPABILITIES.rootElement);
		}
	}
	return {
		...(width === undefined || width <= 0 ? {} : { width: Math.min(width, Number.MAX_SAFE_INTEGER) }),
		...(height === undefined || height <= 0 ? {} : { height: Math.min(height, Number.MAX_SAFE_INTEGER) }),
	};
}

function readNativeViewport(runtime: unknown, probe: MutableProbe): CanvasViewport | undefined {
	const shape = nativeCameraShape(runtime, probe);
	if (shape === undefined) {
		return undefined;
	}
	const zoom = nativeZoomToScale(shape.tZoom);
	if (zoom === undefined) {
		addDiagnostic(probe, {
			code: "native-viewport-invalid",
			level: "warning",
			message: "The native Canvas tZoom is outside the finite log2 camera range.",
			capability: CANVAS_CAPABILITIES.nativeCamera,
		});
		return undefined;
	}
	const size = nativeViewportSize(runtime, probe);
	return {
		x: shape.tx,
		y: shape.ty,
		zoom,
		tx: shape.tx,
		ty: shape.ty,
		tZoom: shape.tZoom,
		coordinateMode: "center",
		zoomMode: "log2",
		...size,
	};
}

function collectionReadFailure(
	probe: MutableProbe,
	capability: string,
	code: "native-read-failed" | "native-collection-limit-reached",
	message: string,
): undefined {
	addDiagnostic(probe, {
		code,
		level: "warning",
		message,
		capability,
	});
	return undefined;
}

function readIterator(
	iterator: unknown,
	probe: MutableProbe,
	capability: string,
): readonly unknown[] | undefined {
	if (!isObject(iterator)) {
		return collectionReadFailure(
			probe,
			capability,
			"native-read-failed",
			`Reading Canvas ${capability} failed: values() did not return an iterator.`,
		);
	}

	const result: unknown[] = [];
	for (;;) {
		if (result.length >= MAX_COLLECTION_ITEMS) {
			return collectionReadFailure(
				probe,
				capability,
				"native-collection-limit-reached",
				`Reading Canvas ${capability} exceeded the ${MAX_COLLECTION_ITEMS}-item safety limit.`,
			);
		}

		const stepResult = safeCallResult(iterator, "next", [], probe, capability);
		if (!stepResult.ok || !isObject(stepResult.value)) {
			return collectionReadFailure(
				probe,
				capability,
				"native-read-failed",
				`Reading Canvas ${capability} failed: iterator.next() returned an invalid result.`,
			);
		}

		const doneResult = safeReadResult(stepResult.value, "done", probe, capability);
		if (!doneResult.ok) {
			return undefined;
		}
		const done = doneResult.value;
		if (done === true) {
			return result;
		}
		if (done !== false) {
			return collectionReadFailure(
				probe,
				capability,
				"native-read-failed",
				`Reading Canvas ${capability} failed: iterator.done is not boolean.`,
			);
		}

		const valueResult = safeReadResult(stepResult.value, "value", probe, capability);
		if (!valueResult.ok) {
			return undefined;
		}
		result.push(valueResult.value);
	}
}

function readArrayCollection(
	raw: unknown[],
	probe: MutableProbe,
	capability: string,
): readonly unknown[] | undefined {
	const lengthResult = safeReadResult(raw as unknown as UnknownRecord, "length", probe, capability);
	if (!lengthResult.ok) {
		return undefined;
	}
	const length = lengthResult.value;
	if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 0) {
		return collectionReadFailure(
			probe,
			capability,
			"native-read-failed",
			`Reading Canvas ${capability} failed: array length is invalid.`,
		);
	}
	if (length > MAX_COLLECTION_ITEMS) {
		return collectionReadFailure(
			probe,
			capability,
			"native-collection-limit-reached",
			`Reading Canvas ${capability} exceeded the ${MAX_COLLECTION_ITEMS}-item safety limit.`,
		);
	}

	const result: unknown[] = [];
	for (let index = 0; index < length; index += 1) {
		const valueResult = safeReadResult(raw as unknown as UnknownRecord, String(index), probe, capability);
		if (!valueResult.ok) {
			return undefined;
		}
		result.push(valueResult.value);
	}
	return result;
}

function readCollection(raw: unknown, probe: MutableProbe, capability: string): readonly unknown[] | undefined {
	if (raw === undefined || raw === null) {
		return undefined;
	}
	const arrayResult = safeIsArray(raw, probe, capability);
	if (!arrayResult.ok) {
		return undefined;
	}
	if (arrayResult.value) {
		return readArrayCollection(raw as unknown[], probe, capability);
	}
	if (!isObject(raw)) {
		return undefined;
	}

	const mapResult = safeInstanceOf(raw, Map, "Map", probe, capability);
	if (!mapResult.ok) {
		return undefined;
	}
	const setResult = safeInstanceOf(raw, Set, "Set", probe, capability);
	if (!setResult.ok) {
		return undefined;
	}
	if (mapResult.value || setResult.value) {
		const valuesResult = safeCallResult(raw, "values", [], probe, capability);
		return valuesResult.ok ? readIterator(valuesResult.value, probe, capability) : undefined;
	}

	const valuesResult = safeReadResult(raw, "values", probe, capability);
	if (!valuesResult.ok) {
		return undefined;
	}
	const values = valuesResult.value;
	if (typeof values === "function") {
		const iteratorResult = safeCallResult(raw, "values", [], probe, capability);
		return iteratorResult.ok ? readIterator(iteratorResult.value, probe, capability) : undefined;
	}

	// A plain object is a common test double for a Map.  Read each value with
	// safeRead so a throwing property cannot escape the adapter.
	try {
		const keys = Reflect.ownKeys(raw);
		if (keys.length > MAX_COLLECTION_ITEMS) {
			return collectionReadFailure(
				probe,
				capability,
				"native-collection-limit-reached",
				`Reading Canvas ${capability} exceeded the ${MAX_COLLECTION_ITEMS}-item safety limit.`,
			);
		}
		const result: unknown[] = [];
		for (const key of keys) {
			const valueResult = safeReadResult(raw, key, probe, capability);
			if (!valueResult.ok) {
				return undefined;
			}
			const value = valueResult.value;
			if (value !== undefined) {
				result.push(value);
			}
		}
		return result;
	} catch (error) {
		return collectionReadFailure(
			probe,
			capability,
			"native-read-failed",
			`Reading Canvas ${capability} failed: ${describeError(error)}.`,
		);
	}
}

/**
 * Safe adapter for a native Canvas view.  It is intentionally usable even
 * when `view` is `undefined`, which lets plugin startup remain unconditional.
 */
export class CanvasAdapter {
	public readonly kind = "native" as const;
	public readonly view: unknown;
	private readonly runtime: unknown;
	private readonly cameraFeaturesValue: CanvasCameraFeatures | undefined;
	private readonly releaseCameraPatch: (() => void) | undefined;
	private readonly capabilitySet: Set<CanvasCapability>;
	private readonly diagnosticList: AdapterDiagnostic[];
	private readonly diagnosticKeys = new Set<string>();
	private currentStatus: AdapterStatus;
	private disposed = false;

	public constructor(view: unknown, options: CanvasAdapterOptions = {}) {
		this.view = view;
		const result = createProbe(view, options);
		this.runtime = result.runtime;
		this.cameraFeaturesValue = result.camera;
		this.capabilitySet = new Set(result.capabilities);
		this.diagnosticList = [...result.diagnostics];
		for (const diagnostic of this.diagnosticList) {
			this.diagnosticKeys.add(`${diagnostic.code}:${diagnostic.capability ?? ""}:${diagnostic.message}`);
		}
		this.currentStatus = result.status;
		const shouldPatch = safeRead(options, "patchNativeCamera", this.probeStateForConstructor()) !== false;
		this.releaseCameraPatch = shouldPatch && this.cameraFeaturesValue?.kind === "native"
			? installNativeCameraPatch(this.runtime, this.probeStateForConstructor())
			: undefined;
	}

	private probeStateForConstructor(): MutableProbe {
		return {
			status: this.currentStatus,
			capabilities: this.capabilitySet,
			diagnostics: this.diagnosticList,
			diagnosticKeys: this.diagnosticKeys,
		};
	}

	public static probe(view: unknown, options: CanvasAdapterOptions = {}): CanvasAdapterProbe {
		const result = createProbe(view, options);
		return {
			status: result.status,
			available: result.available,
			compatible: result.compatible,
			capabilities: new Set(result.capabilities),
			...(result.camera === undefined ? {} : { camera: result.camera }),
			diagnostics: [...result.diagnostics],
		};
	}

	public get status(): AdapterStatus {
		return this.currentStatus;
	}

	/** Alias useful to callers that use state-machine terminology. */
	public get state(): AdapterStatus {
		return this.currentStatus;
	}

	public get available(): boolean {
		return this.currentStatus === "ready";
	}

	public get compatible(): boolean {
		return this.currentStatus !== "incompatible";
	}

	public get disabled(): boolean {
		return !this.available;
	}

	public get capabilities(): ReadonlySet<CanvasCapability> {
		return new Set(this.capabilitySet);
	}

	public get diagnostics(): readonly AdapterDiagnostic[] {
		return [...this.diagnosticList];
	}

	/** Explicit camera semantics discovered at construction time. */
	public get camera(): CanvasCameraFeatures | undefined {
		return this.cameraFeaturesValue;
	}

	public get cameraFeatures(): CanvasCameraFeatures | undefined {
		return this.cameraFeaturesValue;
	}

	public get coordinateMode(): CanvasCoordinateMode | undefined {
		return this.cameraFeaturesValue?.coordinateMode;
	}

	public get zoomMode(): CanvasZoomMode | undefined {
		return this.cameraFeaturesValue?.zoomMode;
	}

	public get cameraSemantics(): CanvasCameraFeatures | undefined {
		return this.cameraFeaturesValue;
	}

	public get viewportSemantics(): CanvasCameraFeatures | undefined {
		return this.cameraFeaturesValue;
	}

	public supports(capability: CanvasCapability | string): boolean {
		return this.capabilitySet.has(capability as CanvasCapability);
	}

	public hasCapability(capability: CanvasCapability | string): boolean {
		return this.supports(capability);
	}

	public getCapabilities(): readonly CanvasCapability[] {
		return [...this.capabilitySet];
	}

	/** Restore any scoped native camera patch.  Safe to call repeatedly. */
	public dispose(): void {
		if (this.disposed) {
			return;
		}
		this.disposed = true;
		this.currentStatus = "unavailable";
		this.releaseCameraPatch?.();
	}

	private addDiagnostic(diagnostic: AdapterDiagnostic): void {
		const key = `${diagnostic.code}:${diagnostic.capability ?? ""}:${diagnostic.message}`;
		if (this.diagnosticKeys.has(key)) {
			return;
		}
		this.diagnosticKeys.add(key);
		this.diagnosticList.push(diagnostic);
	}

	private probeState(): MutableProbe {
		return {
			status: this.currentStatus,
			capabilities: this.capabilitySet,
			diagnostics: this.diagnosticList,
			diagnosticKeys: this.diagnosticKeys,
		};
	}

	/** Read an internal runtime property without exposing the runtime object. */
	public read<T = unknown>(key: PropertyKey): T | undefined {
		const probe = this.probeState();
		return safeRead(this.runtime, key, probe) as T | undefined;
	}

	/** Invoke an internal runtime method; unsupported calls return `undefined`. */
	public invoke<T = unknown>(method: PropertyKey, ...args: readonly unknown[]): T | undefined {
		const probe = this.probeState();
		return safeCall(this.runtime, method, args, probe) as T | undefined;
	}

	public getRootElement(): unknown | undefined {
		const probe = this.probeState();
		const result = firstDefined(this.runtime, ROOT_KEYS, probe, CANVAS_CAPABILITIES.rootElement);
		if (result === undefined) {
			warnUnsupported(probe, CANVAS_CAPABILITIES.rootElement);
		}
		return result?.value;
	}

	public getNodes(): readonly unknown[] | undefined {
		const probe = this.probeState();
		const direct = firstDefined(this.runtime, SCENE_NODE_KEYS, probe, CANVAS_CAPABILITIES.scene);
		const raw = direct?.key === "getNodes"
			? safeCall(this.runtime, "getNodes", [], probe, CANVAS_CAPABILITIES.scene)
			: direct?.value ?? nestedValue(this.runtime, "data", "nodes", probe, CANVAS_CAPABILITIES.scene);
		const result = readCollection(raw, probe, CANVAS_CAPABILITIES.scene);
		if (result === undefined) {
			warnUnsupported(probe, CANVAS_CAPABILITIES.scene);
		}
		return result;
	}

	public getEdges(): readonly unknown[] | undefined {
		const probe = this.probeState();
		const direct = firstDefined(this.runtime, SCENE_EDGE_KEYS, probe, CANVAS_CAPABILITIES.scene);
		const raw = direct?.key === "getEdges"
			? safeCall(this.runtime, "getEdges", [], probe, CANVAS_CAPABILITIES.scene)
			: direct?.value ?? nestedValue(this.runtime, "data", "edges", probe, CANVAS_CAPABILITIES.scene);
		const result = readCollection(raw, probe, CANVAS_CAPABILITIES.scene);
		if (result === undefined) {
			warnUnsupported(probe, CANVAS_CAPABILITIES.scene);
		}
		return result;
	}

	public getScene(): CanvasScene | undefined {
		const nodes = this.getNodes();
		const edges = this.getEdges();
		if (nodes === undefined && edges === undefined) {
			return undefined;
		}
		return { nodes: nodes ?? [], edges: edges ?? [] };
	}

	/**
	 * Return the in-memory JSON Canvas document without exposing private
	 * runtime names to feature modules.  `getData()` wins over `data`; a
	 * throwing getter/method fails closed instead of falling through to an
	 * unverified object.
	 */
	public getDocument(): unknown | undefined {
		const probe = this.probeState();
		const beforeMethodProbe = probe.diagnostics.length;
		const getData = safeRead(this.runtime, DOCUMENT_METHOD_KEYS[0], probe, CANVAS_CAPABILITIES.document);
		if (probe.diagnostics.length !== beforeMethodProbe) {
			return undefined;
		}
		if (typeof getData === "function") {
			const beforeCall = probe.diagnostics.length;
			const value = safeCall(this.runtime, DOCUMENT_METHOD_KEYS[0], [], probe, CANVAS_CAPABILITIES.document);
			if (probe.diagnostics.length !== beforeCall) {
				return undefined;
			}
			if (value !== undefined) {
				return value;
			}
		}

		const beforeDataRead = probe.diagnostics.length;
		const data = safeRead(this.runtime, DOCUMENT_VALUE_KEYS[0], probe, CANVAS_CAPABILITIES.document);
		if (probe.diagnostics.length !== beforeDataRead) {
			return undefined;
		}
		if (data !== undefined) {
			return data;
		}

		warnUnsupported(probe, CANVAS_CAPABILITIES.document);
		return undefined;
	}

	public getViewport(): CanvasViewport | undefined {
		const probe = this.probeState();
		if (this.disposed) {
			addDiagnostic(probe, {
				code: "native-adapter-disposed",
				level: "info",
				message: "The native Canvas adapter has been disposed; viewport access is disabled.",
				capability: CANVAS_CAPABILITIES.viewport,
			});
			return undefined;
		}
		if (this.cameraFeatures?.kind === "native") {
			return readNativeViewport(this.runtime, probe);
		}
		let raw: unknown;
		for (const method of VIEWPORT_METHOD_KEYS) {
			raw = safeCall(this.runtime, method, [], probe, CANVAS_CAPABILITIES.viewport);
			if (raw !== undefined) {
				break;
			}
		}
		if (raw === undefined) {
			raw = firstDefined(this.runtime, VIEWPORT_VALUE_KEYS, probe, CANVAS_CAPABILITIES.viewport)?.value;
		}
		if (raw === undefined) {
			const x = readNumber(this.runtime, ["x", "offsetX"], probe, CANVAS_CAPABILITIES.viewport);
			const y = readNumber(this.runtime, ["y", "offsetY"], probe, CANVAS_CAPABILITIES.viewport);
			const zoom = readNumber(this.runtime, ["zoom", "scale"], probe, CANVAS_CAPABILITIES.viewport);
			if (x !== undefined && y !== undefined && zoom !== undefined) {
				raw = { x, y, zoom };
			}
		}
		const result = normalizeViewport(raw, probe);
		if (result === undefined) {
			addDiagnostic(probe, {
				code: "native-viewport-invalid",
				level: "warning",
				message: "The native Canvas viewport could not be read safely.",
				capability: CANVAS_CAPABILITIES.viewport,
			});
		}
		return result;
	}

	public setViewport(viewport: CanvasViewport | unknown): boolean {
		const probe = this.probeState();
		if (this.disposed) {
			addDiagnostic(probe, {
				code: "native-adapter-disposed",
				level: "info",
				message: "The native Canvas adapter has been disposed; viewport mutation is disabled.",
				capability: CANVAS_CAPABILITIES.viewportMutation,
			});
			return false;
		}
		if (this.cameraFeatures?.kind === "native") {
			const x = isObject(viewport)
				? toFiniteNumber(safeRead(viewport, "x", probe, CANVAS_CAPABILITIES.nativeCamera))
					?? toFiniteNumber(safeRead(viewport, "tx", probe, CANVAS_CAPABILITIES.nativeCamera))
				: undefined;
			const y = isObject(viewport)
				? toFiniteNumber(safeRead(viewport, "y", probe, CANVAS_CAPABILITIES.nativeCamera))
					?? toFiniteNumber(safeRead(viewport, "ty", probe, CANVAS_CAPABILITIES.nativeCamera))
				: undefined;
			const zoom = isObject(viewport) ? toFiniteNumber(safeRead(viewport, "zoom", probe, CANVAS_CAPABILITIES.nativeCamera)) : undefined;
			const requestedTZoom = isObject(viewport)
				? toFiniteNumber(safeRead(viewport, "tZoom", probe, CANVAS_CAPABILITIES.nativeCamera))
				: undefined;
		// `zoom` is the stable linear-facing field.  A tZoom-only payload is
			// accepted for native callers, while an adapter/controller payload that
			// carries both always derives from its requested linear zoom.
		const tZoom = zoom === undefined
				? requestedTZoom
				: nativeScaleToZoom(zoom);
		const requestedZoom = zoom ?? (tZoom === undefined ? undefined : nativeZoomToScale(tZoom));
			if (x === undefined || y === undefined || tZoom === undefined || requestedZoom === undefined) {
				addDiagnostic(probe, {
					code: "native-viewport-invalid",
					level: "warning",
					message: "The requested native Canvas viewport is invalid; no camera change was made.",
					capability: CANVAS_CAPABILITIES.nativeCamera,
				});
				return false;
			}
			const boundedTZoom = clampNativeSafeTZoom(tZoom);
			if (boundedTZoom !== tZoom) {
				addDiagnostic(probe, {
					code: "native-camera-range-limited",
					level: "warning",
					message: `Native Canvas rendering safely supports tZoom ${NATIVE_SAFE_MIN_T_ZOOM}..${NATIVE_SAFE_MAX_T_ZOOM}; the requested zoom was limited without changing screenshotting or other render flags.`,
					capability: CANVAS_CAPABILITIES.nativeCamera,
				});
			}
			const result = safeCallResult(
				this.runtime,
				NATIVE_CAMERA_PATCH_KEY,
				[x, y, boundedTZoom],
				probe,
				CANVAS_CAPABILITIES.viewportMutation,
			);
			if (!result.ok || result.value === false) {
				return false;
			}
			// Do not write camera fields behind the host's method: native Canvas
			// keeps `zoom` in log2 units and schedules a render-frame clamp.  A
			// synchronous mismatch is reported instead of guessing a bypass.
			const observed = nativeCameraShape(this.runtime, probe);
			if (observed === undefined || observed.tx !== x || observed.ty !== y || observed.tZoom !== boundedTZoom) {
				addDiagnostic(probe, {
					code: "native-camera-range-limited",
					level: "warning",
					message: "Native Canvas did not apply the requested camera synchronously; no unsafe field recovery was attempted.",
					capability: CANVAS_CAPABILITIES.nativeCamera,
				});
				return false;
			}
			return true;
		}
		for (const method of ["setViewport", "setViewportTransform", "setViewBox"] as const) {
			if (typeof safeRead(this.runtime, method, probe, CANVAS_CAPABILITIES.viewportMutation) !== "function") {
				continue;
			}
			const result = safeCallResult(this.runtime, method, [viewport], probe, CANVAS_CAPABILITIES.viewportMutation);
			return result.ok && result.value !== false;
		}
		const setZoom = safeRead(this.runtime, "setZoom", probe, CANVAS_CAPABILITIES.viewportMutation);
		if (typeof setZoom === "function" && isObject(viewport)) {
			const zoom = toFiniteNumber(safeRead(viewport, "zoom", probe, CANVAS_CAPABILITIES.viewportMutation));
			if (zoom !== undefined) {
				const result = safeCallResult(this.runtime, "setZoom", [zoom], probe, CANVAS_CAPABILITIES.viewportMutation);
				return result.ok && result.value !== false;
			}
		}
		warnUnsupported(probe, CANVAS_CAPABILITIES.viewportMutation);
		return false;
	}

	public getSelection(): readonly unknown[] | undefined {
		const probe = this.probeState();
		const direct = firstDefined(this.runtime, SELECTION_KEYS, probe, CANVAS_CAPABILITIES.selection);
		const raw = direct?.key === "getSelection"
			? safeCall(this.runtime, "getSelection", [], probe, CANVAS_CAPABILITIES.selection)
			: direct?.value;
		const result = readCollection(raw, probe, CANVAS_CAPABILITIES.selection);
		if (result === undefined) {
			warnUnsupported(probe, CANVAS_CAPABILITIES.selection);
		}
		return result;
	}

	public requestRender(): boolean {
		const probe = this.probeState();
		for (const method of ["requestRender", "render", "rerender"] as const) {
			if (typeof safeRead(this.runtime, method, probe, CANVAS_CAPABILITIES.render) !== "function") {
				continue;
			}
			const result = safeCallResult(this.runtime, method, [], probe, CANVAS_CAPABILITIES.render);
			return result.ok && result.value !== false;
		}
		warnUnsupported(probe, CANVAS_CAPABILITIES.render);
		return false;
	}

	public requestSave(): boolean {
		const probe = this.probeState();
		for (const method of ["requestSave", "save", "persist"] as const) {
			if (typeof safeRead(this.runtime, method, probe, CANVAS_CAPABILITIES.persistence) !== "function") {
				continue;
			}
			const result = safeCallResult(this.runtime, method, [], probe, CANVAS_CAPABILITIES.persistence);
			return result.ok && result.value !== false;
		}
		warnUnsupported(probe, CANVAS_CAPABILITIES.persistence);
		return false;
	}

	/**
	 * Subscribe to a Canvas event.  The returned disposer is always safe to
	 * call, including when a runtime event API disappears after a reload.
	 */
	public on(eventName: string, listener: (payload: unknown) => void): (() => void) | undefined {
		const probe = this.probeState();
		const register = firstDefined(
			this.runtime,
			["on", "addEventListener", "registerEvent"],
			probe,
			CANVAS_CAPABILITIES.events,
		);
		if (register === undefined || typeof register.value !== "function") {
			warnUnsupported(probe, CANVAS_CAPABILITIES.events);
			return undefined;
		}
		const registration = safeCallResult(
			this.runtime,
			register.key,
			register.key === "addEventListener" ? [eventName, listener] : [eventName, listener],
			probe,
			CANVAS_CAPABILITIES.events,
		);
		if (!registration.ok) {
			return undefined;
		}
		const token = registration.value;
		if (typeof token === "function") {
			return () => {
				try {
					(token as () => void)();
				} catch (error) {
					this.addDiagnostic({
						code: "native-event-dispose-failed",
						level: "warning",
						message: `Disposing Canvas event listener failed: ${describeError(error)}.`,
						capability: CANVAS_CAPABILITIES.events,
					});
				}
			};
		}
		return () => {
			this.off(eventName, listener);
		};
	}

	public off(eventName: string, listener: (payload: unknown) => void): boolean {
		const probe = this.probeState();
		for (const method of ["off", "removeEventListener", "unregisterEvent"] as const) {
			if (typeof safeRead(this.runtime, method, probe, CANVAS_CAPABILITIES.events) !== "function") {
				continue;
			}
			const result = safeCallResult(this.runtime, method, [eventName, listener], probe, CANVAS_CAPABILITIES.events);
			return result.ok && result.value !== false;
		}
		warnUnsupported(probe, CANVAS_CAPABILITIES.events);
		return false;
	}
}

export function probeCanvasAdapter(view: unknown, options: CanvasAdapterOptions = {}): CanvasAdapterProbe {
	return CanvasAdapter.probe(view, options);
}

export function createCanvasAdapter(view: unknown, options: CanvasAdapterOptions = {}): CanvasAdapter {
	return new CanvasAdapter(view, options);
}

/** Explicit alias for callers that prefer the native terminology. */
export const createNativeCanvasAdapter = createCanvasAdapter;

export const createNativeAdapter = createCanvasAdapter;
export const probeNativeCanvasAdapter = probeCanvasAdapter;
export { CanvasAdapter as NativeCanvasAdapter };
