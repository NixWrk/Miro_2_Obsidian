/**
 * Pure attachment-title helpers for JSON Canvas file/document nodes.
 *
 * A label is presentation-only: this module never changes `node.file`, node
 * content, aliases, or metadata.  All input is treated as untrusted JSON and
 * malformed values resolve to a hidden/empty result instead of throwing.
 */

export const DEFAULT_SHOW_ATTACHMENT_NAMES = true as const;
export const MAX_ATTACHMENT_LABEL_LENGTH = 512 as const;

export type AttachmentNodeType = "file" | "document";
export type AttachmentLabelSource = "alias" | "basename" | "hidden" | "invalid";

export interface AttachmentLabelSettings {
	readonly showAttachmentNames?: boolean;
	readonly showAttachmentName?: boolean;
	readonly [key: string]: unknown;
}

export interface AttachmentLabelOverride {
	readonly showAttachmentName?: boolean;
	readonly showAttachmentNames?: boolean;
	readonly [key: string]: unknown;
}

export interface AttachmentLabelMetadata {
	readonly settings?: AttachmentLabelSettings;
	readonly localOverrides?: Readonly<Record<string, AttachmentLabelOverride>>;
	readonly [key: string]: unknown;
}

export interface AttachmentLabelOptions {
	readonly metadata?: unknown;
	readonly globalDefault?: unknown;
	readonly showAttachmentNames?: unknown;
	readonly showAttachmentName?: unknown;
	readonly alias?: unknown;
}

export interface AttachmentLabelDecision {
	readonly visible: boolean;
	readonly label?: string;
	readonly source: AttachmentLabelSource;
	readonly valid: boolean;
	readonly nodeType?: AttachmentNodeType;
}

type UnknownRecord = Record<string, unknown>;

const CONTROL_OR_FORMAT = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u200b\u200c\u200e\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/u;
const PATH_SEPARATOR = /[\\/]/u;

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
	if (!Number.isSafeInteger(length) || length < 0 || length > 512) {
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

function hasOwn(value: UnknownRecord, key: string): boolean {
	try {
		return Object.prototype.hasOwnProperty.call(value, key);
	} catch {
		return false;
	}
}

function isValidUnicode(value: string): boolean {
	for (let index = 0; index < value.length; index += 1) {
		const code = value.charCodeAt(index);
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

/**
 * Remove controls that can create line breaks, invisible labels, or bidi/path
 * spoofing.  Printable Unicode (including emoji and non-Latin scripts) is
 * retained and normalized to NFC.  A path separator is rejected here; callers
 * should use `resolveAttachmentBasename` when they intentionally supply a
 * path.
 */
export function sanitizeAttachmentLabel(value: unknown): string | undefined {
	if (typeof value !== "string" || !isValidUnicode(value)) {
		return undefined;
	}
	let normalized: string;
	try {
		normalized = value.normalize("NFC");
	} catch {
		return undefined;
	}
	if (normalized.length === 0 || normalized.length > MAX_ATTACHMENT_LABEL_LENGTH || PATH_SEPARATOR.test(normalized)) {
		return undefined;
	}
	if (CONTROL_OR_FORMAT.test(normalized)) {
		return undefined;
	}
	const trimmed = normalized.trim();
	if (trimmed.length === 0 || trimmed === "." || trimmed === "..") {
		return undefined;
	}
	// A colon at the beginning is a URI/scheme-like label and is not a safe
	// filename presentation.  Colons elsewhere remain valid for non-Windows
	// vaults and ordinary human-readable aliases.
	if (trimmed.startsWith(":") || trimmed.endsWith(":")) {
		return undefined;
	}
	return trimmed;
}

function segmentFromPath(path: string): string | undefined {
	if (path.length === 0 || CONTROL_OR_FORMAT.test(path) || !isValidUnicode(path)) {
		return undefined;
	}
	// Canvas paths may use either separator even on Windows.  Reject a trailing
	// separator: it identifies a directory, not an attachment.
	if (/[\\/]$/u.test(path)) {
		return undefined;
	}
	const segments = path.split(/[\\/]+/u);
	for (let index = segments.length - 1; index >= 0; index -= 1) {
		const segment = segments[index];
		if (segment === "" || segment === ".") {
			continue;
		}
		if (segment === "..") {
			// The label never exposes a parent-directory marker.  A preceding
			// segment is still a safe basename once path syntax is removed.
			continue;
		}
		return sanitizeAttachmentLabel(segment);
	}
	return undefined;
}

/** Resolve a safe display basename from POSIX, Windows, or vault-style paths. */
export function resolveAttachmentBasename(path: unknown): string | undefined {
	if (typeof path !== "string") {
		return undefined;
	}
	let raw = path;
	try {
		raw = raw.normalize("NFC");
	} catch {
		return undefined;
	}
	// A wikilink can carry a display alias.  The basename resolver deliberately
	// ignores that alias and resolves only its path target.
	if (raw.startsWith("[[") && raw.endsWith("]]")) {
		raw = raw.slice(2, -2).split("|")[0].split("#")[0];
	}
	return segmentFromPath(raw);
}

function resolveWikilinkAlias(value: string): string | undefined {
	if (!value.startsWith("[[") || !value.endsWith("]]")) {
		return undefined;
	}
	const inner = value.slice(2, -2);
	const separator = inner.indexOf("|");
	if (separator < 0 || separator === inner.length - 1) {
		return undefined;
	}
	return sanitizeAttachmentLabel(inner.slice(separator + 1));
}

function firstSafeAlias(value: unknown): { readonly present: boolean; readonly valid: boolean; readonly alias?: string } {
	if (value === undefined) {
		return { present: false, valid: true };
	}
	if (typeof value === "string") {
		if (value.startsWith("[[")) {
			const wikilinkAlias = resolveWikilinkAlias(value);
			if (wikilinkAlias === undefined) {
				return value.trim().length === 0 ? { present: true, valid: true } : { present: true, valid: false };
			}
			return { present: true, valid: true, alias: wikilinkAlias };
		}
		if (value.trim().length === 0) {
			return { present: true, valid: true };
		}
		const safe = sanitizeAttachmentLabel(value);
		return safe === undefined ? { present: true, valid: false } : { present: true, valid: true, alias: safe };
	}
	const items = readArrayItems(value);
	if (items === undefined) {
		return { present: true, valid: false };
	}
	for (const item of items) {
		if (typeof item !== "string") {
			return { present: true, valid: false };
		}
		if (item.trim().length === 0) {
			continue;
		}
		const safe = sanitizeAttachmentLabel(item);
		if (safe !== undefined) {
			return { present: true, valid: true, alias: safe };
		}
	}
	return { present: true, valid: true };
}

function nodeType(value: UnknownRecord): AttachmentNodeType | undefined {
	const type = readOwn(value, "type");
	if (!type.ok || !type.present || (type.value !== "file" && type.value !== "document")) {
		return undefined;
	}
	return type.value;
}

function nodeIdentifier(value: UnknownRecord): { readonly valid: boolean; readonly id?: string } {
	const id = readOwn(value, "id");
	if (!id.ok) {
		return { valid: false };
	}
	if (!id.present) {
		return { valid: true };
	}
	if (typeof id.value !== "string" || id.value.length === 0 || id.value.trim() !== id.value || id.value.length > 512 || !isValidUnicode(id.value)) {
		return { valid: false };
	}
	return { valid: true, id: id.value };
}

interface VisibilityResult {
	readonly visible: boolean;
	readonly valid: boolean;
}

function readBoolean(value: UnknownRecord, keys: readonly string[]): { readonly present: boolean; readonly valid: boolean; readonly value?: boolean } {
	for (const key of keys) {
		const property = readOwn(value, key);
		if (!property.ok) {
			return { present: true, valid: false };
		}
		if (property.present) {
			return typeof property.value === "boolean"
				? { present: true, valid: true, value: property.value }
				: { present: true, valid: false };
		}
	}
	return { present: false, valid: true };
}

function visibilityFromMetadata(metadataInput: unknown, nodeId: string | undefined, options: AttachmentLabelOptions | undefined): VisibilityResult {
	let global: boolean = DEFAULT_SHOW_ATTACHMENT_NAMES;
	if (options !== undefined) {
		if (!isPlainObject(options)) {
			return { visible: false, valid: false };
		}
		const optionGlobal = readBoolean(options, ["showAttachmentNames", "showAttachmentName", "globalDefault"]);
		if (!optionGlobal.valid) {
			return { visible: false, valid: false };
		}
		if (optionGlobal.present) {
			global = optionGlobal.value === true;
		}
	}
	if (metadataInput === undefined) {
		return { visible: global, valid: true };
	}
	if (!isPlainObject(metadataInput)) {
		return { visible: false, valid: false };
	}
	let metadata = metadataInput;
	const wrapper = readOwn(metadataInput, "miroCanvas");
	if (!wrapper.ok) {
		return { visible: false, valid: false };
	}
	if (wrapper.present) {
		if (!isPlainObject(wrapper.value)) {
			return { visible: false, valid: false };
		}
		metadata = wrapper.value;
	}
	const settings = readOwn(metadata, "settings");
	if (!settings.ok) {
		return { visible: false, valid: false };
	}
	if (settings.present) {
		if (!isPlainObject(settings.value)) {
			return { visible: false, valid: false };
		}
		const metadataGlobal = readBoolean(settings.value, ["showAttachmentNames", "showAttachmentName"]);
		if (!metadataGlobal.valid) {
			return { visible: false, valid: false };
		}
		if (metadataGlobal.present) {
			global = metadataGlobal.value === true;
		}
	}
	const overrides = readOwn(metadata, "localOverrides");
	if (!overrides.ok) {
		return { visible: false, valid: false };
	}
	if (!overrides.present || nodeId === undefined) {
		return { visible: global, valid: true };
	}
	if (!isPlainObject(overrides.value)) {
		return { visible: false, valid: false };
	}
	const override = readOwn(overrides.value, nodeId);
	if (!override.ok) {
		return { visible: false, valid: false };
	}
	if (!override.present) {
		return { visible: global, valid: true };
	}
	if (!isPlainObject(override.value)) {
		return { visible: false, valid: false };
	}
	const local = readBoolean(override.value, ["showAttachmentName", "showAttachmentNames"]);
	if (!local.valid) {
		return { visible: false, valid: false };
	}
	return { visible: local.present ? local.value === true : global, valid: true };
}

/** Resolve the effective global/per-node visibility without touching input. */
export function shouldShowAttachmentName(
	nodeInput: unknown,
	metadataInput?: unknown,
	options?: AttachmentLabelOptions,
): boolean {
	if (!isPlainObject(nodeInput) || nodeType(nodeInput) === undefined) {
		return false;
	}
	const identifier = nodeIdentifier(nodeInput);
	if (!identifier.valid) {
		return false;
	}
	return visibilityFromMetadata(metadataInput, identifier.id, options).visible;
}

export const shouldShowAttachmentNames = shouldShowAttachmentName;
export const isAttachmentNameVisible = shouldShowAttachmentName;

/** Return a basename or alias only when the effective visibility is enabled. */
export function resolveAttachmentLabel(
	nodeInput: unknown,
	metadataInput?: unknown,
	options?: AttachmentLabelOptions,
): string | undefined {
	const decision = decideAttachmentLabel(nodeInput, metadataInput, options);
	return decision.visible ? decision.label : undefined;
}

export const getAttachmentLabel = resolveAttachmentLabel;
export const resolveAttachmentName = resolveAttachmentLabel;

/** Detailed, deterministic result useful for UI diagnostics and tests. */
export function decideAttachmentLabel(
	nodeInput: unknown,
	metadataInput?: unknown,
	options?: AttachmentLabelOptions,
): AttachmentLabelDecision {
	if (!isPlainObject(nodeInput)) {
		return Object.freeze({ visible: false, source: "invalid" as const, valid: false });
	}
	const type = nodeType(nodeInput);
	if (type === undefined) {
		return Object.freeze({ visible: false, source: "invalid" as const, valid: false });
	}
	const identifier = nodeIdentifier(nodeInput);
	if (!identifier.valid) {
		return Object.freeze({ visible: false, source: "invalid" as const, valid: false, nodeType: type });
	}
	const visibility = visibilityFromMetadata(metadataInput, identifier.id, options);
	if (!visibility.valid) {
		return Object.freeze({ visible: false, source: "invalid" as const, valid: false, nodeType: type });
	}
	if (!visibility.visible) {
		return Object.freeze({ visible: false, source: "hidden" as const, valid: true, nodeType: type });
	}

	let optionAlias: { readonly present: boolean; readonly valid: boolean; readonly alias?: string } = { present: false, valid: true };
	if (options !== undefined) {
		if (!isPlainObject(options)) {
			return Object.freeze({ visible: false, source: "invalid" as const, valid: false, nodeType: type });
		}
		const rawOptionAlias = readOwn(options, "alias");
		if (!rawOptionAlias.ok) {
			return Object.freeze({ visible: false, source: "invalid" as const, valid: false, nodeType: type });
		}
		optionAlias = firstSafeAlias(rawOptionAlias.present ? rawOptionAlias.value : undefined);
	}
	if (!optionAlias.valid) {
		return Object.freeze({ visible: false, source: "invalid" as const, valid: false, nodeType: type });
	}
	let alias = optionAlias.alias;
	if (alias === undefined) {
		const nodeAlias = readOwn(nodeInput, "alias");
		if (!nodeAlias.ok) {
			return Object.freeze({ visible: false, source: "invalid" as const, valid: false, nodeType: type });
		}
		const parsed = firstSafeAlias(nodeAlias.present ? nodeAlias.value : undefined);
		if (!parsed.valid) {
			return Object.freeze({ visible: false, source: "invalid" as const, valid: false, nodeType: type });
		}
		alias = parsed.alias;
	}
	if (alias === undefined) {
		const aliases = readOwn(nodeInput, "aliases");
		if (!aliases.ok) {
			return Object.freeze({ visible: false, source: "invalid" as const, valid: false, nodeType: type });
		}
		const parsed = firstSafeAlias(aliases.present ? aliases.value : undefined);
		if (!parsed.valid) {
			return Object.freeze({ visible: false, source: "invalid" as const, valid: false, nodeType: type });
		}
		alias = parsed.alias;
	}
	if (alias !== undefined) {
		return Object.freeze({ visible: true, label: alias, source: "alias" as const, valid: true, nodeType: type });
	}

	const file = readOwn(nodeInput, "file");
	if (!file.ok) {
		return Object.freeze({ visible: false, source: "invalid" as const, valid: false, nodeType: type });
	}
	const path = file.present ? file.value : readOwn(nodeInput, "path").value;
	if (typeof path === "string" && path.startsWith("[[")) {
		const wikilinkAlias = resolveWikilinkAlias(path);
		if (wikilinkAlias !== undefined) {
			return Object.freeze({ visible: true, label: wikilinkAlias, source: "alias" as const, valid: true, nodeType: type });
		}
	}
	const basename = resolveAttachmentBasename(path);
	if (basename === undefined) {
		return Object.freeze({ visible: false, source: "invalid" as const, valid: false, nodeType: type });
	}
	return Object.freeze({ visible: true, label: basename, source: "basename" as const, valid: true, nodeType: type });
}

/** Naming alias for hosts that use “display” terminology. */
export const resolveAttachmentDisplayLabel = resolveAttachmentLabel;
