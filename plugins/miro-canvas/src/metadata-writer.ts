import {
	createDefaultMiroCanvasMetadata,
	parseMiroCanvasMetadata,
	validateMiroCanvasMetadata,
	type MiroCanvasMetadata,
	type MiroCanvasMetadataParseOptions,
} from "./metadata";

/**
 * The persistence boundary is deliberately injected instead of being
 * discovered from an Obsidian Canvas object.  A host implementation must
 * replace the complete document in one transaction, return `true` only after
 * verification, and must reject the write when its current document is not
 * structurally equal to `expectedDocument`.
 *
 * The writer never calls this boundary while inspecting a document.  It is
 * only called by an explicit `write`, `undo`, or `redo` operation.
 */
export interface MetadataDocumentStore {
	readDocument(): unknown;
	commitDocument(
		nextDocument: Readonly<Record<string, unknown>>,
		expectedDocument: Readonly<Record<string, unknown>>,
	): boolean;
}

/** Alias that makes the intended role clearer to host integrations. */
export type MetadataPersistenceBoundary = MetadataDocumentStore;

export type MetadataMutation = (
	draft: Record<string, unknown>,
) => Record<string, unknown> | void;

export type MetadataWriteStatus = "applied" | "noop" | "rejected";

export interface MetadataWriterDiagnostic {
	readonly code: string;
	readonly message: string;
	readonly phase: "read" | "validate" | "commit" | "rollback" | "history";
}

export interface MetadataWriteResult {
	readonly ok: boolean;
	readonly status: MetadataWriteStatus;
	readonly action: string;
	readonly diagnostics: readonly MetadataWriterDiagnostic[];
	readonly canUndo: boolean;
	readonly canRedo: boolean;
}

interface Snapshot {
	readonly document: Record<string, unknown>;
	readonly sourcePresent: boolean;
	readonly source: unknown;
}

interface HistoryEntry {
	readonly action: string;
	readonly before: Snapshot;
	readonly after: Snapshot;
}

interface InternalWriteResult {
	readonly ok: boolean;
	readonly status: MetadataWriteStatus;
	readonly diagnostics: readonly MetadataWriterDiagnostic[];
}

class SnapshotError extends Error {}

function describeError(error: unknown): string {
	if (error instanceof Error && error.message) {
		return error.message;
	}
	return "unknown error";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	if (value === null || typeof value !== "object") {
		return false;
	}
	try {
		return !Array.isArray(value);
	} catch {
		return false;
	}
}

function addDiagnostic(
	diagnostics: MetadataWriterDiagnostic[],
	phase: MetadataWriterDiagnostic["phase"],
	code: string,
	message: string,
): void {
	diagnostics.push({ code, message, phase });
}

function assertSerializablePrimitive(value: unknown): void {
	if (
		value === undefined ||
		typeof value === "function" ||
		typeof value === "symbol" ||
		typeof value === "bigint"
	) {
		throw new SnapshotError("The Canvas document contains a value that cannot be represented in JSON.");
	}
	if (typeof value === "number" && !Number.isFinite(value)) {
		throw new SnapshotError("The Canvas document contains a non-finite number.");
	}
}

function cloneSnapshotValue(
	value: unknown,
	seen = new Map<object, unknown>(),
	path = "document",
): unknown {
	if (value === null || typeof value !== "object") {
		assertSerializablePrimitive(value);
		return value;
	}

	const previous = seen.get(value);
	if (previous !== undefined) {
		throw new SnapshotError(`The Canvas document contains a cyclic value at ${path}.`);
	}

	let arrayValue = false;
	try {
		arrayValue = Array.isArray(value);
	} catch {
		throw new SnapshotError(`The Canvas document shape could not be inspected at ${path}.`);
	}

	if (arrayValue) {
		let length: number;
		try {
			length = (value as readonly unknown[]).length;
		} catch {
			throw new SnapshotError(`The Canvas array length could not be read at ${path}.`);
		}
		if (!Number.isSafeInteger(length) || length < 0) {
			throw new SnapshotError(`The Canvas array length is invalid at ${path}.`);
		}

		const result: unknown[] = [];
		seen.set(value, result);
		for (let index = 0; index < length; index += 1) {
			const key = String(index);
			let hasItem: boolean;
			try {
				hasItem = Object.prototype.hasOwnProperty.call(value, key);
			} catch {
				throw new SnapshotError(`The Canvas array could not be inspected at ${path}[${index}].`);
			}
			if (!hasItem) {
				throw new SnapshotError(`The Canvas array contains a sparse item at ${path}[${index}].`);
			}
			let item: unknown;
			try {
				item = (value as readonly unknown[])[index];
			} catch {
				throw new SnapshotError(`The Canvas array item could not be read at ${path}[${index}].`);
			}
			result.push(cloneSnapshotValue(item, seen, `${path}[${index}]`));
		}

		let keys: string[];
		try {
			keys = Object.keys(value);
		} catch {
			throw new SnapshotError(`The Canvas array fields could not be enumerated at ${path}.`);
		}
		for (const key of keys) {
			if (key === "length" || isArrayIndexKey(key, length)) {
				continue;
			}
			throw new SnapshotError(`The Canvas array contains a non-index field at ${path}.${key}.`);
		}
		assertNoEnumerableSymbols(value, path);
		return result;
	}

	let prototype: object | null;
	try {
		prototype = Object.getPrototypeOf(value);
	} catch {
		throw new SnapshotError(`The Canvas object prototype could not be read at ${path}.`);
	}
	if (prototype !== null && prototype !== Object.prototype) {
		throw new SnapshotError(`The Canvas document contains a non-plain object at ${path}.`);
	}

	const result: Record<string, unknown> = {};
	seen.set(value, result);
	assertNoEnumerableSymbols(value, path);
	let keys: string[];
	try {
		keys = Object.keys(value);
	} catch {
		throw new SnapshotError(`The Canvas object fields could not be enumerated at ${path}.`);
	}
	for (const key of keys) {
		let item: unknown;
		try {
			item = (value as Record<string, unknown>)[key];
		} catch {
			throw new SnapshotError(`The Canvas property could not be read at ${path}.${key}.`);
		}
		Object.defineProperty(result, key, {
			configurable: true,
			enumerable: true,
			value: cloneSnapshotValue(item, seen, `${path}.${key}`),
			writable: true,
		});
	}
	return result;
}

function assertNoEnumerableSymbols(value: object, path: string): void {
	let symbols: symbol[];
	try {
		symbols = Object.getOwnPropertySymbols(value);
	} catch {
		throw new SnapshotError(`The Canvas symbols could not be inspected at ${path}.`);
	}
	for (const symbol of symbols) {
		try {
			if (Object.prototype.propertyIsEnumerable.call(value, symbol)) {
				throw new SnapshotError(`The Canvas document contains an enumerable symbol at ${path}.`);
			}
		} catch (error) {
			if (error instanceof SnapshotError) {
				throw error;
			}
			throw new SnapshotError(`The Canvas symbol fields could not be inspected at ${path}.`);
		}
	}
}

function isArrayIndexKey(key: string, length: number): boolean {
	if (key.length === 0) {
		return false;
	}
	const index = Number(key);
	return Number.isSafeInteger(index) && index >= 0 && index < length && String(index) === key;
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
	try {
		return Object.prototype.hasOwnProperty.call(record, key);
	} catch {
		return false;
	}
}

function structurallyEqual(left: unknown, right: unknown): boolean {
	if (Object.is(left, right)) {
		return true;
	}
	if (typeof left !== typeof right || left === null || right === null) {
		return false;
	}
	if (typeof left !== "object") {
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
		const leftValues = left as readonly unknown[];
		const rightValues = right as readonly unknown[];
		if (leftValues.length !== rightValues.length) {
			return false;
		}
		for (let index = 0; index < leftValues.length; index += 1) {
			if (!structurallyEqual(leftValues[index], rightValues[index])) {
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
		if (!hasOwn(rightRecord, key)) {
			return false;
		}
		if (!structurallyEqual(leftRecord[key], rightRecord[key])) {
			return false;
		}
	}
	return true;
}

function snapshotDocument(value: unknown): Snapshot {
	let document: unknown;
	try {
		document = cloneSnapshotValue(value);
	} catch (error) {
		throw new SnapshotError(describeError(error));
	}
	if (!isRecord(document)) {
		throw new SnapshotError("The Canvas document root must be a plain object.");
	}
	const sourcePresent = hasOwn(document, "miroSource");
	return {
		document,
		sourcePresent,
		source: sourcePresent ? document.miroSource : undefined,
	};
}

function sourceIsUnchanged(before: Snapshot, after: Snapshot): boolean {
	if (before.sourcePresent !== after.sourcePresent) {
		return false;
	}
	if (!before.sourcePresent) {
		return true;
	}
	return structurallyEqual(before.source, after.source);
}

function cloneRecord(record: Record<string, unknown>): Record<string, unknown> {
	const cloned = cloneSnapshotValue(record);
	if (!isRecord(cloned)) {
		throw new SnapshotError("The Canvas document root must be a plain object.");
	}
	return cloned;
}

function result(
	action: string,
	status: MetadataWriteStatus,
	diagnostics: readonly MetadataWriterDiagnostic[],
	undoDepth: number,
	redoDepth: number,
): MetadataWriteResult {
	return {
		ok: status === "applied" || status === "noop",
		status,
		action,
		diagnostics: [...diagnostics],
		canUndo: undoDepth > 0,
		canRedo: redoDepth > 0,
	};
}

/**
 * Explicit, whole-document metadata transactions with local undo/redo.
 *
 * The writer owns detached snapshots and only exposes a mutable copy of the
 * metadata to the caller's explicit mutation callback.  `miroSource` is never
 * passed to that callback and is compared again before and after every host
 * commit.  A host that partially commits or reports an inconsistent document
 * is restored through the same compare-and-swap boundary when possible.
 */
export class MetadataWriter {
	private readonly store: MetadataDocumentStore;
	private readonly parseOptions: MiroCanvasMetadataParseOptions;
	private readonly undoStack: HistoryEntry[] = [];
	private readonly redoStack: HistoryEntry[] = [];
	private busy = false;

	public constructor(store: MetadataDocumentStore, parseOptions: MiroCanvasMetadataParseOptions = {}) {
		this.store = store;
		this.parseOptions = parseOptions;
	}

	public get canUndo(): boolean {
		return this.undoStack.length > 0;
	}

	public get canRedo(): boolean {
		return this.redoStack.length > 0;
	}

	public get undoDepth(): number {
		return this.undoStack.length;
	}

	public get redoDepth(): number {
		return this.redoStack.length;
	}

	/**
	 * Read and classify current metadata.  This method has no write side effect
	 * and can safely be used from a board-open/status path.
	 */
	public readMetadata(): ReturnType<typeof parseMiroCanvasMetadata> | undefined {
		try {
			return parseMiroCanvasMetadata(this.store.readDocument(), this.parseOptions);
		} catch {
			return undefined;
		}
	}

	/** Apply one explicit metadata action. */
	public write(action: string, mutate: MetadataMutation): MetadataWriteResult {
		return this.runExplicitAction(action, mutate);
	}

	/** Alias for callers that name mutations as commands. */
	public apply(action: string, mutate: MetadataMutation): MetadataWriteResult {
		return this.write(action, mutate);
	}

	public undo(): MetadataWriteResult {
		return this.runHistoryAction("undo", "undo");
	}

	public redo(): MetadataWriteResult {
		return this.runHistoryAction("redo", "redo");
	}

	private runExplicitAction(action: string, mutate: MetadataMutation): MetadataWriteResult {
		if (this.busy) {
			return result(action, "rejected", [
				{
					code: "writer-reentrant",
					message: "A metadata transaction is already in progress.",
					phase: "history",
				},
			], this.undoStack.length, this.redoStack.length);
		}
		if (typeof mutate !== "function") {
			return result(action, "rejected", [
				{
					code: "mutation-callback-invalid",
					message: "An explicit metadata mutation callback is required.",
					phase: "validate",
				},
			], this.undoStack.length, this.redoStack.length);
		}

		this.busy = true;
		try {
			const before = this.readSnapshot();
			if (before === undefined) {
				return result(action, "rejected", [
					{
						code: "document-read-failed",
						message: "The Canvas document could not be read safely.",
						phase: "read",
					},
				], this.undoStack.length, this.redoStack.length);
			}

			const currentMetadata = parseMiroCanvasMetadata(before.document, this.parseOptions);
			if (currentMetadata.status === "invalid" || currentMetadata.status === "unsupported") {
				return result(action, "rejected", [
					{
						code: "current-metadata-invalid",
						message: "The existing miroCanvas metadata is invalid or unsupported; the explicit write was refused.",
						phase: "validate",
					},
				], this.undoStack.length, this.redoStack.length);
			}

			const baseMetadata = currentMetadata.status === "valid" && currentMetadata.metadata !== undefined
				? cloneRecord(currentMetadata.metadata as Record<string, unknown>)
				: createDefaultMiroCanvasMetadata() as Record<string, unknown>;
			let candidate: unknown;
			try {
				const callbackResult = mutate(baseMetadata);
				candidate = callbackResult === undefined ? baseMetadata : callbackResult;
			} catch (error) {
				return result(action, "rejected", [
					{
						code: "mutation-failed",
						message: `The metadata mutation failed: ${describeError(error)}.`,
						phase: "validate",
					},
				], this.undoStack.length, this.redoStack.length);
			}

			const validation = validateMiroCanvasMetadata(candidate);
			if (!validation.valid || validation.metadata === undefined) {
				return result(action, "rejected", [
					{
						code: "metadata-validation-failed",
						message: "The proposed miroCanvas metadata failed validation; no write was attempted.",
						phase: "validate",
					},
				], this.undoStack.length, this.redoStack.length);
			}

			const afterDocument = cloneRecord(before.document);
			afterDocument.miroCanvas = validation.metadata;
			const after = this.snapshotOrReject(afterDocument, action);
			if (after === undefined) {
				return result(action, "rejected", [
					{
						code: "document-copy-failed",
						message: "The proposed Canvas document could not be copied safely.",
						phase: "validate",
					},
				], this.undoStack.length, this.redoStack.length);
			}
			if (!sourceIsUnchanged(before, after)) {
				return result(action, "rejected", [
					{
						code: "miro-source-modified",
						message: "Metadata actions must preserve miroSource exactly; no write was attempted.",
						phase: "validate",
					},
				], this.undoStack.length, this.redoStack.length);
			}

			if (structurallyEqual(before.document, after.document)) {
				return result(action, "noop", [], this.undoStack.length, this.redoStack.length);
			}

			const commit = this.commitSnapshot(before, after);
			if (!commit.ok) {
				return result(action, "rejected", commit.diagnostics, this.undoStack.length, this.redoStack.length);
			}

			this.undoStack.push({ action, before, after });
			// A divergent explicit edit starts a new branch and invalidates redo.
			this.redoStack.length = 0;
			return result(action, "applied", commit.diagnostics, this.undoStack.length, this.redoStack.length);
		} finally {
			this.busy = false;
		}
	}

	private runHistoryAction(action: "undo" | "redo", mode: "undo" | "redo"): MetadataWriteResult {
		if (this.busy) {
			return result(action, "rejected", [
				{
					code: "writer-reentrant",
					message: "A metadata transaction is already in progress.",
					phase: "history",
				},
			], this.undoStack.length, this.redoStack.length);
		}
		const stack = mode === "undo" ? this.undoStack : this.redoStack;
		const opposite = mode === "undo" ? this.redoStack : this.undoStack;
		const entry = stack[stack.length - 1];
		if (entry === undefined) {
			return result(action, "noop", [], this.undoStack.length, this.redoStack.length);
		}

		this.busy = true;
		try {
			const current = this.readSnapshot();
			const expected = mode === "undo" ? entry.after : entry.before;
			const target = mode === "undo" ? entry.before : entry.after;
			if (current === undefined) {
				return result(action, "rejected", [
					{
						code: "document-read-failed",
						message: "The Canvas document could not be read safely for history playback.",
						phase: "read",
					},
				], this.undoStack.length, this.redoStack.length);
			}
			if (!structurallyEqual(current.document, expected.document)) {
				// Never apply a stale snapshot over an edit made outside this writer.
				this.undoStack.length = 0;
				this.redoStack.length = 0;
				return result(action, "rejected", [
					{
						code: "history-conflict",
						message: "The Canvas document diverged from the history snapshot; stale undo/redo was refused.",
						phase: "history",
					},
				], this.undoStack.length, this.redoStack.length);
			}
			if (!sourceIsUnchanged(expected, target)) {
				this.undoStack.length = 0;
				this.redoStack.length = 0;
				return result(action, "rejected", [
					{
						code: "miro-source-modified",
						message: "History snapshots do not preserve miroSource exactly; playback was refused.",
						phase: "validate",
					},
				], this.undoStack.length, this.redoStack.length);
			}

			const commit = this.commitSnapshot(expected, target);
			if (!commit.ok) {
				return result(action, "rejected", commit.diagnostics, this.undoStack.length, this.redoStack.length);
			}
			stack.pop();
			opposite.push(entry);
			return result(action, "applied", commit.diagnostics, this.undoStack.length, this.redoStack.length);
		} finally {
			this.busy = false;
		}
	}

	private readSnapshot(): Snapshot | undefined {
		try {
			return snapshotDocument(this.store.readDocument());
		} catch {
			return undefined;
		}
	}

	private snapshotOrReject(document: Record<string, unknown>, _action: string): Snapshot | undefined {
		try {
			return snapshotDocument(document);
		} catch {
			return undefined;
		}
	}

	private commitSnapshot(before: Snapshot, after: Snapshot): InternalWriteResult {
		const diagnostics: MetadataWriterDiagnostic[] = [];
		let commitAccepted = false;
		try {
			const commitResult = this.store.commitDocument(
				cloneRecord(after.document),
				cloneRecord(before.document),
			);
			commitAccepted = commitResult === true;
		} catch (error) {
			addDiagnostic(
				diagnostics,
				"commit",
				"host-commit-failed",
				`The host rejected the Canvas transaction: ${describeError(error)}.`,
			);
		}

		if (!commitAccepted) {
			addDiagnostic(
				diagnostics,
				"commit",
				"host-commit-rejected",
				"The host did not accept the whole-document Canvas transaction.",
			);
			const observedAfterFailure = this.readSnapshot();
			if (observedAfterFailure === undefined) {
				addDiagnostic(
					diagnostics,
					"rollback",
					"recovery-state-unknown",
					"The document could not be re-read after the failed transaction; no guessed rollback was attempted.",
				);
			} else if (!structurallyEqual(observedAfterFailure.document, before.document)) {
				// Use the exact state observed after failure as the rollback CAS
				// token. Never guess that the requested `after` snapshot was left
				// behind by a partially failing host.
				this.tryRollback(before, observedAfterFailure, diagnostics);
			}
			return { ok: false, status: "rejected", diagnostics };
		}

		const observed = this.readSnapshot();
		if (observed !== undefined && structurallyEqual(observed.document, after.document) && sourceIsUnchanged(before, observed)) {
			return { ok: true, status: "applied", diagnostics };
		}

		addDiagnostic(
			diagnostics,
			"commit",
			"host-commit-verification-failed",
			"The host transaction could not be verified as the exact requested document; rollback was attempted.",
		);
		if (observed === undefined) {
			addDiagnostic(
				diagnostics,
				"rollback",
				"recovery-state-unknown",
				"The document could not be re-read after verification failed; no guessed rollback was attempted.",
			);
		} else if (!structurallyEqual(observed.document, before.document)) {
			this.tryRollback(before, observed, diagnostics);
		}
		return { ok: false, status: "rejected", diagnostics };
	}

	private tryRollback(
		before: Snapshot,
		expectedCurrent: Snapshot,
		diagnostics: MetadataWriterDiagnostic[],
	): void {
		try {
			const rollbackResult = this.store.commitDocument(
				cloneRecord(before.document),
				cloneRecord(expectedCurrent.document),
			);
			if (rollbackResult === false) {
				addDiagnostic(
					diagnostics,
					"rollback",
					"rollback-rejected",
					"The host rejected the rollback transaction; the document may require manual recovery.",
				);
				return;
			}
			const restored = this.readSnapshot();
			if (restored === undefined || !structurallyEqual(restored.document, before.document)) {
				addDiagnostic(
					diagnostics,
					"rollback",
					"rollback-verification-failed",
					"The rollback transaction could not be verified.",
				);
			}
		} catch (error) {
			addDiagnostic(
				diagnostics,
				"rollback",
				"rollback-failed",
				`The host rollback failed: ${describeError(error)}.`,
			);
		}
	}
}

export function createMetadataWriter(
	store: MetadataDocumentStore,
	parseOptions: MiroCanvasMetadataParseOptions = {},
): MetadataWriter {
	return new MetadataWriter(store, parseOptions);
}
