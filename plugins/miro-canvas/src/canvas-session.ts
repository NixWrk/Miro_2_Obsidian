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
import {
	parseMiroCanvasMetadata,
	type MiroCanvasDiagnostic,
	type MiroCanvasMetadataParseResult,
} from "./metadata";

/**
 * A read-only snapshot of the native Canvas adapter state.  Returning a
 * snapshot instead of the adapter instance keeps session consumers from
 * accidentally reaching mutating methods while they inspect a view.
 */
export interface CanvasAdapterInspection {
	readonly status: AdapterStatus;
	readonly available: boolean;
	readonly compatible: boolean;
	readonly capabilities: readonly CanvasCapability[];
	readonly diagnostics: readonly AdapterDiagnostic[];
}

export type CanvasSessionDiagnostic = AdapterDiagnostic | MiroCanvasDiagnostic;

export type CanvasSessionMetadataReadStatus = "available" | "unavailable";

/**
 * Metadata can only be classified as absent after the native document itself
 * was read.  This separate result keeps the existing parser result type while
 * making an unreadable document explicit to session consumers.
 */
export interface CanvasSessionMetadataReadResult {
	readonly status: CanvasSessionMetadataReadStatus;
	readonly result: MiroCanvasMetadataParseResult;
	readonly error?: AdapterDiagnostic;
}

export interface CanvasSessionInspection {
	readonly adapter: CanvasAdapterInspection;
	readonly adapterStatus: AdapterStatus;
	readonly adapterCapabilities: readonly CanvasCapability[];
	readonly adapterDiagnostics: readonly AdapterDiagnostic[];
	readonly metadata: MiroCanvasMetadataParseResult;
	readonly metadataStatus: MiroCanvasMetadataParseResult["status"];
	readonly metadataDiagnostics: readonly MiroCanvasDiagnostic[];
	readonly metadataRead: CanvasSessionMetadataReadResult;
	readonly metadataReadStatus: CanvasSessionMetadataReadStatus;
	readonly metadataReadError?: AdapterDiagnostic;
	readonly diagnostics: readonly CanvasSessionDiagnostic[];
}

export interface AdvancedCanvasInspection {
	readonly status: AdvancedCanvasStatus;
	readonly present: boolean;
	readonly available: boolean;
	readonly compatible: boolean;
	readonly version?: string;
	readonly capabilities: readonly AdvancedCanvasCapability[];
	readonly diagnostics: readonly AdapterDiagnostic[];
}

function describeError(error: unknown): string {
	if (error instanceof Error && error.message) {
		return error.message;
	}
	return "unknown error";
}

function inspectionFailure(message: string): AdapterDiagnostic {
	return {
		code: "canvas-session-inspection-failed",
		level: "warning",
		message,
	};
}

function metadataFailure(error: unknown): MiroCanvasDiagnostic {
	return {
		code: "metadata-inspection-failed",
		path: "miroCanvas",
		message: `Reading miroCanvas metadata failed: ${describeError(error)}.`,
		severity: "error",
	};
}

function documentReadFailure(message: string, code = "canvas-document-unavailable"): AdapterDiagnostic {
	return {
		code,
		level: "warning",
		message,
	};
}

function unavailableMetadataResult(message: string): MiroCanvasMetadataParseResult {
	return {
		status: "invalid",
		migrated: false,
		diagnostics: [
			{
				code: "metadata-document-unavailable",
				path: "miroCanvas",
				message,
				severity: "error",
			},
		],
	};
}

function parseMetadataSafely(
	document: unknown,
): { readonly result: MiroCanvasMetadataParseResult; readonly failure?: MiroCanvasDiagnostic } {
	try {
		return { result: parseMiroCanvasMetadata(document) };
	} catch (error) {
		const failure = metadataFailure(error);
		return {
			result: {
				status: "invalid",
				migrated: false,
				diagnostics: [failure],
			},
			failure,
		};
	}
}

function summarizeAdapter(adapter: CanvasAdapter): CanvasAdapterInspection {
	return {
		status: adapter.status,
		available: adapter.available,
		compatible: adapter.compatible,
		capabilities: adapter.getCapabilities(),
		diagnostics: adapter.diagnostics,
	};
}

function makeCanvasInspection(
	adapter: CanvasAdapter,
	document: unknown,
	documentReadError?: AdapterDiagnostic,
	extraDiagnostics: readonly AdapterDiagnostic[] = [],
): CanvasSessionInspection {
	const adapterInspection = summarizeAdapter(adapter);
	const parsed = documentReadError === undefined
		? parseMetadataSafely(document)
		: { result: unavailableMetadataResult(documentReadError.message) };
	const metadataDiagnostics = parsed.result.diagnostics;
	const metadataRead: CanvasSessionMetadataReadResult = {
		status: documentReadError === undefined ? "available" : "unavailable",
		result: parsed.result,
		error: documentReadError,
	};
	const diagnostics: CanvasSessionDiagnostic[] = [
		...adapterInspection.diagnostics,
		...metadataDiagnostics,
		...(documentReadError === undefined ? [] : [documentReadError]),
		...extraDiagnostics,
	];

	return {
		adapter: adapterInspection,
		adapterStatus: adapterInspection.status,
		adapterCapabilities: adapterInspection.capabilities,
		adapterDiagnostics: adapterInspection.diagnostics,
		metadata: parsed.result,
		metadataStatus: parsed.result.status,
		metadataDiagnostics,
		metadataRead,
		metadataReadStatus: metadataRead.status,
		metadataReadError: metadataRead.error,
		diagnostics,
	};
}

/**
 * Inspect one native Canvas view without changing its document or camera.
 * `getDocument()` is the only adapter operation used here; persistence and
 * viewport mutation methods are intentionally not part of this flow.
 */
export function inspectCanvasView(view: unknown): CanvasSessionInspection {
	try {
		const adapter = createCanvasAdapter(view);
		let document: unknown;
		let documentReadError: AdapterDiagnostic | undefined;
		try {
			document = adapter.getDocument();
			if (document === undefined) {
				documentReadError = documentReadFailure(
					"The native Canvas document is unavailable; metadata presence cannot be determined.",
				);
			}
		} catch (error) {
			documentReadError = documentReadFailure(
				`Reading the native Canvas document failed: ${describeError(error)}.`,
				"canvas-document-read-failed",
			);
		}
		return makeCanvasInspection(adapter, document, documentReadError);
	} catch (error) {
		const failure = inspectionFailure(
			`Creating the native Canvas adapter failed: ${describeError(error)}.`,
		);
		const adapter = new CanvasAdapter(undefined);
		return makeCanvasInspection(adapter, undefined, failure);
	}
}

function summarizeAdvancedAdapter(
	adapter: AdvancedCanvasAdapter,
): AdvancedCanvasInspection {
	return {
		status: adapter.status,
		present: adapter.present,
		available: adapter.available,
		compatible: adapter.compatible,
		version: adapter.version,
		capabilities: [...adapter.capabilities],
		diagnostics: adapter.diagnostics,
	};
}

/**
 * Probe the optional Advanced Canvas integration once.  Runtime discovery is
 * deliberately delegated to its adapter; an absent or changed plugin only
 * disables this optional report and never blocks native Canvas startup.
 */
export function inspectAdvancedCanvas(app: unknown): AdvancedCanvasInspection {
	try {
		return summarizeAdvancedAdapter(createAdvancedCanvasAdapter(app));
	} catch (error) {
		return {
			status: "incompatible",
			present: false,
			available: false,
			compatible: false,
			capabilities: [],
			diagnostics: [
				inspectionFailure(
					`Creating the Advanced Canvas adapter failed: ${describeError(error)}.`,
				),
			],
		};
	}
}
