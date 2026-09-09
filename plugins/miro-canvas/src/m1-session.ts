/**
 * Runtime owner for the M1 feature set.
 *
 * A session exists only while one native Canvas leaf is active.  It owns the
 * namespaced panel, scoped DOM guards, minimap listeners, and any temporary
 * native readonly toggle.  The Canvas adapter remains the only private
 * runtime boundary; MetadataWriter remains the only persistence boundary.
 */

import {
	APPEARANCE_ACTIONS,
	mergeAppearanceMetadata,
	normalizeAppearanceState,
	appearanceReducer,
	colorToCss,
	type AppearanceAction,
	type AppearanceState,
	type ColorSettings,
	type TypographySettings,
} from "./appearance";
import {
	decideAttachmentLabel,
	shouldShowAttachmentName,
} from "./attachment-labels";
import {
	CANVAS_CAPABILITIES,
	createCanvasAdapter,
	type CanvasAdapter,
	type CanvasScene,
} from "./canvas-adapter";
import { CANVAS_SHAPE_KINDS, createCanvasAuthoring, type CanvasAuthoring, type ConnectorSide } from "./canvas-authoring";
import {
	SelectionHandles,
	type HandleRect,
	type HandleSide,
	type SelectionHandlesState,
} from "./selection-handles";
import {
	SelectionToolbar,
	type SelectionKind,
	type SelectionStylePatch,
	type SelectionToolbarStyle,
	type SelectionToolbarPlacement,
	type SelectionToolbarState,
} from "./selection-toolbar";
import {
	collectCanvasElementIds,
	readCanvasElementDom,
	readCanvasElementFile,
	readCanvasElementId,
	readCanvasElementType,
} from "./canvas-elements";
import {
	createInteractionPolicy,
	decideInteraction,
	decideEditOperation,
	reduceInteractionMetadata,
	type InteractionPolicy,
} from "./interaction-policy";
import {
	MinimapModel,
	type MinimapPoint,
	type MinimapRect,
} from "./minimap-model";
import { MetadataWriter, type MetadataWriteResult } from "./metadata-writer";
import { PLUGIN_ROOT_KEYS, parseMiroCanvasMetadata, type MiroCanvasMetadata } from "./metadata";
import { DEFAULT_SETTINGS, panDelta, type MiroCanvasSettings, type PanDirection } from "./settings";
import {
	DEFAULT_MAX_ZOOM,
	DEFAULT_MIN_ZOOM,
	ViewportController,
	type ViewportTransform,
} from "./viewport-controller";
import {
	M1Controls,
	type M1CommandItem,
	type M1ControlsActions,
	type M1ControlsState,
	type M1NavigationAction,
} from "./m1-controls";
import { SourceRenderer } from "./source-renderer";

export interface M1SessionOptions {
	readonly document?: Document;
	readonly panelHost?: HTMLElement;
	readonly onNotice?: (message: string) => void;
	readonly onStateChange?: (state: M1ControlsState) => void;
	/** User preferences; defaults apply when the host supplies none. */
	readonly settings?: MiroCanvasSettings;
}

export type M1SessionStatus = "ready" | "unavailable" | "incompatible";

export interface M1SessionSnapshot {
	readonly status: M1SessionStatus;
	readonly selectedIds: readonly string[];
	readonly reviewMode: boolean;
	readonly minimapVisible: boolean;
	readonly diagnostics: readonly string[];
	readonly viewport?: ViewportTransform;
	readonly contentBounds?: MinimapRect;
}

type UnknownRecord = Record<string, unknown>;

const PANEL_SELECTOR = ".miro-canvas-panel, .miro-canvas-toolbar";
const DEFAULT_TOOLBAR_FONT = "Inter";
const DEFAULT_TOOLBAR_FONT_SIZE = 16;
const REFRESH_INTERVAL_MS = 750;
const APPEARANCE_ATTRIBUTE = "data-miro-canvas-appearance";
const VERTICAL_ALIGN_ATTRIBUTE = "data-miro-canvas-vertical-align";
const THEME_ROOT_CLASS = "miro-canvas-root";

function isObject(value: unknown): value is UnknownRecord {
	return value !== null && (typeof value === "object" || typeof value === "function");
}

function isRecord(value: unknown): value is UnknownRecord {
	if (!isObject(value)) {
		return false;
	}
	try {
		return !Array.isArray(value);
	} catch {
		return false;
	}
}

function readOwn(value: unknown, key: string): unknown {
	if (!isObject(value)) {
		return undefined;
	}
	try {
		return Object.prototype.hasOwnProperty.call(value, key) ? Reflect.get(value, key, value) : undefined;
	} catch {
		return undefined;
	}
}

/** Read a host runtime object (DOM/Event/window) through its prototype chain.
 * JSON metadata continues to use readOwn so inherited fields are ignored. */
function readRuntime(value: unknown, key: PropertyKey): unknown {
	if (!isObject(value)) {
		return undefined;
	}
	try {
		return Reflect.get(value, key, value);
	} catch {
		return undefined;
	}
}

function finite(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function safeText(value: unknown): string {
	if (typeof value === "string") {
		return value;
	}
	if (value instanceof Error && value.message) {
		return value.message;
	}
	return String(value);
}

function isElement(value: unknown): value is HTMLElement {
	return isObject(value)
		&& readRuntime(value, "nodeType") === 1
		&& typeof readRuntime(value, "appendChild") === "function"
		&& typeof readRuntime(value, "removeChild") === "function";
}

function ownerDocument(value: unknown): Document | undefined {
	const document = readRuntime(value, "ownerDocument");
	if (document !== undefined && typeof readRuntime(document, "createElement") === "function") {
		return document as Document;
	}
	if (typeof globalThis.document !== "undefined") {
		return globalThis.document;
	}
	return undefined;
}

function clientSize(root: HTMLElement | undefined): { readonly width: number; readonly height: number } {
	const width = finite(readRuntime(root, "clientWidth")) ?? finite(readRuntime(root, "offsetWidth")) ?? 800;
	const height = finite(readRuntime(root, "clientHeight")) ?? finite(readRuntime(root, "offsetHeight")) ?? 600;
	return { width: Math.max(1, width), height: Math.max(1, height) };
}

/**
 * The element the source renderer rotates.  Native Canvas owns the shell's own
 * transform and rewrites it while panning, so the inner container is the only
 * safe place to compose a rotation.
 */
function rotationTarget(value: unknown): HTMLElement | undefined {
	for (const key of ["containerEl", "nodeEl", "contentEl", "el"] as const) {
		const candidate = readRuntime(value, key);
		if (isElement(candidate)) {
			return candidate;
		}
	}
	return undefined;
}

/** A host that cannot measure yields no placement, and the toolbar stays hidden. */
function boundingRect(value: unknown): { readonly left: number; readonly top: number; readonly right: number; readonly bottom: number } | undefined {
	const measure = readRuntime(value, "getBoundingClientRect");
	if (typeof measure !== "function") {
		return undefined;
	}
	try {
		const rect = Reflect.apply(measure, value, []);
		const left = finite(readRuntime(rect, "left"));
		const top = finite(readRuntime(rect, "top"));
		const right = finite(readRuntime(rect, "right"));
		const bottom = finite(readRuntime(rect, "bottom"));
		return left === undefined || top === undefined || right === undefined || bottom === undefined
			? undefined
			: { left, top, right, bottom };
	} catch {
		return undefined;
	}
}

function sceneFromDocument(document: unknown): CanvasScene | undefined {
	if (!isRecord(document)) {
		return undefined;
	}
	const nodes = readOwn(document, "nodes");
	const edges = readOwn(document, "edges");
	if (!Array.isArray(nodes) && !Array.isArray(edges)) {
		return undefined;
	}
	return {
		nodes: Array.isArray(nodes) ? nodes : [],
		edges: Array.isArray(edges) ? edges : [],
	};
}

function allIds(values: readonly unknown[]): readonly string[] {
	const result: string[] = [];
	const seen = new Set<string>();
	for (const value of values) {
		if (typeof value === "string") {
			if (value.length > 0 && !seen.has(value)) {
				seen.add(value);
				result.push(value);
			}
			continue;
		}
		const id = readCanvasElementId(value);
		if (id !== undefined && !seen.has(id)) {
			seen.add(id);
			result.push(id);
		}
	}
	return result;
}

function eventTarget(event: Event): unknown {
	return readRuntime(event, "target");
}

interface AttributeSnapshot {
	readonly present: boolean;
	readonly value: string | null;
}

interface AppearanceDomSnapshot {
	readonly styles: Map<string, StylePropertySnapshot>;
	readonly appearance: AttributeSnapshot;
	readonly verticalAlign: AttributeSnapshot;
}

interface ThemeRootSnapshot extends AppearanceDomSnapshot {
	readonly className: AttributeSnapshot;
	readonly theme: AttributeSnapshot;
	readonly resolvedTheme: AttributeSnapshot;
}

interface StylePropertySnapshot {
	readonly value: string;
	readonly priority: string;
	applied?: string;
}

const APPEARANCE_STYLE_PROPERTIES = [
	"font-family",
	"font-size",
	"font-weight",
	"font-style",
	"text-decoration",
	"text-align",
	"line-height",
	"--miro-canvas-vertical-align",
	"justify-content",
	"color",
	"background-color",
	"border-color",
	"stroke",
] as const;
const THEME_STYLE_PROPERTIES = ["color-scheme", "background-color", "color"] as const;

function readAttribute(element: HTMLElement, name: string): AttributeSnapshot {
	try {
		const hasAttribute = readRuntime(element, "hasAttribute");
		const getAttribute = readRuntime(element, "getAttribute");
		if (typeof hasAttribute === "function" && typeof getAttribute === "function") {
			return {
				present: Reflect.apply(hasAttribute, element, [name]) === true,
				value: Reflect.apply(getAttribute, element, [name]) as string | null,
			};
		}
	} catch {
		// A closed/revoked host node is treated as an absent attribute.
	}
	return { present: false, value: null };
}

function writeAttribute(element: HTMLElement, name: string, value: unknown): void {
	try {
		const setAttribute = readRuntime(element, "setAttribute");
		if (typeof setAttribute === "function") {
			Reflect.apply(setAttribute, element, [name, String(value)]);
		}
	} catch {
		// Host nodes may disappear while a Canvas pane is closing.
	}
}

function restoreAttribute(element: HTMLElement, name: string, snapshot: AttributeSnapshot): void {
	try {
		const method = readRuntime(element, snapshot.present ? "setAttribute" : "removeAttribute");
		if (typeof method === "function") {
			Reflect.apply(method, element, snapshot.present ? [name, snapshot.value ?? ""] : [name]);
		}
	} catch {
		// Host nodes may disappear while a Canvas pane is closing.
	}
}

function readStyleProperty(element: HTMLElement, property: string): StylePropertySnapshot {
	const style = readRuntime(element, "style");
	if (!isObject(style)) {
		return { value: "", priority: "" };
	}
	try {
		const getPropertyValue = readRuntime(style, "getPropertyValue");
		const getPropertyPriority = readRuntime(style, "getPropertyPriority");
		if (typeof getPropertyValue === "function") {
			return {
				value: String(Reflect.apply(getPropertyValue, style, [property]) ?? ""),
				priority: typeof getPropertyPriority === "function"
					? String(Reflect.apply(getPropertyPriority, style, [property]) ?? "")
					: "",
			};
		}
		const fallback = Reflect.get(style, property, style);
		return { value: typeof fallback === "string" ? fallback : "", priority: "" };
	} catch {
		return { value: "", priority: "" };
	}
}

function writeStyleProperty(element: HTMLElement, property: string, value: string): void {
	const style = readRuntime(element, "style");
	if (!isObject(style)) {
		return;
	}
	try {
		const setProperty = readRuntime(style, "setProperty");
		if (typeof setProperty === "function") {
			Reflect.apply(setProperty, style, [property, value]);
			return;
		}
		Reflect.set(style, property, value, style);
	} catch {
		// A style object can be read-only on a host-provided test/runtime node.
	}
}

function restoreStyleProperties(element: HTMLElement, styles: Map<string, StylePropertySnapshot>): void {
	const style = readRuntime(element, "style");
	if (!isObject(style)) {
		return;
	}
	for (const [property, snapshot] of styles) {
		if (snapshot.applied === undefined || readStyleProperty(element, property).value !== snapshot.applied) {
			continue;
		}
		try {
			if (snapshot.value.length === 0) {
				const removeProperty = readRuntime(style, "removeProperty");
				if (typeof removeProperty === "function") {
					Reflect.apply(removeProperty, style, [property]);
				}
			} else {
				const setProperty = readRuntime(style, "setProperty");
				if (typeof setProperty === "function") {
					Reflect.apply(setProperty, style, [property, snapshot.value, snapshot.priority]);
				} else {
					Reflect.set(style, property, snapshot.value, style);
				}
			}
		} catch {
			// Host styles can become read-only while a Canvas pane closes.
		}
	}
}

function verticalJustification(value: unknown): { readonly css: string; readonly vertical: string } {
	if (value === "center" || value === "middle") {
		return { css: "center", vertical: "middle" };
	}
	if (value === "bottom") {
		return { css: "flex-end", vertical: "bottom" };
	}
	return { css: "flex-start", vertical: "top" };
}

function safeSignature(value: unknown): string {
	try {
		return JSON.stringify(value) ?? "";
	} catch {
		return "<unserializable>";
	}
}

function keyIsPrintable(key: string): boolean {
	return key.length === 1 && key >= " " && key !== "\u007f";
}

/** A single active Canvas runtime and its user-facing M1 controls. */
export class M1CanvasSession {
	public readonly kind = "miro-canvas-m1-session" as const;
	public readonly view: unknown;
	public readonly adapter: CanvasAdapter;
	public readonly viewport: ViewportController;
	public readonly controls: M1Controls;
	public readonly toolbar: SelectionToolbar;
	public readonly handles: SelectionHandles;

	private writer: MetadataWriter | null;
	private readonly options: M1SessionOptions;
	private readonly settings: MiroCanvasSettings;
	private readonly disposers: Array<() => void> = [];
	private readonly sourceRenderer: SourceRenderer | undefined;
	private readonly readonlyOriginal: boolean | undefined;
	private readonly lockedDom = new Map<HTMLElement, { readonly classPresent: boolean; readonly attrPresent: boolean; readonly attrValue: string | null }>();
	private readonly appearanceDom = new Map<HTMLElement, AppearanceDomSnapshot>();
	private readonly attachmentLabels: HTMLElement[] = [];
	private readonly hiddenNativeAttachmentLabels = new Map<HTMLElement, {
		readonly styles: Map<string, StylePropertySnapshot>;
		readonly hidden: AttributeSnapshot;
	}>();
	private readonly domIdentity = new WeakMap<object, number>();
	private themeRootSnapshot: ThemeRootSnapshot | undefined;
	private root: HTMLElement | undefined;
	private mounted = false;
	private disposed = false;
	private nativeReadonlyState: boolean | undefined;
	private nativeReadonlyWarningShown = false;
	private currentMetadata: MiroCanvasMetadata | undefined;
	private currentRawDocument: unknown;
	private appearance: AppearanceState = normalizeAppearanceState(undefined);
	private policy: InteractionPolicy = createInteractionPolicy(undefined);
	private selectedIds: readonly string[] = [];
	private scene: CanvasScene = { nodes: [], edges: [] };
	private minimap: MinimapModel | undefined;
	private transientDiagnostics: string[] = [];
	private lastSnapshot: M1SessionSnapshot = {
		status: "unavailable",
		selectedIds: [],
		reviewMode: false,
		minimapVisible: true,
		diagnostics: [],
	};
	private authoring: CanvasAuthoring | undefined;
	private interactionBlock: string | undefined;
	private rotationPreview: {
		readonly element: HTMLElement;
		readonly base: string;
		readonly committed: number;
	} | undefined;
	private lastToolbarSignature = "";
	private minimapDragStart: MinimapPoint | undefined;
	private minimapDragViewport: ViewportTransform | undefined;
	private refreshTimer: ReturnType<typeof setInterval> | undefined;
	private spacePanHeld = false;
	private pointerEditIds: readonly string[] | undefined;
	private nativeHistoryDepth = 0;
	private readonly guardedMethods = new WeakMap<object, Set<string>>();
	private nextDomIdentity = 1;
	private lastSceneSignature = "";
	private lastAppearanceSignature = "";
	private lastPolicySignature = "";
	private lastMinimapSignature = "";
	private lastDrawSignature = "";
	private lastControlSignature = "";

	public constructor(view: unknown, writer: MetadataWriter | null = null, options: M1SessionOptions = {}) {
		this.view = view;
		this.adapter = createCanvasAdapter(view);
		this.writer = writer;
		this.options = options;
		this.readonlyOriginal = this.readNativeReadonly();
		this.nativeReadonlyState = this.readonlyOriginal;
		const rootCandidate = this.adapter.getRootElement();
		this.root = isElement(rootCandidate)
			? rootCandidate
			: isElement(options.panelHost)
				? options.panelHost
				: undefined;
		const renderDocument = options.document ?? ownerDocument(this.root);
		this.sourceRenderer = renderDocument === undefined ? undefined : new SourceRenderer({
			getDocument: () => this.adapter.getDocument(),
			getNodes: () => this.adapter.getNodes(),
			getEdges: () => this.adapter.getEdges(),
		}, renderDocument);
		const settings = options.settings ?? DEFAULT_SETTINGS;
		this.settings = settings;
		this.viewport = new ViewportController(this.adapter, {
			// A user preference narrows the safe range; it never widens it.
			minZoom: Math.max(DEFAULT_MIN_ZOOM, settings.minZoom),
			maxZoom: Math.min(DEFAULT_MAX_ZOOM, settings.maxZoom),
			zoomStep: settings.zoomStep,
			getViewportSize: () => clientSize(this.root),
		});
		const actions: M1ControlsActions = {
			onAppearance: (action) => this.applyAppearance(action),
			onInteraction: (action) => this.applyInteraction(action),
			onAttachment: (action) => this.applyAttachment(action),
			onNavigation: (action) => this.applyNavigation(action),
			openCommandModal: () => this.openCommandModal(),
		};
		const controlDocument = options.document ?? ownerDocument(this.root);
		this.controls = new M1Controls(actions, { document: controlDocument });
		this.toolbar = new SelectionToolbar({
			onAppearance: (action) => this.applyAppearance(action),
			onStyle: (patch) => this.applyElementStyle(patch),
			onLock: (locked) => (locked ? this.lockSelection() : this.unlockSelection()),
		}, { document: controlDocument });
		this.handles = new SelectionHandles({
			onRotate: (degrees, commit) => this.applyHandleRotation(degrees, commit),
			onConnect: (side, point) => this.applyHandleConnection(side, point),
			onCreateConnected: (side) => this.createConnectedNode(side),
		}, { document: controlDocument });
	}

	/**
	 * Shape, border and connector settings are the one appearance family the
	 * metadata writer cannot express, so they go through the guarded authoring
	 * transaction instead.  Every selected element is patched separately; the
	 * first rejection stops the batch so a partial style is never committed.
	 */
	/**
	 * A drag previews by rotating the decoration in place; only the release
	 * writes, so a gesture produces one native history entry instead of dozens.
	 */
	private applyHandleRotation(degrees: number, commit: boolean): void {
		const id = this.selectedIds[0];
		if (id === undefined) {
			return;
		}
		if (!commit) {
			this.previewRotation(id, degrees);
			return;
		}
		this.rotationPreview = undefined;
		this.readInteractionState();
		if (!this.editAllowed("restyle", [id])) {
			this.refresh();
			return;
		}
		this.authoring ??= createCanvasAuthoring(this.view);
		const result = this.authoring.updateRotation({ id, rotation: degrees });
		if (!result.ok) {
			this.addDiagnostic(result.diagnostics.find((item) => item.level === "error")?.message
				?? `Canvas rejected the rotation for ${id}.`);
		}
		this.refresh();
	}

	/**
	 * Preview by composing a delta onto the element the renderer already
	 * rotates, never by replacing a transform.  The node shell carries the
	 * translation native Canvas uses to place it, so overwriting that would
	 * move the node instead of turning it, and turning it about the wrong
	 * point.  Rotations about the same origin add, so the base captured at the
	 * start of the gesture plus the delta is the previewed angle.
	 */
	private previewRotation(id: string, degrees: number): void {
		const element = [...(this.adapter.getNodes() ?? [])].find((item) => readCanvasElementId(item) === id);
		const dom = rotationTarget(element);
		if (dom === undefined) {
			return;
		}
		if (this.rotationPreview?.element !== dom) {
			this.captureAppearanceDom(dom);
			const base = readRuntime(readRuntime(dom, "style"), "transform");
			this.rotationPreview = {
				element: dom,
				base: typeof base === "string" && base.trim() !== "none" ? base.trim() : "",
				committed: this.rotationFor(id),
			};
		}
		const preview = this.rotationPreview;
		const delta = degrees - preview.committed;
		this.setAppearanceStyle(dom, "transform-origin", "50% 50%");
		this.setAppearanceStyle(dom, "transform", `${preview.base} rotate(${delta}deg)`.trim());
	}

	/** A connection released over another node becomes a native edge. */
	private applyHandleConnection(side: HandleSide, point: { readonly x: number; readonly y: number }): void {
		const fromNode = this.selectedIds[0];
		const toNode = this.nodeAtPoint(point, fromNode);
		if (fromNode === undefined || toNode === undefined) {
			this.addDiagnostic("Release a connection over another Canvas node to connect it.");
			return;
		}
		this.createEdge(fromNode, toNode, side);
	}

	private createEdge(fromNode: string, toNode: string, side: HandleSide): void {
		this.readInteractionState();
		this.authoring ??= createCanvasAuthoring(this.view);
		const opposite: Readonly<Record<HandleSide, HandleSide>> = {
			top: "bottom", bottom: "top", left: "right", right: "left",
		};
		const result = this.authoring.createConnector({
			fromNode, toNode, fromSide: side as ConnectorSide, toSide: opposite[side] as ConnectorSide,
		});
		if (!result.ok) {
			this.addDiagnostic(result.diagnostics.find((item) => item.level === "error")?.message
				?? "Canvas rejected the new connector.");
		}
		this.refresh();
	}

	private nodeAtPoint(point: { readonly x: number; readonly y: number }, exclude: string | undefined): string | undefined {
		for (const element of this.adapter.getNodes() ?? []) {
			const id = readCanvasElementId(element);
			if (id === undefined || id === exclude) {
				continue;
			}
			const rect = boundingRect(readCanvasElementDom(element));
			if (rect === undefined) {
				continue;
			}
			if (point.x >= rect.left && point.x <= rect.right && point.y >= rect.top && point.y <= rect.bottom) {
				return id;
			}
		}
		return undefined;
	}

	/** Place a node beside the selection and connect it, in that order. */
	private createConnectedNode(side: HandleSide): void {
		const fromNode = this.selectedIds[0];
		if (fromNode === undefined) {
			return;
		}
		const nodes = readRuntime(this.currentRawDocument, "nodes");
		const source = Array.isArray(nodes)
			? (nodes as readonly unknown[]).find((item) => readRuntime(item, "id") === fromNode)
			: undefined;
		const x = finite(readRuntime(source, "x"));
		const y = finite(readRuntime(source, "y"));
		const width = finite(readRuntime(source, "width"));
		const height = finite(readRuntime(source, "height"));
		if (x === undefined || y === undefined || width === undefined || height === undefined) {
			this.addDiagnostic("The selected node has no usable geometry; a connected node was not created.");
			return;
		}
		const gap = 80;
		const offset: Readonly<Record<HandleSide, { readonly x: number; readonly y: number }>> = {
			right: { x: x + width + gap, y },
			left: { x: x - width - gap, y },
			top: { x, y: y - height - gap },
			bottom: { x, y: y + height + gap },
		};
		this.readInteractionState();
		this.authoring ??= createCanvasAuthoring(this.view);
		const created = this.authoring.createShape({
			shape: "rectangle", text: "", width, height, ...offset[side],
		});
		if (!created.ok || created.nodeId === undefined) {
			this.addDiagnostic(created.diagnostics.find((item) => item.level === "error")?.message
				?? "Canvas rejected the connected node.");
			this.refresh();
			return;
		}
		this.createEdge(fromNode, created.nodeId, side);
	}

	private applyElementStyle(patch: SelectionStylePatch): void {
		if (this.selectedIds.length === 0) {
			this.addDiagnostic("Select a Canvas element before changing its shape, border or connector settings.");
			return;
		}
		this.readInteractionState();
		if (!this.editAllowed("restyle", this.selectedIds)) {
			return;
		}
		this.authoring ??= createCanvasAuthoring(this.view);
		for (const id of this.selectedIds) {
			const result = this.authoring.updateElementStyle({ id, ...patch });
			if (result.ok) {
				continue;
			}
			const reason = result.diagnostics.find((diagnostic) => diagnostic.level === "error")?.message;
			this.addDiagnostic(reason ?? `Canvas rejected the style change for ${id}.`);
			break;
		}
		this.refresh();
	}

	public get status(): M1SessionStatus {
		return this.lastSnapshot.status;
	}

	public get diagnostics(): readonly string[] {
		return this.lastSnapshot.diagnostics;
	}

	public get snapshot(): M1SessionSnapshot {
		return this.lastSnapshot;
	}

	/**
	 * Attach a writer after the native Canvas has finished initializing.
	 * Construction and mount remain read-only; the host may safely retry its
	 * persistence probe without recreating the scoped DOM session.
	 */
	public setWriter(writer: MetadataWriter | null): void {
		if (this.disposed) {
			return;
		}
		this.writer = writer;
		this.refresh();
	}

	/** Public command-palette entry points; each remains an explicit action. */
	public openCommands(): void {
		this.openCommandModal();
	}

	public setTheme(theme: "system" | "light" | "dark"): void {
		this.applyAppearance({ type: APPEARANCE_ACTIONS.setDisplayTheme, displayTheme: theme });
	}

	public toggleReviewMode(): void {
		this.applyInteraction({ type: "toggle-review-mode" });
	}

	public lockSelection(): void {
		this.readInteractionState();
		this.applyInteraction({ type: "set-locks", elementIds: this.selectedIds, locked: true });
	}

	public unlockSelection(): void {
		this.readInteractionState();
		this.applyInteraction({ type: "set-locks", elementIds: this.selectedIds, locked: false });
	}

	public toggleAttachmentNames(): void {
		this.applyAttachment({ type: "set-global", visible: this.appearance.settings.showAttachmentNames === false });
	}

	public navigate(action: M1NavigationAction): void {
		this.applyNavigation(action);
	}

	/** Mount once; all reads here are observational and do not write metadata. */
	/** Keyboard panning honors the configured step and the Shift multiplier. */
	public pan(direction: PanDirection, fast = false): void {
		const delta = panDelta(this.settings, direction, fast);
		this.viewport.panBy(delta.x, delta.y, "board");
		this.refresh();
	}

	public mount(): boolean {
		if (this.mounted || this.disposed) {
			return this.mounted;
		}
		this.mounted = true;
		if (this.root === undefined || !isElement(this.controls.element)) {
			this.addDiagnostic("Native Canvas root is unavailable; M1 controls are disabled.");
			this.refresh();
			return false;
		}
		try {
			this.root.appendChild(this.controls.element);
			this.root.appendChild(this.controls.minimapElement);
			if (isElement(this.toolbar.element)) {
				this.root.appendChild(this.toolbar.element);
			}
			if (isElement(this.handles.element)) {
				this.root.appendChild(this.handles.element);
			}
		} catch {
			this.handles.dispose();
			this.toolbar.dispose();
			this.controls.minimapElement.remove();
			this.controls.element.remove();
			this.addDiagnostic("Native Canvas root rejected the M1 controls panel; controls are disabled.");
			this.refresh();
			return false;
		}
		this.attachGuards();
		this.attachMinimapHandlers();
		this.attachResizeObserver();
		this.attachSystemThemeListener();
		this.attachRefreshPolling();
		this.refresh();
		return true;
	}

	private identityFor(value: unknown): number {
		if (!isObject(value)) {
			return 0;
		}
		const existing = this.domIdentity.get(value);
		if (existing !== undefined) {
			return existing;
		}
		const identity = this.nextDomIdentity;
		this.nextDomIdentity += 1;
		this.domIdentity.set(value, identity);
		return identity;
	}

	private sceneSignature(scene: CanvasScene): string {
		const describe = (item: unknown): readonly unknown[] => {
			const dom = readCanvasElementDom(item);
			return [
				readCanvasElementId(item),
				readCanvasElementType(item),
				...(dom === undefined ? [] : [`dom:${this.identityFor(dom)}`]),
				...[
					"x", "y", "width", "height", "fromNode", "toNode", "from", "to", "start", "end",
				].map((key) => readOwn(item, key)),
			];
		};
		return safeSignature({
			nodes: scene.nodes.map(describe),
			edges: scene.edges.map(describe),
		});
	}

	private viewportSignature(viewport: ViewportTransform | undefined, size: { readonly width: number; readonly height: number }): string {
		return safeSignature({ viewport, size, coordinateMode: this.viewport.coordinateMode });
	}

	/** Read the current document and repaint only the plugin-owned decoration. */
	public refresh(): void {
		if (this.disposed) {
			return;
		}
		const diagnostics: string[] = [];
		for (const diagnostic of this.adapter.diagnostics) {
			diagnostics.push(diagnostic.message);
		}
		for (const diagnostic of this.viewport.diagnostics) {
			diagnostics.push(diagnostic.message);
		}
		this.currentRawDocument = this.adapter.getDocument();
		const parsed = parseMiroCanvasMetadata(this.currentRawDocument);
		if (parsed.status === "valid" && parsed.metadata !== undefined) {
			this.currentMetadata = parsed.metadata;
			this.appearance = normalizeAppearanceState(parsed.metadata);
		} else {
			this.currentMetadata = undefined;
			this.appearance = normalizeAppearanceState(undefined);
			if (parsed.status !== "absent") {
				for (const diagnostic of parsed.diagnostics) {
					diagnostics.push(`${diagnostic.path}: ${diagnostic.message}`);
				}
			}
		}
		if (this.writer === null) {
			diagnostics.push("Metadata persistence is unavailable; explicit appearance and safety writes are disabled. Run \"Miro Canvas: Show plugin status\" to see which runtime member is missing.");
		}
		const selection = this.adapter.getSelection();
		this.selectedIds = selection === undefined ? [] : allIds(selection);
		this.scene = this.adapter.getScene() ?? sceneFromDocument(this.currentRawDocument) ?? { nodes: [], edges: [] };
		this.policy = this.policyFromDocument(this.currentRawDocument);
		this.attachNativeGuards();
		const sceneSignature = this.sceneSignature(this.scene);
		const appearanceSignature = safeSignature(this.appearance);
		const policySignature = safeSignature({
			reviewMode: this.policy.reviewMode,
			lockedElementIds: this.policy.lockedElementIds,
		});
		const decorationsChanged = sceneSignature !== this.lastSceneSignature
			|| appearanceSignature !== this.lastAppearanceSignature
			|| policySignature !== this.lastPolicySignature;
		this.lastSceneSignature = sceneSignature;
		this.lastAppearanceSignature = appearanceSignature;
		this.lastPolicySignature = policySignature;
		const size = clientSize(this.root);
		const viewport = this.viewport.getViewport();
		const minimapSignature = `${sceneSignature}|${this.viewportSignature(viewport, size)}`;
		const minimapChanged = minimapSignature !== this.lastMinimapSignature;
		if (this.minimap === undefined || minimapChanged) {
			this.minimap = new MinimapModel(this.scene, {
				width: 240,
				height: 160,
				padding: 8,
				viewport,
				viewportSize: size,
				coordinateMode: this.viewport.coordinateMode,
			});
			this.lastMinimapSignature = minimapSignature;
		}
		if (!this.adapter.supports(CANVAS_CAPABILITIES.scene)) {
			diagnostics.push("Canvas scene data is unavailable; minimap content is disabled.");
		}
		if (!this.adapter.supports(CANVAS_CAPABILITIES.viewport)
			|| !this.adapter.supports(CANVAS_CAPABILITIES.viewportMutation)) {
			diagnostics.push("Canvas viewport mutation is unavailable; zoom and minimap navigation are disabled.");
		}
		for (const diagnostic of this.minimap.diagnostics) {
			diagnostics.push(diagnostic.message);
		}
		for (const edge of this.scene.edges) {
			const id = readCanvasElementId(edge);
			if (id !== undefined && this.appearance.localOverrides[id]?.colors !== undefined
				&& readCanvasElementDom(edge) === undefined) {
				diagnostics.push(`Edge ${id} appearance is persisted, but this Canvas runtime exposes no safe edge DOM target.`);
			}
		}
		for (const diagnostic of this.transientDiagnostics) {
			diagnostics.push(diagnostic);
		}
		this.syncNativeReadonly(this.appearance.settings.reviewMode === true, diagnostics);
		this.applyTheme(this.appearance.settings.displayTheme);
		if (decorationsChanged) {
			this.refreshDecorations();
		}
		for (const diagnostic of this.sourceRenderer?.refresh() ?? []) {
			diagnostics.push(diagnostic);
		}
		const minimapVisible = this.appearance.settings.minimapVisible !== false;
		const drawSignature = `${this.lastMinimapSignature}|${minimapVisible ? "visible" : "hidden"}`;
		if (drawSignature !== this.lastDrawSignature || minimapChanged) {
			this.drawMinimap();
			this.lastDrawSignature = drawSignature;
		}
		const lockedSelection = this.selectedIds.length > 0
			&& decideEditOperation(this.policy, "move", this.selectedIds).reason === "element-locked";
		const selectedAttachmentNames = this.selectedAttachmentVisibility();
		const state: M1ControlsState = {
			appearance: this.appearance,
			selectedIds: this.selectedIds,
			reviewMode: this.appearance.settings.reviewMode === true,
			lockedSelection,
			showAttachmentNames: this.appearance.settings.showAttachmentNames !== false,
			...(selectedAttachmentNames === undefined ? {} : { selectedAttachmentNames }),
			minimapVisible: this.appearance.settings.minimapVisible !== false,
			diagnostics: [...new Set(diagnostics)],
		};
		this.lastSnapshot = {
			status: this.adapter.status,
			selectedIds: [...this.selectedIds],
			reviewMode: state.reviewMode,
			minimapVisible: state.minimapVisible,
			diagnostics: state.diagnostics,
			...(viewport === undefined ? {} : { viewport }),
			...(this.minimap.contentBounds === undefined ? {} : { contentBounds: this.minimap.contentBounds }),
		};
		const controlSignature = safeSignature({
			appearance: state.appearance,
			selectedIds: state.selectedIds,
			reviewMode: state.reviewMode,
			lockedSelection: state.lockedSelection,
			showAttachmentNames: state.showAttachmentNames,
			selectedAttachmentNames: state.selectedAttachmentNames,
			minimapVisible: state.minimapVisible,
			diagnostics: state.diagnostics,
		});
		if (controlSignature !== this.lastControlSignature) {
			this.lastControlSignature = controlSignature;
			this.controls.update(state);
			this.options.onStateChange?.(state);
		}
		// The toolbar follows the selection on screen, so it also refreshes on a
		// pan or zoom that leaves the control signature unchanged.
		const toolbarState = this.toolbarState(state, lockedSelection);
		const toolbarSignature = safeSignature(toolbarState);
		if (toolbarSignature !== this.lastToolbarSignature) {
			this.lastToolbarSignature = toolbarSignature;
			this.toolbar.update(toolbarState);
		}
		this.handles.update(this.handlesState(toolbarState.editable));
	}

	private handlesState(editable: boolean): SelectionHandlesState {
		const id = this.selectedIds[0];
		const edgeIds = new Set(collectCanvasElementIds(this.adapter.getEdges() ?? []));
		return {
			selectedIds: this.selectedIds,
			rotation: id === undefined ? 0 : this.rotationFor(id),
			editable,
			isEdge: id !== undefined && edgeIds.has(id),
			...(id === undefined ? {} : { rect: this.handleRect(id) }),
		};
	}

	private rotationFor(id: string): number {
		const override = readRuntime(readRuntime(readRuntime(this.currentRawDocument, "miroCanvas"), "localOverrides"), id);
		const rotation = finite(readRuntime(override, "rotation"));
		return rotation ?? 0;
	}

	/**
	 * The DOM box of a rotated node is its axis-aligned bounds, so only its
	 * center is usable.  The unrotated size comes from the document and the
	 * current zoom, which keeps the frame square to the node at any angle.
	 */
	private handleRect(id: string): HandleRect | undefined {
		if (this.root === undefined) {
			return undefined;
		}
		const rootRect = boundingRect(this.root);
		const element = [...(this.adapter.getNodes() ?? [])].find((item) => readCanvasElementId(item) === id);
		const rect = boundingRect(readCanvasElementDom(element));
		if (rootRect === undefined || rect === undefined) {
			return undefined;
		}
		const nodes = readRuntime(this.currentRawDocument, "nodes");
		const node = Array.isArray(nodes)
			? (nodes as readonly unknown[]).find((item) => readRuntime(item, "id") === id)
			: undefined;
		const zoom = finite(readRuntime(this.viewport.getViewport(), "zoom")) ?? 1;
		const width = (finite(readRuntime(node, "width")) ?? (rect.right - rect.left) / zoom) * zoom;
		const height = (finite(readRuntime(node, "height")) ?? (rect.bottom - rect.top) / zoom) * zoom;
		if (!(width > 0) || !(height > 0)) {
			return undefined;
		}
		return {
			left: (rect.left + rect.right) / 2 - width / 2 - rootRect.left,
			top: (rect.top + rect.bottom) / 2 - height / 2 - rootRect.top,
			width,
			height,
		};
	}

	private toolbarState(state: M1ControlsState, lockedSelection: boolean): SelectionToolbarState {
		const id = this.selectedIds[0];
		const override = id === undefined ? undefined : this.appearance.localOverrides[id];
		const style = this.styleOverrideFor(id);
		const placement = this.selectionPlacement();
		return {
			selectedIds: this.selectedIds,
			kinds: this.selectionKinds(),
			editable: !state.reviewMode && !lockedSelection,
			locked: lockedSelection,
			reviewMode: state.reviewMode,
			...(state.reviewMode
				? { blockedReason: "Review mode is on; formatting is disabled." }
				: lockedSelection
					? { blockedReason: "This selection is locked. Unlock it to change formatting." }
					: {}),
			typography: override?.typography ?? {
				fontFamily: DEFAULT_TOOLBAR_FONT,
				fontSize: DEFAULT_TOOLBAR_FONT_SIZE,
				format: { bold: false, italic: false, underline: false, strike: false },
				alignment: "left",
			},
			colors: override?.colors ?? {},
			palette: this.appearance.settings.palette,
			recentColors: this.appearance.settings.recentColors,
			...style,
			...(placement === undefined ? {} : { placement }),
		};
	}

	private selectionKinds(): readonly SelectionKind[] {
		const edgeIds = new Set(collectCanvasElementIds(this.adapter.getEdges() ?? []));
		const kinds = new Set<SelectionKind>();
		for (const id of this.selectedIds) {
			kinds.add(edgeIds.has(id) ? "edge" : "shape");
		}
		return [...kinds];
	}

	/** Style fields live beside appearance in the same local override record. */
	private styleOverrideFor(id: string | undefined): SelectionToolbarStyle {
		if (id === undefined) {
			return {};
		}
		const metadata = readRuntime(this.currentRawDocument, "miroCanvas");
		const override = readRuntime(readRuntime(metadata, "localOverrides"), id);
		if (!isObject(override)) {
			return {};
		}
		const shapeValue = readRuntime(readRuntime(override, "shape"), "kind") ?? readRuntime(override, "shape");
		const shape = typeof shapeValue === "string" && (CANVAS_SHAPE_KINDS as readonly string[]).includes(shapeValue)
			? shapeValue as SelectionToolbarStyle["shape"]
			: undefined;
		const borderStyle = readRuntime(override, "borderStyle");
		const borderWidth = readRuntime(override, "borderWidth");
		const connector = readRuntime(override, "connector");
		return {
			...(shape === undefined ? {} : { shape }),
			...(borderStyle === "solid" || borderStyle === "dashed" || borderStyle === "dotted" || borderStyle === "none"
				? { borderStyle }
				: {}),
			...(typeof borderWidth === "number" && Number.isFinite(borderWidth) ? { borderWidth } : {}),
			...(isObject(connector) ? { connector: connector as SelectionToolbarStyle["connector"] } : {}),
		};
	}

	/** Screen placement comes from native DOM, so it stays correct under any
	 * coordinate mode, rotation, or Advanced Canvas transform. */
	private selectionPlacement(): SelectionToolbarPlacement | undefined {
		if (this.root === undefined || this.selectedIds.length === 0) {
			return undefined;
		}
		const rootRect = boundingRect(this.root);
		if (rootRect === undefined) {
			return undefined;
		}
		let left = Number.POSITIVE_INFINITY;
		let top = Number.POSITIVE_INFINITY;
		let right = Number.NEGATIVE_INFINITY;
		for (const element of [...(this.adapter.getNodes() ?? []), ...(this.adapter.getEdges() ?? [])]) {
			const id = readCanvasElementId(element);
			if (id === undefined || !this.selectedIds.includes(id)) {
				continue;
			}
			const rect = boundingRect(readCanvasElementDom(element));
			if (rect === undefined) {
				continue;
			}
			left = Math.min(left, rect.left);
			top = Math.min(top, rect.top);
			right = Math.max(right, rect.right);
		}
		if (!Number.isFinite(left) || !Number.isFinite(top) || !Number.isFinite(right)) {
			return undefined;
		}
		return { x: (left + right) / 2 - rootRect.left, y: top - rootRect.top };
	}

	private addDiagnostic(message: string): void {
		if (!this.transientDiagnostics.includes(message)) {
			this.transientDiagnostics.push(message);
			if (this.transientDiagnostics.length > 20) {
				this.transientDiagnostics.shift();
			}
		}
	}

	private notice(message: string): void {
		this.options.onNotice?.(message);
	}

	private metadataActionName(action: string): string {
		return action.startsWith("miro-canvas.") ? action : `miro-canvas.${action}`;
	}

	private readNativeReadonly(): boolean | undefined {
		const value = this.adapter.read("readonly");
		return typeof value === "boolean" ? value : undefined;
	}

	/** Call the known native setter only through CanvasAdapter's safe boundary. */
	private setNativeReadonly(enabled: boolean): boolean {
		const setter = this.adapter.read("setReadonly");
		if (typeof setter !== "function") {
			return false;
		}
		this.adapter.invoke("setReadonly", enabled);
		const observed = this.readNativeReadonly();
		return observed === enabled;
	}

	private syncNativeReadonly(enabled: boolean, diagnostics: string[]): void {
		// A native readonly state that pre-dates this session belongs to the
		// host/user.  Review mode is an overlay: it may add readonly, but turning
		// review off must never unlock a board that was already readonly.
		const desired = enabled || this.readonlyOriginal === true;
		// With no observable readonly field, a disabled review overlay has no
		// state to synchronize.  Avoid invoking a setter during mount merely to
		// write the same unknown value.
		if (!enabled && this.readonlyOriginal === undefined) {
			return;
		}
		if (this.readonlyOriginal === undefined && this.adapter.read("setReadonly") === undefined) {
			if (desired && !this.nativeReadonlyWarningShown) {
				this.nativeReadonlyWarningShown = true;
				diagnostics.push("Native review-mode readonly guard is unavailable; scoped DOM guards remain active.");
			}
			return;
		}
		if (this.nativeReadonlyState === desired) {
			return;
		}
		if (this.setNativeReadonly(desired)) {
			this.nativeReadonlyState = desired;
			return;
		}
		if (!this.nativeReadonlyWarningShown) {
			this.nativeReadonlyWarningShown = true;
			diagnostics.push("Native readonly guard could not be applied; review mode is enforced only by scoped guards.");
		}
	}

	private temporarilyEnableMetadataWrites<T>(callback: () => T): T | undefined {
		if (this.writer === null) {
			this.addDiagnostic("Metadata persistence is unavailable for this Canvas runtime.");
			return undefined;
		}
		const wasReadonly = this.readNativeReadonly();
		let unlocked = false;
		if (wasReadonly === true) {
			// Never bypass a native readonly state that existed before this
			// session.  Only the review overlay that this session enabled may be
			// lifted for one guarded metadata transaction and then restored.
			if (this.readonlyOriginal === true || this.appearance.settings.reviewMode !== true) {
				this.addDiagnostic("Metadata write refused while native Canvas readonly is owned by the host.");
				return undefined;
			}
			if (!this.setNativeReadonly(false)) {
				this.addDiagnostic("Metadata write refused while native Canvas review mode is readonly.");
				return undefined;
			}
			unlocked = true;
		}
		try {
			return callback();
		} finally {
			if (unlocked) {
				// Restore exactly the state observed before the transaction.  This
				// preserves a pre-existing native readonly lock as well as a review
				// overlay, and never guesses a writable state.
				if (wasReadonly !== undefined && this.setNativeReadonly(wasReadonly)) {
					this.nativeReadonlyState = wasReadonly;
				} else {
					this.addDiagnostic("Native Canvas readonly state could not be restored after metadata write.");
				}
			}
		}
	}

	/**
	 * Execute one explicit local metadata transaction through the injected
	 * writer.  M2 document controls use this extension point for their own
	 * metadata fields; callers still receive the same readonly/history guards
	 * and the session refreshes from the committed document afterwards.
	 */
	public writeMetadata(action: string, mutate: (draft: Record<string, unknown>) => Record<string, unknown> | void): MetadataWriteResult | undefined {
		const result = this.temporarilyEnableMetadataWrites(() => this.writer!.write(this.metadataActionName(action), mutate));
		if (result === undefined) {
			this.refresh();
			return undefined;
		}
		if (result.status === "applied") {
			// An accepted-but-altered commit is reported in the panel rather than
			// as a notice, so host behavior stays visible without interrupting.
			for (const diagnostic of result.diagnostics) {
				this.addDiagnostic(diagnostic.message);
			}
			this.notice(`Miro Canvas: ${action} applied.`);
		} else if (result.status === "rejected") {
			const diagnostic = result.diagnostics[0]?.message ?? "The metadata transaction was rejected.";
			this.addDiagnostic(diagnostic);
			this.notice(`Miro Canvas: ${diagnostic}`);
		}
		this.refresh();
		return result;
	}

	private applyAppearance(action: AppearanceAction): void {
		this.readInteractionState();
		const type = typeof action.type === "string" ? action.type : "appearance";
		const isGlobal = type === APPEARANCE_ACTIONS.setDisplayTheme || type === "set-theme" || type === "set-display-theme";
		if (!isGlobal && this.selectedIds.length === 0) {
			this.addDiagnostic("Select at least one Canvas element before changing its appearance.");
			this.refresh();
			return;
		}
		if (!isGlobal) {
			const decision = decideEditOperation(this.policy, "restyle", this.selectedIds);
			if (!decision.allowed) {
				this.addDiagnostic(decision.reason === "review-mode"
					? "Review mode blocks appearance edits; pan, selection, copy, links, and comments remain available."
					: decision.reason === "element-locked"
						? "A locked Canvas element blocks appearance edits. Unlock it explicitly to continue."
						: `Appearance edit blocked because its capability could not be verified: ${this.interactionBlock ?? "the interaction policy refused the request"}.`);
				this.refresh();
				return;
			}
		}
		this.writeMetadata(type, (draft) => {
			const previous = normalizeAppearanceState(draft);
			let next = previous;
			if (isGlobal) {
				next = appearanceReducer(previous, action);
			} else {
				for (const nodeId of this.selectedIds) {
					next = appearanceReducer(next, { ...action, nodeId });
				}
			}
			return mergeAppearanceMetadata(draft, next, previous);
		});
	}

	private applyInteraction(action: Record<string, unknown>): void {
		this.readInteractionState();
		const type = typeof action.type === "string" ? action.type : "interaction";
		if ((type === "set-locks" || type === "lock" || type === "unlock")
			&& this.selectedIds.length === 0 && action.elementId === undefined && action.elementIds === undefined) {
			this.addDiagnostic("Select at least one Canvas element before changing its lock state.");
			this.refresh();
			return;
		}
		const result = this.writeMetadata(type, (draft) => {
			const effective = type === "set-locks" && action.elementIds === undefined
				? { ...action, elementIds: this.selectedIds }
				: action;
			const next = reduceInteractionMetadata(draft, effective);
			if (next === undefined) {
				throw new Error("The safety action was invalid or unsupported by the metadata schema.");
			}
			return next as Record<string, unknown>;
		});
		if (result?.status === "applied" && type.toLowerCase().includes("review")) {
			// writeMetadata refreshes from the committed document.  Derive the
			// overlay from that resulting metadata instead of the pre-transaction
			// state (which would invert toggle-review-mode).
			const enabled = this.appearance.settings.reviewMode === true;
			if (this.readonlyOriginal !== true && !this.setNativeReadonly(enabled)) {
				this.addDiagnostic("Review mode metadata was saved, but native readonly could not be synchronized.");
			}
			this.nativeReadonlyState = this.readNativeReadonly();
		}
	}

	private applyAttachment(action: Record<string, unknown>): void {
		const type = typeof action.type === "string" ? action.type : "attachment";
		if (type === "set-global") {
			const visible = action.visible;
			if (typeof visible !== "boolean") {
				this.addDiagnostic("Attachment visibility must be boolean.");
				this.refresh();
				return;
			}
			this.writeMetadata("attachment-global", (draft) => {
				const settings = isRecord(draft.settings) ? { ...draft.settings } : {};
				settings.showAttachmentNames = visible;
				draft.settings = settings;
			});
			return;
		}
		if (type !== "set-selection" || this.selectedIds.length === 0 || typeof action.visible !== "boolean") {
			this.addDiagnostic("Select one or more elements to set attachment-name visibility.");
			this.refresh();
			return;
		}
		const visible = action.visible;
		this.writeMetadata("attachment-selection", (draft) => {
			const overrides: Record<string, unknown> = isRecord(draft.localOverrides) ? { ...draft.localOverrides } : {};
			for (const id of this.selectedIds) {
				const override = isRecord(overrides[id]) ? { ...overrides[id] } : {};
				override.showAttachmentName = visible;
				overrides[id] = override;
			}
			draft.localOverrides = overrides;
		});
	}

	private applyNavigation(action: M1NavigationAction): void {
		if (action === "toggle-minimap") {
			this.writeMetadata("minimap-visibility", (draft) => {
				const settings = isRecord(draft.settings) ? { ...draft.settings } : {};
				settings.minimapVisible = this.appearance.settings.minimapVisible === false;
				draft.settings = settings;
			});
			return;
		}
		let applied = false;
		if (action === "zoom-in") {
			applied = this.viewport.zoomIn();
		} else if (action === "zoom-out") {
			applied = this.viewport.zoomOut();
		} else if (action === "zoom-reset") {
			applied = this.viewport.resetZoom();
		} else if (action === "zoom-fit") {
			applied = this.viewport.fitToBounds(this.minimap?.contentBounds, clientSize(this.root));
		}
		if (!applied) {
			this.addDiagnostic(`Navigation action "${action}" is unavailable in this Canvas runtime.`);
		}
		this.refresh();
	}

	private openCommandModal(): void {
		const commands: M1CommandItem[] = [
			{ id: "theme-system", label: "Use system board theme", run: () => this.applyAppearance({ type: APPEARANCE_ACTIONS.setDisplayTheme, displayTheme: "system" }) },
			{ id: "theme-light", label: "Use light board theme", run: () => this.applyAppearance({ type: APPEARANCE_ACTIONS.setDisplayTheme, displayTheme: "light" }) },
			{ id: "theme-dark", label: "Use dark board theme", run: () => this.applyAppearance({ type: APPEARANCE_ACTIONS.setDisplayTheme, displayTheme: "dark" }) },
			{ id: "review-toggle", label: "Toggle review mode", run: () => this.applyInteraction({ type: "toggle-review-mode" }) },
			{ id: "lock-selection", label: "Lock selection", run: () => this.applyInteraction({ type: "set-locks", elementIds: this.selectedIds, locked: true }) },
			{ id: "unlock-selection", label: "Unlock selection", run: () => this.applyInteraction({ type: "set-locks", elementIds: this.selectedIds, locked: false }) },
			{ id: "attachment-toggle", label: "Toggle attachment names", run: () => this.applyAttachment({ type: "set-global", visible: this.appearance.settings.showAttachmentNames === false }) },
			{ id: "zoom-in", label: "Zoom in", run: () => this.applyNavigation("zoom-in") },
			{ id: "zoom-out", label: "Zoom out", run: () => this.applyNavigation("zoom-out") },
			{ id: "zoom-reset", label: "Reset zoom", run: () => this.applyNavigation("zoom-reset") },
			{ id: "zoom-fit", label: "Fit board", run: () => this.applyNavigation("zoom-fit") },
			{ id: "minimap-toggle", label: "Toggle minimap", run: () => this.applyNavigation("toggle-minimap") },
		];
		this.controls.openCommandModal(commands);
	}

	private selectedAttachmentVisibility(): boolean | undefined {
		if (this.selectedIds.length === 0) {
			return undefined;
		}
		for (const node of this.scene.nodes) {
			const id = readCanvasElementId(node);
			if (id !== undefined && id === this.selectedIds[0]) {
				return shouldShowAttachmentName(node, this.currentMetadata);
			}
		}
		return undefined;
	}

	private captureAppearanceDom(element: HTMLElement): void {
		if (this.appearanceDom.has(element)) {
			return;
		}
		const styles = new Map<string, StylePropertySnapshot>();
		for (const property of APPEARANCE_STYLE_PROPERTIES) {
			styles.set(property, readStyleProperty(element, property));
		}
		this.appearanceDom.set(element, {
			styles,
			appearance: readAttribute(element, APPEARANCE_ATTRIBUTE),
			verticalAlign: readAttribute(element, VERTICAL_ALIGN_ATTRIBUTE),
		});
	}

	private restoreAppearanceDom(): void {
		for (const [element, snapshot] of this.appearanceDom) {
			restoreStyleProperties(element, snapshot.styles);
			restoreAttribute(element, APPEARANCE_ATTRIBUTE, snapshot.appearance);
			restoreAttribute(element, VERTICAL_ALIGN_ATTRIBUTE, snapshot.verticalAlign);
		}
		this.appearanceDom.clear();
	}

	private applyElementAppearance(
		element: HTMLElement,
		typography: TypographySettings | undefined,
		colors: ColorSettings | undefined,
		isEdge: boolean,
	): void {
		if (typography === undefined && colors === undefined) {
			return;
		}
		this.captureAppearanceDom(element);
		writeAttribute(element, APPEARANCE_ATTRIBUTE, "true");
		if (typography !== undefined) {
			this.setAppearanceStyle(element, "font-family", typography.fontFamily);
			this.setAppearanceStyle(element, "font-size", `${typography.fontSize}px`);
			this.setAppearanceStyle(element, "font-weight", typography.format.bold ? "700" : "400");
			this.setAppearanceStyle(element, "font-style", typography.format.italic ? "italic" : "normal");
			const decoration = [
				...(typography.format.underline ? ["underline"] : []),
				...(typography.format.strike ? ["line-through"] : []),
			].join(" ") || "none";
			this.setAppearanceStyle(element, "text-decoration", decoration);
			this.setAppearanceStyle(element, "text-align", typography.alignment);
			this.setAppearanceStyle(element, "line-height", String(typography.lineHeight ?? 1.2));
			const vertical = verticalJustification(typography.verticalAlign);
			writeAttribute(element, VERTICAL_ALIGN_ATTRIBUTE, vertical.vertical);
			this.setAppearanceStyle(element, "--miro-canvas-vertical-align", vertical.css);
			// Native node shells are flex containers on supported Obsidian
			// releases.  This is harmless on other elements and makes the
			// vertical control visible without replacing the native content.
			this.setAppearanceStyle(element, "justify-content", vertical.css);
		}
		if (colors !== undefined) {
			if (isEdge) {
				const edge = colorToCss(colors.edge);
				this.setAppearanceStyle(element, "stroke", edge);
				this.setAppearanceStyle(element, "color", edge);
				this.setAppearanceStyle(element, "border-color", edge);
			} else {
				this.setAppearanceStyle(element, "color", colorToCss(colors.text));
				this.setAppearanceStyle(element, "background-color", colorToCss(colors.fill));
				this.setAppearanceStyle(element, "border-color", colorToCss(colors.border));
			}
		}
	}

	private setAppearanceStyle(element: HTMLElement, property: string, value: string): void {
		const snapshot = this.appearanceDom.get(element);
		this.setTrackedStyle(element, property, value, snapshot?.styles);
	}

	private setTrackedStyle(
		element: HTMLElement,
		property: string,
		value: string,
		styles: Map<string, StylePropertySnapshot> | undefined,
	): void {
		writeStyleProperty(element, property, value);
		const previous = styles?.get(property);
		if (previous !== undefined) {
			previous.applied = readStyleProperty(element, property).value;
		}
	}

	private appearanceContentTargets(element: HTMLElement): readonly HTMLElement[] {
		const result: HTMLElement[] = [element];
		const querySelectorAll = readRuntime(element, "querySelectorAll");
		if (typeof querySelectorAll !== "function") {
			return result;
		}
		try {
			const matches = Reflect.apply(querySelectorAll, element, [
				".canvas-node-container, .canvas-node-content, .markdown-preview-view, .canvas-node-content-container",
			]);
			const length = finite(readRuntime(matches, "length")) ?? 0;
			for (let index = 0; index < length; index += 1) {
				const candidate = readRuntime(matches, index);
				if (isElement(candidate) && !result.includes(candidate)) {
					result.push(candidate);
				}
			}
		} catch {
			// Selector support is optional; shell-level inheritance still applies.
		}
		return result;
	}

	/** Apply persisted M1 appearance to native node/edge DOM and restore it on teardown. */
	private refreshAppearanceDecorations(): void {
		this.restoreAppearanceDom();
		for (const node of this.scene.nodes) {
			const id = readCanvasElementId(node);
			const dom = readCanvasElementDom(node);
			if (id === undefined || dom === undefined) {
				continue;
			}
			const override = this.appearance.localOverrides[id];
			this.applyElementAppearance(dom, override?.typography, override?.colors, false);
			for (const content of this.appearanceContentTargets(dom).slice(1)) {
				// Native Canvas paints its own fill and border on an inner
				// container that covers the outer node, and it carries explicit
				// font rules there too.  Decorating only the shell is therefore
				// invisible; every painted surface gets the same values.
				this.applyElementAppearance(content, override?.typography, override?.colors, false);
			}
		}
		for (const edge of this.scene.edges) {
			const id = readCanvasElementId(edge);
			const dom = readCanvasElementDom(edge);
			if (id === undefined || dom === undefined) {
				continue;
			}
			const override = this.appearance.localOverrides[id];
			this.applyElementAppearance(dom, undefined, override?.colors, true);
		}
	}

	private attachmentLabelTargets(element: HTMLElement): readonly HTMLElement[] {
		const result: HTMLElement[] = [];
		const querySelectorAll = readRuntime(element, "querySelectorAll");
		if (typeof querySelectorAll !== "function") {
			return result;
		}
		try {
			const matches = Reflect.apply(querySelectorAll, element, [
				".canvas-node-label, .file-embed-title, .internal-embed-title",
			]);
			const length = finite(readRuntime(matches, "length")) ?? 0;
			for (let index = 0; index < length; index += 1) {
				const candidate = readRuntime(matches, index);
				if (isElement(candidate) && !result.includes(candidate)) {
					result.push(candidate);
				}
			}
		} catch {
			// Native label markup is private and optional; caller emits a visible
			// diagnostic when no safe target can be found.
		}
		return result;
	}

	private hideNativeAttachmentLabel(element: HTMLElement): void {
		if (!this.hiddenNativeAttachmentLabels.has(element)) {
			const styles = new Map<string, StylePropertySnapshot>();
			styles.set("display", readStyleProperty(element, "display"));
			this.hiddenNativeAttachmentLabels.set(element, {
				styles,
				hidden: readAttribute(element, "data-miro-canvas-native-label-hidden"),
			});
		}
		const snapshot = this.hiddenNativeAttachmentLabels.get(element);
		if (snapshot === undefined) {
			return;
		}
		writeAttribute(element, "data-miro-canvas-native-label-hidden", "true");
		this.setTrackedStyle(element, "display", "none", snapshot.styles);
	}

	private restoreNativeAttachmentLabels(): void {
		for (const [element, snapshot] of this.hiddenNativeAttachmentLabels) {
			restoreStyleProperties(element, snapshot.styles);
			restoreAttribute(element, "data-miro-canvas-native-label-hidden", snapshot.hidden);
		}
		this.hiddenNativeAttachmentLabels.clear();
	}

	private attachmentNode(node: unknown): UnknownRecord | undefined {
		const id = readCanvasElementId(node);
		const type = readCanvasElementType(node);
		if (id === undefined || type === undefined) {
			return undefined;
		}
		const file = readCanvasElementFile(node);
		return {
			id,
			type,
			...(file === undefined ? {} : { file }),
		};
	}

	private refreshDecorations(): void {
		for (const label of this.attachmentLabels.splice(0)) {
			try {
				label.remove();
			} catch {
				// The native node may have been replaced while the pane refreshed.
			}
		}
		this.restoreNativeAttachmentLabels();
		for (const [element, previous] of this.lockedDom) {
			try {
				if (previous.classPresent) {
					element.classList.add("miro-canvas-locked");
				} else {
					element.classList.remove("miro-canvas-locked");
				}
				if (previous.attrPresent && previous.attrValue !== null) {
					element.setAttribute("data-miro-canvas-locked", previous.attrValue);
				} else {
					element.removeAttribute("data-miro-canvas-locked");
				}
			} catch {
				// A closed/replaced Canvas node may no longer be writable; it is safe
				// to forget the decoration and let the host own the element.
			}
		}
		this.lockedDom.clear();
		for (const node of this.scene.nodes) {
			const dom = readCanvasElementDom(node);
			if (dom === undefined) {
				continue;
			}
			const id = readCanvasElementId(node);
			if (id === undefined) {
				continue;
			}
			const locked = decideEditOperation(this.policy, "move", [id]).reason === "element-locked";
			try {
				this.lockedDom.set(dom, {
					classPresent: dom.classList.contains("miro-canvas-locked"),
					attrPresent: dom.hasAttribute("data-miro-canvas-locked"),
					attrValue: dom.getAttribute("data-miro-canvas-locked"),
				});
				if (locked) {
					dom.classList.add("miro-canvas-locked");
					dom.setAttribute("data-miro-canvas-locked", "true");
				} else {
					dom.classList.remove("miro-canvas-locked");
					dom.removeAttribute("data-miro-canvas-locked");
				}
			} catch {
				continue;
			}
			const candidate = this.attachmentNode(node);
			if (candidate === undefined || (candidate.type !== "file" && candidate.type !== "document")) {
				continue;
			}
			const decision = decideAttachmentLabel(candidate, this.currentMetadata);
			const nativeLabels = this.attachmentLabelTargets(dom);
			if (!decision.visible) {
				if (nativeLabels.length === 0) {
					this.addDiagnostic(`Attachment name for ${id} could not be hidden because this Canvas runtime exposes no safe native label target.`);
				} else {
					for (const nativeLabel of nativeLabels) {
						this.hideNativeAttachmentLabel(nativeLabel);
					}
				}
				continue;
			}
			// Prefer the native label, preserving its event handlers and hover
			// behavior.  Only create the plugin-owned fallback when private
			// native markup is absent.
			if (nativeLabels.length > 0 || decision.label === undefined) {
				continue;
			}
			const document = ownerDocument(dom);
			if (document === undefined) {
				continue;
			}
			const label = document.createElement("span");
			label.className = "miro-canvas-attachment-label";
			label.setAttribute("data-miro-canvas-attachment-label", "true");
			label.setAttribute("aria-hidden", "true");
			label.textContent = decision.label;
			try {
				dom.appendChild(label);
				this.attachmentLabels.push(label);
			} catch {
				label.remove();
			}
		}
		this.refreshAppearanceDecorations();
	}

	private drawMinimap(): void {
		const canvas = this.controls.minimapCanvas;
		const model = this.minimap;
		if (canvas === undefined || model === undefined) {
			return;
		}
		try {
			const context = canvas.getContext("2d");
			if (context === null) {
				this.addDiagnostic("Canvas minimap drawing is unavailable in this runtime.");
				return;
			}
			context.clearRect(0, 0, canvas.width, canvas.height);
			context.fillStyle = "rgba(127, 127, 127, 0.12)";
			context.fillRect(0, 0, canvas.width, canvas.height);
			for (const item of model.items) {
				if (item.mapRect === undefined) {
					continue;
				}
				context.fillStyle = item.kind === "edge" ? "rgba(127, 127, 127, 0.7)" : "rgba(80, 120, 230, 0.65)";
				context.fillRect(item.mapRect.x, item.mapRect.y, Math.max(1, item.mapRect.width), Math.max(1, item.mapRect.height));
			}
			if (model.viewportRect !== undefined) {
				context.strokeStyle = "var(--interactive-accent, #7c3aed)";
				context.lineWidth = 2;
				context.strokeRect(model.viewportRect.x, model.viewportRect.y, model.viewportRect.width, model.viewportRect.height);
			}
		} catch {
			this.addDiagnostic("Canvas minimap drawing failed; navigation remains available from keyboard controls.");
		}
	}

	private mapPoint(event: PointerEvent): MinimapPoint | undefined {
		const canvas = this.controls.minimapCanvas;
		if (canvas === undefined) {
			return undefined;
		}
		try {
			const rect = canvas.getBoundingClientRect();
			if (rect.width <= 0 || rect.height <= 0) {
				return undefined;
			}
			return {
				x: (event.clientX - rect.left) * canvas.width / rect.width,
				y: (event.clientY - rect.top) * canvas.height / rect.height,
			};
		} catch {
			return undefined;
		}
	}

	private attachMinimapHandlers(): void {
		const canvas = this.controls.minimapCanvas;
		if (canvas === undefined) {
			return;
		}
		this.listen(canvas, "pointerdown", (event) => {
			const point = this.mapPoint(event as PointerEvent);
			if (point === undefined) {
				return;
			}
			this.minimapDragStart = point;
			this.minimapDragViewport = this.viewport.getViewport();
			try {
				canvas.setPointerCapture((event as PointerEvent).pointerId);
			} catch {
				// Pointer capture is optional; document-level move handling is not.
			}
			event.preventDefault();
		});
		this.listen(canvas, "pointermove", (event) => {
			if (this.minimapDragStart === undefined) {
				return;
			}
			const point = this.mapPoint(event as PointerEvent);
			if (point === undefined || this.minimap === undefined) {
				return;
			}
			const target = this.minimap.viewportForDrag(this.minimapDragStart, point, this.minimapDragViewport);
			if (target !== undefined) {
				this.viewport.setViewport(target);
				this.refresh();
			}
			event.preventDefault();
		});
		const endDrag = (event: Event): void => {
			if (this.minimapDragStart === undefined) {
				return;
			}
			const pointerConstructor = readRuntime(globalThis, "PointerEvent");
			const point = typeof pointerConstructor === "function" && event instanceof pointerConstructor
				? this.mapPoint(event as PointerEvent)
				: undefined;
			const initial = this.minimapDragStart;
			this.minimapDragStart = undefined;
			this.minimapDragViewport = undefined;
			if (point !== undefined && this.minimap !== undefined && Math.abs(point.x - initial.x) < 2 && Math.abs(point.y - initial.y) < 2) {
				const target = this.minimap.viewportForClick(point);
				if (target !== undefined) {
					this.viewport.setViewport(target);
					this.refresh();
				}
			}
		};
		this.listen(canvas, "pointerup", endDrag);
		this.listen(canvas, "pointercancel", endDrag);
		this.listen(canvas, "keydown", (event) => {
			const key = (event as KeyboardEvent).key;
			let handled = true;
			if (key === "ArrowLeft") {
				this.viewport.panBy(-100, 0);
			} else if (key === "ArrowRight") {
				this.viewport.panBy(100, 0);
			} else if (key === "ArrowUp") {
				this.viewport.panBy(0, -100);
			} else if (key === "ArrowDown") {
				this.viewport.panBy(0, 100);
			} else if (key === "+" || key === "=") {
				this.viewport.zoomIn();
			} else if (key === "-" || key === "_") {
				this.viewport.zoomOut();
			} else if (key === "Home") {
				this.viewport.fitToBounds(this.minimap?.contentBounds, clientSize(this.root));
			} else {
				handled = false;
			}
			if (handled) {
				event.preventDefault();
				this.refresh();
			}
		});
	}

	private listen(target: EventTarget, eventName: string, handler: EventListener, capture = false): void {
		try {
			// Options object, not a boolean: a plain EventTarget host reads the
			// capture flag off the object only, so a boolean would leak the
			// listener past dispose.
			target.addEventListener(eventName, handler, { capture });
			this.disposers.push(() => {
				try {
					target.removeEventListener(eventName, handler, { capture });
				} catch {
					// Host elements can disappear during pane close; no further action.
				}
			});
		} catch {
			this.addDiagnostic(`Canvas event listener "${eventName}" is unavailable.`);
		}
	}

	private attachResizeObserver(): void {
		if (this.root === undefined) {
			return;
		}
		const ResizeObserverConstructor = readRuntime(globalThis, "ResizeObserver");
		if (typeof ResizeObserverConstructor === "function") {
			try {
				const observer = new (ResizeObserverConstructor as new (callback: () => void) => { observe: (target: HTMLElement) => void; disconnect: () => void })((() => this.refresh()) as () => void);
				observer.observe(this.root);
				this.disposers.push(() => observer.disconnect());
				return;
			} catch {
				this.addDiagnostic("Canvas resize observation is unavailable; minimap updates on explicit navigation only.");
			}
		}
		const window = readRuntime(ownerDocument(this.root), "defaultView");
		if (isObject(window)) {
			this.listen(window as unknown as EventTarget, "resize", () => this.refresh());
		}
	}

	/**
	 * Native Canvas does not expose one stable public selection/history event
	 * across supported Obsidian releases.  A bounded, teardown-owned poll keeps
	 * selection, undo/redo, and native edits reflected without monkey-patching
	 * unknown runtime methods or writing metadata on open.
	 */
	private attachRefreshPolling(): void {
		const setIntervalValue = readRuntime(globalThis, "setInterval");
		const clearIntervalValue = readRuntime(globalThis, "clearInterval");
		if (typeof setIntervalValue !== "function" || typeof clearIntervalValue !== "function") {
			this.addDiagnostic("Canvas state refresh polling is unavailable; selection and history changes require explicit refresh.");
			return;
		}
		try {
			const timer = Reflect.apply(setIntervalValue, globalThis, [() => this.refresh(), REFRESH_INTERVAL_MS]);
			this.refreshTimer = timer as ReturnType<typeof setInterval>;
			this.disposers.push(() => {
				if (this.refreshTimer === undefined) {
					return;
				}
				try {
					Reflect.apply(clearIntervalValue, globalThis, [this.refreshTimer]);
				} catch {
					// The host timer registry may already be unavailable during unload.
				}
				this.refreshTimer = undefined;
			});
		} catch {
			this.addDiagnostic("Canvas state refresh polling could not be started; selection and history changes require explicit refresh.");
		}
	}

	private attachSystemThemeListener(): void {
		const window = readRuntime(ownerDocument(this.root), "defaultView");
		const matchMedia = readRuntime(window, "matchMedia");
		if (typeof matchMedia !== "function") {
			return;
		}
		try {
			const media = Reflect.apply(matchMedia, window, ["(prefers-color-scheme: dark)"]) as unknown;
			const listener = () => {
				if (this.appearance.settings.displayTheme === "system") {
					this.applyTheme("system");
				}
			};
			const add = readRuntime(media, "addEventListener");
			if (typeof add === "function") {
				Reflect.apply(add, media, ["change", listener]);
				this.disposers.push(() => {
					const remove = readRuntime(media, "removeEventListener");
					if (typeof remove === "function") {
						Reflect.apply(remove, media, ["change", listener]);
					}
				});
			}
		} catch {
			this.addDiagnostic("System theme observation is unavailable; choose light or dark explicitly.");
		}
	}

	private applyTheme(theme: unknown): void {
		if (this.root === undefined || !isElement(this.controls.element)) {
			return;
		}
		const normalized = theme === "dark" || theme === "light" ? theme : "system";
		if (this.themeRootSnapshot === undefined) {
			const styles = new Map<string, StylePropertySnapshot>();
			for (const property of THEME_STYLE_PROPERTIES) {
				styles.set(property, readStyleProperty(this.root, property));
			}
			this.themeRootSnapshot = {
				styles,
				appearance: readAttribute(this.root, APPEARANCE_ATTRIBUTE),
				verticalAlign: readAttribute(this.root, VERTICAL_ALIGN_ATTRIBUTE),
				className: readAttribute(this.root, "class"),
				theme: readAttribute(this.root, "data-miro-canvas-theme"),
				resolvedTheme: readAttribute(this.root, "data-miro-canvas-resolved-theme"),
			};
		}
		const rootClassList = readRuntime(this.root, "classList");
		const addClass = readRuntime(rootClassList, "add");
		if (typeof addClass === "function") {
			try {
				Reflect.apply(addClass, rootClassList, [THEME_ROOT_CLASS]);
			} catch {
				// Class decoration is optional; the data attributes remain authoritative.
			}
		}
		writeAttribute(this.root, "data-miro-canvas-theme", normalized);
		const window = readRuntime(ownerDocument(this.root), "defaultView");
		let resolved = normalized;
		if (normalized === "system") {
			const matchMedia = readRuntime(window, "matchMedia");
			if (typeof matchMedia === "function") {
				try {
					const media = Reflect.apply(matchMedia, window, ["(prefers-color-scheme: dark)"]) as unknown;
					resolved = readRuntime(media, "matches") === true ? "dark" : "light";
				} catch {
					resolved = "light";
				}
			}
		}
		writeAttribute(this.root, "data-miro-canvas-resolved-theme", resolved);
		writeAttribute(this.controls.element, "data-miro-canvas-theme", normalized);
		writeAttribute(this.controls.element, "data-miro-canvas-resolved-theme", resolved);
		this.setTrackedStyle(this.root, "color-scheme", resolved, this.themeRootSnapshot.styles);
		this.setTrackedStyle(this.root, "background-color", resolved === "dark" ? "#1e1e1e" : "#ffffff", this.themeRootSnapshot.styles);
		this.setTrackedStyle(this.root, "color", resolved === "dark" ? "#dedede" : "#1e1e1e", this.themeRootSnapshot.styles);
	}

	private restoreThemeRoot(): void {
		if (this.root === undefined || this.themeRootSnapshot === undefined) {
			return;
		}
		const snapshot = this.themeRootSnapshot;
		restoreStyleProperties(this.root, snapshot.styles);
		restoreAttribute(this.root, APPEARANCE_ATTRIBUTE, snapshot.appearance);
		restoreAttribute(this.root, VERTICAL_ALIGN_ATTRIBUTE, snapshot.verticalAlign);
		restoreAttribute(this.root, "data-miro-canvas-theme", snapshot.theme);
		restoreAttribute(this.root, "data-miro-canvas-resolved-theme", snapshot.resolvedTheme);
		const originalClasses = snapshot.className.value ?? "";
		if (!new RegExp(`(?:^|\\s)${THEME_ROOT_CLASS}(?:\\s|$)`, "u").test(originalClasses)) {
			const classList = readRuntime(this.root, "classList");
			const removeClass = readRuntime(classList, "remove");
			if (typeof removeClass === "function") {
				try {
					Reflect.apply(removeClass, classList, [THEME_ROOT_CLASS]);
				} catch {
					// The host node may have disappeared during pane close.
				}
			}
		}
		this.themeRootSnapshot = undefined;
	}

	private policyFromDocument(document: unknown): InteractionPolicy {
		const parsed = parseMiroCanvasMetadata(document);
		// A missing extension is an ordinary Canvas. Invalid/unsupported data
		// must never be normalized into an unlocked default policy.
		return createInteractionPolicy(parsed.status === "valid" ? parsed.metadata
			: parsed.status === "absent" ? { settings: {}, localOverrides: {} } : undefined);
	}

	/**
	 * Failing closed is right, but doing it silently is not: a refusal that
	 * cannot be explained is indistinguishable from a broken plugin, so the
	 * reason is recorded and reported with the block.
	 */
	private readInteractionState(): void {
		this.interactionBlock = undefined;
		const document = this.adapter.getDocument();
		this.policy = this.policyFromDocument(document);
		const selection = this.adapter.getSelection();
		this.selectedIds = selection === undefined ? [] : allIds(selection);
		if (selection === undefined) {
			this.interactionBlock = "this Canvas runtime does not report its selection";
			this.policy = createInteractionPolicy(undefined);
			return;
		}
		const unidentified = selection.filter((item) => allIds([item]).length !== 1).length;
		if (unidentified > 0) {
			this.interactionBlock = `${unidentified} of ${selection.length} selected item(s) could not be identified`;
			this.policy = createInteractionPolicy(undefined);
			return;
		}
		const parsed = parseMiroCanvasMetadata(document);
		if (parsed.status !== "valid" && parsed.status !== "absent") {
			this.interactionBlock = `the board metadata is ${parsed.status}`;
		}
	}

	/** Instance-only hooks also protect edits from native menus outside the root.
	 * Never patch prototypes or persistence/history snapshots. Restore only our
	 * own wrappers so another plugin's later hook is not overwritten. */
	private guardNativeMethod(target: unknown, key: string, run: (original: Function, receiver: unknown, args: unknown[]) => unknown): void {
		if (!isObject(target) || this.guardedMethods.get(target)?.has(key)) return;
		const original = readRuntime(target, key);
		if (typeof original !== "function") return;
		try {
			const descriptor = Object.getOwnPropertyDescriptor(target, key);
			const session = this;
			const wrapper = function(this: unknown, ...args: unknown[]): unknown {
				return session.disposed ? Reflect.apply(original, this, args) : run(original, this, args);
			};
			Object.defineProperty(target, key, { configurable: true, writable: true, enumerable: descriptor?.enumerable ?? false, value: wrapper });
			const keys = this.guardedMethods.get(target) ?? new Set<string>();
			keys.add(key);
			this.guardedMethods.set(target, keys);
			this.disposers.push(() => {
				if (readRuntime(target, key) !== wrapper) return;
				try {
					if (descriptor) Object.defineProperty(target, key, descriptor);
					else Reflect.deleteProperty(target, key);
				} catch { /* The host may have disposed/frozen the runtime. */ }
			});
		} catch {
			this.addDiagnostic(`Native Canvas guard for ${key} is unavailable; scoped input guards remain active.`);
		}
	}

	private nativeEditAllowed(operation: string, ids: readonly string[]): boolean {
		if (this.nativeHistoryDepth > 0) return true;
		this.readInteractionState();
		return this.editAllowed(operation, ids);
	}

	private attachNativeGuards(): void {
		// Use the adapter's observed runtime methods to verify the owner before
		// installing the narrowly scoped hooks required for native menu actions.
		// The adapter accepts several runtime shapes, so probe the same keys it
		// does instead of assuming `view.canvas`; a silent miss would leave
		// native menus unguarded on a locked element.
		const observed = this.adapter.read("getData");
		const canvas = [this.view, ...["canvas", "_canvas", "canvasView", "canvasRuntime"]
			.map((key) => readRuntime(this.view, key))]
			.find((candidate) => isObject(candidate) && observed !== undefined && readRuntime(candidate, "getData") === observed);
		if (!isObject(canvas)) {
			this.addDiagnostic("Native Canvas guards are unavailable; scoped input guards remain active.");
			return;
		}
		for (const owner of [canvas, readRuntime(canvas, "history")]) {
			for (const key of ["undo", "redo"]) {
				this.guardNativeMethod(owner, key, (original, receiver, args) => {
					this.nativeHistoryDepth += 1;
					try { return Reflect.apply(original, receiver, args); }
					finally {
						this.nativeHistoryDepth -= 1;
						this.pointerEditIds = undefined;
						if (this.nativeHistoryDepth === 0) {
							this.readInteractionState();
							this.attachNativeGuards();
						}
					}
				});
			}
		}
		// Native `getData` rebuilds the document from the Canvas model and keeps
		// only the keys it owns, so a plain native save would silently erase this
		// plugin's metadata and the imported source snapshot.  Carry across every
		// root key that survived in the live document but is missing from the
		// rebuild: a value only exists here because something put it there, and
		// dropping another plugin's data would be as destructive as dropping our
		// own.  A value the host produced itself is never overwritten.
		this.guardNativeMethod(canvas, "getData", (original, receiver, args) => {
			const data = Reflect.apply(original, receiver, args);
			if (!isObject(data)) {
				return data;
			}
			const live = readRuntime(receiver, "data");
			if (!isObject(live)) {
				return data;
			}
			let keys: readonly string[];
			try {
				keys = Object.keys(live);
			} catch {
				keys = PLUGIN_ROOT_KEYS;
			}
			for (const key of keys) {
				// `nodes` and `edges` are the host's to rebuild, never ours to restore.
				if (key === "nodes" || key === "edges" || readRuntime(data, key) !== undefined) {
					continue;
				}
				const preserved = readRuntime(live, key);
				if (preserved === undefined) {
					continue;
				}
				try {
					Reflect.set(data, key, preserved);
				} catch {
					this.addDiagnostic(`Canvas rebuilt its document and "${key}" could not be carried across; that value is the host's to keep.`);
				}
			}
			return data;
		});
		for (const key of ["removeNode", "removeEdge", "removeSelection", "deleteSelection"]) {
			this.guardNativeMethod(canvas, key, (original, receiver, args) => {
				this.readInteractionState();
				const ids = key.endsWith("Selection") ? this.selectedIds : allIds([args[0]]);
				return this.nativeEditAllowed("delete", ids) ? Reflect.apply(original, receiver, args) : undefined;
			});
		}
		const operations: Record<string, string> = {
			moveTo: "move", moveAndResize: "resize", resize: "resize",
			setText: "edit-text", startEditing: "edit-text", setColor: "restyle", setData: "restyle",
		};
		for (const element of [...(this.adapter.getNodes() ?? []), ...(this.adapter.getEdges() ?? [])]) {
			for (const [key, operation] of Object.entries(operations)) {
				this.guardNativeMethod(element, key, (original, receiver, args) => {
					const ids = allIds([element]);
					return this.nativeEditAllowed(operation, ids) ? Reflect.apply(original, receiver, args) : undefined;
				});
			}
		}
	}

	private eventElementId(target: unknown): string | undefined {
		if (readRuntime(target, "nodeType") === 3) target = readRuntime(target, "parentElement");
		if (!isObject(target)) {
			return undefined;
		}
		const closest = readRuntime(target, "closest");
		if (typeof closest === "function") {
			try {
				const element = Reflect.apply(closest, target, ["[data-miro-canvas-id], [data-node-id], [data-edge-id], [data-id]"]);
				for (const key of ["data-miro-canvas-id", "data-node-id", "data-edge-id", "data-id"] as const) {
					const value = readRuntime(element, "getAttribute");
					if (typeof value === "function") {
						const id = Reflect.apply(value, element, [key]);
						if (typeof id === "string" && id.length > 0) {
							return id;
						}
					}
				}
			} catch {
				return undefined;
			}
		}
		// Native Canvas nodes do not consistently expose a data-id attribute.
		for (const item of [...(this.adapter.getNodes() ?? []), ...(this.adapter.getEdges() ?? [])]) {
			for (const key of ["nodeEl", "edgeEl", "containerEl", "contentEl", "el"]) {
				const element = readRuntime(item, key);
				const contains = readRuntime(element, "contains");
				try {
					if (element === target || (typeof contains === "function" && Reflect.apply(contains, element, [target]))) {
						return readCanvasElementId(item);
					}
				} catch { /* A detached host node cannot identify a target. */ }
			}
		}
		return undefined;
	}

	private eventIds(event: Event): readonly string[] {
		const id = this.eventElementId(eventTarget(event));
		return id === undefined ? this.selectedIds : [...new Set([id, ...this.selectedIds])];
	}

	private inControls(event: Event): boolean {
		return this.closestTarget(event, PANEL_SELECTOR);
	}

	private closestTarget(event: Event, selector: string): boolean {
		const target = eventTarget(event);
		if (!isObject(target)) {
			return false;
		}
		const closest = readRuntime(target, "closest");
		if (typeof closest !== "function") {
			return false;
		}
		try {
			return Reflect.apply(closest, target, [selector]) != null;
		} catch {
			return false;
		}
	}

	private editAllowed(operation: string, ids: readonly string[]): boolean {
		const decision = decideInteraction(this.policy, { operation, elementIds: ids });
		if (decision.allowed) return true;
		this.addDiagnostic(decision.reason === "review-mode"
			? "Review mode blocked a Canvas edit; pan, selection, copy, links, and comments remain available."
			: decision.reason === "element-locked"
				? "A locked Canvas element blocked that edit. Unlock it explicitly to continue."
				: `Canvas edit blocked because its capability could not be verified: ${this.interactionBlock ?? "the interaction policy refused the request"}.`);
		return false;
	}

	private blockIfNeeded(event: Event, operation: string, ids: readonly string[]): boolean {
		if (this.inControls(event)) {
			return false;
		}
		if (this.editAllowed(operation, ids)) {
			return false;
		}
		try {
			event.preventDefault();
			event.stopImmediatePropagation();
			event.stopPropagation();
		} catch {
			// A test double may only implement preventDefault; policy still fails closed.
		}
		return true;
	}

	private isSpacePanHeld(): boolean {
		if (this.spacePanHeld) {
			return true;
		}
		const native = this.adapter.read("isHoldingSpace");
		if (typeof native === "boolean") {
			return native;
		}
		return typeof native === "function" && this.adapter.invoke("isHoldingSpace") === true;
	}

	private attachGuards(): void {
		if (this.root === undefined) {
			return;
		}
		const listen = (type: string, handler: EventListener): void => {
			this.listen(this.root!, type, (event) => {
				if (this.inControls(event)) return;
				this.readInteractionState();
				handler(event);
			}, true);
		};
		listen("keydown", (event) => {
			const keyboard = event as KeyboardEvent;
			const key = keyboard.key;
			if ((key === " " || key === "Space") && !this.closestTarget(event, "input, textarea, [contenteditable=true]")) {
				this.spacePanHeld = true;
				return;
			}
			const modified = keyboard.ctrlKey || keyboard.metaKey;
			const lowerKey = typeof key === "string" ? key.toLowerCase() : "";
			// Preserve native history, search, and selection shortcuts.  They are
			// read/navigation actions even while review/lock policy is active.
			if (modified && ["z", "y", "f", "a", "s"].includes(lowerKey)) {
				return;
			}
			if (modified && lowerKey === "c") {
				return; // Copy remains available in review mode.
			}
			if (modified && lowerKey === "v") {
				this.blockIfNeeded(event, "paste", this.eventIds(event));
				return;
			}
			if (modified && lowerKey === "x") {
				this.blockIfNeeded(event, "delete", this.eventIds(event));
				return;
			}
			if (modified && lowerKey === "d") {
				this.blockIfNeeded(event, "duplicate", this.eventIds(event));
				return;
			}
			if (key === "Delete" || key === "Backspace") {
				this.blockIfNeeded(event, "delete", this.eventIds(event));
				return;
			}
			if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(key)) {
				this.blockIfNeeded(event, "move", this.eventIds(event));
				return;
			}
			if (key === "Enter" || (typeof key === "string" && keyIsPrintable(key))) {
				this.blockIfNeeded(event, "edit-text", this.eventIds(event));
			}
		});
		listen("keyup", (event) => {
			const key = (event as KeyboardEvent).key;
			if (key === " " || key === "Space") {
				this.spacePanHeld = false;
			}
		});
		for (const type of ["beforeinput", "input", "change"]) {
			listen(type, (event) => {
				const input = readRuntime(event, "inputType");
				if (input === "historyUndo" || input === "historyRedo") return;
				this.blockIfNeeded(event, typeof input === "string" && input.startsWith("format") ? "restyle" : "edit-text", this.eventIds(event));
			});
		}
		listen("dblclick", (event) => {
			const id = this.eventElementId(eventTarget(event));
			this.blockIfNeeded(event, id === undefined ? "create" : "edit-text", id === undefined ? [] : this.eventIds(event));
		});
		for (const type of ["pointerdown", "mousedown"]) {
			listen(type, (event) => {
				this.pointerEditIds = undefined;
				if (readRuntime(event, "button") === 1 || readRuntime(event, "button") === 2 || this.isSpacePanHeld()) return;
				const id = this.eventElementId(eventTarget(event));
				if (id === undefined && !this.closestTarget(event, ".canvas-node, .canvas-edge, .canvas-selection, .canvas-node-resizer")) return;
				this.pointerEditIds = this.eventIds(event);
				if (this.blockIfNeeded(event, "move", this.pointerEditIds) && id !== undefined) {
					// Selection must remain possible for the explicit Unlock action,
					// without handing the press to native drag/resize initialization.
					const element = [...(this.adapter.getNodes() ?? []), ...(this.adapter.getEdges() ?? [])].find((item) => readCanvasElementId(item) === id);
					if (element !== undefined && !this.selectedIds.includes(id)) {
						this.adapter.invoke(readRuntime(event, "shiftKey") === true ? "select" : "selectOnly", element);
						this.readInteractionState();
					}
				}
			});
		}
		const clearGesture = (): void => { this.pointerEditIds = undefined; };
		const host = ownerDocument(this.root) ?? this.root;
		this.listen(host, "pointermove", (event) => this.handles.handlePointerMove(event), true);
		this.listen(host, "pointerup", (event) => this.handles.handlePointerUp(event), true);
		this.listen(host, "pointercancel", () => this.handles.cancelGesture(), true);
		for (const type of ["pointerup", "pointercancel", "mouseup"]) {
			this.listen(host, type, clearGesture, true);
		}
		const window = readRuntime(ownerDocument(this.root), "defaultView");
		if (isObject(window)) this.listen(window as unknown as EventTarget, "blur", () => {
			clearGesture();
			this.spacePanHeld = false;
		});
		listen("dragstart", (event) => this.blockIfNeeded(event, "drag-drop", this.eventIds(event)));
		listen("drop", (event) => this.blockIfNeeded(event, "drag-drop", this.eventIds(event)));
		listen("paste", (event) => this.blockIfNeeded(event, "paste", this.eventIds(event)));
		listen("cut", (event) => this.blockIfNeeded(event, "delete", this.eventIds(event)));
		listen("pointermove", (event) => {
			const buttons = readRuntime(event, "buttons");
			if (buttons === 0 || (typeof buttons === "number" && (buttons & 4) !== 0) || this.isSpacePanHeld()) {
				return;
			}
			const id = this.eventElementId(eventTarget(event));
			const ids = this.pointerEditIds ?? (id === undefined ? undefined : this.eventIds(event));
			if (ids !== undefined) this.blockIfNeeded(event, "move", [...new Set([...ids, ...this.selectedIds])]);
		});
	}

	/** Restore native readonly state, DOM decorations, listeners, and panel. */
	public dispose(): void {
		if (this.disposed) {
			return;
		}
		this.disposed = true;
		this.controls.dispose();
		this.toolbar.dispose();
		this.handles.dispose();
		this.authoring?.dispose();
		this.authoring = undefined;
		this.sourceRenderer?.dispose();
		for (const dispose of this.disposers.splice(0)) {
			dispose();
		}
		for (const label of this.attachmentLabels.splice(0)) {
			try {
				label.remove();
			} catch {
				// The native node may have been destroyed with its pane.
			}
		}
		this.restoreNativeAttachmentLabels();
		for (const [element, previous] of this.lockedDom) {
			try {
				if (previous.classPresent) {
					element.classList.add("miro-canvas-locked");
				} else {
					element.classList.remove("miro-canvas-locked");
				}
				if (previous.attrPresent && previous.attrValue !== null) {
					element.setAttribute("data-miro-canvas-locked", previous.attrValue);
				} else {
					element.removeAttribute("data-miro-canvas-locked");
				}
			} catch {
				// The Canvas node may have been destroyed with its pane.
			}
		}
		this.lockedDom.clear();
		this.restoreAppearanceDom();
		this.restoreThemeRoot();
		if (this.readonlyOriginal !== undefined && this.readNativeReadonly() !== this.readonlyOriginal) {
			this.setNativeReadonly(this.readonlyOriginal);
		}
		// CanvasAdapter may have installed a scoped native camera patch for the
		// zoom-unlock behavior.  Releasing it here restores the exact original
		// method before the leaf is allowed to close.
		this.adapter.dispose();
		this.root = undefined;
		this.minimap = undefined;
		this.currentMetadata = undefined;
		this.currentRawDocument = undefined;
		this.spacePanHeld = false;
	}
}

export const M1Session = M1CanvasSession;
export const createM1Session = (view: unknown, writer: MetadataWriter | null = null, options: M1SessionOptions = {}): M1CanvasSession => new M1CanvasSession(view, writer, options);
