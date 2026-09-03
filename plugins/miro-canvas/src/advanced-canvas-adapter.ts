/**
 * Optional integration boundary for Developer-Mike/obsidian-advanced-canvas.
 *
 * Advanced Canvas is deliberately discovered at runtime.  This module never
 * imports it and never assumes that its private objects exist.  An absent or
 * changed plugin produces a disabled adapter with diagnostics; it is not a
 * startup error for miro-canvas.
 */

import type {
	AdapterDiagnostic,
	DiagnosticLevel,
} from "./canvas-adapter";

export const ADVANCED_CANVAS_PLUGIN_ID = "advanced-canvas";

export const ADVANCED_CANVAS_CAPABILITIES = {
	metadata: "metadata",
	events: "events",
	controls: "controls",
} as const;

export type AdvancedCanvasCapability =
	(typeof ADVANCED_CANVAS_CAPABILITIES)[keyof typeof ADVANCED_CANVAS_CAPABILITIES];

export type AdvancedCanvasStatus = "ready" | "absent" | "incompatible";

export interface AdvancedCanvasAdapterOptions {
	/** The id can be overridden for a compatible fork or a local test double. */
	readonly pluginId?: string;
	/** Bypass app/plugin-registry discovery with an injected plugin mock. */
	readonly plugin?: unknown;
}

export interface AdvancedCanvasProbe {
	readonly status: AdvancedCanvasStatus;
	readonly present: boolean;
	readonly available: boolean;
	readonly compatible: boolean;
	readonly version?: string;
	readonly capabilities: ReadonlySet<AdvancedCanvasCapability>;
	readonly diagnostics: readonly AdapterDiagnostic[];
}

type UnknownRecord = Record<PropertyKey, unknown>;

interface MutableProbe {
	status: AdvancedCanvasStatus;
	readonly capabilities: Set<AdvancedCanvasCapability>;
	readonly diagnostics: AdapterDiagnostic[];
	readonly diagnosticKeys: Set<string>;
}

type SafeCallResult =
	| { readonly ok: true; readonly value: unknown }
	| { readonly ok: false };

interface LocatedPlugin {
	readonly plugin: unknown;
	readonly lookedUp: boolean;
	readonly lookupFailed: boolean;
}

const METADATA_METHODS = [
	"getMetadata",
	"getAdvancedCanvasMetadata",
	"getMiroCanvasMetadata",
	"readMetadata",
] as const;
const METADATA_PROPERTIES = [
	"metadata",
	"advancedCanvasMetadata",
	"miroCanvasMetadata",
	"jsonCanvasMetadata",
] as const;
const EVENT_ROOTS = ["events", "eventBus", "emitter", "api"] as const;
const EVENT_METHODS = ["on", "addEventListener", "registerEvent"] as const;
const EVENT_OFF_METHODS = ["off", "removeEventListener", "unregisterEvent"] as const;
const MAX_PLUGIN_COLLECTION_ITEMS = 10_000;

function isObject(value: unknown): value is UnknownRecord {
	return (typeof value === "object" && value !== null) || typeof value === "function";
}

function describeError(error: unknown): string {
	// Error values cross an optional-plugin boundary and may themselves be
	// revoked/hostile Proxies.  Avoid `instanceof` and guard message reads so a
	// diagnostic can never become a second exception.
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

function safeRead(
	target: unknown,
	key: PropertyKey,
	probe: MutableProbe,
	capability?: string,
): unknown {
	if (!isObject(target)) {
		return undefined;
	}
	try {
		return Reflect.get(target, key, target);
	} catch (error) {
		addDiagnostic(probe, {
			code: "advanced-probe-failed",
			level: "warning" as DiagnosticLevel,
			message: `Reading Advanced Canvas property "${describePropertyKey(key)}" failed: ${describeError(error)}.`,
			capability,
		});
		return undefined;
	}
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
			code: "advanced-operation-failed",
			level: "warning" as DiagnosticLevel,
			message: `Calling Advanced Canvas method "${describePropertyKey(method)}" failed: ${describeError(error)}.`,
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
			code: "advanced-probe-failed",
			level: "warning" as DiagnosticLevel,
			message: `Checking whether an Advanced Canvas value is an array failed: ${describeError(error)}.`,
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
			code: "advanced-probe-failed",
			level: "warning" as DiagnosticLevel,
			message: `Checking whether an Advanced Canvas value is a ${constructorName} failed: ${describeError(error)}.`,
			capability,
		});
		return { ok: false };
	}
}

function hasCollectionMember(
	target: unknown,
	key: PropertyKey,
	probe: MutableProbe,
): boolean {
	const value = safeRead(target, key, probe);
	if (value === undefined || value === null) {
		return false;
	}
	const arrayResult = safeIsArray(value, probe);
	if (!arrayResult.ok) {
		return false;
	}
	if (arrayResult.value) {
		return true;
	}
	const mapResult = safeInstanceOf(value, Map, "Map", probe);
	if (!mapResult.ok) {
		return false;
	}
	const setResult = safeInstanceOf(value, Set, "Set", probe);
	if (!setResult.ok) {
		return false;
	}
	if (mapResult.value || setResult.value) {
		return true;
	}
	if (isObject(value)) {
		try {
			return Reflect.ownKeys(value).length > 0;
		} catch (error) {
			addDiagnostic(probe, {
				code: "advanced-probe-failed",
				level: "warning" as DiagnosticLevel,
				message: `Inspecting Advanced Canvas collection "${String(key)}" failed: ${describeError(error)}.`,
			});
		}
	}
	return true;
}

function idFromPlugin(plugin: unknown, probe: MutableProbe): string | undefined {
	const direct = firstDefined(plugin, ["id", "pluginId"], probe);
	if (typeof direct?.value === "string") {
		return direct.value;
	}
	const manifest = safeRead(plugin, "manifest", probe);
	const manifestId = safeRead(manifest, "id", probe);
	return typeof manifestId === "string" ? manifestId : undefined;
}

function looksLikePlugin(value: unknown, pluginId: string, probe: MutableProbe): boolean {
	if (!isObject(value)) {
		return false;
	}
	const id = idFromPlugin(value, probe);
	if (id !== undefined) {
		return id === pluginId;
	}
	if (typeof safeRead(value, "manifest", probe) === "object") {
		// A manifest with an unreadable id is still a plugin-shaped object.  It is
		// safer to report incompatibility than silently claim the integration is
		// absent.
		return true;
	}
	return (
		methodExists(value, METADATA_METHODS, probe, ADVANCED_CANVAS_CAPABILITIES.metadata) ||
		firstDefined(value, METADATA_PROPERTIES, probe, ADVANCED_CANVAS_CAPABILITIES.metadata) !== undefined ||
		methodExists(value, EVENT_METHODS, probe, ADVANCED_CANVAS_CAPABILITIES.events) ||
		methodExists(value, ["registerControl", "hasControl"], probe, ADVANCED_CANVAS_CAPABILITIES.controls)
	);
}

function containsPluginId(value: unknown, pluginId: string, probe: MutableProbe): boolean {
	if (typeof value === "string") {
		return value === pluginId;
	}
	const arrayResult = safeIsArray(value, probe);
	if (!arrayResult.ok) {
		return false;
	}
	if (arrayResult.value) {
		const beforeLengthRead = probe.diagnostics.length;
		const length = safeRead(value as unknown as UnknownRecord, "length", probe);
		if (probe.diagnostics.length !== beforeLengthRead) {
			return false;
		}
		if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 0) {
			addDiagnostic(probe, {
				code: "advanced-plugin-collection-invalid",
				level: "warning" as DiagnosticLevel,
				message: "The enabled Advanced Canvas plugin collection has an invalid array length.",
			});
			return false;
		}
		if (length > MAX_PLUGIN_COLLECTION_ITEMS) {
			addDiagnostic(probe, {
				code: "advanced-plugin-collection-limit-reached",
				level: "warning" as DiagnosticLevel,
				message: `The enabled Advanced Canvas plugin collection exceeded the ${MAX_PLUGIN_COLLECTION_ITEMS}-item safety limit.`,
			});
			return false;
		}
		for (let index = 0; index < length; index += 1) {
			const beforeEntryRead = probe.diagnostics.length;
			const entry = safeRead(value as unknown as UnknownRecord, String(index), probe);
			if (probe.diagnostics.length !== beforeEntryRead) {
				return false;
			}
			if (entry === pluginId) {
				return true;
			}
		}
		return false;
	}
	const setResult = safeInstanceOf(value, Set, "Set", probe);
	if (!setResult.ok) {
		return false;
	}
	const mapResult = safeInstanceOf(value, Map, "Map", probe);
	if (!mapResult.ok) {
		return false;
	}
	if (setResult.value || mapResult.value) {
		const hasResult = safeCallResult(value, "has", [pluginId], probe);
		return hasResult.ok && hasResult.value === true;
	}
	if (isObject(value)) {
		return safeRead(value, pluginId, probe) !== undefined;
	}
	return false;
}

function locatePlugin(
	source: unknown,
	pluginId: string,
	options: AdvancedCanvasAdapterOptions,
	probe: MutableProbe,
): LocatedPlugin {
	const pluginOverride = safeRead(options, "plugin", probe);
	if (pluginOverride !== undefined) {
		return { plugin: pluginOverride, lookedUp: true, lookupFailed: false };
	}

	if (!isObject(source)) {
		return { plugin: undefined, lookedUp: false, lookupFailed: false };
	}

	// Explicit wrapper forms make testing and host integration straightforward.
	for (const key of ["advancedCanvas", "advancedCanvasPlugin", "plugin"] as const) {
		const candidate = safeRead(source, key, probe);
		if (candidate !== undefined && looksLikePlugin(candidate, pluginId, probe)) {
			return { plugin: candidate, lookedUp: true, lookupFailed: false };
		}
	}

	const registry = safeRead(source, "plugins", probe);
	if (isObject(registry)) {
		const getPlugin = safeRead(registry, "getPlugin", probe);
		if (typeof getPlugin === "function") {
			try {
				const candidate = Reflect.apply(getPlugin, registry, [pluginId]);
				if (candidate !== undefined && candidate !== null) {
					return { plugin: candidate, lookedUp: true, lookupFailed: false };
				}
			} catch (error) {
				addDiagnostic(probe, {
					code: "advanced-plugin-lookup-failed",
					level: "warning" as DiagnosticLevel,
					message: `Advanced Canvas plugin lookup failed: ${describeError(error)}.`,
				});
				return { plugin: undefined, lookedUp: true, lookupFailed: true };
			}
		}

		for (const key of ["plugins", "installedPlugins", "enabledPlugins"] as const) {
			const collection = safeRead(registry, key, probe);
			if (isObject(collection)) {
				const candidate = safeRead(collection, pluginId, probe);
				if (candidate !== undefined && looksLikePlugin(candidate, pluginId, probe)) {
					return { plugin: candidate, lookedUp: true, lookupFailed: false };
				}
			}
			if (containsPluginId(collection, pluginId, probe)) {
				return { plugin: undefined, lookedUp: true, lookupFailed: true };
			}
		}
	}

	if (looksLikePlugin(source, pluginId, probe)) {
		return { plugin: source, lookedUp: true, lookupFailed: false };
	}

	return { plugin: undefined, lookedUp: Boolean(registry), lookupFailed: false };
}

function detectCapabilities(plugin: unknown, probe: MutableProbe): void {
	if (!isObject(plugin)) {
		return;
	}

	if (
		methodExists(plugin, METADATA_METHODS, probe, ADVANCED_CANVAS_CAPABILITIES.metadata) ||
		firstDefined(plugin, METADATA_PROPERTIES, probe, ADVANCED_CANVAS_CAPABILITIES.metadata) !== undefined ||
		firstDefined(safeRead(plugin, "settings", probe), METADATA_PROPERTIES, probe, ADVANCED_CANVAS_CAPABILITIES.metadata) !== undefined ||
		firstDefined(safeRead(plugin, "api", probe), METADATA_PROPERTIES, probe, ADVANCED_CANVAS_CAPABILITIES.metadata) !== undefined
	) {
		probe.capabilities.add(ADVANCED_CANVAS_CAPABILITIES.metadata);
	}

	const eventRoots: unknown[] = [plugin];
	for (const rootKey of EVENT_ROOTS) {
		const root = safeRead(plugin, rootKey, probe, ADVANCED_CANVAS_CAPABILITIES.events);
		if (root !== undefined) {
			eventRoots.push(root);
		}
	}
	if (eventRoots.some((root) => methodExists(root, EVENT_METHODS, probe, ADVANCED_CANVAS_CAPABILITIES.events))) {
		probe.capabilities.add(ADVANCED_CANVAS_CAPABILITIES.events);
	}

	if (
		methodExists(plugin, ["registerControl", "unregisterControl", "hasControl"], probe, ADVANCED_CANVAS_CAPABILITIES.controls) ||
		hasCollectionMember(plugin, "controls", probe)
	) {
		probe.capabilities.add(ADVANCED_CANVAS_CAPABILITIES.controls);
	}
}

function versionFromPlugin(plugin: unknown, probe: MutableProbe): string | undefined {
	const direct = firstDefined(plugin, ["version", "pluginVersion"], probe);
	if (typeof direct?.value === "string") {
		return direct.value;
	}
	const manifest = safeRead(plugin, "manifest", probe);
	const version = safeRead(manifest, "version", probe);
	return typeof version === "string" ? version : undefined;
}

function createProbe(
	source: unknown,
	options: AdvancedCanvasAdapterOptions = {},
): AdvancedCanvasProbe & { readonly plugin: unknown; readonly pluginId: string } {
	const probe: MutableProbe = {
		status: "absent",
		capabilities: new Set<AdvancedCanvasCapability>(),
		diagnostics: [],
		diagnosticKeys: new Set<string>(),
	};
	const configuredPluginId = safeRead(options, "pluginId", probe);
	const pluginId = typeof configuredPluginId === "string" && configuredPluginId
		? configuredPluginId
		: ADVANCED_CANVAS_PLUGIN_ID;

	const located = locatePlugin(source, pluginId, options, probe);
	const plugin = located.plugin;
	if (plugin === undefined || plugin === null) {
		if (located.lookupFailed) {
			probe.status = "incompatible";
			addDiagnostic(probe, {
				code: "advanced-canvas-incompatible",
				level: "warning" as DiagnosticLevel,
				message: "Advanced Canvas appears to be installed, but its runtime object could not be read safely.",
			});
		} else {
			addDiagnostic(probe, {
				code: "advanced-canvas-absent",
				level: "info" as DiagnosticLevel,
				message: "Advanced Canvas is not installed or is not enabled; optional integration is disabled.",
			});
		}
	} else {
		const id = idFromPlugin(plugin, probe);
		if (id !== undefined && id !== pluginId) {
			probe.status = "absent";
			addDiagnostic(probe, {
				code: "advanced-canvas-absent",
				level: "info" as DiagnosticLevel,
				message: `Optional plugin "${pluginId}" was not found; discovered a different plugin instead.`,
			});
		} else {
			detectCapabilities(plugin, probe);
			if (probe.capabilities.size > 0) {
				probe.status = "ready";
			} else {
				probe.status = "incompatible";
				addDiagnostic(probe, {
					code: "advanced-canvas-incompatible",
					level: "warning" as DiagnosticLevel,
					message: "Advanced Canvas was found, but no supported metadata, event, or control capability was recognised.",
				});
			}
		}
	}

	return {
		status: probe.status,
		present: plugin !== undefined && plugin !== null,
		available: probe.status === "ready",
		compatible: probe.status !== "incompatible",
		version: plugin === undefined || plugin === null ? undefined : versionFromPlugin(plugin, probe),
		capabilities: new Set(probe.capabilities),
		diagnostics: [...probe.diagnostics],
		plugin,
		pluginId,
	};
}

/**
 * Optional Advanced Canvas adapter.  It is safe to construct with `undefined`
 * and should be created during plugin startup without gating native Canvas.
 */
export class AdvancedCanvasAdapter {
	public readonly kind = "advanced" as const;
	public readonly optional = true as const;
	private readonly plugin: unknown;
	private readonly pluginId: string;
	private readonly capabilitySet: Set<AdvancedCanvasCapability>;
	private readonly diagnosticList: AdapterDiagnostic[];
	private readonly diagnosticKeys: Set<string>;
	private currentStatus: AdvancedCanvasStatus;
	private readonly pluginVersion: string | undefined;

	public constructor(source: unknown, options: AdvancedCanvasAdapterOptions = {}) {
		const result = createProbe(source, options);
		this.pluginId = result.pluginId;
		this.plugin = result.plugin;
		this.capabilitySet = new Set(result.capabilities);
		this.diagnosticList = [...result.diagnostics];
		this.diagnosticKeys = new Set(
			this.diagnosticList.map((diagnostic) => `${diagnostic.code}:${diagnostic.capability ?? ""}:${diagnostic.message}`),
		);
		this.currentStatus = result.status;
		this.pluginVersion = result.version;
	}

	public static probe(source: unknown, options: AdvancedCanvasAdapterOptions = {}): AdvancedCanvasProbe {
		const result = createProbe(source, options);
		return {
			status: result.status,
			present: result.present,
			available: result.available,
			compatible: result.compatible,
			version: result.version,
			capabilities: new Set(result.capabilities),
			diagnostics: [...result.diagnostics],
		};
	}

	public get status(): AdvancedCanvasStatus {
		return this.currentStatus;
	}

	public get state(): AdvancedCanvasStatus {
		return this.currentStatus;
	}

	public get present(): boolean {
		return this.plugin !== undefined && this.plugin !== null;
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

	public get version(): string | undefined {
		return this.pluginVersion;
	}

	public get capabilities(): ReadonlySet<AdvancedCanvasCapability> {
		return new Set(this.capabilitySet);
	}

	public get diagnostics(): readonly AdapterDiagnostic[] {
		return [...this.diagnosticList];
	}

	public supports(capability: AdvancedCanvasCapability | string): boolean {
		return this.capabilitySet.has(capability as AdvancedCanvasCapability);
	}

	public hasCapability(capability: AdvancedCanvasCapability | string): boolean {
		return this.supports(capability);
	}

	private probeState(): MutableProbe {
		return {
			status: this.currentStatus,
			capabilities: this.capabilitySet,
			diagnostics: this.diagnosticList,
			diagnosticKeys: this.diagnosticKeys,
		};
	}

	private addDiagnostic(diagnostic: AdapterDiagnostic): void {
		const key = `${diagnostic.code}:${diagnostic.capability ?? ""}:${diagnostic.message}`;
		if (!this.diagnosticKeys.has(key)) {
			this.diagnosticKeys.add(key);
			this.diagnosticList.push(diagnostic);
		}
	}

	public read<T = unknown>(key: PropertyKey): T | undefined {
		return safeRead(this.plugin, key, this.probeState()) as T | undefined;
	}

	public invoke<T = unknown>(method: PropertyKey, ...args: readonly unknown[]): T | undefined {
		return safeCall(this.plugin, method, args, this.probeState()) as T | undefined;
	}

	public readMetadata(): unknown | undefined {
		const probe = this.probeState();
		for (const method of METADATA_METHODS) {
			const value = safeCall(this.plugin, method, [], probe, ADVANCED_CANVAS_CAPABILITIES.metadata);
			if (value !== undefined) {
				return value;
			}
		}
		for (const root of [this.plugin, safeRead(this.plugin, "settings", probe), safeRead(this.plugin, "api", probe)]) {
			const value = firstDefined(root, METADATA_PROPERTIES, probe, ADVANCED_CANVAS_CAPABILITIES.metadata);
			if (value !== undefined) {
				return value.value;
			}
		}
		addDiagnostic(probe, {
			code: "advanced-capability-unavailable",
			level: "warning" as DiagnosticLevel,
			message: "Advanced Canvas metadata is unavailable in this runtime.",
			capability: ADVANCED_CANVAS_CAPABILITIES.metadata,
		});
		return undefined;
	}

	public getMetadata(): unknown | undefined {
		return this.readMetadata();
	}

	private eventTarget(probe: MutableProbe): { readonly target: unknown; readonly register: PropertyKey } | undefined {
		for (const target of [
			this.plugin,
			safeRead(this.plugin, "events", probe, ADVANCED_CANVAS_CAPABILITIES.events),
			safeRead(this.plugin, "eventBus", probe, ADVANCED_CANVAS_CAPABILITIES.events),
			safeRead(this.plugin, "emitter", probe, ADVANCED_CANVAS_CAPABILITIES.events),
			safeRead(this.plugin, "api", probe, ADVANCED_CANVAS_CAPABILITIES.events),
		]) {
			const register = firstDefined(target, EVENT_METHODS, probe, ADVANCED_CANVAS_CAPABILITIES.events);
			if (register !== undefined && typeof register.value === "function") {
				return { target, register: register.key };
			}
		}
		return undefined;
	}

	public on(eventName: string, listener: (payload: unknown) => void): (() => void) | undefined {
		const probe = this.probeState();
		const target = this.eventTarget(probe);
		if (target === undefined) {
			addDiagnostic(probe, {
				code: "advanced-capability-unavailable",
				level: "warning" as DiagnosticLevel,
				message: "Advanced Canvas events are unavailable in this runtime.",
				capability: ADVANCED_CANVAS_CAPABILITIES.events,
			});
			return undefined;
		}
		const registration = safeCallResult(
			target.target,
			target.register,
			[eventName, listener],
			probe,
			ADVANCED_CANVAS_CAPABILITIES.events,
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
						code: "advanced-event-dispose-failed",
						level: "warning" as DiagnosticLevel,
						message: `Disposing Advanced Canvas listener failed: ${describeError(error)}.`,
						capability: ADVANCED_CANVAS_CAPABILITIES.events,
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
		for (const target of [
			this.plugin,
			safeRead(this.plugin, "events", probe, ADVANCED_CANVAS_CAPABILITIES.events),
			safeRead(this.plugin, "eventBus", probe, ADVANCED_CANVAS_CAPABILITIES.events),
			safeRead(this.plugin, "emitter", probe, ADVANCED_CANVAS_CAPABILITIES.events),
			safeRead(this.plugin, "api", probe, ADVANCED_CANVAS_CAPABILITIES.events),
		]) {
			for (const method of EVENT_OFF_METHODS) {
				if (typeof safeRead(target, method, probe, ADVANCED_CANVAS_CAPABILITIES.events) !== "function") {
					continue;
				}
				const result = safeCallResult(target, method, [eventName, listener], probe, ADVANCED_CANVAS_CAPABILITIES.events);
				return result.ok && result.value !== false;
			}
		}
		addDiagnostic(probe, {
			code: "advanced-capability-unavailable",
			level: "warning" as DiagnosticLevel,
			message: "Advanced Canvas event removal is unavailable in this runtime.",
			capability: ADVANCED_CANVAS_CAPABILITIES.events,
		});
		return false;
	}

	public hasControl(controlId: string): boolean {
		const probe = this.probeState();
		const method = safeRead(this.plugin, "hasControl", probe, ADVANCED_CANVAS_CAPABILITIES.controls);
		if (typeof method === "function") {
			return safeCall(this.plugin, "hasControl", [controlId], probe, ADVANCED_CANVAS_CAPABILITIES.controls) === true;
		}
		const controls = safeRead(this.plugin, "controls", probe, ADVANCED_CANVAS_CAPABILITIES.controls);
		const setResult = safeInstanceOf(controls, Set, "Set", probe, ADVANCED_CANVAS_CAPABILITIES.controls);
		if (!setResult.ok) {
			return false;
		}
		const mapResult = safeInstanceOf(controls, Map, "Map", probe, ADVANCED_CANVAS_CAPABILITIES.controls);
		if (!mapResult.ok) {
			return false;
		}
		if (setResult.value || mapResult.value) {
			const hasResult = safeCallResult(
				controls,
				"has",
				[controlId],
				probe,
				ADVANCED_CANVAS_CAPABILITIES.controls,
			);
			if (hasResult.ok) {
				return hasResult.value === true;
			}
			this.addDiagnostic({
				code: "advanced-control-read-failed",
				level: "warning",
				message: `Reading Advanced Canvas control "${describePropertyKey(controlId as PropertyKey)}" failed.`,
				capability: ADVANCED_CANVAS_CAPABILITIES.controls,
			});
		}
		return false;
	}

	public registerControl(controlId: string, control: unknown): boolean {
		const probe = this.probeState();
		if (typeof safeRead(this.plugin, "registerControl", probe, ADVANCED_CANVAS_CAPABILITIES.controls) !== "function") {
			addDiagnostic(probe, {
				code: "advanced-capability-unavailable",
				level: "warning" as DiagnosticLevel,
				message: "Advanced Canvas control registration is unavailable in this runtime.",
				capability: ADVANCED_CANVAS_CAPABILITIES.controls,
			});
			return false;
		}
		const result = safeCallResult(
			this.plugin,
			"registerControl",
			[controlId, control],
			probe,
			ADVANCED_CANVAS_CAPABILITIES.controls,
		);
		return result.ok && result.value !== false;
	}

	public get pluginIdentifier(): string {
		return this.pluginId;
	}
}

export function probeAdvancedCanvas(
	source: unknown,
	options: AdvancedCanvasAdapterOptions = {},
): AdvancedCanvasProbe {
	return AdvancedCanvasAdapter.probe(source, options);
}

export function createAdvancedCanvasAdapter(
	source: unknown,
	options: AdvancedCanvasAdapterOptions = {},
): AdvancedCanvasAdapter {
	return new AdvancedCanvasAdapter(source, options);
}

export const detectAdvancedCanvas = probeAdvancedCanvas;
