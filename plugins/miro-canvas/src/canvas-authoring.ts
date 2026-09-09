/**
 * Small, native-only authoring boundary for M2 shape creation.
 *
 * JSON Canvas has no portable shape subtype field.  Created shapes therefore
 * use an ordinary, editable `type: "text"` node and keep the requested shape
 * descriptor under `miroCanvas.localOverrides[id].shape`.  All graph changes
 * cross the native Canvas import/history boundary as one complete document;
 * assigning `canvas.data` is intentionally not a supported write path because
 * it does not rebuild the native node graph.
 */

import {
	decideEditOperation,
	type InteractionDecision,
} from "./interaction-policy";
import {
	MIRO_CANVAS_SCHEMA_VERSION,
	parseMiroCanvasMetadata,
	validateMiroCanvasMetadata,
} from "./metadata";
import {
	updateConnectorEndpoint as buildConnectorEndpointUpdate,
	type UpdateConnectorEndpointInput,
} from "./connector-endpoints";
import type { CanvasAnchor } from "./anchors";
import { isSafeColor, normalizeColor } from "./appearance";
import {
	LOCAL_SHAPE_KINDS, CONNECTOR_CAPS, CONNECTOR_ROUTES, CONNECTOR_STROKES,
	buildSourceScene, type LocalConnectorSettings,
} from "./source-model";

export const CANVAS_SHAPE_KINDS = LOCAL_SHAPE_KINDS;

export type CanvasShapeKind = (typeof CANVAS_SHAPE_KINDS)[number];

export interface CanvasShapeDescriptor {
	readonly kind: CanvasShapeKind;
	readonly fallback: "text";
}

export interface CanvasShapeAction {
	readonly text?: unknown;
	readonly shape?: unknown;
	readonly x?: unknown;
	readonly y?: unknown;
	readonly width?: unknown;
	readonly height?: unknown;
	readonly id?: unknown;
	readonly locked?: unknown;
	readonly colors?: unknown;
	readonly typography?: unknown;
	readonly borderStyle?: unknown;
	readonly borderWidth?: unknown;
}

/** ID is supplied by the caller's selection; absent fields retain their source/local values. */
export const CONNECTOR_SIDES = ["top", "right", "bottom", "left"] as const;
export type ConnectorSide = (typeof CONNECTOR_SIDES)[number];

export interface CreateConnectorInput {
	readonly fromNode: string;
	readonly toNode: string;
	readonly fromSide?: ConnectorSide;
	readonly toSide?: ConnectorSide;
	readonly fromAnchor?: CanvasAnchor;
	readonly toAnchor?: CanvasAnchor;
	readonly id?: string;
}

export interface CreateConnectorResult extends CanvasGraphResult {
	readonly edgeId?: string;
}

export interface UpdateElementStyleInput {
	readonly id: string;
	readonly shape?: CanvasShapeKind;
	readonly colors?: Readonly<Record<string, unknown>>;
	readonly typography?: Readonly<Record<string, unknown>>;
	readonly borderStyle?: "solid" | "dashed" | "dotted" | "none";
	readonly borderWidth?: number;
	readonly connector?: LocalConnectorSettings;
}

export interface UpdateRotationInput {
	readonly id: string;
	readonly rotation: number;
}

export type ZOrderDirection = "front" | "back" | "forward" | "backward";

export interface ChangeZOrderInput {
	readonly id: string;
	readonly direction: ZOrderDirection;
}

export interface CanvasAuthoringOptions {
	/** Prefix for generated IDs.  It is never used when an explicit ID is given. */
	readonly idPrefix?: string;
}

export type CanvasAuthoringStatus = "ready" | "unavailable" | "incompatible";

export type CanvasAuthoringDiagnosticLevel = "info" | "warning" | "error";

export interface CanvasAuthoringDiagnostic {
	readonly code: string;
	readonly level: CanvasAuthoringDiagnosticLevel;
	readonly message: string;
}

export type CanvasAuthoringCapability =
	| "document-read"
	| "graph-import"
	| "history-save"
	| "whole-document-transaction";

export interface CanvasAuthoringProbe {
	readonly status: CanvasAuthoringStatus;
	readonly available: boolean;
	readonly compatible: boolean;
	readonly capabilities: ReadonlySet<CanvasAuthoringCapability>;
	readonly diagnostics: readonly CanvasAuthoringDiagnostic[];
}

export interface CanvasAuthoringSnapshot {
	readonly ok: boolean;
	readonly status: CanvasAuthoringStatus;
	readonly document?: Readonly<Record<string, unknown>>;
	readonly nodes?: readonly Readonly<Record<string, unknown>>[];
	readonly edges?: readonly Readonly<Record<string, unknown>>[];
	readonly diagnostics: readonly CanvasAuthoringDiagnostic[];
}

export interface CanvasShapePreview {
	readonly ok: boolean;
	readonly status: "preview" | "rejected";
	readonly node?: Readonly<Record<string, unknown>>;
	readonly nodeId?: string;
	readonly document?: Readonly<Record<string, unknown>>;
	readonly diagnostics: readonly CanvasAuthoringDiagnostic[];
}

export interface CanvasShapeResult {
	readonly ok: boolean;
	readonly status: "applied" | "rejected";
	readonly node?: Readonly<Record<string, unknown>>;
	readonly nodeId?: string;
	readonly document?: Readonly<Record<string, unknown>>;
	readonly diagnostics: readonly CanvasAuthoringDiagnostic[];
}

export interface CanvasGraphResult {
	readonly ok: boolean;
	readonly status: "applied" | "rejected";
	readonly document?: Readonly<Record<string, unknown>>;
	readonly diagnostics: readonly CanvasAuthoringDiagnostic[];
}

export type CanvasAuthoringExpected =
	| Readonly<Record<string, unknown>>
	| CanvasAuthoringSnapshot
	| { readonly document: Readonly<Record<string, unknown>> };

type UnknownRecord = Record<string, unknown>;
type AnyRecord = Record<PropertyKey, unknown>;

type ReadResult =
	| { readonly ok: true; readonly value: unknown }
	| { readonly ok: false };

type NativeMutationMode = "importData" | "setData" | "applyHistory";

interface NativeHost {
	readonly runtime: AnyRecord;
	readonly mode: NativeMutationMode;
	readonly capabilities: ReadonlySet<CanvasAuthoringCapability>;
}

interface HostInspection {
	readonly status: CanvasAuthoringStatus;
	readonly runtime?: AnyRecord;
	readonly host?: NativeHost;
	readonly capabilities: ReadonlySet<CanvasAuthoringCapability>;
	readonly diagnostics: readonly CanvasAuthoringDiagnostic[];
}

interface InternalSnapshot {
	readonly document: UnknownRecord;
	readonly nodes: readonly UnknownRecord[];
	readonly edges: readonly UnknownRecord[];
}

interface BuiltShape {
	readonly id: string;
	readonly node: UnknownRecord;
	readonly document: UnknownRecord;
}

class SnapshotError extends Error {}

const MAX_DOCUMENT_ITEMS = 250_000;
const MAX_DOCUMENT_DEPTH = 96;
const MAX_TEXT_LENGTH = 1_000_000;
const MAX_IDENTIFIER_LENGTH = 512;
const MAX_ID_ATTEMPTS = 10_000;
const SAFE_GENERATED_ID_PREFIX = "miro-canvas-node";
const DANGEROUS_IDENTIFIER_NAMES = new Set(["__proto__", "prototype", "constructor"]);

function isObject(value: unknown): value is AnyRecord {
	return (typeof value === "object" && value !== null) || typeof value === "function";
}

function isPlainObject(value: unknown): value is AnyRecord {
	if (value === null || typeof value !== "object") {
		return false;
	}
	try {
		if (Array.isArray(value)) {
			return false;
		}
		const prototype = Object.getPrototypeOf(value);
		return prototype === null || prototype === Object.prototype;
	} catch {
		return false;
	}
}

function safeRead(target: unknown, key: PropertyKey): ReadResult {
	if (!isObject(target)) {
		return { ok: false };
	}
	try {
		return { ok: true, value: Reflect.get(target, key, target) };
	} catch {
		return { ok: false };
	}
}

function optionalValue(target: unknown, key: string): { readonly present: boolean; readonly value?: unknown } {
	if (!isObject(target) || !hasOwn(target, key)) {
		return { present: false };
	}
	const result = safeRead(target, key);
	return result.ok ? { present: true, value: result.value } : { present: true };
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

function ownKeys(target: AnyRecord): readonly string[] | undefined {
	try {
		for (const symbol of Object.getOwnPropertySymbols(target)) {
			if (Object.prototype.propertyIsEnumerable.call(target, symbol)) {
				return undefined;
			}
		}
		return Object.keys(target);
	} catch {
		return undefined;
	}
}

function describeError(_error: unknown): string {
	// Keep host errors out of user-facing diagnostics.  Private runtime error
	// values can contain paths or other data unrelated to this operation.
	return "native operation failed";
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

function safeInvoke(target: AnyRecord, method: string, args: readonly unknown[]): ReadResult {
	const candidate = safeRead(target, method);
	if (!candidate.ok || typeof candidate.value !== "function") {
		return { ok: false };
	}
	try {
		const value = Reflect.apply(candidate.value, target, [...args]);
		return isThenable(value) ? { ok: false } : { ok: true, value };
	} catch {
		return { ok: false };
	}
}

function addDiagnostic(
	diagnostics: CanvasAuthoringDiagnostic[],
	code: string,
	level: CanvasAuthoringDiagnosticLevel,
	message: string,
): void {
	if (diagnostics.some((item) => item.code === code && item.message === message)) {
		return;
	}
	diagnostics.push({ code, level, message });
}

function isSafeIdentifier(value: unknown): value is string {
	if (typeof value !== "string" || value.length === 0 || value.trim() !== value || value.length > MAX_IDENTIFIER_LENGTH) {
		return false;
	}
	if (DANGEROUS_IDENTIFIER_NAMES.has(value)) {
		return false;
	}
	for (let index = 0; index < value.length; index += 1) {
		const code = value.charCodeAt(index);
		if ((code >= 0 && code <= 0x1f) || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029) {
			return false;
		}
		if (code >= 0xd800 && code <= 0xdbff) {
			const next = value.charCodeAt(index + 1);
			if (next < 0xdc00 || next > 0xdfff) {
				return false;
			}
			index += 1;
		} else if (code >= 0xdc00 && code <= 0xdfff) {
			return false;
		}
	}
	return true;
}

function isFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

function cloneJson(
	value: unknown,
	seen = new Set<object>(),
	path = "document",
	state: { items: number } = { items: 0 },
	depth = 0,
): unknown {
	state.items += 1;
	if (state.items > MAX_DOCUMENT_ITEMS) {
		throw new SnapshotError("document item limit exceeded");
	}
	if (depth > MAX_DOCUMENT_DEPTH) {
		throw new SnapshotError(`document depth limit exceeded at ${path}`);
	}
	if (value === null || typeof value !== "object") {
		if (value === undefined || typeof value === "function" || typeof value === "symbol" || typeof value === "bigint") {
			throw new SnapshotError(`non-JSON value at ${path}`);
		}
		if (typeof value === "number" && !Number.isFinite(value)) {
			throw new SnapshotError(`non-finite number at ${path}`);
		}
		return value;
	}
	if (seen.has(value)) {
		throw new SnapshotError(`cyclic value at ${path}`);
	}
	seen.add(value);
	try {
		let arrayValue = false;
		try {
			arrayValue = Array.isArray(value);
		} catch {
			throw new SnapshotError(`array check failed at ${path}`);
		}
		if (arrayValue) {
			const array = value as readonly unknown[];
			const length = safeRead(array, "length");
			if (!length.ok || typeof length.value !== "number" || !Number.isSafeInteger(length.value) || length.value < 0) {
				throw new SnapshotError(`invalid array length at ${path}`);
			}
			const result: unknown[] = [];
			for (let index = 0; index < length.value; index += 1) {
				if (!hasOwn(array, String(index))) {
					throw new SnapshotError(`sparse array at ${path}[${index}]`);
				}
				const item = safeRead(array, index);
				if (!item.ok) {
					throw new SnapshotError(`array item read failed at ${path}[${index}]`);
				}
				result.push(cloneJson(item.value, seen, `${path}[${index}]`, state, depth + 1));
			}
			const keys = ownKeys(value as AnyRecord);
			if (keys === undefined || keys.some((key) => key !== "length" && !/^\d+$/.test(key))) {
				throw new SnapshotError(`invalid array fields at ${path}`);
			}
			return result;
		}
		if (!isPlainObject(value)) {
			throw new SnapshotError(`non-plain object at ${path}`);
		}
		const keys = ownKeys(value);
		if (keys === undefined) {
			throw new SnapshotError(`object enumeration failed at ${path}`);
		}
		const result: UnknownRecord = {};
		for (const key of keys) {
			const item = safeRead(value, key);
			if (!item.ok) {
				throw new SnapshotError(`property read failed at ${path}.${key}`);
			}
			Object.defineProperty(result, key, {
				configurable: true,
				enumerable: true,
				value: cloneJson(item.value, seen, `${path}.${key}`, state, depth + 1),
				writable: true,
			});
		}
		return result;
	} finally {
		seen.delete(value);
	}
}

function cloneRecord(value: unknown): UnknownRecord {
	const result = cloneJson(value);
	if (!isPlainObject(result)) {
		throw new SnapshotError("Canvas document root must be an object");
	}
	return result as UnknownRecord;
}

function structurallyEqual(left: unknown, right: unknown): boolean {
	if (Object.is(left, right)) {
		return true;
	}
	if (left === null || right === null || typeof left !== typeof right || typeof left !== "object") {
		return false;
	}
	let leftArray = false;
	let rightArray = false;
	try {
		leftArray = Array.isArray(left);
		rightArray = Array.isArray(right);
	} catch {
		return false;
	}
	if (leftArray !== rightArray) {
		return false;
	}
	if (leftArray) {
		const a = left as readonly unknown[];
		const b = right as readonly unknown[];
		if (a.length !== b.length) {
			return false;
		}
		for (let index = 0; index < a.length; index += 1) {
			if (!structurallyEqual(a[index], b[index])) {
				return false;
			}
		}
		return true;
	}
	if (!isPlainObject(left) || !isPlainObject(right)) {
		return false;
	}
	const leftKeys = ownKeys(left);
	const rightKeys = ownKeys(right);
	if (leftKeys === undefined || rightKeys === undefined || leftKeys.length !== rightKeys.length) {
		return false;
	}
	for (const key of leftKeys) {
		if (!hasOwn(right, key)) {
			return false;
		}
		const leftValue = safeRead(left, key);
		const rightValue = safeRead(right, key);
		if (!leftValue.ok || !rightValue.ok || !structurallyEqual(leftValue.value, rightValue.value)) {
			return false;
		}
	}
	return true;
}

function readRequiredString(record: UnknownRecord, key: string): string | undefined {
	const value = safeRead(record, key);
	return value.ok && isSafeIdentifier(value.value) ? value.value : undefined;
}

function validateGraphDocument(value: unknown): InternalSnapshot {
	const document = cloneRecord(value);
	const nodesValue = safeRead(document, "nodes");
	const edgesValue = safeRead(document, "edges");
	if (!nodesValue.ok || !edgesValue.ok || !Array.isArray(nodesValue.value) || !Array.isArray(edgesValue.value)) {
		throw new SnapshotError("Canvas document must contain nodes and edges arrays");
	}
	const nodes: UnknownRecord[] = [];
	const edges: UnknownRecord[] = [];
	const ids = new Set<string>();
	const readItems = (valueToRead: readonly unknown[], target: UnknownRecord[], label: string): void => {
		if (valueToRead.length > MAX_DOCUMENT_ITEMS) {
			throw new SnapshotError(`${label} limit exceeded`);
		}
		for (let index = 0; index < valueToRead.length; index += 1) {
			const item = valueToRead[index];
			if (!isPlainObject(item)) {
				throw new SnapshotError(`${label}[${index}] must be an object`);
			}
			const id = readRequiredString(item, "id");
			if (id === undefined || ids.has(id)) {
				throw new SnapshotError(`${label}[${index}] has an invalid or duplicate id`);
			}
			ids.add(id);
			target.push(item);
		}
	};
	readItems(nodesValue.value as readonly unknown[], nodes, "nodes");
	readItems(edgesValue.value as readonly unknown[], edges, "edges");
	return { document, nodes, edges };
}

function resolveRuntime(view: unknown, diagnostics: CanvasAuthoringDiagnostic[]): AnyRecord | undefined {
	if (!isObject(view)) {
		addDiagnostic(diagnostics, "native-runtime-missing", "info", "No native Canvas runtime was supplied.");
		return undefined;
	}
	const canvas = safeRead(view, "canvas");
	if (!canvas.ok) {
		addDiagnostic(diagnostics, "native-runtime-read-failed", "warning", "The native Canvas runtime could not be read safely.");
		return undefined;
	}
	if (canvas.value !== undefined) {
		if (!isObject(canvas.value)) {
			addDiagnostic(diagnostics, "native-runtime-incompatible", "warning", "The supplied Canvas runtime is not an object.");
			return undefined;
		}
		return canvas.value;
	}
	return view;
}

function inspectHost(view: unknown): HostInspection {
	const diagnostics: CanvasAuthoringDiagnostic[] = [];
	const runtime = resolveRuntime(view, diagnostics);
	if (runtime === undefined) {
		return {
			status: "unavailable",
			capabilities: new Set(),
			diagnostics,
		};
	}
	const getData = safeRead(runtime, "getData");
	if (!getData.ok || typeof getData.value !== "function") {
		addDiagnostic(diagnostics, "native-get-data-missing", "warning", "Native Canvas getData() is required for a safe graph transaction.");
		return { status: "incompatible", runtime, capabilities: new Set(), diagnostics };
	}
	const document = safeInvoke(runtime, "getData", []);
	if (!document.ok) {
		addDiagnostic(diagnostics, "native-get-data-failed", "warning", "Native Canvas getData() failed or returned an asynchronous result.");
		return { status: "incompatible", runtime, capabilities: new Set(), diagnostics };
	}
	try {
		validateGraphDocument(document.value);
	} catch (error) {
		addDiagnostic(diagnostics, "canvas-document-invalid", "warning", `The native Canvas document is not a supported graph: ${describeError(error)}.`);
		return { status: "incompatible", runtime, capabilities: new Set(), diagnostics };
	}

	const importData = safeRead(runtime, "importData");
	const setData = safeRead(runtime, "setData");
	const applyHistory = safeRead(runtime, "applyHistory");
	const requestSave = safeRead(runtime, "requestSave");
	const hasImport = importData.ok && typeof importData.value === "function";
	const hasSetData = setData.ok && typeof setData.value === "function";
	const hasApplyHistory = applyHistory.ok && typeof applyHistory.value === "function";
	const hasRequestSave = requestSave.ok && typeof requestSave.value === "function";
	let mode: NativeMutationMode | undefined;
	if (hasImport && hasRequestSave) {
		mode = "importData";
	} else if (hasSetData) {
		// Native setData() records one history entry itself on the observed host.
		mode = "setData";
	} else if (hasApplyHistory) {
		// Native applyHistory() imports and records the supplied snapshot itself.
		mode = "applyHistory";
	}
	if (mode === undefined) {
		addDiagnostic(
			diagnostics,
			"native-graph-transaction-missing",
			"warning",
			"Native Canvas exposes no verified synchronous graph import plus history boundary; authoring is disabled.",
		);
		return { status: "incompatible", runtime, capabilities: new Set(), diagnostics };
	}
	const capabilities = new Set<CanvasAuthoringCapability>([
		"document-read",
		"graph-import",
		"history-save",
		"whole-document-transaction",
	]);
	return {
		status: "ready",
		runtime,
		host: { runtime, mode, capabilities },
		capabilities,
		diagnostics,
	};
}

function makeSnapshot(value: unknown, diagnostics: CanvasAuthoringDiagnostic[]): InternalSnapshot | undefined {
	try {
		return validateGraphDocument(value);
	} catch (error) {
		addDiagnostic(diagnostics, "canvas-document-invalid", "warning", `The native Canvas graph could not be read safely: ${describeError(error)}.`);
		return undefined;
	}
}

function readSnapshotFromHost(host: NativeHost, diagnostics: CanvasAuthoringDiagnostic[]): InternalSnapshot | undefined {
	const result = safeInvoke(host.runtime, "getData", []);
	if (!result.ok) {
		addDiagnostic(diagnostics, "native-get-data-failed", "warning", "Native Canvas getData() failed or returned an asynchronous result.");
		return undefined;
	}
	return makeSnapshot(result.value, diagnostics);
}

function setOwn(record: UnknownRecord, key: string, value: unknown): void {
	Object.defineProperty(record, key, {
		configurable: true,
		enumerable: true,
		value,
		writable: true,
	});
}

function actionProperty(action: unknown, key: string): ReadResult {
	if (!isPlainObject(action) || !hasOwn(action, key)) {
		return { ok: false };
	}
	return safeRead(action, key);
}

/** Copy untrusted action data without evaluating accessors or retaining references. */
function copyStyleData(value: unknown, depth = 0): unknown {
	if (depth > 8) throw new SnapshotError("style nesting limit");
	if (value === null || typeof value !== "object") return cloneJson(value);
	if (!isPlainObject(value)) throw new SnapshotError("style object expected");
	const keys = ownKeys(value);
	if (keys === undefined || keys.length > 64) throw new SnapshotError("style field limit");
	const result: UnknownRecord = {};
	for (const key of keys) {
		if (DANGEROUS_IDENTIFIER_NAMES.has(key)) throw new SnapshotError("unsafe style key");
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		if (descriptor === undefined || !("value" in descriptor)) throw new SnapshotError("style accessor refused");
		setOwn(result, key, copyStyleData(descriptor.value, depth + 1));
	}
	return result;
}

function readStylePatch(action: unknown, diagnostics: CanvasAuthoringDiagnostic[], allowConnector = false): UnknownRecord | undefined {
	const patch: UnknownRecord = {};
	try {
		if (!isPlainObject(action)) throw new SnapshotError("style action expected");
		for (const key of ["colors", "typography", "borderStyle", "borderWidth", "connector"]) {
			const property = Object.getOwnPropertyDescriptor(action, key);
			if (property === undefined) continue;
			if (!("value" in property)) throw new SnapshotError("style accessor refused");
			if (property.value === undefined) continue;
			if (key === "connector" && !allowConnector) throw new SnapshotError("connector settings on shape creation");
			patch[key] = copyStyleData(property.value);
		}
		const only = (value: unknown, keys: readonly string[]): UnknownRecord => {
			if (!isPlainObject(value) || Object.keys(value).some((key) => !keys.includes(key))) throw new SnapshotError("unsupported style field");
			return value as UnknownRecord;
		};
		if (patch.colors !== undefined) {
			const colors = only(patch.colors, ["text", "fill", "border", "edge"]);
			for (const key of Object.keys(colors)) {
				if (!isSafeColor(colors[key])) throw new SnapshotError("unsafe color");
				colors[key] = normalizeColor(colors[key]);
			}
		}
		if (patch.typography !== undefined) {
			const typography = only(patch.typography, ["fontFamily", "fontSize", "fontWeight", "fontStyle", "format", "alignment", "textAlign", "textDecoration", "lineHeight", "verticalAlign"]);
			if (typography.format !== undefined) {
				const format = only(typography.format, ["bold", "italic", "underline", "strike"]);
				if (Object.values(format).some((value) => typeof value !== "boolean")) throw new SnapshotError("invalid format flag");
			}
		}
		if (patch.borderStyle !== undefined && !["solid", "dashed", "dotted", "none"].includes(patch.borderStyle as string)) throw new SnapshotError("invalid border style");
		if (patch.borderWidth !== undefined && (!isFiniteNumber(patch.borderWidth) || patch.borderWidth < 0 || patch.borderWidth > 100)) throw new SnapshotError("invalid border width");
		if (patch.connector !== undefined) {
			const connector = only(patch.connector, ["route", "strokeStyle", "startCap", "endCap", "width", "color"]);
			for (const [key, values] of [["route", CONNECTOR_ROUTES], ["strokeStyle", CONNECTOR_STROKES], ["startCap", CONNECTOR_CAPS], ["endCap", CONNECTOR_CAPS]] as const) {
				if (connector[key] !== undefined && !(values as readonly unknown[]).includes(connector[key])) throw new SnapshotError("invalid connector enum");
			}
			if (connector.width !== undefined && (!isFiniteNumber(connector.width) || connector.width <= 0 || connector.width > 100)) throw new SnapshotError("invalid connector width");
			if (hasOwn(connector, "color")) {
				if (!isSafeColor(connector.color)) throw new SnapshotError("unsafe connector color");
				connector.color = normalizeColor(connector.color);
			}
		}
		if (!validateMiroCanvasMetadata({ schemaVersion: MIRO_CANVAS_SCHEMA_VERSION, localOverrides: { target: patch } }).valid) throw new SnapshotError("invalid appearance settings");
		return patch;
	} catch {
		addDiagnostic(diagnostics, "element-style-invalid", "error", "Style settings contain unsupported, unsafe, or out-of-range values.");
		return undefined;
	}
}

/** Merge only explicitly supplied leaves; preserve future fields at every edited level. */
function mergeStylePatch(existing: UnknownRecord, patch: UnknownRecord): UnknownRecord {
	const merged = cloneRecord(existing);
	for (const key of Object.keys(patch)) {
		const value = patch[key];
		if (isPlainObject(value)) {
			const prior = merged[key];
			if (prior !== undefined && !isPlainObject(prior)) throw new SnapshotError("existing style object is malformed");
			setOwn(merged, key, mergeStylePatch((prior ?? {}) as UnknownRecord, value as UnknownRecord));
		} else setOwn(merged, key, value);
	}
	return merged;
}

function readShapeAction(action: unknown, diagnostics: CanvasAuthoringDiagnostic[]): {
	readonly text: string;
	readonly shape: CanvasShapeKind;
	readonly x: number;
	readonly y: number;
	readonly width: number;
	readonly height: number;
	readonly id?: string;
	readonly locked?: boolean;
	readonly colors?: unknown;
	readonly typography?: unknown;
	readonly borderStyle?: unknown;
	readonly borderWidth?: unknown;
} | undefined {
	if (!isPlainObject(action)) {
		addDiagnostic(diagnostics, "shape-action-invalid", "error", "A shape action must be a plain object.");
		return undefined;
	}
	const shape = actionProperty(action, "shape");
	if (!shape.ok || typeof shape.value !== "string" || !(CANVAS_SHAPE_KINDS as readonly string[]).includes(shape.value)) {
		addDiagnostic(diagnostics, "shape-kind-invalid", "error", "The shape kind is not supported.");
		return undefined;
	}
	const textValue = actionProperty(action, "text");
	const text = textValue.ok && textValue.value !== undefined ? textValue.value : "";
	if (typeof text !== "string" || text.length > MAX_TEXT_LENGTH) {
		addDiagnostic(diagnostics, "shape-text-invalid", "error", "Shape text must be a bounded string.");
		return undefined;
	}
	const numeric = (key: string): number | undefined => {
		const value = actionProperty(action, key);
		return value.ok && isFiniteNumber(value.value) ? value.value : undefined;
	};
	const x = numeric("x");
	const y = numeric("y");
	const width = numeric("width");
	const height = numeric("height");
	if (x === undefined || y === undefined || width === undefined || height === undefined || width <= 0 || height <= 0) {
		addDiagnostic(diagnostics, "shape-geometry-invalid", "error", "Shape x, y, width, and height must be finite; dimensions must be positive.");
		return undefined;
	}
	const idValue = actionProperty(action, "id");
	let id: string | undefined;
	if (idValue.ok && idValue.value !== undefined) {
		if (!isSafeIdentifier(idValue.value)) {
			addDiagnostic(diagnostics, "shape-id-invalid", "error", "An explicit shape ID is not safe.");
			return undefined;
		}
		id = idValue.value;
	}
	const lockedValue = actionProperty(action, "locked");
	let locked: boolean | undefined;
	if (lockedValue.ok && lockedValue.value !== undefined) {
		if (typeof lockedValue.value !== "boolean") {
			addDiagnostic(diagnostics, "shape-lock-invalid", "error", "The optional shape lock must be boolean.");
			return undefined;
		}
		locked = lockedValue.value;
	}
	const style = readStylePatch(action, diagnostics);
	if (style === undefined) return undefined;
	return {
		...style,
		text,
		shape: shape.value as CanvasShapeKind,
		x,
		y,
		width,
		height,
		...(id === undefined ? {} : { id }),
		...(locked === undefined ? {} : { locked }),
	};
}

function collectDocumentIds(snapshot: InternalSnapshot): Set<string> {
	const result = new Set<string>();
	for (const item of [...snapshot.nodes, ...snapshot.edges]) {
		const id = readRequiredString(item, "id");
		if (id !== undefined) {
			result.add(id);
		}
	}
	const metadata = safeRead(snapshot.document, "miroCanvas");
	if (metadata.ok && isPlainObject(metadata.value)) {
		const overrides = safeRead(metadata.value, "localOverrides");
		if (overrides.ok && isPlainObject(overrides.value)) {
			for (const key of ownKeys(overrides.value) ?? []) {
				if (isSafeIdentifier(key)) {
					result.add(key);
				}
			}
		}
	}
	return result;
}

function allocateId(
	actionId: string | undefined,
	used: Set<string>,
	prefix: string,
	counter: number,
): { readonly id?: string; readonly nextCounter: number } {
	if (actionId !== undefined) {
		return used.has(actionId) ? { nextCounter: counter } : { id: actionId, nextCounter: counter };
	}
	for (let attempt = 0; attempt < MAX_ID_ATTEMPTS; attempt += 1) {
		const id = `${prefix}-${counter + attempt}`;
		if (isSafeIdentifier(id) && !used.has(id)) {
			return { id, nextCounter: counter + attempt + 1 };
		}
	}
	return { nextCounter: counter };
}

function readMetadataForUpdate(document: UnknownRecord, diagnostics: CanvasAuthoringDiagnostic[]): UnknownRecord | undefined {
	const current = safeRead(document, "miroCanvas");
	if (!current.ok) {
		addDiagnostic(diagnostics, "metadata-read-failed", "error", "The existing miroCanvas metadata could not be read safely.");
		return undefined;
	}
	if (current.value === undefined) {
		return {
			schemaVersion: MIRO_CANVAS_SCHEMA_VERSION,
			localOverrides: {},
		};
	}
	if (!isPlainObject(current.value)) {
		addDiagnostic(diagnostics, "metadata-invalid", "error", "Existing miroCanvas metadata is not an object; the write was refused.");
		return undefined;
	}
	const parsed = parseMiroCanvasMetadata(document);
	if (parsed.status === "invalid" || parsed.status === "unsupported" || parsed.metadata === undefined) {
		addDiagnostic(diagnostics, "metadata-invalid", "error", "Existing miroCanvas metadata is invalid or unsupported; the write was refused.");
		return undefined;
	}
	try {
		return cloneRecord(current.value);
	} catch (error) {
		addDiagnostic(diagnostics, "metadata-copy-failed", "error", `Existing miroCanvas metadata could not be copied: ${describeError(error)}.`);
		return undefined;
	}
}

function updateShapeMetadata(
	document: UnknownRecord,
	id: string,
	shape: CanvasShapeKind,
	locked: boolean | undefined,
	diagnostics: CanvasAuthoringDiagnostic[],
): UnknownRecord | undefined {
	const metadata = readMetadataForUpdate(document, diagnostics);
	if (metadata === undefined) {
		return undefined;
	}
	const overridesValue = safeRead(metadata, "localOverrides");
	if (!overridesValue.ok || (overridesValue.value !== undefined && !isPlainObject(overridesValue.value))) {
		addDiagnostic(diagnostics, "metadata-overrides-invalid", "error", "Existing localOverrides are not a safe object map.");
		return undefined;
	}
	let overrides: UnknownRecord;
	try {
		overrides = overridesValue.value === undefined ? {} : cloneRecord(overridesValue.value);
	} catch (error) {
		addDiagnostic(diagnostics, "metadata-overrides-invalid", "error", `Existing localOverrides could not be copied: ${describeError(error)}.`);
		return undefined;
	}
	const existing = safeRead(overrides, id);
	let override: UnknownRecord;
	if (existing.ok && existing.value !== undefined) {
		if (!isPlainObject(existing.value)) {
			addDiagnostic(diagnostics, "metadata-override-invalid", "error", "The target local override is not an object.");
			return undefined;
		}
		try {
			override = cloneRecord(existing.value);
		} catch (error) {
			addDiagnostic(diagnostics, "metadata-override-invalid", "error", `The target local override could not be copied: ${describeError(error)}.`);
			return undefined;
		}
	} else {
		override = {};
	}
	setOwn(override, "shape", {
		kind: shape,
		fallback: "text",
	} satisfies CanvasShapeDescriptor);
	if (locked !== undefined) {
		setOwn(override, "locked", locked);
	}
	setOwn(overrides, id, override);
	setOwn(metadata, "localOverrides", overrides);
	const validation = validateMiroCanvasMetadata(metadata);
	if (!validation.valid) {
		addDiagnostic(diagnostics, "metadata-validation-failed", "error", "The proposed shape metadata failed validation; no graph import was attempted.");
		return undefined;
	}
	return metadata;
}

function graphElementIds(snapshot: InternalSnapshot): readonly string[] {
	return [...snapshot.nodes, ...snapshot.edges]
		.map((item) => readRequiredString(item, "id"))
		.filter((id): id is string => id !== undefined);
}

function readGraphActionId(action: unknown, diagnostics: CanvasAuthoringDiagnostic[], code: string): string | undefined {
	const id = actionProperty(action, "id");
	if (!id.ok || !isSafeIdentifier(id.value)) {
		addDiagnostic(diagnostics, `${code}-id-invalid`, "error", "The target Canvas graph ID is missing or invalid.");
		return undefined;
	}
	return id.value;
}

function hasGraphElement(snapshot: InternalSnapshot, id: string): boolean {
	return graphElementIds(snapshot).includes(id);
}

function policyAllowsGraphEdit(
	document: UnknownRecord,
	operation: "rotate" | "edit",
	id: string,
	code: "rotation" | "z-order" | "element-style",
	diagnostics: CanvasAuthoringDiagnostic[],
): boolean {
	const decision = decideEditOperation(document, operation, id);
	if (!decision.valid) {
		addDiagnostic(diagnostics, `${code}-policy-invalid`, "error", "The Canvas interaction policy is invalid; the graph edit was refused.");
		return false;
	}
	if (!decision.allowed) {
		addDiagnostic(
			diagnostics,
			decision.reason === "review-mode" ? `${code}-blocked-review` : `${code}-blocked-lock`,
			"warning",
			decision.reason === "review-mode"
				? "Canvas review mode blocks this graph edit."
				: "The target Canvas graph element is locked.",
		);
		return false;
	}
	return true;
}

function normalizeRotation(rotation: number): number {
	if (rotation === 0) {
		return 0;
	}
	const normalized = ((rotation + 180) % 360 + 360) % 360 - 180;
	return Object.is(normalized, -0) ? 0 : normalized;
}

function buildRotationDocument(
	snapshot: InternalSnapshot,
	id: string,
	rotation: number,
	diagnostics: CanvasAuthoringDiagnostic[],
): UnknownRecord | undefined {
	let document: UnknownRecord;
	try {
		document = cloneRecord(snapshot.document);
	} catch (error) {
		addDiagnostic(diagnostics, "document-copy-failed", "error", `The Canvas document could not be copied: ${describeError(error)}.`);
		return undefined;
	}
	const metadata = readMetadataForUpdate(document, diagnostics);
	if (metadata === undefined) {
		return undefined;
	}
	const overridesValue = safeRead(metadata, "localOverrides");
	if (!overridesValue.ok || (overridesValue.value !== undefined && !isPlainObject(overridesValue.value))) {
		addDiagnostic(diagnostics, "metadata-overrides-invalid", "error", "Existing localOverrides are not a safe object map.");
		return undefined;
	}
	let overrides: UnknownRecord;
	try {
		overrides = overridesValue.value === undefined ? {} : cloneRecord(overridesValue.value);
	} catch (error) {
		addDiagnostic(diagnostics, "metadata-overrides-invalid", "error", `Existing localOverrides could not be copied: ${describeError(error)}.`);
		return undefined;
	}
	const existing = safeRead(overrides, id);
	let override: UnknownRecord;
	if (existing.ok && existing.value !== undefined) {
		if (!isPlainObject(existing.value)) {
			addDiagnostic(diagnostics, "metadata-override-invalid", "error", "The target local override is not an object.");
			return undefined;
		}
		try {
			override = cloneRecord(existing.value);
		} catch (error) {
			addDiagnostic(diagnostics, "metadata-override-invalid", "error", `The target local override could not be copied: ${describeError(error)}.`);
			return undefined;
		}
	} else if (existing.ok) {
		override = {};
	} else {
		addDiagnostic(diagnostics, "metadata-override-invalid", "error", "The target local override could not be read safely.");
		return undefined;
	}
	setOwn(override, "rotation", rotation);
	setOwn(overrides, id, override);
	setOwn(metadata, "localOverrides", overrides);
	const validation = validateMiroCanvasMetadata(metadata);
	if (!validation.valid) {
		addDiagnostic(diagnostics, "metadata-validation-failed", "error", "The proposed rotation metadata failed validation; no graph import was attempted.");
		return undefined;
	}
	setOwn(document, "miroCanvas", metadata);
	return document;
}

interface ZOrderBuildResult {
	readonly changed: boolean;
	readonly document: UnknownRecord;
}

function buildSourceAliases(
	metadata: UnknownRecord,
	graphIds: ReadonlySet<string>,
	diagnostics: CanvasAuthoringDiagnostic[],
): Map<string, string> | undefined {
	const aliases = new Map<string, string>();
	const bindingsValue = safeRead(metadata, "bindings");
	if (!bindingsValue.ok) {
		addDiagnostic(diagnostics, "z-order-bindings-invalid", "error", "miroCanvas.bindings could not be read safely.");
		return undefined;
	}
	if (bindingsValue.value === undefined) {
		return aliases;
	}
	if (!isPlainObject(bindingsValue.value)) {
		addDiagnostic(diagnostics, "z-order-bindings-invalid", "error", "miroCanvas.bindings must be an object map.");
		return undefined;
	}
	const keys = ownKeys(bindingsValue.value);
	if (keys === undefined) {
		addDiagnostic(diagnostics, "z-order-bindings-invalid", "error", "miroCanvas.bindings could not be enumerated safely.");
		return undefined;
	}
	for (const canvasId of keys) {
		if (!graphIds.has(canvasId)) {
			continue;
		}
		const binding = safeRead(bindingsValue.value, canvasId);
		if (!binding.ok || !isPlainObject(binding.value)) {
			addDiagnostic(diagnostics, "z-order-bindings-invalid", "error", "A graph binding could not be read safely.");
			return undefined;
		}
		const sourceIdValue = safeRead(binding.value, "sourceId");
		if (!sourceIdValue.ok || typeof sourceIdValue.value !== "string" || sourceIdValue.value.length === 0) {
			addDiagnostic(diagnostics, "z-order-bindings-invalid", "error", "A graph binding has no valid source ID.");
			return undefined;
		}
		const sourceId = sourceIdValue.value;
		const directGraphId = graphIds.has(sourceId) ? sourceId : undefined;
		const existing = aliases.get(sourceId);
		if ((existing !== undefined && existing !== canvasId) || (directGraphId !== undefined && directGraphId !== canvasId)) {
			addDiagnostic(diagnostics, "z-order-id-collision", "error", "Canvas and source IDs collide, so z-order cannot be resolved unambiguously.");
			return undefined;
		}
		aliases.set(sourceId, canvasId);
	}
	return aliases;
}

function buildZOrderDocument(
	snapshot: InternalSnapshot,
	id: string,
	direction: ZOrderDirection,
	diagnostics: CanvasAuthoringDiagnostic[],
): ZOrderBuildResult | undefined {
	let document: UnknownRecord;
	try {
		document = cloneRecord(snapshot.document);
	} catch (error) {
		addDiagnostic(diagnostics, "document-copy-failed", "error", `The Canvas document could not be copied: ${describeError(error)}.`);
		return undefined;
	}
	const metadata = readMetadataForUpdate(document, diagnostics);
	if (metadata === undefined) {
		return undefined;
	}
	const nativeOrder = graphElementIds(snapshot);
	const graphIds = new Set(nativeOrder);
	const aliases = buildSourceAliases(metadata, graphIds, diagnostics);
	if (aliases === undefined) {
		return undefined;
	}
	const resolveToken = (token: string): string | undefined => {
		const direct = graphIds.has(token) ? token : undefined;
		const alias = aliases.get(token);
		if (direct !== undefined && alias !== undefined && direct !== alias) {
			return undefined;
		}
		return direct ?? alias;
	};
	const zOrderValue = safeRead(metadata, "zOrder");
	if (!zOrderValue.ok) {
		addDiagnostic(diagnostics, "z-order-invalid", "error", "miroCanvas.zOrder could not be read safely.");
		return undefined;
	}
	const hasExplicitOrder = zOrderValue.value !== undefined;
	if (hasExplicitOrder && !Array.isArray(zOrderValue.value)) {
		addDiagnostic(diagnostics, "z-order-invalid", "error", "miroCanvas.zOrder must be an array.");
		return undefined;
	}
	const explicitOrder: string[] = [];
	if (Array.isArray(zOrderValue.value)) {
		for (const token of zOrderValue.value) {
			if (typeof token !== "string" || token.length === 0) {
				addDiagnostic(diagnostics, "z-order-invalid", "error", "miroCanvas.zOrder contains an invalid ID.");
				return undefined;
			}
			explicitOrder.push(token);
		}
	}
	const canonicalBySlot: Array<string | undefined> = [];
	const preferredTokens = new Map<string, string>();
	const represented = new Set<string>();
	for (const token of explicitOrder) {
		const canonical = resolveToken(token);
		canonicalBySlot.push(canonical);
		if (canonical === undefined) {
			continue;
		}
		if (represented.has(canonical)) {
			addDiagnostic(diagnostics, "z-order-id-collision", "error", "The explicit z-order names one graph element through multiple IDs.");
			return undefined;
		}
		represented.add(canonical);
		preferredTokens.set(canonical, token);
	}
	const canonicalOrder = canonicalBySlot.filter((entry): entry is string => entry !== undefined);
	const fallbackIds = nativeOrder.filter((graphId) => !represented.has(graphId));
	canonicalOrder.push(...fallbackIds);
	if (fallbackIds.length > 0) {
		addDiagnostic(
			diagnostics,
			"z-order-source-limited-fallback",
			"info",
			"Explicit source/local layer order is incomplete; native Canvas graph order supplies the unresolved graph entries.",
		);
	}
	const index = canonicalOrder.indexOf(id);
	if (index < 0) {
		addDiagnostic(diagnostics, "z-order-id-missing", "error", "The target Canvas graph ID is not present in the native graph.");
		return undefined;
	}
	let destination = index;
	if (direction === "front") {
		destination = canonicalOrder.length - 1;
	} else if (direction === "back") {
		destination = 0;
	} else if (direction === "forward") {
		destination = Math.min(index + 1, canonicalOrder.length - 1);
	} else {
		destination = Math.max(index - 1, 0);
	}
	if (destination === index) {
		return { changed: false, document: snapshot.document };
	}
	const reordered = [...canonicalOrder];
	const [moved] = reordered.splice(index, 1);
	if (moved === undefined) {
		addDiagnostic(diagnostics, "z-order-invalid", "error", "The target z-order entry could not be moved safely.");
		return undefined;
	}
	reordered.splice(destination, 0, moved);
	const orderedTokens = reordered.map((graphId) => preferredTokens.get(graphId) ?? graphId);
	let nextOrder: string[];
	if (hasExplicitOrder) {
		nextOrder = [...explicitOrder];
		let tokenIndex = 0;
		for (let slot = 0; slot < canonicalBySlot.length; slot += 1) {
			if (canonicalBySlot[slot] !== undefined) {
				nextOrder[slot] = orderedTokens[tokenIndex]!;
				tokenIndex += 1;
			}
		}
		nextOrder.push(...orderedTokens.slice(tokenIndex));
	} else {
		nextOrder = orderedTokens;
	}
	setOwn(metadata, "zOrder", nextOrder);
	const validation = validateMiroCanvasMetadata(metadata);
	if (!validation.valid) {
		addDiagnostic(diagnostics, "metadata-validation-failed", "error", "The proposed z-order metadata failed validation; no graph import was attempted.");
		return undefined;
	}
	setOwn(document, "miroCanvas", metadata);
	return { changed: !structurallyEqual(document, snapshot.document), document };
}

function buildShape(
	snapshot: InternalSnapshot,
	action: unknown,
	prefix: string,
	counter: number,
	diagnostics: CanvasAuthoringDiagnostic[],
): BuiltShape | undefined {
	const parsed = readShapeAction(action, diagnostics);
	if (parsed === undefined) {
		return undefined;
	}
	const used = collectDocumentIds(snapshot);
	const allocated = allocateId(parsed.id, used, prefix, counter);
	if (allocated.id === undefined) {
		addDiagnostic(diagnostics, parsed.id === undefined ? "shape-id-generation-failed" : "shape-id-collision", "error", parsed.id === undefined
			? "A collision-free Canvas node ID could not be generated."
			: "The explicit Canvas node ID is already in use.");
		return undefined;
	}
	const node: UnknownRecord = {
		id: allocated.id,
		type: "text",
		x: parsed.x,
		y: parsed.y,
		width: parsed.width,
		height: parsed.height,
		text: parsed.text,
	};
	let document: UnknownRecord;
	try {
		document = cloneRecord(snapshot.document);
	} catch (error) {
		addDiagnostic(diagnostics, "document-copy-failed", "error", `The Canvas document could not be copied: ${describeError(error)}.`);
		return undefined;
	}
	const nodesValue = safeRead(document, "nodes");
	if (!nodesValue.ok || !Array.isArray(nodesValue.value)) {
		addDiagnostic(diagnostics, "canvas-document-invalid", "error", "The target Canvas nodes array is unavailable.");
		return undefined;
	}
	const nodes = [...nodesValue.value, node];
	setOwn(document, "nodes", nodes);
	const metadata = updateShapeMetadata(document, allocated.id, parsed.shape, parsed.locked, diagnostics);
	if (metadata === undefined) {
		return undefined;
	}
	const style = readStylePatch(parsed, diagnostics);
	if (style === undefined) return undefined;
	const overrides = metadata.localOverrides as UnknownRecord;
	setOwn(overrides, allocated.id, mergeStylePatch(overrides[allocated.id] as UnknownRecord, style));
	setOwn(document, "miroCanvas", metadata);
	return { id: allocated.id, node, document };
}

function policyAllowsCreate(document: UnknownRecord, diagnostics: CanvasAuthoringDiagnostic[]): InteractionDecision | undefined {
	const decision = decideEditOperation(document, "create");
	if (!decision.valid) {
		addDiagnostic(diagnostics, "policy-invalid", "error", "The Canvas interaction policy is invalid; authoring was refused.");
		return undefined;
	}
	if (!decision.allowed) {
		addDiagnostic(
			diagnostics,
			decision.reason === "review-mode" ? "policy-review-mode" : "policy-locked",
			"warning",
			decision.reason === "review-mode"
				? "Canvas review mode blocks shape creation."
				: "Canvas interaction policy blocks shape creation.",
		);
		return undefined;
	}
	return decision;
}

function extractExpectedDocument(expected: unknown): unknown {
	if (!isPlainObject(expected)) {
		return expected;
	}
	const document = safeRead(expected, "document");
	return document.ok && document.value !== undefined ? document.value : expected;
}

function invokeMutation(
	host: NativeHost,
	document: UnknownRecord,
	diagnostics: CanvasAuthoringDiagnostic[],
	phase: "import" | "history" | "rollback",
): boolean {
	let payload: UnknownRecord;
	try {
		payload = cloneRecord(document);
	} catch {
		addDiagnostic(diagnostics, `${phase}-document-invalid`, "error", "The transaction document could not be copied safely.");
		return false;
	}
	let result: ReadResult;
	if (phase === "history" && host.mode === "importData") {
		result = safeInvoke(host.runtime, "requestSave", [true]);
	} else {
		const method = host.mode === "importData" ? "importData" : host.mode;
		const args = host.mode === "importData" ? [payload, true] : [payload];
		result = safeInvoke(host.runtime, method, args);
	}
	if (!result.ok || result.value === false) {
		addDiagnostic(
			diagnostics,
			phase === "history" ? "native-history-failed" : phase === "rollback" ? "rollback-failed" : "native-import-failed",
			"error",
			phase === "history"
				? "Native Canvas did not accept the single history/save boundary."
				: phase === "rollback"
					? "Native Canvas rollback failed; the graph may require manual recovery."
					: "Native Canvas did not accept the complete graph import.",
		);
		return false;
	}
	return true;
}

function restoreGraph(host: NativeHost, before: InternalSnapshot, diagnostics: CanvasAuthoringDiagnostic[]): boolean {
	// importData is the only verified graph rebuild primitive.  Even when a
	// legacy setData/applyHistory host was selected for forward compatibility,
	// prefer importData for rollback if it exists and is callable.
	const importData = safeRead(host.runtime, "importData");
	const rollbackHost: NativeHost = importData.ok && typeof importData.value === "function"
		? { ...host, mode: "importData" }
		: host;
	if (!invokeMutation(rollbackHost, before.document, diagnostics, "rollback")) {
		return false;
	}
	const restored = readSnapshotFromHost(host, diagnostics);
	if (restored === undefined || !structurallyEqual(restored.document, before.document)) {
		addDiagnostic(diagnostics, "rollback-verification-failed", "error", "Native Canvas rollback could not be verified.");
		return false;
	}
	return true;
}

function runtimeAllowsMutation(host: NativeHost, diagnostics: CanvasAuthoringDiagnostic[]): boolean {
	const readonly = safeRead(host.runtime, "readonly");
	if (!readonly.ok) {
		addDiagnostic(diagnostics, "native-readonly-read-failed", "warning", "Native Canvas readonly state could not be read safely; graph mutation was refused.");
		return false;
	}
	if (readonly.value === true) {
		addDiagnostic(diagnostics, "native-runtime-readonly", "warning", "Native Canvas is readonly; graph mutation was refused.");
		return false;
	}
	return true;
}

function resultWithDiagnostics(
	diagnostics: readonly CanvasAuthoringDiagnostic[],
	ok: boolean,
	status: "applied" | "rejected",
	shape?: BuiltShape,
	verified?: InternalSnapshot,
): CanvasShapeResult {
	return {
		ok,
		status,
		...(shape === undefined ? {} : { node: shape.node, nodeId: shape.id }),
		...(verified === undefined ? {} : { document: verified.document }),
		diagnostics: [...diagnostics],
	};
}

export class CanvasAuthoring {
	public readonly kind = "canvas-authoring" as const;
	private readonly inspection: HostInspection;
	private readonly host: NativeHost | undefined;
	private readonly diagnosticList: CanvasAuthoringDiagnostic[];
	private readonly idPrefix: string;
	private idCounter = 1;
	private disposed = false;

	public constructor(view: unknown, options: CanvasAuthoringOptions = {}) {
		this.inspection = inspectHost(view);
		this.host = this.inspection.host;
		this.diagnosticList = [...this.inspection.diagnostics];
		const configuredPrefix = safeRead(options, "idPrefix");
		this.idPrefix = configuredPrefix.ok && isSafeIdentifier(configuredPrefix.value)
			? configuredPrefix.value
			: SAFE_GENERATED_ID_PREFIX;
	}

	public get status(): CanvasAuthoringStatus {
		return this.disposed ? "unavailable" : this.inspection.status;
	}

	public get available(): boolean {
		return !this.disposed && this.inspection.status === "ready";
	}

	public get compatible(): boolean {
		return this.inspection.status !== "incompatible";
	}

	public get capabilities(): ReadonlySet<CanvasAuthoringCapability> {
		return new Set(this.inspection.capabilities);
	}

	public get diagnostics(): readonly CanvasAuthoringDiagnostic[] {
		return [...this.diagnosticList];
	}

	public probe(): CanvasAuthoringProbe {
		return {
			status: this.status,
			available: this.available,
			compatible: this.compatible,
			capabilities: new Set(this.inspection.capabilities),
			diagnostics: this.diagnostics,
		};
	}

	/** Read a detached graph snapshot.  This method never imports or saves. */
	public readSnapshot(): CanvasAuthoringSnapshot {
		if (this.disposed || this.host === undefined) {
			return {
				ok: false,
				status: this.disposed ? "unavailable" : this.inspection.status,
				diagnostics: this.diagnostics,
			};
		}
		const diagnostics: CanvasAuthoringDiagnostic[] = [];
		const snapshot = readSnapshotFromHost(this.host, diagnostics);
		if (snapshot === undefined) {
			return { ok: false, status: "incompatible", diagnostics: [...this.diagnostics, ...diagnostics] };
		}
		return {
			ok: true,
			status: "ready",
			document: snapshot.document,
			nodes: snapshot.nodes,
			edges: snapshot.edges,
			diagnostics: [...this.diagnostics, ...diagnostics],
		};
	}

	/** Build a detached prospective shape without touching the native runtime. */
	public previewShape(action: unknown): CanvasShapePreview {
		const read = this.readSnapshot();
		if (!read.ok || read.document === undefined) {
			return { ok: false, status: "rejected", diagnostics: read.diagnostics };
		}
		const diagnostics: CanvasAuthoringDiagnostic[] = [];
		if (policyAllowsCreate(read.document as UnknownRecord, diagnostics) === undefined) {
			return { ok: false, status: "rejected", diagnostics: [...read.diagnostics, ...diagnostics] };
		}
		const snapshot: InternalSnapshot = {
			document: read.document as UnknownRecord,
			nodes: (read.nodes ?? []) as readonly UnknownRecord[],
			edges: (read.edges ?? []) as readonly UnknownRecord[],
		};
		const shape = buildShape(snapshot, action, this.idPrefix, this.idCounter, diagnostics);
		if (shape === undefined) {
			return { ok: false, status: "rejected", diagnostics: [...read.diagnostics, ...diagnostics] };
		}
		return {
			ok: true,
			status: "preview",
			node: shape.node,
			nodeId: shape.id,
			document: shape.document,
			diagnostics: [...read.diagnostics, ...diagnostics],
		};
	}

	/**
	 * Apply one complete graph transaction and record exactly one native history
	 * snapshot.  `expected` is optional; when supplied it is an explicit CAS
	 * token and a stale document is rejected before importData is called.
	 */
	public createShape(action: unknown, expected?: CanvasAuthoringExpected): CanvasShapeResult {
		if (this.disposed || this.host === undefined) {
			return resultWithDiagnostics(this.diagnostics, false, "rejected");
		}
		const beforeDiagnostics: CanvasAuthoringDiagnostic[] = [];
		const before = readSnapshotFromHost(this.host, beforeDiagnostics);
		if (before === undefined) {
			return resultWithDiagnostics([...this.diagnostics, ...beforeDiagnostics], false, "rejected");
		}
		const expectedInput = expected ?? (() => {
			const candidate = actionProperty(action, "expectedSnapshot");
			if (candidate.ok) return candidate.value;
			const document = actionProperty(action, "expectedDocument");
			return document.ok ? document.value : undefined;
		})();
		if (expectedInput !== undefined) {
			const expectedDiagnostics: CanvasAuthoringDiagnostic[] = [];
			const expectedSnapshot = makeSnapshot(extractExpectedDocument(expectedInput), expectedDiagnostics);
			if (expectedSnapshot === undefined || !structurallyEqual(expectedSnapshot.document, before.document)) {
				addDiagnostic(beforeDiagnostics, "stale-document", "warning", "The Canvas document changed since the supplied expected snapshot; no import was attempted.");
				return resultWithDiagnostics([...this.diagnostics, ...beforeDiagnostics, ...expectedDiagnostics], false, "rejected");
			}
		}
		// Re-read immediately before building/importing so an integration cannot
		// apply a stale detached snapshot after a synchronous external edit.
		const liveDiagnostics: CanvasAuthoringDiagnostic[] = [];
		const live = readSnapshotFromHost(this.host, liveDiagnostics);
		if (live === undefined || !structurallyEqual(live.document, before.document)) {
			addDiagnostic(liveDiagnostics, "stale-document", "warning", "The Canvas document changed before the transaction began; no import was attempted.");
			return resultWithDiagnostics([...this.diagnostics, ...beforeDiagnostics, ...liveDiagnostics], false, "rejected");
		}
		const policyDiagnostics: CanvasAuthoringDiagnostic[] = [];
		if (policyAllowsCreate(before.document, policyDiagnostics) === undefined) {
			return resultWithDiagnostics([...this.diagnostics, ...beforeDiagnostics, ...policyDiagnostics], false, "rejected");
		}
		const diagnostics: CanvasAuthoringDiagnostic[] = [...beforeDiagnostics, ...liveDiagnostics, ...policyDiagnostics];
		const parsedAction = readShapeAction(action, diagnostics);
		if (parsedAction === undefined) {
			return resultWithDiagnostics([...this.diagnostics, ...diagnostics], false, "rejected");
		}
		const used = collectDocumentIds(before);
		const allocation = allocateId(parsedAction.id, used, this.idPrefix, this.idCounter);
		if (allocation.id === undefined) {
			addDiagnostic(diagnostics, parsedAction.id === undefined ? "shape-id-generation-failed" : "shape-id-collision", "error", parsedAction.id === undefined
				? "A collision-free Canvas node ID could not be generated."
				: "The explicit Canvas node ID is already in use.");
			return resultWithDiagnostics([...this.diagnosticList, ...diagnostics], false, "rejected");
		}
		this.idCounter = allocation.nextCounter;
		const shape = buildShape({ ...before, document: before.document }, { ...parsedAction, id: allocation.id }, this.idPrefix, this.idCounter, diagnostics);
		if (shape === undefined) {
			return resultWithDiagnostics([...this.diagnosticList, ...diagnostics], false, "rejected");
		}
		const verified = this.commitDocument(before, shape.document, diagnostics);
		if (verified === undefined) {
			return resultWithDiagnostics([...this.diagnosticList, ...diagnostics], false, "rejected");
		}
		return resultWithDiagnostics([...this.diagnosticList, ...diagnostics], true, "applied", shape, verified);
	}

	/**
	 * Add one connector between two existing nodes.
	 *
	 * Native Canvas owns the edge list, so the edge is written in its own shape
	 * and nothing is recorded in plugin metadata.  Both endpoints are checked
	 * against the interaction policy: a locked node does not grow new
	 * connections behind the user's back.
	 */
	public createConnector(input: CreateConnectorInput, expected?: CanvasAuthoringExpected): CreateConnectorResult {
		const diagnostics: CanvasAuthoringDiagnostic[] = [];
		const reject = (): CreateConnectorResult => ({ ok: false, status: "rejected", diagnostics: [...this.diagnosticList, ...diagnostics] });
		if (this.disposed || this.host === undefined) return reject();
		const before = readSnapshotFromHost(this.host, diagnostics);
		if (before === undefined) return reject();
		if (expected !== undefined) {
			const snapshot = makeSnapshot(extractExpectedDocument(expected), diagnostics);
			if (snapshot === undefined || !structurallyEqual(snapshot.document, before.document)) {
				addDiagnostic(diagnostics, "stale-document", "warning", "The Canvas document changed since the supplied expected snapshot.");
				return reject();
			}
		}
		const fromNode = typeof input?.fromNode === "string" ? input.fromNode : undefined;
		const toNode = typeof input?.toNode === "string" ? input.toNode : undefined;
		if (fromNode === undefined || toNode === undefined || fromNode === toNode) {
			addDiagnostic(diagnostics, "connector-endpoints-invalid", "error", "A connector needs two different existing Canvas nodes.");
			return reject();
		}
		for (const id of [fromNode, toNode]) {
			if (before.nodes.some((node) => node.id === id)) continue;
			addDiagnostic(diagnostics, "connector-endpoint-missing", "error", `Canvas node ${id} does not exist.`);
			return reject();
		}
		const side = (value: unknown, fallback: ConnectorSide): ConnectorSide | undefined => {
			if (value === undefined) return fallback;
			return (CONNECTOR_SIDES as readonly string[]).includes(value as string) ? value as ConnectorSide : undefined;
		};
		const fromSide = side(input.fromSide, "right");
		const toSide = side(input.toSide, "left");
		if (fromSide === undefined || toSide === undefined) {
			addDiagnostic(diagnostics, "connector-side-invalid", "error", "A connector side must be top, right, bottom or left.");
			return reject();
		}
		if (policyAllowsCreate(before.document, diagnostics) === undefined) return reject();
		for (const id of [fromNode, toNode]) {
			if (!policyAllowsGraphEdit(before.document, "edit", id, "element-style", diagnostics)) return reject();
		}
		const allocation = allocateId(input.id, collectDocumentIds(before), this.idPrefix, this.idCounter);
		if (allocation.id === undefined) {
			addDiagnostic(diagnostics, input.id === undefined ? "connector-id-generation-failed" : "connector-id-collision", "error",
				input.id === undefined ? "A collision-free Canvas edge ID could not be generated." : "The explicit Canvas edge ID is already in use.");
			return reject();
		}
		this.idCounter = allocation.nextCounter;
		let document: UnknownRecord;
		try {
			document = cloneRecord(before.document);
		} catch (error) {
			addDiagnostic(diagnostics, "document-copy-failed", "error", `The Canvas document could not be copied: ${describeError(error)}.`);
			return reject();
		}
		const edgesValue = safeRead(document, "edges");
		const edges = edgesValue.ok && Array.isArray(edgesValue.value) ? edgesValue.value : undefined;
		if (edges === undefined) {
			addDiagnostic(diagnostics, "canvas-document-invalid", "error", "The target Canvas edges array is unavailable.");
			return reject();
		}
		setOwn(document, "edges", [...edges, {
			id: allocation.id, fromNode, fromSide, toNode, toSide, toEnd: "arrow",
		}]);
		for (const [end, anchor] of [["from", input.fromAnchor], ["to", input.toAnchor]] as const) {
			if (anchor === undefined) continue;
			const update = buildConnectorEndpointUpdate(document, { edgeId: allocation.id, end, anchor });
			for (const item of update.diagnostics) {
				addDiagnostic(diagnostics, item.code, update.ok ? "info" : "error", item.message);
			}
			if (!update.ok || update.document === undefined) return reject();
			document = update.document;
		}
		const verified = this.commitDocument(before, document, diagnostics);
		if (verified === undefined) return reject();
		return { ok: true, status: "applied", edgeId: allocation.id, document: verified.document, diagnostics: [...this.diagnosticList, ...diagnostics] };
	}

	/** Apply one connector endpoint change through the same guarded native graph transaction. */
	public updateConnectorEndpoint(
		input: UpdateConnectorEndpointInput,
		expected?: CanvasAuthoringExpected,
	): CanvasGraphResult {
		if (this.disposed || this.host === undefined) {
			return { ok: false, status: "rejected", diagnostics: this.diagnostics };
		}
		const diagnostics: CanvasAuthoringDiagnostic[] = [];
		const before = readSnapshotFromHost(this.host, diagnostics);
		if (before === undefined) {
			return { ok: false, status: "rejected", diagnostics: [...this.diagnosticList, ...diagnostics] };
		}
		if (expected !== undefined) {
			const expectedDiagnostics: CanvasAuthoringDiagnostic[] = [];
			const expectedSnapshot = makeSnapshot(extractExpectedDocument(expected), expectedDiagnostics);
			if (expectedSnapshot === undefined || !structurallyEqual(expectedSnapshot.document, before.document)) {
				addDiagnostic(diagnostics, "stale-document", "warning", "The Canvas document changed since the supplied expected snapshot; no import was attempted.");
				return { ok: false, status: "rejected", diagnostics: [...this.diagnosticList, ...diagnostics, ...expectedDiagnostics] };
			}
		}
		const liveDiagnostics: CanvasAuthoringDiagnostic[] = [];
		const live = readSnapshotFromHost(this.host, liveDiagnostics);
		if (live === undefined || !structurallyEqual(live.document, before.document)) {
			addDiagnostic(liveDiagnostics, "stale-document", "warning", "The Canvas document changed before the transaction began; no import was attempted.");
			return { ok: false, status: "rejected", diagnostics: [...this.diagnosticList, ...diagnostics, ...liveDiagnostics] };
		}
		diagnostics.push(...liveDiagnostics);
		const update = buildConnectorEndpointUpdate(before.document, input);
		for (const item of update.diagnostics) {
			addDiagnostic(diagnostics, item.code, update.ok ? "info" : "error", item.message);
		}
		if (!update.ok || update.document === undefined) {
			return { ok: false, status: "rejected", diagnostics: [...this.diagnosticList, ...diagnostics] };
		}
		const verified = this.commitDocument(before, update.document, diagnostics);
		if (verified === undefined) {
			return { ok: false, status: "rejected", diagnostics: [...this.diagnosticList, ...diagnostics] };
		}
		return { ok: true, status: "applied", document: verified.document, diagnostics: [...this.diagnosticList, ...diagnostics] };
	}

	/**
	 * Configure a selected shape or edge using its exact Canvas ID. Settings go
	 * only to localOverrides; native graph/history import preserves source evidence.
	 * Connector color takes precedence over colors.edge when both are present.
	 */
	public updateElementStyle(input: UpdateElementStyleInput, expected?: CanvasAuthoringExpected): CanvasGraphResult {
		return this.updateElementStyles([input], expected);
	}

	/** Apply one toolbar action to every selected element as one undoable transaction. */
	public updateElementStyles(inputs: readonly UpdateElementStyleInput[], expected?: CanvasAuthoringExpected): CanvasGraphResult {
		const diagnostics: CanvasAuthoringDiagnostic[] = [];
		const reject = (): CanvasGraphResult => ({ ok: false, status: "rejected", diagnostics: [...this.diagnosticList, ...diagnostics] });
		if (this.disposed || this.host === undefined) return reject();
		if (!Array.isArray(inputs) || inputs.length === 0) {
			addDiagnostic(diagnostics, "element-style-invalid", "error", "At least one style target is required.");
			return reject();
		}
		const before = readSnapshotFromHost(this.host, diagnostics);
		if (before === undefined) return reject();
		if (expected !== undefined) {
			const snapshot = makeSnapshot(extractExpectedDocument(expected), diagnostics);
			if (snapshot === undefined || !structurallyEqual(snapshot.document, before.document)) {
				addDiagnostic(diagnostics, "stale-document", "warning", "The Canvas document changed since the supplied expected snapshot.");
				return reject();
			}
		}
		let document: UnknownRecord;
		try {
			document = cloneRecord(before.document);
		} catch {
			addDiagnostic(diagnostics, "element-style-invalid", "error", "The Canvas document could not be copied for the style transaction.");
			return reject();
		}
		try {
			const metadata = readMetadataForUpdate(document, diagnostics);
			if (metadata === undefined) return reject();
			const overrides = metadata.localOverrides ?? {};
			if (!isPlainObject(overrides)) throw new SnapshotError("invalid overrides");
			const scene = buildSourceScene(before.document);
			let changed = false;
			for (const input of inputs) {
				const action = copyStyleData(input) as UnknownRecord;
				if (!isPlainObject(action) || Object.keys(action).some((key) => !["id", "shape", "colors", "typography", "borderStyle", "borderWidth", "connector"].includes(key))) throw new SnapshotError("invalid action");
				const id = readGraphActionId(action, diagnostics, "element-style");
				if (id === undefined) return reject();
				const node = before.nodes.find((item) => item.id === id);
				const edge = before.edges.find((item) => item.id === id);
				const sourceKind = node === undefined ? undefined : scene.items.get(id)?.kind;
				if (edge === undefined && (node === undefined || (sourceKind !== undefined ? sourceKind !== "shape" : node.type !== "text"))) {
					addDiagnostic(diagnostics, "element-style-target-invalid", "error", "The target must be an existing Canvas shape, text node, or connector.");
					return reject();
				}
				if (!policyAllowsGraphEdit(before.document, "edit", id, "element-style", diagnostics)) return reject();
				const patch = readStylePatch(action, diagnostics, edge !== undefined);
				if (patch === undefined) return reject();
				if (hasOwn(action, "shape")) {
					if (edge !== undefined || typeof action.shape !== "string" || !(CANVAS_SHAPE_KINDS as readonly string[]).includes(action.shape)) {
						addDiagnostic(diagnostics, "shape-kind-invalid", "error", "A supported shape kind can only be applied to a shape node.");
						return reject();
					}
					patch.shape = { kind: action.shape, fallback: "text" };
				}
				if (edge !== undefined && (hasOwn(patch, "borderStyle") || hasOwn(patch, "borderWidth"))) {
					addDiagnostic(diagnostics, "element-style-invalid", "error", "Use connector settings for an edge stroke.");
					return reject();
				}
				const previous = hasOwn(overrides, id) ? overrides[id] : {};
				if (!isPlainObject(previous)) throw new SnapshotError("invalid target override");
				const merged = mergeStylePatch(previous as UnknownRecord, patch);
				if (!structurallyEqual(previous, merged)) {
					setOwn(overrides as UnknownRecord, id, merged);
					changed = true;
				}
			}
			if (!changed) document = before.document;
			else {
				setOwn(metadata, "localOverrides", overrides);
				if (!validateMiroCanvasMetadata(metadata).valid) throw new SnapshotError("invalid merged metadata");
				setOwn(document, "miroCanvas", metadata);
			}
		} catch {
			addDiagnostic(diagnostics, "element-style-invalid", "error", "The existing metadata cannot be safely merged with these settings.");
			return reject();
		}
		const live = readSnapshotFromHost(this.host, diagnostics);
		if (live === undefined || !structurallyEqual(live.document, before.document)) {
			addDiagnostic(diagnostics, "stale-document", "warning", "The Canvas document changed before the style transaction began.");
			return reject();
		}
		if (structurallyEqual(document, before.document)) {
			if (!runtimeAllowsMutation(this.host, diagnostics)) return reject();
			return { ok: true, status: "applied", document: before.document, diagnostics: [...this.diagnosticList, ...diagnostics] };
		}
		const verified = this.commitDocument(before, document, diagnostics);
		return verified === undefined ? reject() : { ok: true, status: "applied", document: verified.document, diagnostics: [...this.diagnosticList, ...diagnostics] };
	}

	/** Apply a local rotation override through the guarded whole-document transaction. */
	public updateRotation(input: UpdateRotationInput, expected?: CanvasAuthoringExpected): CanvasGraphResult {
		if (this.disposed || this.host === undefined) {
			return { ok: false, status: "rejected", diagnostics: this.diagnostics };
		}
		const diagnostics: CanvasAuthoringDiagnostic[] = [];
		const before = readSnapshotFromHost(this.host, diagnostics);
		if (before === undefined) {
			return { ok: false, status: "rejected", diagnostics: [...this.diagnosticList, ...diagnostics] };
		}
		if (expected !== undefined) {
			const expectedDiagnostics: CanvasAuthoringDiagnostic[] = [];
			const expectedSnapshot = makeSnapshot(extractExpectedDocument(expected), expectedDiagnostics);
			if (expectedSnapshot === undefined || !structurallyEqual(expectedSnapshot.document, before.document)) {
				addDiagnostic(diagnostics, "stale-document", "warning", "The Canvas document changed since the supplied expected snapshot; no import was attempted.");
				return { ok: false, status: "rejected", diagnostics: [...this.diagnosticList, ...diagnostics, ...expectedDiagnostics] };
			}
		}
		const liveDiagnostics: CanvasAuthoringDiagnostic[] = [];
		const live = readSnapshotFromHost(this.host, liveDiagnostics);
		if (live === undefined || !structurallyEqual(live.document, before.document)) {
			addDiagnostic(liveDiagnostics, "stale-document", "warning", "The Canvas document changed before the transaction began; no import was attempted.");
			return { ok: false, status: "rejected", diagnostics: [...this.diagnosticList, ...diagnostics, ...liveDiagnostics] };
		}
		diagnostics.push(...liveDiagnostics);
		const id = readGraphActionId(input, diagnostics, "rotation");
		const rotationValue = actionProperty(input, "rotation");
		if (id === undefined || !rotationValue.ok || !isFiniteNumber(rotationValue.value)) {
			if (id !== undefined) {
				addDiagnostic(diagnostics, "rotation-value-invalid", "error", "Rotation must be a finite number.");
			}
			return { ok: false, status: "rejected", diagnostics: [...this.diagnosticList, ...diagnostics] };
		}
		if (!hasGraphElement(before, id)) {
			addDiagnostic(diagnostics, "rotation-id-missing", "error", "The target Canvas graph ID does not exist.");
			return { ok: false, status: "rejected", diagnostics: [...this.diagnosticList, ...diagnostics] };
		}
		if (!policyAllowsGraphEdit(before.document, "rotate", id, "rotation", diagnostics)) {
			return { ok: false, status: "rejected", diagnostics: [...this.diagnosticList, ...diagnostics] };
		}
		const document = buildRotationDocument(before, id, normalizeRotation(rotationValue.value), diagnostics);
		if (document === undefined) {
			return { ok: false, status: "rejected", diagnostics: [...this.diagnosticList, ...diagnostics] };
		}
		if (structurallyEqual(document, before.document)) {
			if (!runtimeAllowsMutation(this.host, diagnostics)) {
				return { ok: false, status: "rejected", diagnostics: [...this.diagnosticList, ...diagnostics] };
			}
			addDiagnostic(diagnostics, "rotation-noop", "info", "The normalized rotation already matches the local override; no graph history entry was created.");
			return { ok: true, status: "applied", document: before.document, diagnostics: [...this.diagnosticList, ...diagnostics] };
		}
		const verified = this.commitDocument(before, document, diagnostics);
		if (verified === undefined) {
			return { ok: false, status: "rejected", diagnostics: [...this.diagnosticList, ...diagnostics] };
		}
		return { ok: true, status: "applied", document: verified.document, diagnostics: [...this.diagnosticList, ...diagnostics] };
	}

	/** Move one graph element in the local back-to-front z-order. */
	public changeZOrder(input: ChangeZOrderInput, expected?: CanvasAuthoringExpected): CanvasGraphResult {
		if (this.disposed || this.host === undefined) {
			return { ok: false, status: "rejected", diagnostics: this.diagnostics };
		}
		const diagnostics: CanvasAuthoringDiagnostic[] = [];
		const before = readSnapshotFromHost(this.host, diagnostics);
		if (before === undefined) {
			return { ok: false, status: "rejected", diagnostics: [...this.diagnosticList, ...diagnostics] };
		}
		if (expected !== undefined) {
			const expectedDiagnostics: CanvasAuthoringDiagnostic[] = [];
			const expectedSnapshot = makeSnapshot(extractExpectedDocument(expected), expectedDiagnostics);
			if (expectedSnapshot === undefined || !structurallyEqual(expectedSnapshot.document, before.document)) {
				addDiagnostic(diagnostics, "stale-document", "warning", "The Canvas document changed since the supplied expected snapshot; no import was attempted.");
				return { ok: false, status: "rejected", diagnostics: [...this.diagnosticList, ...diagnostics, ...expectedDiagnostics] };
			}
		}
		const liveDiagnostics: CanvasAuthoringDiagnostic[] = [];
		const live = readSnapshotFromHost(this.host, liveDiagnostics);
		if (live === undefined || !structurallyEqual(live.document, before.document)) {
			addDiagnostic(liveDiagnostics, "stale-document", "warning", "The Canvas document changed before the transaction began; no import was attempted.");
			return { ok: false, status: "rejected", diagnostics: [...this.diagnosticList, ...diagnostics, ...liveDiagnostics] };
		}
		diagnostics.push(...liveDiagnostics);
		const id = readGraphActionId(input, diagnostics, "z-order");
		const directionValue = actionProperty(input, "direction");
		const direction = directionValue.ok && typeof directionValue.value === "string"
			&& ["front", "back", "forward", "backward"].includes(directionValue.value)
			? directionValue.value as ZOrderDirection
			: undefined;
		if (id === undefined || direction === undefined) {
			if (id !== undefined) {
				addDiagnostic(diagnostics, "z-order-direction-invalid", "error", "Z-order direction must be front, back, forward, or backward.");
			}
			return { ok: false, status: "rejected", diagnostics: [...this.diagnosticList, ...diagnostics] };
		}
		if (!hasGraphElement(before, id)) {
			addDiagnostic(diagnostics, "z-order-id-missing", "error", "The target Canvas graph ID does not exist.");
			return { ok: false, status: "rejected", diagnostics: [...this.diagnosticList, ...diagnostics] };
		}
		if (!policyAllowsGraphEdit(before.document, "edit", id, "z-order", diagnostics)) {
			return { ok: false, status: "rejected", diagnostics: [...this.diagnosticList, ...diagnostics] };
		}
		const update = buildZOrderDocument(before, id, direction, diagnostics);
		if (update === undefined) {
			return { ok: false, status: "rejected", diagnostics: [...this.diagnosticList, ...diagnostics] };
		}
		if (!update.changed) {
			if (!runtimeAllowsMutation(this.host, diagnostics)) {
				return { ok: false, status: "rejected", diagnostics: [...this.diagnosticList, ...diagnostics] };
			}
			addDiagnostic(diagnostics, "z-order-noop", "info", "The graph element is already at the requested z-order bound; no graph history entry was created.");
			return { ok: true, status: "applied", document: before.document, diagnostics: [...this.diagnosticList, ...diagnostics] };
		}
		const verified = this.commitDocument(before, update.document, diagnostics);
		if (verified === undefined) {
			return { ok: false, status: "rejected", diagnostics: [...this.diagnosticList, ...diagnostics] };
		}
		return { ok: true, status: "applied", document: verified.document, diagnostics: [...this.diagnosticList, ...diagnostics] };
	}

	private commitDocument(
		before: InternalSnapshot,
		document: UnknownRecord,
		diagnostics: CanvasAuthoringDiagnostic[],
	): InternalSnapshot | undefined {
		if (this.host === undefined) return undefined;
		const beforeSource = optionalValue(before.document, "miroSource");
		const afterSource = optionalValue(document, "miroSource");
		if (beforeSource.present !== afterSource.present || !structurallyEqual(beforeSource.value, afterSource.value)) {
			addDiagnostic(diagnostics, "miro-source-modified", "error", "Graph transactions must preserve miroSource exactly.");
			return undefined;
		}
		if (!runtimeAllowsMutation(this.host, diagnostics)) {
			return undefined;
		}
		if (!invokeMutation(this.host, document, diagnostics, "import")) {
			restoreGraph(this.host, before, diagnostics);
			return undefined;
		}
		const imported = readSnapshotFromHost(this.host, diagnostics);
		if (imported === undefined || !structurallyEqual(imported.document, document)) {
			addDiagnostic(diagnostics, "native-import-verification-failed", "error", "The imported Canvas graph did not match the requested document; history was not requested.");
			restoreGraph(this.host, before, diagnostics);
			return undefined;
		}
		if (this.host.mode === "importData" && !invokeMutation(this.host, document, diagnostics, "history")) {
			restoreGraph(this.host, before, diagnostics);
			return undefined;
		}
		const verified = readSnapshotFromHost(this.host, diagnostics);
		if (verified === undefined || !structurallyEqual(verified.document, document)) {
			addDiagnostic(diagnostics, "native-history-verification-failed", "error", "The native history/save boundary did not preserve the requested Canvas graph.");
			restoreGraph(this.host, before, diagnostics);
			return undefined;
		}
		return verified;
	}

	public dispose(): void {
		this.disposed = true;
	}
}

export function createCanvasAuthoring(view: unknown, options: CanvasAuthoringOptions = {}): CanvasAuthoring {
	return new CanvasAuthoring(view, options);
}

export function probeCanvasAuthoring(view: unknown): CanvasAuthoringProbe {
	const inspection = inspectHost(view);
	return {
		status: inspection.status,
		available: inspection.status === "ready",
		compatible: inspection.status !== "incompatible",
		capabilities: new Set(inspection.capabilities),
		diagnostics: [...inspection.diagnostics],
	};
}

/** Convenience wrapper for callers that do not need to retain an authoring object. */
export function createShape(view: unknown, action: unknown, options: CanvasAuthoringOptions = {}): CanvasShapeResult {
	const authoring = createCanvasAuthoring(view, options);
	try {
		return authoring.createShape(action);
	} finally {
		authoring.dispose();
	}
}

export const createCanvasShape = createShape;
