import type { MetadataDocumentStore } from "./metadata-writer";

/**
 * The native Canvas root-data bridge is intentionally smaller than the general
 * Canvas adapter.  Obsidian 1.12.7 exposes the live root document as
 * `canvas.data`, and its normal history/save boundary as
 * `canvas.requestSave(true)`.  Both are private implementation details, so this
 * module is the only place where a writer may use them.
 *
 * The bridge does not use `getData`, `setData`, `importData`, vault writes, or
 * a text-view serialization path.  Those operations either address nodes or
 * reload the complete graph and cannot provide the root compare-and-swap
 * semantics required by metadata-only actions.
 */

export type ObsidianMetadataStoreStatus =
	| "ready"
	| "unavailable"
	| "incompatible";

export interface ObsidianMetadataStoreDiagnostic {
	readonly code: string;
	readonly level: "info" | "warning" | "error";
	readonly message: string;
}

export interface ObsidianMetadataStoreProbe {
	readonly status: ObsidianMetadataStoreStatus;
	readonly available: boolean;
	readonly compatible: boolean;
	readonly diagnostics: readonly ObsidianMetadataStoreDiagnostic[];
	/** Present only after every native root-mutation capability has passed. */
	readonly store?: MetadataDocumentStore;
}

type UnknownRecord = Record<PropertyKey, unknown>;
type ReadResult =
	| { readonly ok: true; readonly value: unknown }
	| { readonly ok: false };

const MAX_DOCUMENT_ITEMS = 1_000_000;
const MAX_DOCUMENT_DEPTH = 128;

class NativeShapeError extends Error {}

function isObject(value: unknown): value is UnknownRecord {
	return (typeof value === "object" && value !== null) || typeof value === "function";
}

function describeError(error: unknown): string {
	return error instanceof Error && error.message ? error.message : "unknown error";
}

function safeGet(target: unknown, key: PropertyKey): ReadResult {
	if (!isObject(target)) {
		return { ok: false };
	}
	try {
		return { ok: true, value: Reflect.get(target, key, target) };
	} catch {
		return { ok: false };
	}
}

function hasOwn(target: unknown, key: PropertyKey): boolean {
	if (!isObject(target)) {
		return false;
	}
	try {
		return Object.prototype.hasOwnProperty.call(target, key);
	} catch {
		return false;
	}
}

function isArrayIndexKey(key: string, length: number): boolean {
	if (key.length === 0) {
		return false;
	}
	const index = Number(key);
	return Number.isSafeInteger(index) && index >= 0 && index < length && String(index) === key;
}

function assertPrimitive(value: unknown, path: string): void {
	if (
		value === undefined ||
		typeof value === "function" ||
		typeof value === "symbol" ||
		typeof value === "bigint"
	) {
		throw new NativeShapeError(`The Canvas document contains a non-JSON value at ${path}.`);
	}
	if (typeof value === "number" && !Number.isFinite(value)) {
		throw new NativeShapeError(`The Canvas document contains a non-finite number at ${path}.`);
	}
}

function assertNoEnumerableSymbols(value: object, path: string): void {
	let symbols: symbol[];
	try {
		symbols = Object.getOwnPropertySymbols(value);
	} catch (error) {
		throw new NativeShapeError(`Canvas document symbols could not be inspected at ${path}: ${describeError(error)}.`);
	}
	for (const symbol of symbols) {
		try {
			if (Object.prototype.propertyIsEnumerable.call(value, symbol)) {
				throw new NativeShapeError(`The Canvas document contains an enumerable symbol at ${path}.`);
			}
		} catch (error) {
			if (error instanceof NativeShapeError) {
				throw error;
			}
			throw new NativeShapeError(`Canvas document symbols could not be inspected at ${path}: ${describeError(error)}.`);
		}
	}
}

/**
 * Clone only JSON-shaped data.  Apart from protecting the writer from live
 * object references, the clone is the guard that keeps a private runtime
 * object, class instance, proxy, cycle, sparse array, or executable value out
 * of the replacement root.
 */
function cloneJsonValue(
	value: unknown,
	seen = new Set<object>(),
	path = "document",
	depth = 0,
	state: { items: number } = { items: 0 },
): unknown {
	state.items += 1;
	if (state.items > MAX_DOCUMENT_ITEMS) {
		throw new NativeShapeError(`The Canvas document exceeds the ${MAX_DOCUMENT_ITEMS}-item safety limit.`);
	}
	if (depth > MAX_DOCUMENT_DEPTH) {
		throw new NativeShapeError(`The Canvas document exceeds the ${MAX_DOCUMENT_DEPTH}-level safety limit at ${path}.`);
	}

	if (value === null || typeof value !== "object") {
		assertPrimitive(value, path);
		return value;
	}

	if (seen.has(value)) {
		throw new NativeShapeError(`The Canvas document contains a cycle at ${path}.`);
	}
	seen.add(value);

	let arrayValue: boolean;
	try {
		arrayValue = Array.isArray(value);
	} catch (error) {
		throw new NativeShapeError(`The Canvas document shape could not be inspected at ${path}: ${describeError(error)}.`);
	}

	if (arrayValue) {
		let length: number;
		try {
			length = (value as readonly unknown[]).length;
		} catch (error) {
			throw new NativeShapeError(`The Canvas array length could not be read at ${path}: ${describeError(error)}.`);
		}
		if (!Number.isSafeInteger(length) || length < 0) {
			throw new NativeShapeError(`The Canvas array length is invalid at ${path}.`);
		}
		if (length > MAX_DOCUMENT_ITEMS) {
			throw new NativeShapeError(`The Canvas array exceeds the ${MAX_DOCUMENT_ITEMS}-item safety limit at ${path}.`);
		}

		const result: unknown[] = [];
		for (let index = 0; index < length; index += 1) {
			const key = String(index);
			if (!hasOwn(value, key)) {
				throw new NativeShapeError(`The Canvas array contains a sparse item at ${path}[${index}].`);
			}
			const item = safeGet(value, index);
			if (!item.ok) {
				throw new NativeShapeError(`The Canvas array item could not be read at ${path}[${index}].`);
			}
			result.push(cloneJsonValue(item.value, seen, `${path}[${index}]`, depth + 1, state));
		}

		let keys: string[];
		try {
			keys = Object.keys(value);
		} catch (error) {
			throw new NativeShapeError(`The Canvas array fields could not be enumerated at ${path}: ${describeError(error)}.`);
		}
		for (const key of keys) {
			if (key !== "length" && !isArrayIndexKey(key, length)) {
				throw new NativeShapeError(`The Canvas array contains a non-index field at ${path}.${key}.`);
			}
		}
		assertNoEnumerableSymbols(value, path);
		seen.delete(value);
		return result;
	}

	let prototype: object | null;
	try {
		prototype = Object.getPrototypeOf(value);
	} catch (error) {
		throw new NativeShapeError(`The Canvas object prototype could not be read at ${path}: ${describeError(error)}.`);
	}
	if (prototype !== Object.prototype && prototype !== null) {
		throw new NativeShapeError(`The Canvas document contains a non-plain object at ${path}.`);
	}

	const result: Record<string, unknown> = {};
	let keys: string[];
	try {
		keys = Object.keys(value);
	} catch (error) {
		throw new NativeShapeError(`The Canvas object fields could not be enumerated at ${path}: ${describeError(error)}.`);
	}
	assertNoEnumerableSymbols(value, path);
	for (const key of keys) {
		const item = safeGet(value, key);
		if (!item.ok) {
			throw new NativeShapeError(`The Canvas property could not be read at ${path}.${key}.`);
		}
		Object.defineProperty(result, key, {
			configurable: true,
			enumerable: true,
			value: cloneJsonValue(item.value, seen, `${path}.${key}`, depth + 1, state),
			writable: true,
		});
	}
	seen.delete(value);
	return result;
}

function cloneDocument(value: unknown): Record<string, unknown> {
	const clone = cloneJsonValue(value);
	if (clone === null || typeof clone !== "object" || Array.isArray(clone)) {
		throw new NativeShapeError("The Canvas document root must be a plain object.");
	}
	return clone as Record<string, unknown>;
}

function equalJson(left: unknown, right: unknown): boolean {
	if (Object.is(left, right)) {
		return true;
	}
	if (left === null || right === null || typeof left !== typeof right || typeof left !== "object") {
		return false;
	}
	const leftArray = Array.isArray(left);
	if (leftArray !== Array.isArray(right)) {
		return false;
	}
	if (leftArray) {
		const leftItems = left as readonly unknown[];
		const rightItems = right as readonly unknown[];
		if (leftItems.length !== rightItems.length) {
			return false;
		}
		for (let index = 0; index < leftItems.length; index += 1) {
			if (!equalJson(leftItems[index], rightItems[index])) {
				return false;
			}
		}
		return true;
	}
	const leftRecord = left as Record<string, unknown>;
	const rightRecord = right as Record<string, unknown>;
	let leftKeys: string[];
	let rightKeys: string[];
	try {
		leftKeys = Object.keys(leftRecord);
		rightKeys = Object.keys(rightRecord);
	} catch {
		return false;
	}
	if (leftKeys.length !== rightKeys.length) {
		return false;
	}
	for (const key of leftKeys) {
		if (!hasOwn(rightRecord, key) || !equalJson(leftRecord[key], rightRecord[key])) {
			return false;
		}
	}
	return true;
}

function ownDataIsReplaceable(runtime: UnknownRecord): ObsidianMetadataStoreDiagnostic | undefined {
	let descriptor: PropertyDescriptor | undefined;
	try {
		descriptor = Object.getOwnPropertyDescriptor(runtime, "data");
	} catch (error) {
		return {
			code: "native-data-descriptor-failed",
			level: "warning",
			message: `Reading the native Canvas data descriptor failed: ${describeError(error)}.`,
		};
	}
	if (descriptor === undefined) {
		return {
			code: "native-data-missing",
			level: "warning",
			message: "The native Canvas runtime does not expose its root data as an own property.",
		};
	}
	if (descriptor.get !== undefined || descriptor.set !== undefined) {
		return {
			code: "native-data-accessor-unsupported",
			level: "warning",
			message: "The native Canvas root data is an accessor; the bridge only accepts the known replaceable data object shape.",
		};
	}
	if (descriptor.writable !== true) {
		return {
			code: "native-data-not-replaceable",
			level: "warning",
			message: "The native Canvas root data property is not writable, so atomic metadata actions are disabled.",
		};
	}
	return undefined;
}

function makeProbe(
	status: ObsidianMetadataStoreStatus,
	diagnostics: readonly ObsidianMetadataStoreDiagnostic[],
	store?: MetadataDocumentStore,
): ObsidianMetadataStoreProbe {
	return {
		status,
		available: status === "ready" && store !== undefined,
		compatible: status !== "incompatible",
		diagnostics: [...diagnostics],
		store,
	};
}

function resolveRuntime(
	view: unknown,
	diagnostics: ObsidianMetadataStoreDiagnostic[],
): UnknownRecord | undefined | null {
	if (!isObject(view)) {
		diagnostics.push({
			code: "native-view-missing",
			level: "info",
			message: "No native Canvas view was supplied; metadata persistence is unavailable.",
		});
		return undefined;
	}

	const canvas = safeGet(view, "canvas");
	if (!canvas.ok) {
		diagnostics.push({
			code: "native-runtime-read-failed",
			level: "warning",
			message: "Reading the native Canvas runtime from the supplied view failed.",
		});
		return null;
	}
	if (canvas.value !== undefined) {
		if (!isObject(canvas.value)) {
			diagnostics.push({
				code: "native-runtime-incompatible",
				level: "warning",
				message: "The supplied Canvas view exposes a non-object runtime; root metadata persistence is disabled.",
			});
			return null;
		}
		return canvas.value;
	}

	// A direct runtime is useful in tests and in the narrowest unwrapped view
	// shape.  It is accepted only when both known native members are present.
	const data = safeGet(view, "data");
	const save = safeGet(view, "requestSave");
	if (!data.ok || !save.ok) {
		diagnostics.push({
			code: "native-runtime-read-failed",
			level: "warning",
			message: "Reading the native Canvas root-data capabilities failed.",
		});
		return null;
	}
	if (data.value !== undefined || save.value !== undefined) {
		if (data.value === undefined || typeof save.value !== "function") {
			diagnostics.push({
				code: "native-runtime-incompatible",
				level: "warning",
				message: "The supplied object is not the known native Canvas root-data runtime shape.",
			});
			return null;
		}
		return view;
	}

	diagnostics.push({
		code: "native-canvas-missing",
		level: "info",
		message: "The supplied view has no native Canvas runtime; metadata persistence is unavailable.",
	});
	return undefined;
}

class ObsidianRootMetadataStore implements MetadataDocumentStore {
	public constructor(private readonly runtime: UnknownRecord) {}

	public readDocument(): unknown {
		const raw = this.readRawData();
		if (!raw.ok) {
			return undefined;
		}
		try {
			return cloneDocument(raw.value);
		} catch {
			return undefined;
		}
	}

	/**
	 * Compare the live root, replace it with a detached clone, request native
	 * history/save, and verify the replacement.  No operation mutates either
	 * the expected object or the current root in place.  A failed save restores
	 * the previous root in memory and returns false so MetadataWriter can refuse
	 * the transaction (and attempt its own guarded rollback when appropriate).
	 */
	public commitDocument(
		nextDocument: Readonly<Record<string, unknown>>,
		expectedDocument: Readonly<Record<string, unknown>>,
	): boolean {
		const current = this.readRawData();
		if (!current.ok) {
			return false;
		}

		let currentSnapshot: Record<string, unknown>;
		let expectedSnapshot: Record<string, unknown>;
		let replacement: Record<string, unknown>;
		try {
			currentSnapshot = cloneDocument(current.value);
			expectedSnapshot = cloneDocument(expectedDocument);
			replacement = cloneDocument(nextDocument);
		} catch {
			return false;
		}
		if (!equalJson(currentSnapshot, expectedSnapshot)) {
			return false;
		}

		const readonly = safeGet(this.runtime, "readonly");
		if (!readonly.ok || readonly.value === true) {
			return false;
		}
		const save = safeGet(this.runtime, "requestSave");
		if (!save.ok || typeof save.value !== "function") {
			return false;
		}

		if (!this.replaceRoot(replacement, current.value)) {
			return false;
		}

		const replaced = this.readRawData();
		if (!replaced.ok || replaced.value === current.value || !this.equalsRaw(replaced.value, replacement)) {
			this.restoreRoot(currentSnapshot);
			return false;
		}

		try {
			// `true` asks native Canvas to record this exact root snapshot in its
			// own undo/redo history and then schedule the normal view save.
			const saveResult = Reflect.apply(save.value, this.runtime, [true]);
			// Obsidian 1.12.7's requestSave is synchronous and returns void.  A
			// thenable cannot be verified by this synchronous writer, so it is
			// rejected instead of pretending that an async save is atomic.
			if (saveResult === false || isThenable(saveResult)) {
				this.restoreRoot(currentSnapshot);
				return false;
			}
		} catch {
			this.restoreRoot(currentSnapshot);
			return false;
		}

		const observed = this.readRawData();
		if (!observed.ok || observed.value === current.value || !this.equalsRaw(observed.value, replacement)) {
			this.restoreRoot(currentSnapshot);
			return false;
		}
		return true;
	}

	private readRawData(): ReadResult {
		return safeGet(this.runtime, "data");
	}

	private equalsRaw(value: unknown, expected: Record<string, unknown>): boolean {
		try {
			return equalJson(cloneDocument(value), expected);
		} catch {
			return false;
		}
	}

	private replaceRoot(next: Record<string, unknown>, previous: unknown): boolean {
		if (next === previous) {
			return false;
		}
		try {
			return Reflect.set(this.runtime, "data", next, this.runtime);
		} catch {
			return false;
		}
	}

	private restoreRoot(previous: Record<string, unknown>): boolean {
		let replacement: Record<string, unknown>;
		try {
			replacement = cloneDocument(previous);
		} catch {
			return false;
		}
		try {
			if (!Reflect.set(this.runtime, "data", replacement, this.runtime)) {
				return false;
			}
			const observed = this.readRawData();
			return observed.ok && this.equalsRaw(observed.value, replacement);
		} catch {
			return false;
		}
	}
}

function isThenable(value: unknown): boolean {
	if (!isObject(value)) {
		return false;
	}
	try {
		return typeof Reflect.get(value, "then", value) === "function";
	} catch {
		return true;
	}
}

/**
 * Probe the exact native root-data shape and return a writer-compatible store
 * only when replacement and native history/save are both justified.  Missing
 * Canvas is an ordinary unavailable state; an observed but changed private
 * shape is incompatible.  Neither state is faked as an in-memory fallback.
 */
export function createObsidianMetadataStore(view: unknown): ObsidianMetadataStoreProbe {
	const diagnostics: ObsidianMetadataStoreDiagnostic[] = [];
	const runtime = resolveRuntime(view, diagnostics);
	if (runtime === undefined) {
		return makeProbe("unavailable", diagnostics);
	}
	if (runtime === null) {
		return makeProbe("incompatible", diagnostics);
	}

	const descriptorDiagnostic = ownDataIsReplaceable(runtime);
	if (descriptorDiagnostic !== undefined) {
		diagnostics.push(descriptorDiagnostic);
		return makeProbe("incompatible", diagnostics);
	}

	const data = safeGet(runtime, "data");
	if (!data.ok) {
		diagnostics.push({
			code: "native-data-read-failed",
			level: "warning",
			message: "Reading the native Canvas root document failed; metadata persistence is disabled.",
		});
		return makeProbe("incompatible", diagnostics);
	}
	try {
		cloneDocument(data.value);
	} catch (error) {
		diagnostics.push({
			code: "native-data-invalid",
			level: "warning",
			message: `The native Canvas root document is not a safe JSON object: ${describeError(error)}.`,
		});
		return makeProbe("incompatible", diagnostics);
	}

	const save = safeGet(runtime, "requestSave");
	if (!save.ok || typeof save.value !== "function") {
		diagnostics.push({
			code: "native-save-missing",
			level: "warning",
			message: "The native Canvas runtime does not expose requestSave(true); undoable metadata persistence is disabled.",
		});
		return makeProbe("incompatible", diagnostics);
	}

	return makeProbe("ready", diagnostics, new ObsidianRootMetadataStore(runtime));
}
