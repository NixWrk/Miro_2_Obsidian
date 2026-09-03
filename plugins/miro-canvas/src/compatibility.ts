/**
 * Offline compatibility checks for the M0 native/Advanced Canvas boundary.
 *
 * The matrix deliberately uses only adapter reads.  It is safe to run against
 * a fixture, a mocked Obsidian view, or a real view supplied by a future test
 * vault.  No save, viewport mutation, event registration, or network request
 * is performed here.  A report is data-only so a later status panel can render
 * it without knowing anything about the private Canvas runtime.
 */

import {
	CanvasAdapter,
	createCanvasAdapter,
	type AdapterDiagnostic,
	type AdapterStatus,
	type CanvasCapability,
} from "./canvas-adapter";
import {
	AdvancedCanvasAdapter,
	createAdvancedCanvasAdapter,
	type AdvancedCanvasCapability,
	type AdvancedCanvasStatus,
} from "./advanced-canvas-adapter";

export const COMPATIBILITY_MODES = {
	nativeOnly: "native-only",
	miroCanvasOnly: "miro-canvas-only",
	advancedCanvasOnly: "advanced-canvas-only",
	bothPlugins: "both-plugins",
} as const;

export type CompatibilityMode =
	(typeof COMPATIBILITY_MODES)[keyof typeof COMPATIBILITY_MODES];

export type CompatibilityResultStatus = "pass" | "degraded" | "fail";

/** Result of a byte comparison when the values may be unavailable. */
export type ByteEquivalence = boolean | "unknown";

export type CompatibilityDiagnosticSeverity = "info" | "warning" | "error";

export type CompatibilityDiagnosticSource =
	| "native"
	| "advanced"
	| "document"
	| "ownership"
	| "execution";

/** A stable, UI-friendly diagnostic with no raw payload values. */
export interface CompatibilityDiagnostic {
	readonly code: string;
	readonly severity: CompatibilityDiagnosticSeverity;
	readonly message: string;
	readonly source: CompatibilityDiagnosticSource;
}

/**
 * The smallest host input needed by the matrix.  `advancedPlugin` is useful
 * for tests and for hosts that already resolved the optional plugin; when it
 * is absent, `advancedApp` is passed to the adapter's normal registry probe.
 */
export interface CompatibilityFixture {
	readonly nativeView: unknown;
	readonly advancedApp?: unknown;
	readonly advancedPlugin?: unknown;
	/** Controls exposed by the host's native Canvas, when known. */
	readonly nativeControls?: readonly string[];
	/** Controls registered by miro-canvas, when a host has installed them. */
	readonly miroCanvasControls?: readonly string[];
	/** Explicit test override for controls exposed by Advanced Canvas. */
	readonly advancedCanvasControls?: readonly string[];
	/** Console errors captured by the host/test harness, not adapter diagnostics. */
	readonly consoleErrors?: readonly string[];
	/** Optional boundary supplied by a runtime/test harness to return captured errors. */
	readonly captureConsoleErrors?: () => readonly string[];
}

export interface CompatibilityMatrixOptions {
	/** Run only selected modes; the default is the complete four-mode matrix. */
	readonly modes?: readonly CompatibilityMode[];
	/** External console errors captured for every scenario in this run. */
	readonly consoleErrors?: readonly string[];
	/** Per-scenario console-error capture hook supplied by a host/test harness. */
	readonly captureConsoleErrors?:
		(mode: CompatibilityMode) => readonly string[];
	/**
	 * Optional explicit action executed after the read-only baseline and before
	 * the second snapshot.  This exists to prove the distinction between a
	 * passive compatibility check and an intentional caller mutation.
	 */
	readonly explicitMutation?:
		(context: CompatibilityMutationContext) => void;
}

export interface CompatibilityMutationContext {
	readonly mode: CompatibilityMode;
	readonly document: unknown;
	readonly nativeAdapter: CanvasAdapter;
	readonly advancedAdapter: AdvancedCanvasAdapter;
}

export interface NativeCompatibilityReport {
	readonly status: AdapterStatus;
	readonly available: boolean;
	readonly compatible: boolean;
	readonly capabilities: readonly CanvasCapability[];
	readonly documentReadable: boolean;
	/** Exact JSON.stringify output captured before and after adapter reads. */
	readonly documentBytesBefore?: string;
	readonly documentBytesAfter?: string;
	readonly documentByteEquivalent: boolean;
	/** Alias suitable for a future UI/data-integrity status row. */
	readonly unknownMetadataByteEquivalent: boolean;
	readonly diagnostics: readonly AdapterDiagnostic[];
}

export interface AdvancedCompatibilityReport {
	readonly status: AdvancedCanvasStatus;
	readonly present: boolean;
	readonly available: boolean;
	readonly compatible: boolean;
	readonly version?: string;
	readonly capabilities: readonly AdvancedCanvasCapability[];
	readonly metadataReadable: boolean;
	readonly metadataBytesBefore?: string;
	readonly metadataBytesAfter?: string;
	/** True/false when compared; unknown when Advanced metadata is unavailable. */
	readonly metadataByteEquivalent: ByteEquivalence;
	/** Optional integration may be disabled without disabling native Canvas. */
	readonly optionalIntegrationDisabled: boolean;
	readonly diagnostics: readonly AdapterDiagnostic[];
}

export type CompatibilityControlOwner =
	| "native-canvas"
	| "miro-canvas"
	| "advanced-canvas";

export interface ControlOwnershipReport {
	readonly owners: Readonly<Record<string, readonly CompatibilityControlOwner[]>>;
	readonly duplicateControlIds: readonly string[];
	readonly nativeControls: readonly string[];
	readonly miroCanvasControls: readonly string[];
	readonly advancedCanvasControls: readonly string[];
}

export interface CompatibilityScenarioReport {
	readonly mode: CompatibilityMode;
	readonly status: CompatibilityResultStatus;
	/** Core remains usable even when the optional integration is degraded. */
	readonly coreOperational: boolean;
	readonly optionalIntegrationGraceful: boolean;
	readonly native: NativeCompatibilityReport;
	readonly advanced: AdvancedCompatibilityReport;
	readonly ownership: ControlOwnershipReport;
	readonly consoleErrors: readonly string[];
	/** Exceptions raised by the compatibility runner itself, separate from console errors. */
	readonly executionErrors: readonly string[];
	readonly diagnostics: readonly CompatibilityDiagnostic[];
	readonly passed: boolean;
}

export interface CompatibilityMatrixReport {
	readonly modes: readonly CompatibilityMode[];
	readonly scenarios: readonly CompatibilityScenarioReport[];
	readonly passed: boolean;
	readonly hasDegradedScenarios: boolean;
	readonly diagnostics: readonly CompatibilityDiagnostic[];
}

interface ByteSnapshot {
	readonly readable: boolean;
	readonly bytes?: string;
	readonly error?: string;
}

interface ModeDefinition {
	readonly mode: CompatibilityMode;
	readonly miroCanvasEnabled: boolean;
	readonly advancedCanvasEnabled: boolean;
}

const DEFAULT_MODE_DEFINITIONS: readonly ModeDefinition[] = [
	{
		mode: COMPATIBILITY_MODES.nativeOnly,
		miroCanvasEnabled: false,
		advancedCanvasEnabled: false,
	},
	{
		mode: COMPATIBILITY_MODES.miroCanvasOnly,
		miroCanvasEnabled: true,
		advancedCanvasEnabled: false,
	},
	{
		mode: COMPATIBILITY_MODES.advancedCanvasOnly,
		miroCanvasEnabled: false,
		advancedCanvasEnabled: true,
	},
	{
		mode: COMPATIBILITY_MODES.bothPlugins,
		miroCanvasEnabled: true,
		advancedCanvasEnabled: true,
	},
];

function isObject(value: unknown): value is Record<PropertyKey, unknown> {
	return (typeof value === "object" && value !== null) || typeof value === "function";
}

function describeError(error: unknown): string {
	return error instanceof Error && error.message ? error.message : "unknown error";
}

function snapshotBytes(value: unknown): ByteSnapshot {
	try {
		const bytes = JSON.stringify(value);
		if (bytes === undefined) {
			return {
				readable: false,
				error: "value is not JSON-serializable",
			};
		}
		return { readable: true, bytes };
	} catch (error) {
		return {
			readable: false,
			error: describeError(error),
		};
	}
}

function readProperty(value: unknown, key: PropertyKey): unknown {
	if (!isObject(value)) {
		return undefined;
	}
	try {
		return Reflect.get(value, key, value);
	} catch {
		return undefined;
	}
}

function asControlId(value: unknown): string | undefined {
	if (typeof value === "string" && value.trim().length > 0) {
		return value;
	}
	if (!isObject(value)) {
		return undefined;
	}
	for (const key of ["id", "controlId", "name"] as const) {
		const candidate = readProperty(value, key);
		if (typeof candidate === "string" && candidate.trim().length > 0) {
			return candidate;
		}
	}
	return undefined;
}

function readControlIds(value: unknown): readonly string[] {
	if (value === undefined || value === null) {
		return [];
	}
	const result: string[] = [];
	const add = (candidate: unknown): void => {
		const id = asControlId(candidate);
		if (id !== undefined && !result.includes(id)) {
			result.push(id);
		}
	};

	try {
		if (Array.isArray(value)) {
			for (let index = 0; index < value.length; index += 1) {
				add(value[index]);
			}
			return result;
		}
		if (value instanceof Map) {
			for (const [key, entry] of value.entries()) {
				add(key);
				add(entry);
			}
			return result;
		}
		if (value instanceof Set) {
			for (const entry of value.values()) {
				add(entry);
			}
			return result;
		}
		for (const key of Reflect.ownKeys(value)) {
			if (typeof key === "string") {
				add(key);
			}
		}
	} catch {
		// A changed optional API simply contributes no ownership claims.
	}
	return result;
}

function controlOwnership(
	fixture: CompatibilityFixture,
	mode: ModeDefinition,
	advancedAdapter: AdvancedCanvasAdapter,
): ControlOwnershipReport {
	const nativeControls = [...(fixture.nativeControls ?? [])];
	const miroCanvasControls = mode.miroCanvasEnabled
		? [...(fixture.miroCanvasControls ?? [])]
		: [];
	const advancedCanvasControls = mode.advancedCanvasEnabled
		? fixture.advancedCanvasControls === undefined
			? readControlIds(
					advancedAdapter.read("controls") ??
					advancedAdapter.read("registeredControls"),
			  )
			: [...fixture.advancedCanvasControls]
		: [];

	const ownerEntries: Array<readonly [CompatibilityControlOwner, readonly string[]]> = [
		["native-canvas", nativeControls],
		["miro-canvas", miroCanvasControls],
		["advanced-canvas", advancedCanvasControls],
	];
	const ownerMap = new Map<string, CompatibilityControlOwner[]>();
	for (const [owner, controls] of ownerEntries) {
		for (const control of controls) {
			if (!ownerMap.has(control)) {
				ownerMap.set(control, []);
			}
			const owners = ownerMap.get(control);
			if (owners !== undefined && !owners.includes(owner)) {
				owners.push(owner);
			}
		}
	}

	const owners: Record<string, readonly CompatibilityControlOwner[]> = {};
	const duplicateControlIds: string[] = [];
	for (const [control, controlOwners] of ownerMap.entries()) {
		owners[control] = [...controlOwners];
		if (controlOwners.length > 1) {
			duplicateControlIds.push(control);
		}
	}

	return {
		owners,
		duplicateControlIds,
		nativeControls,
		miroCanvasControls,
		advancedCanvasControls,
	};
}

function diagnostic(
	code: string,
	severity: CompatibilityDiagnosticSeverity,
	message: string,
	source: CompatibilityDiagnosticSource,
): CompatibilityDiagnostic {
	return { code, severity, message, source };
}

function advancedAdapterForFixture(fixture: CompatibilityFixture): AdvancedCanvasAdapter {
	if (fixture.advancedPlugin !== undefined) {
		return createAdvancedCanvasAdapter(undefined, { plugin: fixture.advancedPlugin });
	}
	return createAdvancedCanvasAdapter(fixture.advancedApp);
}

interface CapturedConsoleErrors {
	readonly errors: readonly string[];
	readonly failures: readonly string[];
}

/**
 * Read externally captured console errors without patching the global console.
 * A real Obsidian harness can provide a collector at the boundary, while unit
 * tests can pass a deterministic array.  Adapter diagnostics and caught
 * exceptions remain separate from this channel.
 */
function capturedConsoleErrors(
	mode: CompatibilityMode,
	fixture: CompatibilityFixture,
	options: CompatibilityMatrixOptions,
): CapturedConsoleErrors {
	const errors: string[] = [];
	const failures: string[] = [];
	const addValues = (values: readonly string[] | undefined, source: string): void => {
		if (values === undefined) {
			return;
		}
		try {
			for (const value of values) {
				if (typeof value === "string" && value.trim().length > 0 && !errors.includes(value)) {
					errors.push(value);
				}
			}
		} catch (error) {
			failures.push(`${source}: ${describeError(error)}`);
		}
	};

	addValues(fixture.consoleErrors, "fixture console error capture");
	addValues(options.consoleErrors, "options console error capture");
	if (fixture.captureConsoleErrors !== undefined) {
		try {
			addValues(fixture.captureConsoleErrors(), "fixture console error capture");
		} catch (error) {
			failures.push(`fixture console error capture: ${describeError(error)}`);
		}
	}
	if (options.captureConsoleErrors !== undefined) {
		try {
			addValues(options.captureConsoleErrors(mode), "options console error capture");
		} catch (error) {
			failures.push(`options console error capture: ${describeError(error)}`);
		}
	}

	return { errors, failures };
}

function runReadPass(
	mode: ModeDefinition,
	fixture: CompatibilityFixture,
	options: CompatibilityMatrixOptions,
): CompatibilityScenarioReport {
	const nativeAdapter = createCanvasAdapter(fixture.nativeView);
	const advancedAdapter = advancedAdapterForFixture(fixture);
	const diagnostics: CompatibilityDiagnostic[] = [];
	const executionErrors: string[] = [];

	let document: unknown;
	try {
		document = nativeAdapter.getDocument();
	} catch (error) {
		executionErrors.push(`native document read failed: ${describeError(error)}`);
		diagnostics.push(
			diagnostic(
				"native-document-read-failed",
				"error",
				"The native Canvas document could not be read safely.",
				"document",
			),
		);
	}

	const documentBefore = snapshotBytes(document);
	if (!documentBefore.readable) {
		diagnostics.push(
			diagnostic(
				"document-not-readable",
				"error",
				"The compatibility fixture did not expose a JSON-readable Canvas document.",
				"document",
			),
		);
	}

	// Exercise all read-only adapter paths that M0 promises.  These calls are
	// intentionally kept separate from persistence and viewport mutation APIs.
	try {
		nativeAdapter.getNodes();
		nativeAdapter.getEdges();
		nativeAdapter.getSelection();
		nativeAdapter.getViewport();
	} catch (error) {
		executionErrors.push(`native inspection failed: ${describeError(error)}`);
		diagnostics.push(
			diagnostic(
				"native-inspection-failed",
				"error",
				"A native Canvas read-only inspection operation threw.",
				"native",
			),
		);
	}

	const advancedMetadataBefore = mode.advancedCanvasEnabled
		? snapshotBytes(advancedAdapter.readMetadata())
		: undefined;
	if (
		mode.advancedCanvasEnabled &&
		advancedAdapter.supports("metadata") &&
		advancedMetadataBefore !== undefined &&
		!advancedMetadataBefore.readable
	) {
		diagnostics.push(
			diagnostic(
				"advanced-metadata-not-readable",
				"warning",
				"Advanced Canvas metadata was advertised but could not be serialized for comparison.",
				"advanced",
			),
		);
	}

	if (options.explicitMutation !== undefined && document !== undefined) {
		try {
			options.explicitMutation({
				mode: mode.mode,
				document,
				nativeAdapter,
				advancedAdapter,
			});
		} catch (error) {
			executionErrors.push(`explicit mutation failed: ${describeError(error)}`);
			diagnostics.push(
				diagnostic(
					"explicit-mutation-failed",
					"error",
					"The explicit mutation callback failed.",
					"execution",
				),
			);
		}
	}

	let documentAfterValue: unknown;
	try {
		// Reacquire instead of reusing the first reference: some native runtimes
		// return detached snapshots, and a read-only probe must detect changes
		// made to the host document between the two reads.
		documentAfterValue = nativeAdapter.getDocument();
	} catch (error) {
		executionErrors.push(`native document reacquire failed: ${describeError(error)}`);
		diagnostics.push(
			diagnostic(
				"native-document-reacquire-failed",
				"error",
				"The native Canvas document could not be reacquired safely after inspection.",
				"document",
			),
		);
	}
	const documentAfter = snapshotBytes(documentAfterValue);
	const documentByteEquivalent =
		documentBefore.readable &&
		documentAfter.readable &&
		documentBefore.bytes === documentAfter.bytes;
	const advancedMetadataAfter = mode.advancedCanvasEnabled
		? snapshotBytes(advancedAdapter.readMetadata())
		: undefined;
	const advancedMetadataByteEquivalent: ByteEquivalence =
		!mode.advancedCanvasEnabled ||
		advancedAdapter.status !== "ready" ||
		advancedMetadataBefore === undefined ||
		advancedMetadataAfter === undefined ||
		!advancedMetadataBefore.readable ||
		!advancedMetadataAfter.readable
			? "unknown"
			: advancedMetadataBefore.bytes === advancedMetadataAfter.bytes;

	if (!documentByteEquivalent && options.explicitMutation === undefined) {
		diagnostics.push(
			diagnostic(
				"document-mutated-during-read",
				"error",
				"A compatibility read changed Canvas document bytes without an explicit mutation.",
				"document",
			),
		);
	}
	if (advancedMetadataByteEquivalent === false && options.explicitMutation === undefined) {
		diagnostics.push(
			diagnostic(
				"advanced-metadata-mutated-during-read",
				"error",
				"Advanced Canvas metadata changed during a read-only compatibility pass.",
				"advanced",
			),
		);
	}
	if (
		mode.advancedCanvasEnabled &&
		advancedMetadataByteEquivalent === "unknown" &&
		advancedAdapter.status === "ready"
	) {
		diagnostics.push(
			diagnostic(
				"advanced-metadata-unverifiable",
				"warning",
				"Advanced Canvas metadata could not be verified byte-for-byte in this runtime.",
				"advanced",
			),
		);
	}

	const ownership = controlOwnership(fixture, mode, advancedAdapter);
	if (ownership.duplicateControlIds.length > 0) {
		diagnostics.push(
			diagnostic(
				"duplicate-control-ownership",
				"error",
				"At least one UI control is claimed by more than one Canvas integration.",
				"ownership",
			),
		);
	}

	const nativeReady = nativeAdapter.available && documentBefore.readable;
	const captured = capturedConsoleErrors(mode.mode, fixture, options);
	const consoleErrors = [...captured.errors];
	for (const failure of captured.failures) {
		executionErrors.push(failure);
	}
	if (consoleErrors.length > 0) {
		diagnostics.push(
			diagnostic(
				"console-errors-detected",
				"error",
				`${consoleErrors.length} external console error(s) were captured for this scenario.`,
				"execution",
			),
		);
	}
	if (captured.failures.length > 0) {
		diagnostics.push(
			diagnostic(
				"console-error-capture-failed",
				"error",
				"The external console-error capture boundary failed.",
				"execution",
			),
		);
	}
	const optionalIntegrationGraceful =
		!mode.advancedCanvasEnabled ||
		advancedAdapter.compatible ||
		(nativeReady && executionErrors.length === 0);
	if (mode.advancedCanvasEnabled && advancedAdapter.status === "incompatible") {
		diagnostics.push(
			diagnostic(
				"advanced-integration-disabled",
				"warning",
				"Advanced Canvas integration is disabled; native Canvas remains the required core.",
				"advanced",
			),
		);
	}

	const coreOperational = nativeReady && executionErrors.length === 0;
	const hasHardFailure =
		!coreOperational ||
		consoleErrors.length > 0 ||
		executionErrors.length > 0 ||
		(!documentByteEquivalent && options.explicitMutation === undefined) ||
		(advancedMetadataByteEquivalent === false && options.explicitMutation === undefined) ||
		ownership.duplicateControlIds.length > 0 ||
		!optionalIntegrationGraceful;
	const status: CompatibilityResultStatus = hasHardFailure
		? "fail"
		: mode.advancedCanvasEnabled &&
		  (!advancedAdapter.available || advancedMetadataByteEquivalent === "unknown")
			? "degraded"
			: "pass";

	const nativeReport: NativeCompatibilityReport = {
		status: nativeAdapter.status,
		available: nativeAdapter.available,
		compatible: nativeAdapter.compatible,
		capabilities: nativeAdapter.getCapabilities(),
		documentReadable: documentBefore.readable,
		documentBytesBefore: documentBefore.bytes,
		documentBytesAfter: documentAfter.bytes,
		documentByteEquivalent,
		unknownMetadataByteEquivalent: documentByteEquivalent,
		diagnostics: nativeAdapter.diagnostics,
	};
	const advancedReport: AdvancedCompatibilityReport = {
		status: advancedAdapter.status,
		present: advancedAdapter.present,
		available: advancedAdapter.available,
		compatible: advancedAdapter.compatible,
		version: advancedAdapter.version,
		capabilities: [...advancedAdapter.capabilities],
		metadataReadable: advancedMetadataBefore?.readable ?? false,
		metadataBytesBefore: advancedMetadataBefore?.bytes,
		metadataBytesAfter: advancedMetadataAfter?.bytes,
		metadataByteEquivalent: advancedMetadataByteEquivalent,
		optionalIntegrationDisabled: mode.advancedCanvasEnabled && !advancedAdapter.available,
		diagnostics: advancedAdapter.diagnostics,
	};

	return {
		mode: mode.mode,
		status,
		coreOperational,
		optionalIntegrationGraceful,
		native: nativeReport,
		advanced: advancedReport,
		ownership,
		consoleErrors,
		executionErrors,
		diagnostics,
		passed: status !== "fail",
	};
}

function modeDefinition(mode: CompatibilityMode): ModeDefinition {
	return DEFAULT_MODE_DEFINITIONS.find((definition) => definition.mode === mode) ?? {
		mode,
		miroCanvasEnabled: mode === COMPATIBILITY_MODES.miroCanvasOnly || mode === COMPATIBILITY_MODES.bothPlugins,
		advancedCanvasEnabled: mode === COMPATIBILITY_MODES.advancedCanvasOnly || mode === COMPATIBILITY_MODES.bothPlugins,
	};
}

/** Run one scenario from the native/Advanced compatibility matrix. */
export function runCompatibilityScenario(
	mode: CompatibilityMode,
	fixture: CompatibilityFixture,
	options: CompatibilityMatrixOptions = {},
): CompatibilityScenarioReport {
	return runReadPass(modeDefinition(mode), fixture, options);
}

/** Run native-only, miro-canvas-only, Advanced-only, and both-plugin modes. */
export function runCompatibilityMatrix(
	fixture: CompatibilityFixture,
	options: CompatibilityMatrixOptions = {},
): CompatibilityMatrixReport {
	const modes = options.modes === undefined
		? DEFAULT_MODE_DEFINITIONS.map((definition) => definition.mode)
		: [...options.modes];
	const scenarios = modes.map((mode) =>
		runCompatibilityScenario(mode, fixture, options),
	);
	const diagnostics = scenarios.flatMap((scenario) =>
		scenario.diagnostics.map((item) => ({
			...item,
			message: `${scenario.mode}: ${item.message}`,
		})),
	);
	return {
		modes,
		scenarios,
		passed: scenarios.every((scenario) => scenario.passed),
		hasDegradedScenarios: scenarios.some((scenario) => scenario.status === "degraded"),
		diagnostics,
	};
}

/** Alias for callers that prefer an imperative/check naming convention. */
export const checkCompatibilityMatrix = runCompatibilityMatrix;
