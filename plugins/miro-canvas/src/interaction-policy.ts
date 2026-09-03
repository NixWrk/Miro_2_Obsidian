/**
 * Framework-free policy and metadata helpers for the M1 safety features.
 *
 * This module deliberately does not know about Obsidian's Canvas classes.  It
 * reads the JSON-shaped `miroCanvas.settings` and `miroCanvas.localOverrides`
 * containers and returns detached values, so a host can decide whether to
 * consume the result before it crosses an adapter boundary.
 *
 * The imported `miroSource` is never read or written here.  Unknown metadata
 * fields are copied forward, while malformed input is rejected (rather than
 * guessed) and edit decisions fail closed.
 */

export const EDIT_OPERATIONS = [
	"edit",
	"create",
	"duplicate",
	"paste",
	"move",
	"resize",
	"rotate",
	"edit-text",
	"reconnect",
	"delete",
	"drag-drop",
	"restyle",
] as const;

export type EditOperation = (typeof EDIT_OPERATIONS)[number];

export const READ_OPERATIONS = [
	"pan",
	"zoom",
	"navigate",
	"select",
	"search",
	"open-link",
	"open-document",
	"view-document",
	"copy",
	"comment",
] as const;

export type ReadOperation = (typeof READ_OPERATIONS)[number];

export type InteractionOperation = EditOperation | ReadOperation;

export type InteractionDecisionReason =
	| "allowed"
	| "review-mode"
	| "element-locked"
	| "invalid-input";

export interface InteractionSettings {
	readonly reviewMode?: boolean;
	readonly showAttachmentNames?: boolean;
	readonly [key: string]: unknown;
}

export interface InteractionLocalOverride {
	readonly locked?: boolean;
	readonly showAttachmentName?: boolean;
	readonly [key: string]: unknown;
}

/**
 * A structural view of the part of `miroCanvas` used by this module.  The
 * index signature lets callers retain M0/M2 fields without a second metadata
 * model.
 */
export interface InteractionMetadata {
	readonly settings?: InteractionSettings;
	readonly localOverrides?: Readonly<Record<string, InteractionLocalOverride>>;
	readonly [key: string]: unknown;
}

export interface InteractionPolicy {
	readonly valid: boolean;
	readonly reviewMode: boolean;
	readonly lockedElementIds: readonly string[];
	readonly groupDescendants: Readonly<Record<string, readonly string[]>>;
	readonly diagnostics: readonly string[];
}

export interface EditRequest {
	readonly operation: unknown;
	readonly elementId?: unknown;
	readonly elementIds?: unknown;
	readonly targetId?: unknown;
	readonly targetIds?: unknown;
}

export interface InteractionDecision {
	readonly allowed: boolean;
	readonly blocked: boolean;
	readonly reason: InteractionDecisionReason;
	readonly operation?: InteractionOperation;
	readonly elementIds: readonly string[];
	readonly lockedElementIds: readonly string[];
	readonly reviewMode: boolean;
	readonly valid: boolean;
}

export type InteractionMetadataAction =
	| { readonly type: "set-review-mode"; readonly enabled: unknown }
	| { readonly type: "toggle-review-mode" }
	| { readonly type: "set-lock"; readonly elementId: unknown; readonly locked: unknown }
	| { readonly type: "lock"; readonly elementId: unknown }
	| { readonly type: "unlock"; readonly elementId: unknown }
	| {
			readonly type: "set-locks";
			readonly elementIds: unknown;
			readonly locked: unknown;
		};

export interface InteractionMetadataReduction {
	readonly ok: boolean;
	readonly changed: boolean;
	readonly metadata?: InteractionMetadata;
	readonly diagnostics: readonly string[];
}

type UnknownRecord = Record<string, unknown>;

const EDIT_OPERATION_ALIASES: Readonly<Record<string, EditOperation>> = Object.freeze({
	edit: "edit",
	create: "create",
	duplicate: "duplicate",
	paste: "paste",
	move: "move",
	resize: "resize",
	rotate: "rotate",
	"edit-text": "edit-text",
	"text-edit": "edit-text",
	editText: "edit-text",
	text: "edit-text",
	reconnect: "reconnect",
	delete: "delete",
	"drag-drop": "drag-drop",
	dragDrop: "drag-drop",
	drag: "drag-drop",
	drop: "drag-drop",
	restyle: "restyle",
	style: "restyle",
});

const READ_OPERATION_ALIASES: Readonly<Record<string, ReadOperation>> = Object.freeze({
	pan: "pan",
	zoom: "zoom",
	navigate: "navigate",
	select: "select",
	search: "search",
	"open-link": "open-link",
	openLink: "open-link",
	"open-document": "open-document",
	openDocument: "open-document",
	"view-document": "view-document",
	viewDocument: "view-document",
	copy: "copy",
	comment: "comment",
});

const EMPTY_POLICY: InteractionPolicy = Object.freeze({
	valid: false,
	reviewMode: true,
	lockedElementIds: Object.freeze([]),
	groupDescendants: Object.freeze(Object.create(null) as Record<string, readonly string[]>),
	diagnostics: Object.freeze(["invalid-policy"]),
});

function isArray(value: unknown): value is readonly unknown[] {
	try {
		return Array.isArray(value);
	} catch {
		return false;
	}
}

function isPlainObject(value: unknown): value is UnknownRecord {
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

function hasOwn(value: UnknownRecord, key: string): boolean {
	try {
		return Object.prototype.hasOwnProperty.call(value, key);
	} catch {
		return false;
	}
}

function readOwn(value: UnknownRecord, key: string): { readonly ok: boolean; readonly present: boolean; readonly value?: unknown } {
	try {
		if (!Object.prototype.hasOwnProperty.call(value, key)) {
			return { ok: true, present: false };
		}
		return { ok: true, present: true, value: value[key] };
	} catch {
		return { ok: false, present: false };
	}
}

function ownKeys(value: UnknownRecord): readonly string[] | undefined {
	try {
		const symbols = Object.getOwnPropertySymbols(value);
		for (const symbol of symbols) {
			if (Object.prototype.propertyIsEnumerable.call(value, symbol)) {
				return undefined;
			}
		}
		return Object.keys(value);
	} catch {
		return undefined;
	}
}

function readArrayItems(value: unknown): readonly unknown[] | undefined {
	if (!isArray(value)) {
		return undefined;
	}
	let length: number;
	try {
		length = value.length;
	} catch {
		return undefined;
	}
	if (!Number.isSafeInteger(length) || length < 0 || length > 100_000) {
		return undefined;
	}
	const result: unknown[] = [];
	for (let index = 0; index < length; index += 1) {
		try {
			if (!Object.prototype.hasOwnProperty.call(value, String(index))) {
				return undefined;
			}
			result.push(value[index]);
		} catch {
			return undefined;
		}
	}
	return result;
}

function isSafeIdentifier(value: unknown): value is string {
	if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
		return false;
	}
	if (value.length > 512) {
		return false;
	}
	for (let index = 0; index < value.length; index += 1) {
		const code = value.charCodeAt(index);
		if (
			(code >= 0 && code <= 0x1f)
			|| (code >= 0x7f && code <= 0x9f)
			|| code === 0x2028
			|| code === 0x2029
		) {
			return false;
		}
		if (code >= 0xd800 && code <= 0xdbff) {
			const next = value.charCodeAt(index + 1);
			if (next < 0xdc00 || next > 0xdfff || Number.isNaN(next)) {
				return false;
			}
			index += 1;
		} else if (code >= 0xdc00 && code <= 0xdfff) {
			return false;
		}
	}
	return true;
}

function freezeDeep<T>(value: T, seen = new Set<object>()): T {
	if (value === null || typeof value !== "object") {
		return value;
	}
	if (seen.has(value)) {
		return value;
	}
	seen.add(value);
	if (isArray(value)) {
		for (const item of value) {
			freezeDeep(item, seen);
		}
	} else {
		for (const key of Object.keys(value as UnknownRecord)) {
			freezeDeep((value as UnknownRecord)[key], seen);
		}
	}
	try {
		Object.freeze(value);
	} catch {
		// Values produced by this module are ordinary objects.  This catch keeps
		// the helper non-throwing if a future caller supplies a host object.
	}
	return value;
}

/** Clone JSON-shaped input without invoking inherited fields or accepting cycles. */
function cloneJson(value: unknown, seen = new Set<object>()): unknown {
	if (value === null || typeof value !== "object") {
		if (typeof value === "number" && !Number.isFinite(value)) {
			throw new Error("non-finite-number");
		}
		if (value === undefined || typeof value === "function" || typeof value === "symbol" || typeof value === "bigint") {
			throw new Error("non-json-value");
		}
		return value;
	}
	if (seen.has(value)) {
		throw new Error("cyclic-value");
	}
	seen.add(value);
	if (isArray(value)) {
		let length: number;
		try {
			length = value.length;
		} catch {
			throw new Error("array-read-failed");
		}
		if (!Number.isSafeInteger(length) || length < 0 || length > 100_000) {
			throw new Error("array-length-invalid");
		}
		const result: unknown[] = [];
		for (let index = 0; index < length; index += 1) {
			let present = false;
			try {
				present = Object.prototype.hasOwnProperty.call(value, String(index));
			} catch {
				throw new Error("array-read-failed");
			}
			if (!present) {
				throw new Error("sparse-array");
			}
			try {
				result.push(cloneJson(value[index], seen));
			} catch (error) {
				throw error;
			}
		}
		const keys = ownKeys(value as unknown as UnknownRecord);
		if (keys === undefined) {
			throw new Error("array-enumeration-failed");
		}
		for (const key of keys) {
			if (!/^\d+$/.test(key) || Number(key) >= length || String(Number(key)) !== key) {
				throw new Error("array-extra-field");
			}
		}
		seen.delete(value);
		return result;
	}
	if (!isPlainObject(value)) {
		throw new Error("non-plain-object");
	}
	const result = Object.create(null) as UnknownRecord;
	const keys = ownKeys(value);
	if (keys === undefined) {
		throw new Error("object-enumeration-failed");
	}
	for (const key of keys) {
		let item: unknown;
		try {
			item = value[key];
		} catch {
			throw new Error("property-read-failed");
		}
		Object.defineProperty(result, key, {
			configurable: true,
			enumerable: true,
			value: cloneJson(item, seen),
			writable: true,
		});
	}
	seen.delete(value);
	return result;
}

function ownPropertyValue(value: UnknownRecord, key: string): { readonly present: boolean; readonly value?: unknown; readonly error: boolean } {
	const result = readOwn(value, key);
	return { present: result.present, value: result.value, error: !result.ok };
}

function readBoolean(value: UnknownRecord, key: string): { readonly valid: boolean; readonly present: boolean; readonly value?: boolean } {
	const property = ownPropertyValue(value, key);
	if (property.error) {
		return { valid: false, present: true };
	}
	if (!property.present) {
		return { valid: true, present: false };
	}
	return typeof property.value === "boolean"
		? { valid: true, present: true, value: property.value }
		: { valid: false, present: true };
}

function getPolicyContainer(input: unknown): { readonly valid: boolean; readonly container?: UnknownRecord } {
	if (!isPlainObject(input)) {
		return { valid: false };
	}
	const wrapper = ownPropertyValue(input, "miroCanvas");
	if (wrapper.error) {
		return { valid: false };
	}
	if (wrapper.present) {
		return isPlainObject(wrapper.value) ? { valid: true, container: wrapper.value } : { valid: false };
	}
	return { valid: true, container: input };
}

interface ParsedPolicyFields {
	readonly reviewMode: boolean;
	readonly lockedIds: readonly string[];
	readonly groupDescendants: Readonly<Record<string, readonly string[]>>;
	readonly diagnostics: readonly string[];
}

function readIdList(value: unknown): readonly string[] | undefined {
	const items = readArrayItems(value);
	if (items === undefined) {
		return undefined;
	}
	const result: string[] = [];
	const seen = new Set<string>();
	for (const item of items) {
		if (!isSafeIdentifier(item) || seen.has(item)) {
			return undefined;
		}
		seen.add(item);
		result.push(item);
	}
	return result;
}

function readGroupMap(value: unknown): Readonly<Record<string, readonly string[]>> | undefined {
	if (!isPlainObject(value)) {
		return undefined;
	}
	const result = Object.create(null) as Record<string, readonly string[]>;
	const keys = ownKeys(value);
	if (keys === undefined) {
		return undefined;
	}
	for (const key of keys) {
		if (!isSafeIdentifier(key)) {
			return undefined;
		}
		const property = ownPropertyValue(value, key);
		if (property.error) {
			return undefined;
		}
		const descendants = readIdList(property.value);
		if (descendants === undefined) {
			return undefined;
		}
		Object.defineProperty(result, key, {
			configurable: true,
			enumerable: true,
			value: Object.freeze([...descendants]),
			writable: false,
		});
	}
	return Object.freeze(result);
}

function readPolicyFields(container: UnknownRecord): ParsedPolicyFields | undefined {
	const diagnostics: string[] = [];
	let settings: UnknownRecord = container;
	const settingsProperty = ownPropertyValue(container, "settings");
	if (settingsProperty.error) {
		return undefined;
	}
	if (settingsProperty.present) {
		if (!isPlainObject(settingsProperty.value)) {
			return undefined;
		}
		settings = settingsProperty.value;
	}

	const review = readBoolean(settings, "reviewMode");
	if (!review.valid) {
		return undefined;
	}
	const rootReview = readBoolean(container, "reviewMode");
	if (!rootReview.valid) {
		return undefined;
	}
	const reviewMode = review.present ? review.value === true : rootReview.present ? rootReview.value === true : false;

	const lockedIds = new Set<string>();
	for (const field of ["lockedIds", "lockedElementIds"] as const) {
		const directLocked = ownPropertyValue(container, field);
		if (directLocked.error) {
			return undefined;
		}
		if (directLocked.present) {
			const ids = readIdList(directLocked.value);
			if (ids === undefined) {
				return undefined;
			}
			for (const id of ids) {
				lockedIds.add(id);
			}
		}
	}

	const overridesProperty = ownPropertyValue(container, "localOverrides");
	if (overridesProperty.error) {
		return undefined;
	}
	if (overridesProperty.present) {
		if (!isPlainObject(overridesProperty.value)) {
			return undefined;
		}
		const overrideIds = ownKeys(overridesProperty.value);
		if (overrideIds === undefined) {
			return undefined;
		}
		for (const id of overrideIds) {
			if (!isSafeIdentifier(id)) {
				return undefined;
			}
			const overrideProperty = ownPropertyValue(overridesProperty.value, id);
			if (overrideProperty.error || !isPlainObject(overrideProperty.value)) {
				return undefined;
			}
			const locked = readBoolean(overrideProperty.value, "locked");
			if (!locked.valid) {
				return undefined;
			}
			if (locked.present && locked.value === true) {
				lockedIds.add(id);
			}
		}
	}

	const directLocks = ownPropertyValue(container, "locks");
	if (directLocks.error) {
		return undefined;
	}
	if (directLocks.present) {
		if (!isPlainObject(directLocks.value)) {
			return undefined;
		}
		const lockIds = ownKeys(directLocks.value);
		if (lockIds === undefined) {
			return undefined;
		}
		for (const id of lockIds) {
			if (!isSafeIdentifier(id)) {
				return undefined;
			}
			const lock = readBoolean(directLocks.value, id);
			if (!lock.valid) {
				return undefined;
			}
			if (lock.value === true) {
				lockedIds.add(id);
			}
		}
	}

	let groupDescendants: Readonly<Record<string, readonly string[]>> = Object.freeze(Object.create(null) as Record<string, readonly string[]>);
	for (const field of ["groupDescendants", "groups", "groupMembers"] as const) {
		const groupProperty = ownPropertyValue(container, field);
		if (groupProperty.error) {
			return undefined;
		}
		if (groupProperty.present) {
			const parsed = readGroupMap(groupProperty.value);
			if (parsed === undefined) {
				return undefined;
			}
			groupDescendants = parsed;
			break;
		}
	}

	return {
		reviewMode,
		lockedIds: Object.freeze([...lockedIds].sort()),
		groupDescendants,
		diagnostics: Object.freeze(diagnostics),
	};
}

function parsePolicy(input: unknown): InteractionPolicy {
	const containerResult = getPolicyContainer(input);
	if (!containerResult.valid || containerResult.container === undefined) {
		return EMPTY_POLICY;
	}
	const fields = readPolicyFields(containerResult.container);
	if (fields === undefined) {
		return EMPTY_POLICY;
	}
	return Object.freeze({
		valid: true,
		reviewMode: fields.reviewMode,
		lockedElementIds: fields.lockedIds,
		groupDescendants: fields.groupDescendants,
		diagnostics: fields.diagnostics,
	});
}

/**
 * Normalize policy input into a detached, immutable snapshot.  Invalid input
 * yields a locked/review policy so callers that forget to check `valid` still
 * fail closed.
 */
export function createInteractionPolicy(input: unknown): InteractionPolicy {
	return parsePolicy(input);
}

export const normalizeInteractionPolicy = createInteractionPolicy;
export const parseInteractionPolicy = createInteractionPolicy;

function canonicalOperation(value: unknown): InteractionOperation | undefined {
	if (typeof value !== "string") {
		return undefined;
	}
	if (Object.prototype.hasOwnProperty.call(EDIT_OPERATION_ALIASES, value)) {
		return EDIT_OPERATION_ALIASES[value];
	}
	if (Object.prototype.hasOwnProperty.call(READ_OPERATION_ALIASES, value)) {
		return READ_OPERATION_ALIASES[value];
	}
	return undefined;
}

function isEditOperation(operation: InteractionOperation): operation is EditOperation {
	return Object.prototype.hasOwnProperty.call(EDIT_OPERATION_ALIASES, operation);
}

function requiresElement(operation: EditOperation): boolean {
	return operation !== "create" && operation !== "paste";
}

function extractElementIds(request: UnknownRecord): readonly string[] | undefined {
	const values: unknown[] = [];
	for (const key of ["elementIds", "targetIds", "ids"] as const) {
		const property = ownPropertyValue(request, key);
		if (property.error) {
			return undefined;
		}
		if (property.present) {
			const items = readArrayItems(property.value);
			if (items === undefined) {
				return undefined;
			}
			values.push(...items);
		}
	}
	for (const key of ["elementId", "targetId", "id"] as const) {
		const property = ownPropertyValue(request, key);
		if (property.error) {
			return undefined;
		}
		if (property.present) {
			values.push(property.value);
		}
	}
	const result: string[] = [];
	const seen = new Set<string>();
	for (const value of values) {
		if (!isSafeIdentifier(value)) {
			return undefined;
		}
		if (!seen.has(value)) {
			seen.add(value);
			result.push(value);
		}
	}
	return result;
}

function collectLockedTargets(policy: InteractionPolicy, elementIds: readonly string[]): readonly string[] {
	if (!policy.valid) {
		return Object.freeze(["*"]);
	}
	const locked = new Set(policy.lockedElementIds);
	const descendantsByGroup = policy.groupDescendants;
	const result = new Set<string>();
	const targets = new Set(elementIds);
	const lockedGroups = [...locked].filter((id) => descendantsByGroup[id] !== undefined);
	const visitGroup = (groupId: string, visited: Set<string>): void => {
		if (visited.has(groupId)) {
			return;
		}
		visited.add(groupId);
		const descendants = descendantsByGroup[groupId];
		if (descendants === undefined) {
			return;
		}
		for (const descendant of descendants) {
			if (targets.has(descendant)) {
				result.add(descendant);
			}
			visitGroup(descendant, visited);
		}
	};
	for (const id of elementIds) {
		if (locked.has(id)) {
			result.add(id);
		}
	}
	for (const groupId of lockedGroups) {
		visitGroup(groupId, new Set<string>());
	}
	return Object.freeze([...result].sort());
}

function invalidDecision(policy: InteractionPolicy, operation?: InteractionOperation): InteractionDecision {
	return Object.freeze({
		allowed: false,
		blocked: true,
		reason: "invalid-input" as const,
		operation,
		elementIds: Object.freeze([]),
		lockedElementIds: Object.freeze([]),
		reviewMode: policy.reviewMode,
		valid: false,
	});
}

/** Determine whether an interaction is safe under review mode and locks. */
export function decideInteraction(policyInput: unknown, requestInput: unknown): InteractionDecision {
	const policy = parsePolicy(policyInput);
	if (!policy.valid || !isPlainObject(requestInput)) {
		return invalidDecision(policy);
	}
	let operationProperty: { readonly error: boolean; readonly present: boolean; readonly value?: unknown } = {
		error: false,
		present: false,
	};
	for (const key of ["operation", "action", "kind", "edit"] as const) {
		const candidate = ownPropertyValue(requestInput, key);
		if (candidate.error) {
			return invalidDecision(policy);
		}
		if (candidate.present) {
			operationProperty = candidate;
			break;
		}
	}
	if (operationProperty.error || !operationProperty.present) {
		return invalidDecision(policy);
	}
	const operation = canonicalOperation(operationProperty.value);
	if (operation === undefined) {
		return invalidDecision(policy);
	}
	const elementIds = extractElementIds(requestInput);
	if (elementIds === undefined) {
		return invalidDecision(policy, operation);
	}
	if (isEditOperation(operation) && requiresElement(operation) && elementIds.length === 0) {
		return invalidDecision(policy, operation);
	}
	if (isEditOperation(operation) && policy.reviewMode) {
		return Object.freeze({
			allowed: false,
			blocked: true,
			reason: "review-mode" as const,
			operation,
			elementIds: Object.freeze([...elementIds]),
			lockedElementIds: Object.freeze([]),
			reviewMode: true,
			valid: true,
		});
	}
	const lockedElementIds = isEditOperation(operation) ? collectLockedTargets(policy, elementIds) : Object.freeze([]);
	if (lockedElementIds.length > 0) {
		return Object.freeze({
			allowed: false,
			blocked: true,
			reason: "element-locked" as const,
			operation,
			elementIds: Object.freeze([...elementIds]),
			lockedElementIds,
			reviewMode: policy.reviewMode,
			valid: true,
		});
	}
	return Object.freeze({
		allowed: true,
		blocked: false,
		reason: "allowed" as const,
		operation,
		elementIds: Object.freeze([...elementIds]),
		lockedElementIds,
		reviewMode: policy.reviewMode,
		valid: true,
	});
}

function makeRequest(operation: unknown, elementIds: unknown): UnknownRecord | undefined {
	if (!isSafeIdentifier(typeof operation === "string" ? operation : undefined)) {
		// The operation is validated separately; this branch only prevents a
		// surprising object shape from being constructed by this convenience API.
		if (typeof operation !== "string") {
			return undefined;
		}
	}
	const request = Object.create(null) as UnknownRecord;
	Object.defineProperty(request, "operation", { enumerable: true, value: operation, writable: false });
	if (isArray(elementIds)) {
		Object.defineProperty(request, "elementIds", { enumerable: true, value: elementIds, writable: false });
	} else if (elementIds !== undefined) {
		Object.defineProperty(request, "elementId", { enumerable: true, value: elementIds, writable: false });
	}
	return request;
}

/** Convenience decision with `(policy, operation, elementIds)` arguments. */
export function decideEditOperation(policyInput: unknown, operation: unknown, elementIds?: unknown): InteractionDecision {
	const request = makeRequest(operation, elementIds);
	return request === undefined ? invalidDecision(parsePolicy(policyInput)) : decideInteraction(policyInput, request);
}

/**
 * Edit-focused alias.  The object form is preferred, but the operation form
 * keeps the core convenient for adapters and supports both
 * `(policy, operation, ids)` and `(policy, id, operation)` call sites.
 */
export function decideEdit(policyInput: unknown, requestInput: unknown, elementIdsOrOperation?: unknown): InteractionDecision {
	if (isPlainObject(requestInput) && (hasOwn(requestInput, "operation") || hasOwn(requestInput, "action"))) {
		return decideInteraction(policyInput, requestInput);
	}
	if (canonicalOperation(requestInput) !== undefined) {
		return decideEditOperation(policyInput, requestInput, elementIdsOrOperation);
	}
	if (canonicalOperation(elementIdsOrOperation) !== undefined) {
		return decideEditOperation(policyInput, elementIdsOrOperation, requestInput);
	}
	return invalidDecision(parsePolicy(policyInput));
}

/** Boolean convenience wrapper for hosts that do not need diagnostics. */
export function isInteractionAllowed(
	policyInput: unknown,
	requestInput: unknown,
	elementIdsOrOperation?: unknown,
): boolean {
	return decideEdit(policyInput, requestInput, elementIdsOrOperation).allowed;
}

export const isEditAllowed = isInteractionAllowed;
export const canEdit = isInteractionAllowed;

function getActionType(action: UnknownRecord): string | undefined {
	const property = ownPropertyValue(action, "type");
	return property.error || !property.present || typeof property.value !== "string" ? undefined : property.value;
}

function readActionId(action: UnknownRecord): string | undefined {
	for (const key of ["elementId", "targetId", "id"] as const) {
		const property = ownPropertyValue(action, key);
		if (property.error) {
			return undefined;
		}
		if (property.present) {
			return isSafeIdentifier(property.value) ? property.value : undefined;
		}
	}
	return undefined;
}

function readActionIds(action: UnknownRecord): readonly string[] | undefined {
	for (const key of ["elementIds", "targetIds", "ids"] as const) {
		const property = ownPropertyValue(action, key);
		if (property.error) {
			return undefined;
		}
		if (property.present) {
			return readIdList(property.value);
		}
	}
	const id = readActionId(action);
	return id === undefined ? undefined : Object.freeze([id]);
}

function readActionBoolean(action: UnknownRecord, keys: readonly string[]): boolean | undefined {
	for (const key of keys) {
		const property = ownPropertyValue(action, key);
		if (property.error) {
			return undefined;
		}
		if (property.present) {
			return typeof property.value === "boolean" ? property.value : undefined;
		}
	}
	return undefined;
}

function defineMutable(record: UnknownRecord, key: string, value: unknown): void {
	Object.defineProperty(record, key, {
		configurable: true,
		enumerable: true,
		value,
		writable: true,
	});
}

function reduceMetadataInternal(metadataInput: unknown, actionInput: unknown): InteractionMetadataReduction {
	if (!isPlainObject(metadataInput) || !isPlainObject(actionInput)) {
		return { ok: false, changed: false, diagnostics: Object.freeze(["invalid-input"]) };
	}
	let metadata: UnknownRecord;
	try {
		metadata = cloneJson(metadataInput) as UnknownRecord;
	} catch (error) {
		const diagnostic = error instanceof Error && error.message ? error.message : "invalid-metadata";
		return { ok: false, changed: false, diagnostics: Object.freeze([diagnostic]) };
	}
	const type = getActionType(actionInput);
	if (type === undefined) {
		return { ok: false, changed: false, diagnostics: Object.freeze(["invalid-action"]) };
	}

	let settings: UnknownRecord;
	if (hasOwn(metadata, "settings")) {
		const value = metadata.settings;
		if (!isPlainObject(value)) {
			return { ok: false, changed: false, diagnostics: Object.freeze(["invalid-settings"]) };
		}
		settings = value;
	} else {
		settings = Object.create(null) as UnknownRecord;
		defineMutable(metadata, "settings", settings);
	}
	const currentReview = readBoolean(settings, "reviewMode");
	if (!currentReview.valid) {
		return { ok: false, changed: false, diagnostics: Object.freeze(["invalid-review-mode"]) };
	}
	const currentAttachmentNames = readBoolean(settings, "showAttachmentNames");
	if (!currentAttachmentNames.valid) {
		return { ok: false, changed: false, diagnostics: Object.freeze(["invalid-attachment-label-setting"]) };
	}

	let overrides: UnknownRecord;
	if (hasOwn(metadata, "localOverrides")) {
		const value = metadata.localOverrides;
		if (!isPlainObject(value)) {
			return { ok: false, changed: false, diagnostics: Object.freeze(["invalid-local-overrides"]) };
		}
		overrides = value;
	} else {
		overrides = Object.create(null) as UnknownRecord;
		defineMutable(metadata, "localOverrides", overrides);
	}
	const overrideIds = ownKeys(overrides);
	if (overrideIds === undefined) {
		return { ok: false, changed: false, diagnostics: Object.freeze(["invalid-local-overrides"]) };
	}
	for (const id of overrideIds) {
		if (!isSafeIdentifier(id) || !isPlainObject(overrides[id])) {
			return { ok: false, changed: false, diagnostics: Object.freeze(["invalid-local-override"]) };
		}
		const lock = readBoolean(overrides[id], "locked");
		if (!lock.valid) {
			return { ok: false, changed: false, diagnostics: Object.freeze(["invalid-lock-state"]) };
		}
		const attachmentName = readBoolean(overrides[id], "showAttachmentName");
		if (!attachmentName.valid) {
			return { ok: false, changed: false, diagnostics: Object.freeze(["invalid-attachment-label-override"]) };
		}
	}

	let changed = false;
	const typeLower = type.toLowerCase();
	if (typeLower === "set-review-mode" || typeLower === "setreviewmode" || typeLower === "review-mode") {
		const enabled = readActionBoolean(actionInput, ["enabled", "reviewMode", "value"]);
		if (enabled === undefined) {
			return { ok: false, changed: false, diagnostics: Object.freeze(["invalid-review-mode-action"]) };
		}
		if (!currentReview.present || currentReview.value !== enabled) {
			defineMutable(settings, "reviewMode", enabled);
			changed = true;
		}
	} else if (typeLower === "toggle-review-mode" || typeLower === "togglereviewmode") {
		defineMutable(settings, "reviewMode", !(currentReview.present && currentReview.value === true));
		changed = !currentReview.present || currentReview.value !== settings.reviewMode;
	} else if (
		typeLower === "set-lock"
		|| typeLower === "setlock"
		|| typeLower === "set-element-lock"
		|| typeLower === "setelementlock"
		|| typeLower === "lock"
		|| typeLower === "unlock"
		|| typeLower === "set-locks"
		|| typeLower === "setlocks"
	) {
		let ids: readonly string[] | undefined;
		if (typeLower === "set-locks" || typeLower === "setlocks") {
			ids = readActionIds(actionInput);
		} else {
			const id = readActionId(actionInput);
			ids = id === undefined ? undefined : Object.freeze([id]);
		}
		if (ids === undefined || ids.length === 0) {
			return { ok: false, changed: false, diagnostics: Object.freeze(["invalid-lock-action"]) };
		}
		let locked: boolean;
		if (typeLower === "lock") {
			locked = true;
		} else if (typeLower === "unlock") {
			locked = false;
		} else {
			const value = readActionBoolean(actionInput, ["locked", "value", "enabled"]);
			if (value === undefined) {
				return { ok: false, changed: false, diagnostics: Object.freeze(["invalid-lock-action"]) };
			}
			locked = value;
		}
		for (const id of ids) {
			let override: UnknownRecord;
			if (hasOwn(overrides, id)) {
				const existing = overrides[id];
				if (!isPlainObject(existing)) {
					return { ok: false, changed: false, diagnostics: Object.freeze(["invalid-local-override"]) };
				}
				override = existing;
			} else {
				override = Object.create(null) as UnknownRecord;
				defineMutable(overrides, id, override);
			}
		const existingLock = readBoolean(override, "locked");
			if (!existingLock.valid) {
				return { ok: false, changed: false, diagnostics: Object.freeze(["invalid-lock-state"]) };
			}
			const existingAttachmentName = readBoolean(override, "showAttachmentName");
			if (!existingAttachmentName.valid) {
				return { ok: false, changed: false, diagnostics: Object.freeze(["invalid-attachment-label-override"]) };
			}
			if (!existingLock.present || existingLock.value !== locked) {
				defineMutable(override, "locked", locked);
				changed = true;
			}
		}
	} else {
		return { ok: false, changed: false, diagnostics: Object.freeze(["unknown-action"]) };
	}

	return {
		ok: true,
		changed,
		metadata: freezeDeep(metadata) as InteractionMetadata,
		diagnostics: Object.freeze([]),
	};
}

/**
 * Pure metadata reducer.  It returns a detached frozen metadata object for a
 * valid action, and `undefined` for malformed input.  The source object is
 * never mutated.
 */
export function reduceInteractionMetadata(metadataInput: unknown, actionInput: unknown): InteractionMetadata | undefined {
	return reduceMetadataInternal(metadataInput, actionInput).metadata;
}

/** Result form for hosts that need a stable diagnostic instead of `undefined`. */
export function reduceInteractionMetadataResult(metadataInput: unknown, actionInput: unknown): InteractionMetadataReduction {
	return reduceMetadataInternal(metadataInput, actionInput);
}

export const reduceInteractionPolicy = reduceInteractionMetadata;
export const reduceMiroCanvasInteractionMetadata = reduceInteractionMetadata;
export const applyInteractionMetadata = reduceInteractionMetadata;
