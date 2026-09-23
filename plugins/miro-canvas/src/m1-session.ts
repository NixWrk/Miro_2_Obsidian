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
	type PaletteColor,
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
import { boardConnectors, connectorEndCap, connectorRoutes, restyleBoardConnector, type BoardConnector } from "./board-connectors";
import { commentSelectionId, selectedComment, translateBoardSelection, routeEndsInBox, pointInSelectionBox, rectIntersectsBox, type SelectedRouteEnds } from "./board-selection";
import { ConnectorLayer } from "./connector-layer";
import { NativeEdgeLabels, type NativeEdgeLabel } from "./native-edge-labels";
import {
	MAX_WAYPOINTS, gripNear, moveElbowSegment, placeWaypoint, planRoute, removeWaypoint, routeBends, routeHandles, routePath, simplifyCorners,
	type PlannedRoute, type RouteEnd,
} from "./connector-route";
import {
	SelectionHandles,
	normalizeAngle,
	type ConnectorGesture,
	type HandleRect,
	type HandleSide,
	type RouteGrip,
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
	MINIMAP_COLORS,
	MinimapModel,
	minimapCategory,
	type MinimapPoint,
	type MinimapRect,
} from "./minimap-model";
import { MetadataWriter, type MetadataWriteResult } from "./metadata-writer";
import { PLUGIN_ROOT_KEYS, parseMiroCanvasMetadata, type MiroCanvasMetadata } from "./metadata";
import { DEFAULT_SETTINGS, commentAuthorName, obsidianAccountName, panDelta, type MiroCanvasSettings, type PanDirection } from "./settings";
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
import { SourceRenderer, type DeckAction } from "./source-renderer";
import { SlideShow, type SlideRect } from "./slide-show";
import { buildSourceInspection } from "./source-inspector";
import {
	buildSourceScene,
	CONNECTOR_CAPS,
	CONNECTOR_ROUTES,
	CONNECTOR_STROKES,
	takesShape,
	type SourceScene,
} from "./source-model";
import { CommentMarkers } from "./comment-markers";
import { matchesPointer } from "./pointer-bindings";
import { edgeLanding } from "./edge-landing";
import { addLocalComment, addReply, deleteLocalComment, deleteLocalReply, listCommentThreads, renameCommentDisplayAuthor, setCommentResolved, type CommentOrigin, type CommentMutationResult } from "./local-comments";
import { CommentThreadCard, threadMessages } from "./comment-thread";
import { QUICK_TOOL_KEYS, QuickTools, isDrawingTool, type QuickTool } from "./quick-tools";
import { LOCAL_ITEM_SIZES, MAX_LINE_POINTS, MAX_STROKE_POINTS, TABLE_TEMPLATE, type LocalItem, type LocalLine } from "./local-items";
import {
	blockArrowOutline, bowPoint, lineBoardPoints, lineFromBoard, lineKind, planLine, type LineKindSpec, type LinePoint,
} from "./free-line";
import {
	eraseFromStroke, pointInLasso, recogniseStroke, simplifyPoints, snapAngle, strokeBounds, strokeHitsPoint, strokeHitsSegment,
	type StrokePoint,
} from "./drawing";
import {
	boundaryAnchorOnRect,
	buildCanvasAnchorGeometry,
	facingSide,
	facingSideOfRect,
	insideRect,
	nodeBoundaryAnchorAtSide,
	sideAnchorOnOutline,
	sideDirection,
	snapToStandardPoint,
} from "./connector-endpoints";
import { normalizeAnchor, resolveAnchor, type AnchorGeometry, type CanvasAnchor } from "./anchors";
import { shapeOutline } from "./shape-geometry";
import { FRAME_COLORS, MIRO_STICKY_COLORS, readableInk } from "./miro-palette";
import { highlightText, isHtmlText, markSelection, unhighlightText } from "./text-highlight";
import {
	CANVAS_CLIPBOARD_TYPE, CLIPBOARD_TYPE, linkedFilePaths, planPaste, readCanvasClipboard, readClipboardRecord,
	type ClipboardItem,
} from "./board-clipboard";

export interface M1SessionOptions {
	readonly desktopClipboard?: { readText():string; writeText(text:string):void };
	readonly document?: Document;
	readonly panelHost?: HTMLElement;
	readonly onNotice?: (message: string) => void;
	readonly onStateChange?: (state: M1ControlsState) => void;
	/** User preferences; defaults apply when the host supplies none. */
	readonly settings?: MiroCanvasSettings;
	/** Why persistence is unavailable, when the host could not build a store. */
	readonly persistenceProblem?: string;
	/** Draws a named Obsidian icon; the toolbar falls back to glyphs without it. */
	readonly setIcon?: (element: HTMLElement, icon: string) => void;
	/** Opens this plugin's page in Obsidian's settings, from the board menu. */
	readonly onOpenSettings?: () => void;
	readonly onOpenCommentThread?: (threadId: string, origin: CommentOrigin) => void;
	readonly onClipboardMenu?: (event: MouseEvent, run: (action: "copy" | "cut" | "paste") => void, nativeMenu: () => void) => void;
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

const STICKY_PALETTE: readonly PaletteColor[] = Object.freeze(MIRO_STICKY_COLORS.map((entry) => Object.freeze({
	id: `miro-sticky-${entry.token}`, label: entry.label, color: entry.color, source: "miro" as const,
})));
const FRAME_PALETTE: readonly PaletteColor[] = Object.freeze(FRAME_COLORS.map((entry) => Object.freeze({
	id: `miro-${entry.token}`, label: entry.label, color: entry.color, source: "miro" as const,
})));
/** Miro's highlighter is a wider, see-through pen. */
const HIGHLIGHTER_OPACITY = 0.4;
const HIGHLIGHTER_SCALE = 3;
/** How long after a stylus a touch is still taken for a palm. */
const STYLUS_HOLD_MS = 1_500;
const MIN_PRESSURE_SCALE = 0.5;
const MAX_PRESSURE_SCALE = 1.6;

/** Whether a colour lets what lies under it show: a hex colour with less than full alpha. */
function seeThrough(color: unknown): boolean {
	return typeof color === "string" && /^#[0-9a-f]{6}[0-9a-f]{2}$/iu.test(color) && !/ff$/iu.test(color);
}

/** The native side a connector end sits on, from where its anchor lies on the node. */
function nativeSideOf(anchor: CanvasAnchor | undefined, fallback: ConnectorSide): ConnectorSide {
	if (anchor?.type !== "node") return fallback;
	const candidates: readonly [ConnectorSide, number][] = [
		["top", anchor.v], ["right", 1 - anchor.u], ["bottom", 1 - anchor.v], ["left", anchor.u],
	];
	return candidates.reduce((best, candidate) => candidate[1] < best[1] ? candidate : best)[0];
}
const PANEL_SELECTOR = ".miro-canvas-panel, .miro-canvas-dock, .miro-canvas-thread, .miro-canvas-slideshow, .miro-canvas-toolbar, .miro-canvas-comment-markers, .miro-canvas-handles, .miro-canvas-minimap";
const DEFAULT_TOOLBAR_FONT = "Inter";
const DEFAULT_TOOLBAR_FONT_SIZE = 16;
const REFRESH_INTERVAL_MS = 750;
/** A bend dropped within this many screen pixels of the straight line is no bend. */
const STRAIGHTEN_DISTANCE = 8;
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

/** The key a moved comment's place is kept under: its origin and id, which alone may repeat. */
function commentPlaceKey(origin: CommentOrigin, id: string): string {
	return `${origin}:${id}`;
}

/** A node or connector id as native Canvas makes one: sixteen hex digits. */
function newCanvasId(): string {
	const bytes = new Uint8Array(8);
	globalThis.crypto.getRandomValues(bytes);
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Call a method a host object may or may not have; what it throws is swallowed. */
function callRuntime(value: unknown, key: PropertyKey, ...args: readonly unknown[]): unknown {
	const method = readRuntime(value, key);
	if (typeof method !== "function") return undefined;
	try {
		return Reflect.apply(method, value, args);
	} catch {
		return undefined;
	}
}

function finite(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function cssNumber(value: string | undefined): number | undefined {
	if (value === undefined) return undefined;
	const parsed = Number(value.trim().replace(/px$/u, ""));
	return Number.isFinite(parsed) ? parsed : undefined;
}

/** Effective source + local style shown by the toolbar for one Canvas ID. */
export function resolveSelectionToolbarPresentation(
	document: unknown,
	id: string | undefined,
): Pick<SelectionToolbarState, "typography" | "colors"> & { readonly style: SelectionToolbarStyle } {
	const descriptor = id === undefined ? undefined : buildSourceScene(document).items.get(id);
	const css = descriptor?.css ?? {};
	const fontSize = cssNumber(css["font-size"]);
	const lineHeight = cssNumber(css["line-height"]);
	const weight = css["font-weight"];
	const decoration = new Set((css["text-decoration"] ?? "").split(/\s+/u));
	const alignmentValue = css["text-align"];
	const alignment = alignmentValue === "center" || alignmentValue === "right" || alignmentValue === "justify"
		? alignmentValue
		: alignmentValue === "end" ? "right" : "left";
	const verticalValue = css["vertical-align"];
	const verticalAlign = verticalValue === "middle" || verticalValue === "center" ? "center"
		: verticalValue === "bottom" ? "bottom" : "top";
	const typography: TypographySettings = {
		fontFamily: css["font-family"] ?? DEFAULT_TOOLBAR_FONT,
		fontSize: fontSize !== undefined && fontSize > 0 ? fontSize : DEFAULT_TOOLBAR_FONT_SIZE,
		format: {
			bold: weight === "bold" || (cssNumber(weight) ?? 0) >= 600,
			italic: css["font-style"] === "italic",
			underline: decoration.has("underline"),
			strike: decoration.has("line-through"),
		},
		alignment,
		...(lineHeight !== undefined && lineHeight > 0 ? { lineHeight } : {}),
		verticalAlign,
	};
	const colors: Record<string, string | null> = {};
	for (const [slot, property] of [
		["text", "color"], ["fill", "background-color"], ["border", "border-color"], ["edge", "stroke"], ["highlight", "--miro-highlight"],
	] as const) {
		const color = css[property];
		if (color !== undefined) colors[slot] = color === "transparent" ? null : color;
	}
	const shape = descriptor?.shape !== undefined && (CANVAS_SHAPE_KINDS as readonly string[]).includes(descriptor.shape)
		? descriptor.shape as SelectionToolbarStyle["shape"]
		: undefined;
	const borderStyle = css["border-style"];
	const borderWidth = cssNumber(css["border-width"]);
	const connector = descriptor?.connector;
	// An imported connector without a route is drawn straight; a local one curves like Obsidian's.
	const route = connector?.shape !== undefined && (CONNECTOR_ROUTES as readonly string[]).includes(connector.shape)
		? connector.shape
		: descriptor?.kind === "connector" && descriptor.sourceId !== undefined ? "straight" : undefined;
	const strokeStyle = connector?.strokeStyle !== undefined && (CONNECTOR_STROKES as readonly string[]).includes(connector.strokeStyle)
		? connector.strokeStyle : undefined;
	const startCap = connector?.startCap !== undefined && (CONNECTOR_CAPS as readonly string[]).includes(connector.startCap)
		? connector.startCap as NonNullable<SelectionToolbarStyle["connector"]>["startCap"] : undefined;
	const endCap = connector?.endCap !== undefined && (CONNECTOR_CAPS as readonly string[]).includes(connector.endCap)
		? connector.endCap as NonNullable<SelectionToolbarStyle["connector"]>["endCap"] : undefined;
	const width = cssNumber(css["stroke-width"]);
	const connectorStyle: NonNullable<SelectionToolbarStyle["connector"]> = {
		...(connector?.headSize === undefined ? {} : {headSize: connector.headSize}),
		...(route === undefined ? {} : { route }),
		...(strokeStyle === undefined ? {} : { strokeStyle }),
		...(startCap === undefined ? {} : { startCap }),
		...(endCap === undefined ? {} : { endCap }),
		...(width !== undefined && width > 0 ? { width } : {}),
		...(css.stroke === undefined ? {} : { color: css.stroke === "transparent" ? null : css.stroke }),
	};
	return {
		typography,
		colors,
		style: {
			...(shape === undefined ? {} : { shape }),
			...(borderStyle === "solid" || borderStyle === "dashed" || borderStyle === "dotted" || borderStyle === "none"
				? { borderStyle } : {}),
			...(borderWidth !== undefined && borderWidth >= 0 ? { borderWidth } : {}),
			...(Object.keys(connectorStyle).length === 0 ? {} : { connector: connectorStyle }),
		},
	};
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

/** A resolved custom property of an element, when the host can compute styles. */
function readStyleValue(element: unknown, property: string): string | undefined {
	try {
		const view = readRuntime(readRuntime(element, "ownerDocument"), "defaultView");
		const compute = readRuntime(view, "getComputedStyle");
		if (typeof compute !== "function") return undefined;
		const style = Reflect.apply(compute, view, [element]);
		const value = Reflect.apply(readRuntime(style, "getPropertyValue") as (name: string) => string, style, [property]);
		return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
	} catch {
		return undefined;
	}
}

function firstProblem(diagnostics: readonly { readonly level: string; readonly message: string }[]): string | undefined {
	return (diagnostics.find((item) => item.level === "error")
		?? diagnostics.find((item) => item.level === "warning"))?.message;
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
	"--canvas-color",
	"--miro-highlight",
	"--miro-highlight-ink",
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
	private connectorLayer?: ConnectorLayer;
	private nativeEdgeLabels?: NativeEdgeLabels;
	private activeNativeRouteDragId?: string;
	private connectorColor?: string;
	private connectorHeadSize?: number;
	private connectorWidth = 2;
	private ordinaryConnectorWidth = 2;
	private blockConnectorWidth = 16;
	private clipboardCommand?: (action:"copy"|"cut"|"paste")=>boolean;
	private liveGeometryDirty = false;
	public resetTools(): void {
		this.rectangleSelectionEnd?.();
		this.selectedRouteEnds.clear();
		this.selectionMoveEnd?.();
		this.toolGesture?.end();this.panGestureEnd?.();this.linePlacing=undefined;
		this.cancelHandleRotation();this.connectorLayer?.reset();this.callNative("deselectAll");this.selectedCommentKeys.clear();
		this.closeCommentThread();this.quickTools?.closePanels();this.armTool("select");this.refresh();
	}
	public migrateLines(): void {
		this.authoring ??= createCanvasAuthoring(this.view);
		const result = this.authoring.migrateLines();
		this.options.onNotice?.(result.ok ? "Line migration finished. Unsupported legacy lines are retained; Undo restores the previous graph." : firstProblem(result.diagnostics) ?? "Line migration was refused.");
		for (const diagnostic of result.diagnostics) this.addDiagnostic(diagnostic.message);
		this.refresh();
	}
	private refreshBoardConnectors(): void {
		if (!this.root || typeof this.root.ownerDocument?.createElementNS !== "function" || typeof this.root.append !== "function") return;
		this.connectorLayer ??= new ConnectorLayer(this.root, {
			document: () => this.commentMovePreview ?? this.selectionMovePreview ?? this.currentRawDocument,
			geometry: () => this.landingGeometry().geometry,
			screen: p => { const at = this.viewportPoint(p) ?? p; const box = boundingRect(this.root); return {x:at.x-(box?.left??0),y:at.y-(box?.top??0)}; },
			board: p => this.boardPoint(p),
			landing: (p,id) => this.connectorLanding(p,undefined,undefined,id)?.anchor,
			editable: ids => this.editAllowed(ids.length ? "edit" : "paste",ids),
			write: (items,remove,expected) => this.writeBoardConnectors(items,remove,expected),
			deselectNative: () => {this.callNative("deselectAll");}, id: newCanvasId,
			clipboard: action => {this.clipboardCommand?.(action);},
			removeSelection: () => this.deleteBoardSelection(),
			moveSelection: event => this.startSelectionMove(event),
			selectionChanged: () => this.refresh(),
			defaultLabelT: () => this.settings.connectorLabelPosition,
		});
		this.connectorLayer.render();
	}
	/** Edit the label of the one selected line: a board connector's, or a native edge's. */
	private editSelectedConnectorLabel(): void {
		if (this.connectorLayer?.editSelectedLabel() === true) return;
		const id = this.selectedIds.length === 1 ? this.selectedIds[0] : undefined;
		if (id !== undefined) this.nativeEdgeLabels?.edit(id);
	}
	private updateNativeEdgeLabels(): void {
		// Persistence tests and some headless hosts expose a canvas root
		// without a DOM document; labels are only a visual enhancement.
		if(!this.root?.ownerDocument)return;
		this.nativeEdgeLabels??=new NativeEdgeLabels(this.root,{
			editable:id=>this.editAllowed("edit-text",[id]),
			move:(id,t)=>{
				this.authoring??=createCanvasAuthoring(this.view);
				const result=this.authoring.updateElementStyles([{id,connector:{labelT:t}}]);
				if(!result.ok)this.options.onNotice?.(firstProblem(result.diagnostics)??"Edge label could not be moved.");
				this.refresh();
			},
			edit:(id,label)=>{
				this.authoring??=createCanvasAuthoring(this.view);
				const result=this.authoring.updateEdgeLabel(id,label);
				if(!result.ok)this.options.onNotice?.(firstProblem(result.diagnostics)??"Edge label could not be edited.");
				this.refresh();
			},
		});
		const raw=this.currentRawDocument,edges=readRuntime(raw,"edges");
		const byId=new Map((Array.isArray(edges)?edges:[]).filter(isRecord).map(edge=>[readRuntime(edge,"id"),edge]));
		const geometry=this.landingGeometry().geometry;
		const items:NativeEdgeLabel[]=[];
		for(const edge of this.adapter.getEdges()??[]){
			const id=readCanvasElementId(edge),rawEdge=id===undefined?undefined:byId.get(id);
			if(!id||!rawEdge)continue;
			const value=readRuntime(rawEdge,"label"),label=typeof value==="string"?value:"";
			const override=readRuntime(readRuntime(readRuntime(raw,"miroCanvas"),"localOverrides"),id);
			const connector=readRuntime(override,"connector");
			const labelT=readRuntime(connector,"labelT");
			const dom=readCanvasElementDom(edge)??readRuntime(edge,"edgeEl");
			const query=readRuntime(dom,"querySelector");
			const found=typeof query==="function"?Reflect.apply(query,dom,[".canvas-edge-label,.canvas-edge-label-wrapper"]):undefined;
			const native=[readRuntime(edge,"labelEl"),readRuntime(edge,"textEl"),found]
				.find(value=>isElement(value)&&isObject(readRuntime(value,"style")));
			const labelElement=(typeof HTMLElement!=="undefined"&&native instanceof HTMLElement)
				|| (typeof SVGElement!=="undefined"&&native instanceof SVGElement)?native as HTMLElement|SVGElement:undefined;
			const route=geometry.edges?.[id];
			const points=(route?.points??(route?.start&&route.end?[route.start,route.end]:[]))
				.map(point=>this.viewportPoint(point)).filter((point):point is {x:number;y:number}=>point!==undefined);
			if(points.length<2)continue;
			items.push({id,text:label,points,t:typeof labelT==="number"&&labelT>=0&&labelT<=1?labelT:this.settings.connectorLabelPosition,native:labelElement});
		}
		this.nativeEdgeLabels.update(items);
	}
	private writeBoardConnectors(items: BoardConnector[], remove: string[] = [], expected?: BoardConnector): boolean {
		this.currentRawDocument = this.adapter.getDocument();
		this.readInteractionState();
		if (expected && JSON.stringify(boardConnectors(this.currentRawDocument).find(c => c.id === expected.id)) !== JSON.stringify(expected)) {
			this.options.onNotice?.("Connector move was cancelled because the connector changed during the drag.");
			this.refresh();
			return false;
		}
		if (!this.editAllowed("edit",[...items.map(c=>c.id),...remove])) return false;
		const old = boardConnectors(this.currentRawDocument);
		const next = old.filter(c=>!remove.includes(c.id) && !items.some(item=>item.id===c.id)).concat(items);
		const geometry = buildCanvasAnchorGeometry(this.currentRawDocument);
		const routes = connectorRoutes(old,geometry);
		const detached = next.map(c => {
			const route=routes.get(c.id);
			const end=(a:CanvasAnchor,p:{x:number;y:number}|undefined):CanvasAnchor=>a.type==="edge"&&remove.includes(a.edgeId)&&p?{type:"free",x:p.x,y:p.y}:a;
			return {...c,from:end(c.from,route?.start),to:end(c.to,route?.end)};
		});
		const changed = detached.filter(c=>JSON.stringify(c)!==JSON.stringify(old.find(o=>o.id===c.id)));
		if (changed.length && !this.editAllowed("edit",changed.map(c=>c.id))) return false;
		const metadata=readRuntime(this.currentRawDocument,"miroCanvas");
		const overrides={...(isRecord(metadata)&&isRecord(metadata.localOverrides)?metadata.localOverrides:{})};
		for (const [id,value] of Object.entries(overrides)) {
			if (!isRecord(value) || !isRecord(value.connectorAnchors)) continue;
			const anchors={...value.connectorAnchors};let edited=false;
			for (const end of ["from","to"] as const) {
				const a=anchors[end]; const route=geometry.edges?.[id]; const p=end==="from"?route?.start:route?.end;
				if(isRecord(a)&&a.type==="edge"&&remove.includes(a.edgeId as string)) {
					if(!p || !this.editAllowed("edit",[id])) return false;
					anchors[end]={type:"free",x:p.x,y:p.y};edited=true;
				}
			}
			if(edited)overrides[id]={...value,connectorAnchors:anchors};
		}
		const connectors=Object.fromEntries(detached.map(c=>[c.id,c]));
		const proposed={...(isRecord(this.currentRawDocument)?this.currentRawDocument:{}),miroCanvas:{...(isRecord(metadata)?metadata:{}),connectors,localOverrides:overrides}};
		const nextGeometry=buildCanvasAnchorGeometry(proposed);
		if (detached.some(c=>nextGeometry.edges?.[c.id]===undefined)) {this.options.onNotice?.("Connector target is missing or would create a cycle.");return false;}
		return this.writeMetadata("board-connectors",draft=>{draft.connectors=connectors;draft.localOverrides=overrides;})?.ok === true;
	}
	public readonly kind = "miro-canvas-m1-session" as const;
	public readonly view: unknown;
	public readonly adapter: CanvasAdapter;
	public readonly viewport: ViewportController;
	public readonly controls: M1Controls;
	public readonly toolbar: SelectionToolbar;
	public readonly handles: SelectionHandles;
	public readonly commentMarkers: CommentMarkers | undefined;

	private writer: MetadataWriter | null;
	private readonly options: M1SessionOptions;
	private readonly settings: MiroCanvasSettings;
	private readonly disposers: Array<() => void> = [];
	private readonly sourceRenderer: SourceRenderer | undefined;
	private slideShow: SlideShow | undefined;
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
	private commentMovePreview: Record<string, unknown> | undefined;
	private appearance: AppearanceState = normalizeAppearanceState(undefined);
	private policy: InteractionPolicy = createInteractionPolicy(undefined);
	private selectedIds: readonly string[] = [];
	private selectedCommentKeys = new Set<string>();
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
	private rotationPreview: { readonly id: string; readonly rotation: number } | undefined;
	private rotationGestureTarget: string | undefined;
	/** What the last rotation gesture actually did, for the selection dump. */
	private lastRotationAttempt = "none";
	/** Geometry for placing connector ends, kept while the document is the same object. */
	private landingCache: { readonly document: unknown; readonly geometry: AnchorGeometry; readonly scene: SourceScene } | undefined;
	private lastToolbarSignature = "";
	private lastToolbarState: SelectionToolbarState | undefined;
	/** Until when a click is the tail of a reshape drag rather than a click of its own. */
	private swallowClickUntil = 0;
	/** The node a resize gesture is changing, and the box to put back if it is cancelled. */
	private resizeGesture: {
		readonly id: string;
		readonly node: unknown;
		readonly before: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
	} | undefined;
	/** Observer moving the overlays with native pans, zooms and drags between refreshes. */
	private followObserver: { observe(target: unknown, options: unknown): void; disconnect(): void } | undefined;
	private followTargets: readonly unknown[] = [];
	/** Shape kind of each selected element, kept while the document is the same object. */
	private shapeCache: { readonly document: unknown; readonly shapes: Map<string, string | undefined> } | undefined;
	private commentThreadCache: { readonly document: unknown; readonly threads: ReturnType<typeof listCommentThreads> } | undefined;
	private commentCard: CommentThreadCard | undefined;
	private openThread: { readonly id: string; readonly origin: CommentOrigin } | undefined;
	/** Where a comment being written will be pinned. */
	private commentDraft: CanvasAnchor | undefined;
	private readonly quickTools: QuickTools | undefined;
	private armedTool: QuickTool = "select";
	private toolShape = "rectangle";
	/** Where the pointer last was over the board, and when: a paste lands there. */
	private lastPointer: { readonly x: number; readonly y: number; readonly at: number } | undefined;
	private panGestureEnd: (() => void) | undefined;
	private suppressContextUntil = 0;
	/** A polyline or spline being placed a click at a time. */
	private linePlacing: {
		readonly spec: LineKindSpec;
		readonly points: StrokePoint[];
		readonly place: (point: { readonly x: number; readonly y: number }, straight: boolean) => void;
		readonly finish: () => void;
	} | undefined;
	/** The pen writes in the board's own ink until a colour is picked. */
	private penColor: string | undefined;
	private penWidth = 5;
	/** How wide the erasers are, in screen pixels. */
	private eraserSize = 32;
	/** The circle that shows where a pen or an eraser will act. */
	private brush: HTMLElement | undefined;
	/** The board points a pen gesture has passed through, and what it erases. */
	private penPoints: StrokePoint[] = [];
	private penPressures: number[] = [];
	private erasing = new Set<string>();
	/** When a stylus was last used here, and whether one has been seen at all. */
	private lastPenAt = 0;
	private stylusSeen = false;
	/** A tool being used on the board: where the press began and what it draws meanwhile. */
	private toolGesture: {
		readonly tool: QuickTool;
		readonly start: { readonly x: number; readonly y: number };
		readonly from?: { readonly nodeId: string; readonly anchor: CanvasAnchor; readonly board: { readonly x: number; readonly y: number } };
		readonly ghost: HTMLElement;
		readonly end: () => void;
	} | undefined;
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
			getDocument: () => this.commentMovePreview ?? this.selectionMovePreview ?? this.adapter.getDocument(),
			getNodes: () => this.adapter.getNodes(),
			getEdges: () => this.adapter.getEdges(),
			getSelectionMovePreviewIds: () => this.selectionMovePreview === undefined ? undefined : this.selectionMoveIds,
			getRotationPreview: () => this.rotationPreview,
			onDeckAction: (deckId, action) => this.runDeckAction(deckId, action),
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
			openSourceInspector: () => this.openSourceInspector(),
			...(options.onOpenSettings === undefined ? {} : { openSettings: options.onOpenSettings }),
		};
		const controlDocument = options.document ?? ownerDocument(this.root);
		this.controls = new M1Controls(actions, {
			...(controlDocument === undefined ? {} : { document: controlDocument }),
			...(options.setIcon === undefined ? {} : { setIcon: options.setIcon }),
		});
		this.toolbar = new SelectionToolbar({
			onAppearance: (action) => this.applyAppearance(action),
			onStyle: (patch) => this.applyElementStyle(patch),
			onEditConnectorLabel: () => {this.editSelectedConnectorLabel();},
			onDelete: () => this.deleteBoardSelection(),
			onLock: (locked) => (locked ? this.lockSelection() : this.unlockSelection()),
			onOpenLink: () => this.openSelectedLink(),
		}, {
			...(controlDocument === undefined ? {} : { document: controlDocument }),
			...(options.setIcon === undefined ? {} : { setIcon: options.setIcon }),
		});
		this.handles = new SelectionHandles({
			onRotate: (degrees, commit) => this.applyHandleRotation(degrees, commit),
			onCancelRotation: () => this.cancelHandleRotation(),
			onConnect: (sourceId, side, position, point) => this.applyHandleConnection(sourceId, side, position, point),
			onCreateConnected: (sourceId, side, position) => this.createConnectedNode(sourceId, side, position),
			onMoveEndpoint: (edgeId, end, point) => this.moveConnectorEnd(edgeId, end, point),
			previewEnd: (gesture, point) => this.previewLanding(gesture, point),
			onResize: (rect, commit) => this.applyHandleResize(rect, commit),
			onCancelResize: () => this.cancelHandleResize(),
			previewRoute: (edgeId, grip, point) => this.previewReshape(edgeId, grip, point),
			onCancelRoutePreview: edgeId => {this.activeNativeRouteDragId=undefined;this.nativeEdgeLabels?.clearPreview(edgeId);this.updateNativeEdgeLabels();},
			onReshape: (edgeId, grip, point) => this.reshapeConnector(edgeId, grip, point),
			onStraighten: (edgeId, grip) => this.straightenConnector(edgeId, grip),
		}, { document: controlDocument });
		this.commentMarkers = controlDocument === undefined ? undefined : new CommentMarkers({
			onOpenThread: (threadId, origin) => this.openCommentThread(threadId, origin),
			onMoveThread: (threadId, origin, point) => this.moveCommentThread(threadId, origin, point),
			onPreviewThreadMove: (threadId, origin, point) => this.previewCommentMove(threadId, origin, point),
			onCancelThreadMove: () => this.cancelCommentMove(),
		}, { document: controlDocument });
		this.quickTools = controlDocument === undefined ? undefined : new QuickTools({
			onArm: (tool) => this.armTool(tool),
			onShape: (shape) => {
				const wasBlock = lineKind(this.toolShape)?.block === true;
				const isBlock = lineKind(shape)?.block === true;
				if (wasBlock !== isBlock) {
					if (wasBlock) this.blockConnectorWidth = this.connectorWidth;
					else this.ordinaryConnectorWidth = this.connectorWidth;
					this.connectorWidth = isBlock ? this.blockConnectorWidth : this.ordinaryConnectorWidth;
				}
				this.toolShape = shape;
				this.updateQuickTools();
			},
			onConnector: settings => {this.connectorColor=settings.color??this.connectorColor;this.connectorWidth=settings.width??this.connectorWidth;this.connectorHeadSize=settings.headSize??this.connectorHeadSize;this.updateQuickTools();},
			onPen: (settings) => {
				if (settings.color !== undefined) this.penColor = settings.color;
				if (settings.width !== undefined) this.penWidth = settings.width;
				if (settings.eraserSize !== undefined) this.eraserSize = settings.eraserSize;
				this.updateQuickTools();
			},
		}, {
			document: controlDocument,
			...(options.setIcon === undefined ? {} : { setIcon: options.setIcon }),
		});
	}

	/**
	 * Shape, border and connector settings are the one appearance family the
	 * metadata writer cannot express, so they go through the guarded authoring
	 * transaction instead. Every selected element is patched in one graph commit.
	 */
	/**
	 * A drag previews by rotating the decoration in place; only the release
	 * writes, so a gesture produces one native history entry instead of dozens.
	 */
	private applyHandleRotation(degrees: number, commit: boolean): void {
		const id = commit ? this.rotationGestureTarget ?? this.selectedIds[0] : this.selectedIds[0];
		if (id === undefined) {
			if (commit) this.cancelHandleRotation();
			return;
		}
		if (!commit) {
			this.rotationGestureTarget = id;
			this.previewRotation(id, degrees);
			return;
		}
		this.rotationPreview = undefined;
		this.rotationGestureTarget = undefined;
		this.setElementRotation(id, degrees);
	}

	/** Persist one absolute angle without rebuilding the host-owned graph. */
	public setElementRotation(id: string, degrees: number): MetadataWriteResult | undefined {
		if (!Number.isFinite(degrees)) {
			this.addDiagnostic("Rotation must be a finite number.");
			this.refresh();
			return undefined;
		}
		this.readInteractionState();
		if (!this.editAllowed("restyle", [id])) {
			this.lastRotationAttempt = `write ${id} blocked by policy`;
			this.refresh();
			return undefined;
		}
		const rotation = normalizeAngle(degrees);
		this.lastRotationAttempt = `write ${id} ${Math.round(rotation)}`;
		const written = this.writeMetadata("set-rotation", (draft) => {
			const overrides: Record<string, unknown> = isRecord(draft.localOverrides) ? { ...draft.localOverrides } : {};
			const override = isRecord(overrides[id]) ? { ...overrides[id] } : {};
			override.rotation = rotation;
			overrides[id] = override;
			draft.localOverrides = overrides;
		});
		this.lastRotationAttempt = `write ${id} ${Math.round(rotation)} -> ${written?.status ?? "no writer"}`;
		return written;
	}

	private previewRotation(id: string, degrees: number): void {
		this.rotationPreview = { id, rotation: degrees };
		this.sourceRenderer?.refresh();
		this.connectorLayer?.render();
		this.updateCommentMarkers();
		this.handles.update(this.handlesState(true));
	}

	private cancelHandleRotation(): void {
		if (this.rotationPreview === undefined && this.rotationGestureTarget === undefined) return;
		this.rotationPreview = undefined;
		this.rotationGestureTarget = undefined;
		this.sourceRenderer?.refresh();
		this.refresh();
	}

	/**
	 * Resize the selected node to a box the handles drew.
	 *
	 * The drag previews through native Canvas itself, so the node, its edges
	 * and its snapping all follow the pointer the way a native resize does,
	 * and only the release saves - one native history entry per gesture.  The
	 * box stays unturned: the node keeps its angle about its new centre.
	 */
	private applyHandleResize(rect: HandleRect, commit: boolean): void {
		let gesture = this.resizeGesture;
		if (gesture === undefined) {
			const id = this.selectedIds[0];
			const node = id === undefined
				? undefined
				: [...(this.adapter.getNodes() ?? [])].find((item) => readCanvasElementId(item) === id);
			if (id === undefined || node === undefined) return;
			this.readInteractionState();
			if (!this.editAllowed("resize", [id])) {
				this.refresh();
				return;
			}
			const before = {
				x: finite(readRuntime(node, "x")), y: finite(readRuntime(node, "y")),
				width: finite(readRuntime(node, "width")), height: finite(readRuntime(node, "height")),
			};
			if (before.x === undefined || before.y === undefined || before.width === undefined || before.height === undefined) return;
			gesture = { id, node, before: { x: before.x, y: before.y, width: before.width, height: before.height } };
			this.resizeGesture = gesture;
		}
		const box = this.boardBox(rect);
		if (box !== undefined) this.resizeNode(gesture.node, box);
		if (!commit) return;
		this.resizeGesture = undefined;
		this.adapter.requestSave();
		this.refresh();
	}

	private cancelHandleResize(): void {
		const gesture = this.resizeGesture;
		if (gesture === undefined) return;
		this.resizeGesture = undefined;
		this.resizeNode(gesture.node, gesture.before);
		this.adapter.requestSave();
		this.refresh();
	}

	private resizeNode(node: unknown, box: { readonly x: number; readonly y: number; readonly width: number; readonly height: number }): void {
		const moveAndResize = readRuntime(node, "moveAndResize");
		if (typeof moveAndResize !== "function") {
			this.addDiagnostic("Canvas cannot resize this node.");
			return;
		}
		try {
			Reflect.apply(moveAndResize, node, [box]);
		} catch {
			this.addDiagnostic("Canvas refused to resize this node.");
		}
	}

	/** The board box under an unturned overlay-local box. */
	private boardBox(rect: HandleRect): { readonly x: number; readonly y: number; readonly width: number; readonly height: number } | undefined {
		const origin = this.overlayOrigin();
		const zoom = finite(readRuntime(this.viewport.getViewport(), "zoom"));
		if (origin === undefined || zoom === undefined || !(zoom > 0)) return undefined;
		const centre = this.boardPoint({
			x: origin.left + rect.left + rect.width / 2,
			y: origin.top + rect.top + rect.height / 2,
		});
		if (centre === undefined) return undefined;
		const width = rect.width / zoom, height = rect.height / zoom;
		return { x: centre.x - width / 2, y: centre.y - height / 2, width, height };
	}

	/** A connector's route as the anchoring geometry planned it, with the ends it was planned from. */
	private plannedRoute(edgeId: string): (PlannedRoute & {
		readonly ends: { readonly from: RouteEnd; readonly to: RouteEnd };
		readonly imported: boolean;
	}) | undefined {
		const drawn = this.lineOf(edgeId);
		if (drawn !== undefined) {
			const plan = planLine(drawn.route, drawn.points);
			return { ...plan, ends: { from: { point: plan.start }, to: { point: plan.end } }, imported: false };
		}
		const geometry = this.landingGeometry().geometry.edges?.[edgeId] as Record<string, unknown> | undefined;
		if (geometry === undefined || !Array.isArray(geometry.corners) || !Array.isArray(geometry.segments)
			|| !isObject(geometry.ends) || typeof geometry.route !== "string") return undefined;
		return geometry as unknown as ReturnType<M1CanvasSession["plannedRoute"]>;
	}

	/** Where the selected connector's route can be grabbed, in overlay pixels. */
	private routeGrips(edgeId: string): RouteGrip[] | undefined {
		// A block arrow runs straight from tail to tip: only its ends move.
		if (this.lineOf(edgeId)?.line.block === true) return [];
		const plan = this.plannedRoute(edgeId);
		const origin = this.overlayOrigin();
		if (plan === undefined || origin === undefined) return undefined;
		return routeHandles(plan).flatMap((handle): RouteGrip[] => {
			const at = this.viewportPoint(handle.point);
			if (at === undefined) return [];
			const place = { index: handle.index, x: at.x - origin.left, y: at.y - origin.top };
			return [handle.kind === "segment" ? { kind: "segment", axis: handle.axis, ...place } : { kind: handle.kind, ...place }];
		});
	}

	/**
	 * The bends a connector would have with one grip dragged to a viewport
	 * point.  A waypoint dropped back on the line between its neighbours
	 * goes, and an elbowed route loses corners that no longer turn.
	 */
	private reshapedBends(
		edgeId: string, grip: RouteGrip, point: { readonly x: number; readonly y: number },
	): { readonly plan: NonNullable<ReturnType<M1CanvasSession["plannedRoute"]>>; readonly bends: { x: number; y: number }[] } | undefined {
		const plan = this.plannedRoute(edgeId);
		const board = this.boardPoint(point);
		if (plan === undefined || board === undefined) return undefined;
		const { from, to } = plan.ends;
		const bends = routeBends(plan);
		if (grip.kind === "segment") {
			if (plan.route !== "elbowed") return undefined;
			const moved = moveElbowSegment(from, to, bends, grip.index, grip.axis === "x" ? board.x : board.y);
			return { plan, bends: simplifyCorners([from.point, ...moved, to.point]).slice(1, -1) };
		}
		const zoom = finite(readRuntime(this.viewport.getViewport(), "zoom")) ?? 1;
		return {
			plan,
			bends: placeWaypoint(from.point, to.point, bends, grip.index, board, {
				insert: grip.kind === "insert",
				straighten: STRAIGHTEN_DISTANCE / (zoom > 0 ? zoom : 1),
			}),
		};
	}

	/** The route a drag would leave, in overlay pixels, for the handles to draw. */
	private previewReshape(
		edgeId: string, grip: RouteGrip, point: { readonly x: number; readonly y: number },
	): readonly { readonly x: number; readonly y: number }[] | undefined {
		const shaped = this.reshapedBends(edgeId, grip, point);
		const origin = this.overlayOrigin();
		if (shaped === undefined || origin === undefined) return undefined;
		const { plan, bends } = shaped;
		const route = planRoute(plan.ends.from, plan.ends.to, plan.route, bends, { imported: plan.imported });
		if(this.activeNativeRouteDragId!==edgeId){
			this.activeNativeRouteDragId=edgeId;
			this.updateNativeEdgeLabels();
		}
		this.nativeEdgeLabels?.preview(edgeId,route.points.flatMap(item=>{const at=this.viewportPoint(item);return at?[at]:[];}));
		return route.points.flatMap((item) => {
			const at = this.viewportPoint(item);
			return at === undefined ? [] : [{ x: at.x - origin.left, y: at.y - origin.top }];
		});
	}

	/**
	 * A press on a connector's line bends it there, as Miro does, instead of
	 * native Canvas pulling the nearest end loose - which deletes the edge when
	 * it is let go over empty board.  A click still reaches native Canvas and
	 * selects the connector; its ends move by their own grips.
	 */
	private grabConnectorLine(event: Event): void {
		if (readRuntime(event, "button") !== 0 || readRuntime(event, "shiftKey") === true || this.isSpacePanHeld()) return;
		if (!this.closestTarget(event, "path.canvas-interaction-path")) return;
		const target = eventTarget(event);
		const edge = [...(this.adapter.getEdges() ?? [])].find((item) => {
			const group = readRuntime(item, "lineGroupEl");
			const contains = readRuntime(group, "contains");
			try {
				return typeof contains === "function" && Reflect.apply(contains, group, [target]) === true;
			} catch {
				return false;
			}
		});
		const id = readCanvasElementId(edge);
		const x = finite(readRuntime(event, "clientX")), y = finite(readRuntime(event, "clientY"));
		if (edge === undefined || id === undefined || x === undefined || y === undefined) return;
		this.readInteractionState();
		if (!this.editAllowed("restyle", [id])) return;
		const plan = this.plannedRoute(id);
		const board = this.boardPoint({ x, y });
		const handle = plan === undefined || board === undefined ? undefined : gripNear(plan, board);
		if (handle === undefined) return;
		try {
			event.preventDefault();
			event.stopImmediatePropagation();
		} catch {
			// A test double may not stop propagation; the drag still starts.
		}
		if (this.selectedIds.length !== 1 || this.selectedIds[0] !== id) {
			this.adapter.invoke("selectOnly", edge);
			this.readInteractionState();
		}
		const grip: RouteGrip = handle.kind === "segment"
			? { kind: "segment", axis: handle.axis, index: handle.index, x, y }
			: { kind: handle.kind, index: handle.index, x, y };
		this.handles.grabRoute(id, grip, event);
	}

	/**
	 * A press on a line drawn on its own moves it, as a press on any node
	 * does.  Native Canvas starts that drag from the node's inner container,
	 * which a line lets presses through; only its course takes them, so the
	 * press is handed on to the node from there.
	 */
	private grabDrawnLine(event: Event): void {
		const hit = this.closestTarget(event, ".miro-source-line-hit");
		if (!hit) return;
		const target = eventTarget(event);
		const node = [...(this.adapter.getNodes() ?? [])].find((item) => {
			const element = readRuntime(item, "nodeEl");
			const contains = readRuntime(element, "contains");
			try {
				return typeof contains === "function" && Reflect.apply(contains, element, [target]) === true;
			} catch {
				return false;
			}
		});
		const press = readRuntime(node, "onPointerdown");
		if (typeof press !== "function") return;
		try {
			Reflect.apply(press, node, [event]);
		} catch {
			// A host without the native drag leaves the line where it is.
		}
	}

	private reshapeConnector(edgeId: string, grip: RouteGrip, point: { readonly x: number; readonly y: number }): void {
		this.activeNativeRouteDragId=undefined;
		this.nativeEdgeLabels?.clearPreview(edgeId);
		// The release that ends a drag must not also click the board clear.
		this.swallowClickUntil = Date.now() + 400;
		const shaped = this.reshapedBends(edgeId, grip, point);
		if (shaped === undefined) {
			this.refresh();
			return;
		}
		this.writeBends(edgeId, shaped.plan.route, shaped.bends);
	}

	/** A double-clicked waypoint goes; a double-clicked elbowed segment lets the route find its own way again. */
	private straightenConnector(edgeId: string, grip: RouteGrip): void {
		const plan = this.plannedRoute(edgeId);
		if (plan === undefined) return;
		this.writeBends(edgeId, plan.route, grip.kind === "waypoint" ? removeWaypoint(routeBends(plan), grip.index) : []);
	}

	/**
	 * Store a connector's bends together with its route, so the bends keep
	 * describing the same kind of line whatever the default becomes.
	 */
	private writeBends(edgeId: string, route: PlannedRoute["route"], bends: readonly { readonly x: number; readonly y: number }[]): void {
		const drawn = this.lineOf(edgeId);
		if (drawn !== undefined) {
			const points = drawn.points;
			this.writeLine(edgeId, [points[0]!, ...bends, points[points.length - 1]!]);
			return;
		}
		this.readInteractionState();
		if (!this.editAllowed("restyle", [edgeId])) {
			this.refresh();
			return;
		}
		const waypoints = bends.slice(0, MAX_WAYPOINTS).map((point) => ({
			x: Math.round(point.x * 100) / 100,
			y: Math.round(point.y * 100) / 100,
		}));
		this.authoring ??= createCanvasAuthoring(this.view);
		const result = this.authoring.updateElementStyles([{ id: edgeId, connector: { route, waypoints } }]);
		if (!result.ok) this.addDiagnostic(firstProblem(result.diagnostics) ?? "Canvas rejected the new connector shape.");
		this.refresh();
	}

	/** A connection released on the board: onto a node, or into free space. */
	private applyHandleConnection(
		sourceId: string,
		side: HandleSide,
		position: number,
		point: { readonly x: number; readonly y: number },
	): void {
		this.readInteractionState();
		const landing = this.connectorLanding(point, sourceId, this.pulledFrom(sourceId, side, position));
		if (landing === undefined) {
			this.addDiagnostic("The connector could not be placed at that point.");
			this.refresh();
			return;
		}
		// A native Canvas edge joins two nodes, so a connector dropped in free
		// space brings its node along - as native Canvas and Miro both offer.
		if (landing.nodeId === undefined) {
			this.createConnectedNode(sourceId, side, position, landing.board);
			return;
		}
		this.createEdge(sourceId, landing.nodeId, side, position, landing.anchor);
	}

	/** The board point under a viewport point. */
	private boardPoint(point: { readonly x: number; readonly y: number }): { readonly x: number; readonly y: number } | undefined {
		const rootRect = boundingRect(this.root);
		const displayed=this.displayViewport(), size=clientSize(this.root);
		if(displayed && this.viewport.coordinateMode==="center") return {x:(point.x-(rootRect?.left??0)-size.width/2)/displayed.zoom+displayed.x,y:(point.y-(rootRect?.top??0)-size.height/2)/displayed.zoom+displayed.y};
		return this.viewport.screenToBoard({ x: point.x - (rootRect?.left ?? 0), y: point.y - (rootRect?.top ?? 0) });
	}
	/** Native target camera animates toward x/y/zoom. Overlays follow the displayed camera. */
	private displayViewport(): ViewportTransform | undefined {
		const viewport=this.viewport.getViewport();
		if(this.viewport.coordinateMode!=="center")return viewport;
		const canvas=this.nativeCanvas(), x=finite(readRuntime(canvas,"x")),y=finite(readRuntime(canvas,"y")),logZoom=finite(readRuntime(canvas,"zoom"));
		const zoom=logZoom===undefined?undefined:2**logZoom;
		return viewport && x!==undefined && y!==undefined && zoom!==undefined && Number.isFinite(zoom) && zoom>0 ? {...viewport,x,y,zoom} : viewport;
	}

	/** The viewport point over a board point. */
	private viewportPoint(point: { readonly x: number; readonly y: number }): { readonly x: number; readonly y: number } | undefined {
		const rootRect = boundingRect(this.root);
		const displayed=this.displayViewport(), size=clientSize(this.root);
		if(displayed && this.viewport.coordinateMode==="center") return {x:(point.x-displayed.x)*displayed.zoom+size.width/2+(rootRect?.left??0),y:(point.y-displayed.y)*displayed.zoom+size.height/2+(rootRect?.top??0)};
		const screen = this.viewport.boardToScreen(point);
		return screen === undefined ? undefined : { x: screen.x + (rootRect?.left ?? 0), y: screen.y + (rootRect?.top ?? 0) };
	}

	/** Node boxes, silhouettes and routes of the current document, measured once per document. */
	private landingGeometry(): { readonly geometry: AnchorGeometry; readonly scene: SourceScene } {
		const document = this.commentMovePreview ?? this.currentRawDocument;
		const preview = this.rotationPreview;
		if (preview) return {geometry: buildCanvasAnchorGeometry(document, {[preview.id]: {rotation: preview.rotation}}), scene: buildSourceScene(document)};
		let cache = this.landingCache;
		if (cache === undefined || cache.document !== document) {
			cache = { document, geometry: buildCanvasAnchorGeometry(document), scene: buildSourceScene(document) };
			const independent = connectorRoutes(boardConnectors(document),cache.geometry);
			cache = {...cache,geometry:{...cache.geometry,edges:{...cache.geometry.edges,...Object.fromEntries([...independent].map(([id,r])=>[id,{start:r.start,end:r.end,points:r.points}]))}}};
			this.landingCache = cache;
		}
		return cache;
	}

	/** The board point a connector pulled from a selection point starts at. */
	private pulledFrom(nodeId: string, side: HandleSide, position: number): { readonly x: number; readonly y: number } | undefined {
		const { geometry, scene } = this.landingGeometry();
		const rect = geometry.nodes?.[nodeId];
		const anchor = rect === undefined ? undefined : sideAnchorOnOutline(nodeId, shapeOutline(scene.items.get(nodeId)?.shape), side, position);
		return anchor === undefined || rect === undefined ? undefined : resolveAnchor(anchor, { nodes: { [nodeId]: rect } }).point;
	}

	/**
	 * Where a connector end lands for a viewport point.
	 *
	 * Within the magnet distance of a node's outline - or anywhere inside the
	 * node - the end attaches to it: at the closest outline point, snapped onto
	 * a standard point within the snap distance, or, dropped deep inside, at
	 * the standard point facing the other end.  Anywhere else it stays free
	 * where it was dropped.  The live preview and the drop both ask here, so
	 * an end lands exactly where it was shown.
	 */
	private connectorLanding(
		point: { readonly x: number; readonly y: number },
		exclude: string | undefined,
		toward: { readonly x: number; readonly y: number } | undefined,
		excludeEdge?: string,
	): { readonly board: { readonly x: number; readonly y: number }; readonly anchor: CanvasAnchor; readonly nodeId?: string } | undefined {
		const board = this.boardPoint(point);
		if (board === undefined) return undefined;
		const { geometry, scene } = this.landingGeometry();
		const zoom = finite(readRuntime(this.viewport.getViewport(), "zoom")) ?? 1;
		const magnet = this.settings.connectorMagnet / zoom;
		const snap = this.settings.connectorSnap / zoom;
		// Comment pins are screen-sized targets, independent of their text card.
		if (this.settings.connectorAttachNodes) {
			let closest: {key: string; point: {x: number;y: number}; distance: number} | undefined;
			for (const [key, at] of Object.entries(geometry.comments ?? {})) {
				const distance = Math.hypot(at.x-board.x, at.y-board.y);
				if (distance <= (14 / zoom + magnet) && (!closest || distance < closest.distance)) closest = {key, point: at, distance};
			}
			if (closest) {
				const colon = closest.key.indexOf(":");
				return {board: closest.point, anchor: {type: "comment", origin: closest.key.slice(0, colon) as CommentOrigin, commentId: closest.key.slice(colon+1)}};
			}
		}
		let best: {
			readonly nodeId: string; readonly anchor: CanvasAnchor;
			readonly distance: number; readonly inside: boolean; readonly area: number;
		} | undefined;
		for (const [nodeId, rect] of Object.entries(this.settings.connectorAttachNodes ? geometry.nodes ?? {} : {})) {
			if (nodeId === exclude || !(rect.width > 0) || !(rect.height > 0)) continue;
			const reach = Math.hypot(rect.width, rect.height) / 2 + magnet;
			if (Math.hypot(board.x - (rect.x + rect.width / 2), board.y - (rect.y + rect.height / 2)) > reach) continue;
			const outline = shapeOutline(scene.items.get(nodeId)?.shape);
			const closest = boundaryAnchorOnRect(nodeId, rect, outline, board);
			const at = closest === undefined ? undefined : resolveAnchor(closest, { nodes: { [nodeId]: rect } }).point;
			if (closest === undefined || at === undefined) continue;
			const distance = Math.hypot(at.x - board.x, at.y - board.y);
			const inside = insideRect(rect, board);
			if (!inside && distance > magnet) continue;
			const facing = inside && distance > magnet && toward !== undefined ? facingSideOfRect(rect, toward) : undefined;
			const anchor = facing === undefined
				? snapToStandardPoint(closest, rect, outline, snap)
				: sideAnchorOnOutline(nodeId, outline, facing, 0.5) ?? closest;
			const area = rect.width * rect.height;
			// The node the pointer is in wins over a neighbour it is only near,
			// and the smallest such node over a group around it.
			if (best === undefined || (inside && !best.inside)
				|| (inside === best.inside && (inside ? area < best.area : distance < best.distance))) {
				best = { nodeId, anchor, distance, inside, area };
			}
		}
		// A dragged native endpoint may attach anywhere along another edge's
		// route. Store its parameter, not a fixed point or the target's style.
		if (this.settings.connectorAttachConnectors && excludeEdge !== undefined && !best?.inside) {
			let nearest: { distance: number; anchor: CanvasAnchor; board: { x: number; y: number } } | undefined;
			for (const edgeId of Object.keys(geometry.edges ?? {})) {
				if (edgeId === excludeEdge) continue;
				const candidate = edgeLanding(edgeId, geometry.edges![edgeId]!, board);
				if (candidate !== undefined && candidate.distance <= magnet && (nearest === undefined || candidate.distance < nearest.distance)) nearest = candidate;
			}
			if (nearest !== undefined && (best === undefined || nearest.distance < best.distance)) return nearest;
		}
		if (best === undefined) return this.settings.connectorAllowFree ? { board, anchor: { type: "free", x: board.x, y: board.y } } : undefined;
		const rect = geometry.nodes![best.nodeId]!;
		const at = resolveAnchor(best.anchor, { nodes: { [best.nodeId]: rect } }).point;
		return { board: at === undefined ? board : { x: at.x, y: at.y }, anchor: best.anchor, nodeId: best.nodeId };
	}

	/** The node and point at the end of a connector opposite `end`. */
	private oppositeEnd(edgeId: string, end: "from" | "to"): { readonly nodeId?: string; readonly point?: { readonly x: number; readonly y: number } } {
		const other = end === "from" ? "to" : "from";
		const document = this.currentRawDocument;
		const edges = readRuntime(document, "edges");
		const edge = Array.isArray(edges) ? (edges as readonly unknown[]).find((item) => readRuntime(item, "id") === edgeId) : undefined;
		const stored = readRuntime(readRuntime(readRuntime(readRuntime(document, "miroCanvas"), "localOverrides"), edgeId), "connectorAnchors");
		const free = readRuntime(readRuntime(stored, other), "type") === "free";
		const nodeId = readRuntime(edge, `${other}Node`);
		const route = this.landingGeometry().geometry.edges?.[edgeId];
		const point = other === "to" ? route?.end : route?.start;
		return {
			...(free || typeof nodeId !== "string" ? {} : { nodeId }),
			...(point === undefined ? {} : { point }),
		};
	}

	/** Where a pulled connector or a dragged end would land, for the live preview. */
	private previewLanding(
		gesture: ConnectorGesture,
		point: { readonly x: number; readonly y: number },
	): { readonly x: number; readonly y: number } | undefined {
		let landing: ReturnType<M1CanvasSession["connectorLanding"]>;
		if (gesture.kind === "connect") {
			landing = this.connectorLanding(point, gesture.sourceId, this.pulledFrom(gesture.sourceId, gesture.side, gesture.position));
		} else {
			if (this.lineOf(gesture.edgeId) !== undefined) return point;
			const other = this.oppositeEnd(gesture.edgeId, gesture.end);
			landing = this.connectorLanding(point, other.nodeId, other.point, gesture.edgeId);
		}
		return landing === undefined ? undefined : this.viewportPoint(landing.board);
	}

	private createEdge(
		fromNode: string,
		toNode: string,
		side: HandleSide,
		position = 0.5,
		toAnchor?: CanvasAnchor,
		documentOverride?: unknown,
	): void {
		this.readInteractionState();
		this.authoring ??= createCanvasAuthoring(this.view);
		const anchorDocument = documentOverride ?? this.currentRawDocument;
		const geometry = buildCanvasAnchorGeometry(anchorDocument);
		// The connector leaves exactly where it was pulled from.
		const fromAnchor = nodeBoundaryAnchorAtSide(anchorDocument, fromNode, side, position);
		const fromPoint = fromAnchor === undefined ? undefined : resolveAnchor(fromAnchor, geometry).point;
		const facing = fromPoint === undefined ? undefined : facingSide(anchorDocument, toNode, fromPoint);
		const target = toAnchor
			?? (facing === undefined ? undefined : nodeBoundaryAnchorAtSide(anchorDocument, toNode, facing, 0.5));
		if (fromAnchor === undefined || target === undefined) {
			this.addDiagnostic(`A connector endpoint could not be measured on the node outline (${fromAnchor === undefined ? fromNode : toNode}).`);
		}
		const nativeSide = (anchor: CanvasAnchor | undefined, fallback: HandleSide): ConnectorSide => {
			if (anchor?.type !== "node") return fallback as ConnectorSide;
			const candidates: readonly [ConnectorSide, number][] = [
				["top", anchor.v], ["right", 1 - anchor.u], ["bottom", 1 - anchor.v], ["left", anchor.u],
			];
			return candidates.reduce((best, candidate) => candidate[1] < best[1] ? candidate : best)[0];
		};
		const result = this.authoring.createConnector({
			fromNode, toNode,
			fromSide: nativeSide(fromAnchor, side),
			toSide: nativeSide(target, side === "top" ? "bottom" : side === "bottom" ? "top" : side === "left" ? "right" : "left"),
			...(fromAnchor === undefined ? {} : { fromAnchor }),
			...(target === undefined ? {} : { toAnchor: target }),
		});
		if (!result.ok) {
			this.addDiagnostic(firstProblem(result.diagnostics) ?? "Canvas rejected the new connector.");
		}
		this.refresh();
	}

	/**
	 * Move one end of a connector to where it was dropped.
	 *
	 * Near or on a node the end attaches to its outline; anywhere else it is
	 * left free at that point, while the edge keeps its node as the native
	 * fallback.  It never lands on the node the other end already holds.
	 */
	private moveConnectorEnd(edgeId: string, end: "from" | "to", point: { readonly x: number; readonly y: number }): void {
		const drawn = this.lineOf(edgeId);
		if (drawn !== undefined) {
			// A line's end goes where it is dropped; it holds on to nothing.
			const board = this.boardPoint(point);
			if (board !== undefined) {
				const points = [...drawn.points];
				points[end === "from" ? 0 : points.length - 1] = board;
				this.writeLine(edgeId, points);
			}
			return;
		}
		this.readInteractionState();
		const other = this.oppositeEnd(edgeId, end);
		const landing = this.connectorLanding(point, other.nodeId, other.point, edgeId);
		if (landing === undefined) {
			this.addDiagnostic("The connector end could not be placed at that point.");
			this.refresh();
			return;
		}
		this.authoring ??= createCanvasAuthoring(this.view);
		const result = this.authoring.updateConnectorEndpoint({ edgeId, end, anchor: landing.anchor });
		if (!result.ok) {
			this.addDiagnostic(firstProblem(result.diagnostics) ?? "Canvas rejected the connector end.");
			this.options.onNotice?.(firstProblem(result.diagnostics) ?? "Canvas rejected the connector end.");
		}
		this.refresh();
	}

	/** Where a selected connector's ends are, in the handle overlay's coordinates. */
	private connectorEnds(edgeId: string): SelectionHandlesState["endpoints"] {
		const drawn = this.lineOf(edgeId);
		const route = drawn === undefined
			? this.landingGeometry().geometry.edges?.[edgeId]
			: { start: drawn.points[0], end: drawn.points[drawn.points.length - 1] };
		const overlay = this.overlayOrigin();
		if (route?.start === undefined || route.end === undefined || overlay === undefined) return undefined;
		const local = (point: { readonly x: number; readonly y: number }) => {
			const screen = this.viewportPoint(point);
			return screen === undefined ? undefined : { x: screen.x - overlay.left, y: screen.y - overlay.top };
		};
		const from = local(route.start), to = local(route.end);
		return from === undefined || to === undefined ? undefined : { from, to };
	}

	/**
	 * Place a node beside the selection, or where a pulled connector was
	 * dropped, and connect it, in that order.
	 */
	private createConnectedNode(
		fromNode: string,
		side: HandleSide,
		position: number = 0.5,
		at?: { readonly x: number; readonly y: number },
	): void {
		// The gesture pins its source across native selection changes, but the
		// node must still exist in the live document when the click commits.
		this.readInteractionState();
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
		// Beside the node, the new node goes the way the point faces now, not
		// the way the side faced before the node was turned: an upside-down
		// node's top point creates below it.  The new node itself stays upright.
		const gap = 80;
		const rotation = buildSourceScene(this.currentRawDocument).items.get(fromNode)?.rotation ?? this.rotationFor(fromNode);
		const direction = sideDirection(side, rotation);
		const reach = (side === "left" || side === "right" ? width : height) / 2
			+ gap + (Math.abs(direction.x) * width + Math.abs(direction.y) * height) / 2;
		const centerX = at?.x ?? x + width / 2 + direction.x * reach;
		const centerY = at?.y ?? y + height / 2 + direction.y * reach;
		this.authoring ??= createCanvasAuthoring(this.view);
		const created = this.authoring.createShape({
			shape: "rectangle", text: "", width, height,
			x: Math.round(centerX - width / 2), y: Math.round(centerY - height / 2),
		});
		if (!created.ok || created.nodeId === undefined) {
			this.addDiagnostic(firstProblem(created.diagnostics) ?? "Canvas rejected the connected node.");
			this.refresh();
			return;
		}
		this.createEdge(fromNode, created.nodeId, side, position, undefined, created.document);
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
		const lines = this.selectedIds.filter((id) => this.lineOf(id) !== undefined);
		const independent=boardConnectors(this.currentRawDocument).filter(c=>this.selectedIds.includes(c.id));
		if(independent.length && patch.connector){
			const {route,color,...style}=patch.connector;
			this.writeBoardConnectors(independent.map(c=>restyleBoardConnector(c,{...style,...(route?{route,...(route!==c.route?{waypoints:[]}: {})}:{}),...(typeof color==="string"?{color}: {})})));
		}
		if (lines.length > 0) this.restyleLines(lines, patch);
		const others = this.selectedIds.filter((id) => !lines.includes(id) && !independent.some(c=>c.id===id));
		if (others.length === 0) {
			this.refresh();
			return;
		}
		const result = this.authoring.updateElementStyles(others.map((id) => {
			// A connector changing its kind of route starts unbent: bends made for
			// one kind of line do not describe another.
			const route = patch.connector?.route;
			if (route === undefined || patch.connector?.waypoints !== undefined) return { id, ...patch };
			const current = resolveSelectionToolbarPresentation(this.currentRawDocument, id).style.connector?.route;
			return current === route ? { id, ...patch } : { id, ...patch, connector: { ...patch.connector, waypoints: [] } };
		}));
		if (!result.ok) {
			const reason = firstProblem(result.diagnostics);
			this.addDiagnostic(reason ?? "Canvas rejected the style change.");
		}
		this.refresh();
	}

	/**
	 * A line drawn on its own: its stored record, where its points are on the
	 * board now, and the route it takes.
	 */
	private lineOf(id: string): { readonly line: LocalLine; readonly points: LinePoint[]; readonly route: LocalLine["route"] } | undefined {
		const line = this.landingGeometry().scene.items.get(id)?.structured?.line;
		const rect = line === undefined ? undefined : this.nodeRect(id);
		if (line === undefined || rect === undefined) return undefined;
		return { line, points: lineBoardPoints(line, rect), route: line.route };
	}

	/** Store a line along new board points, its node moved to wrap them, in one step. */
	private writeLine(id: string, points: readonly LinePoint[], style: Partial<Omit<LocalLine, "box" | "points">> = {}): boolean {
		// The release that ends a drag must not also click the board clear.
		this.swallowClickUntil = Date.now() + 400;
		const drawn = this.lineOf(id);
		this.readInteractionState();
		if (drawn === undefined || !this.editAllowed("restyle", [id])) {
			this.refresh();
			return false;
		}
		const { box: _box, points: _points, ...kept } = drawn.line;
		const merged = { ...kept, ...style };
		for (const key of ["startCap", "endCap", "strokeStyle"] as const) {
			if (merged[key] === undefined || merged[key] === "none" || merged[key] === "solid") delete merged[key];
		}
		const { rect, line } = lineFromBoard(points, merged);
		this.authoring ??= createCanvasAuthoring(this.view);
		const result = this.authoring.changeItems({ updates: [{ id, item: { type: "line", line }, rect }] });
		if (!result.ok) this.addDiagnostic(firstProblem(result.diagnostics) ?? "Canvas rejected the line.");
		this.refresh();
		return result.ok;
	}

	/** What the connector settings mean for lines: their route, ends, dashes and width. */
	private restyleLines(ids: readonly string[], patch: SelectionStylePatch): void {
		const connector = patch.connector;
		if (connector === undefined) return;
		for (const id of ids) {
			const drawn = this.lineOf(id);
			if (drawn === undefined) continue;
			this.writeLine(id, drawn.points, {
				...(connector.route === undefined ? {} : { route: connector.route }),
				...(connector.strokeStyle === undefined ? {} : { strokeStyle: connector.strokeStyle as LocalLine["strokeStyle"] }),
				...(connector.startCap === undefined ? {} : { startCap: connector.startCap }),
				...(connector.endCap === undefined ? {} : { endCap: connector.endCap }),
				...(connector.width === undefined ? {} : { width: connector.width }),
				...(connector.headSize === undefined ? {} : {headSize: connector.headSize}),
			});
		}
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
	 * A compact dump of what the selection layers currently believe.
	 *
	 * Rotation and connector attachment are decided by several pieces at once -
	 * the stored angle, the previewed one, the frame the handles draw, and the
	 * anchors written for an edge - and a screenshot cannot tell which of them
	 * disagrees.  This reports all of them together, including what the last
	 * rotation gesture actually did, which is the difference between "blocked",
	 * "refused" and "never ran".
	 */
	public describeSelection(): string {
		const id = this.selectedIds[0];
		if (id === undefined) {
			return "No Canvas element is selected.";
		}
		const descriptor = buildSourceScene(this.currentRawDocument).items.get(id);
		const overrides = readRuntime(readRuntime(this.currentRawDocument, "miroCanvas"), "localOverrides");
		const override = readRuntime(overrides, id);
		const handles = this.handlesState(true);
		const edges = readRuntime(this.currentRawDocument, "edges");
		const attached = (Array.isArray(edges) ? edges as readonly unknown[] : []).filter((edge) =>
			readRuntime(edge, "fromNode") === id || readRuntime(edge, "toNode") === id);
		return [
			`id=${id}`,
			`kind=${descriptor?.kind ?? "none"}`,
			`shape=${descriptor?.shape ?? "none"}`,
			`storedRotation=${finite(readRuntime(override, "rotation")) ?? "none"}`,
			`projectedRotation=${descriptor?.rotation ?? "none"}`,
			`previewRotation=${this.rotationPreview?.id === id ? this.rotationPreview.rotation : "none"}`,
			`handleRotation=${handles.rotation}`,
			`handleRect=${handles.rect === undefined
				? "none"
				: `${Math.round(handles.rect.left)},${Math.round(handles.rect.top)} ${Math.round(handles.rect.width)}x${Math.round(handles.rect.height)}`}`,
			// The frame turns about its own centre and the node about its own, so
			// the two centres are the thing to compare when they appear to
			// rotate about different points.
			`nodeBox=${(() => {
				const origin = this.overlayOrigin();
				const element = [...(this.adapter.getNodes() ?? [])].find((item) => readCanvasElementId(item) === id);
				const box = boundingRect(readCanvasElementDom(element));
				if (origin === undefined || box === undefined) return "none";
				return `${Math.round((box.left + box.right) / 2 - origin.left)},${Math.round((box.top + box.bottom) / 2 - origin.top)}`;
			})()}`,
			// Model and DOM can disagree: the angle may be stored, projected and
			// shown by the handles while the host refused to apply it, which
			// looks exactly like the frame turning on its own.
			`domRotation=${(() => {
				const element = [...(this.adapter.getNodes() ?? [])].find((item) => readCanvasElementId(item) === id);
				const dom = readCanvasElementDom(element);
				const style = readRuntime(dom, "style");
				const read = (property: string): string => {
					const getter = readRuntime(style, "getPropertyValue");
					if (typeof getter !== "function") return "?";
					try {
						const value = Reflect.apply(getter, style, [property]);
						return typeof value === "string" && value.length > 0 ? value : "-";
					} catch {
						return "?";
					}
				};
				return dom === undefined
					? "no dom"
					: `rotate:${read("rotate")} origin:${read("transform-origin")} transform:${read("transform")}`;
			})()}`,
			`frameCentre=${handles.rect === undefined
				? "none"
				: `${Math.round(handles.rect.left + handles.rect.width / 2)},${Math.round(handles.rect.top + handles.rect.height / 2)}`}`,
			`lastRotation=${this.lastRotationAttempt}`,
			`edges=${attached.length}`,
			`anchors=${attached.map((edge) => {
				const edgeId = readRuntime(edge, "id");
				if (typeof edgeId !== "string") return "?:unknown";
				const anchors = readRuntime(readRuntime(overrides, edgeId), "connectorAnchors");
				return `${edgeId}:${anchors === undefined ? "side" : "anchored"}`;
			}).join(",") || "none"}`,
		].join("  ");
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

	public openSourceInspector(): void {
		this.controls.openSourceInspector(buildSourceInspection(this.adapter.getDocument(), this.selectedIds));
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

	/** Give every new comment a stable Canvas location even without an explicit picker. */
	public defaultCommentAnchor(): CanvasAnchor | undefined {
		const id = this.selectedIds[0];
		if (id !== undefined) {
			const edgeIds = new Set(collectCanvasElementIds(this.adapter.getEdges() ?? []));
			return edgeIds.has(id)
				? { type: "edge", edgeId: id, t: 0.5 }
				: { type: "node", nodeId: id, u: 0.5, v: 0.5 };
		}
		const size = clientSize(this.root);
		const point = this.viewport.screenToBoard({ x: size.width / 2, y: size.height / 2 });
		return point === undefined ? undefined : { type: "free", x: point.x, y: point.y };
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
			if (isElement(this.toolbar.element) && this.settings.selectionToolbarEnabled) {
				this.root.appendChild(this.toolbar.element);
			}
			if (isElement(this.handles.element)) {
				this.root.appendChild(this.handles.element);
			}
			if (isElement(this.commentMarkers?.element)) {
				this.root.appendChild(this.commentMarkers.element);
			}
			if (isElement(this.quickTools?.element)) {
				this.root.appendChild(this.quickTools.element);
			}
		} catch {
			this.commentMarkers?.destroy();
			this.handles.dispose();
			this.toolbar.dispose();
			this.controls.minimapElement.remove();
			this.controls.element.remove();
			this.addDiagnostic("Native Canvas root rejected the M1 controls panel; controls are disabled.");
			this.refresh();
			return false;
		}
		this.adoptNativeMenu();
		this.attachQuickTools();
		this.attachClipboard();
		this.attachGuards();
		this.attachMinimapHandlers();
		this.attachResizeObserver();
		this.attachSystemThemeListener();
		this.attachRefreshPolling();
		this.attachViewportFrames();
		this.attachRectangleSelection();
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
		this.currentRawDocument = this.selectionMovePreview ?? this.adapter.getDocument();
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
			// Naming the missing member here saves a trip through another
			// command: without persistence nothing this plugin writes can work,
			// including locking, so this is the first thing worth knowing.
			diagnostics.push(this.options.persistenceProblem === undefined
				? "Metadata persistence is unavailable; explicit appearance and safety writes are disabled."
				: `Metadata persistence is unavailable, so appearance, locking and every other write is disabled: ${this.options.persistenceProblem}`);
		}
		const selection = this.adapter.getSelection();
		this.selectedIds = [...new Set([...(selection === undefined ? [] : allIds(selection)),...(this.connectorLayer?.selection() ?? [])])];
		this.scene = this.adapter.getScene() ?? sceneFromDocument(this.currentRawDocument) ?? { nodes: [], edges: [] };
		const independentGeometry=buildCanvasAnchorGeometry(this.currentRawDocument);
		const independentEdges=boardConnectors(this.currentRawDocument).flatMap(c=>{
			const route=independentGeometry.edges?.[c.id];return route?[{id:c.id,...route}]:[];
		});
		if(independentEdges.length)this.scene={...this.scene,edges:[...this.scene.edges,...independentEdges]};
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
		const viewport = this.displayViewport();
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
			if (id !== undefined && this.appearance.localOverrides[id]?.colors?.edge !== undefined
				&& !isElement(readRuntime(edge, "lineGroupEl"))) {
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
		this.refreshBoardConnectors();
		this.updateNativeEdgeLabels();
		this.updateMixedSelectionFrame();
		const markerModel = this.updateCommentMarkers();
		for (const diagnostic of markerModel?.diagnostics ?? []) {
			diagnostics.push(`Comment ${diagnostic.threadId}: ${diagnostic.message}`);
		}
		const minimapVisible = this.minimapShown();
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
			minimapVisible,
			diagnostics: [...new Set(diagnostics)],
			...(viewport === undefined ? {} : { zoom: Math.round(viewport.zoom * 100) / 100 }),
			...this.nativeSnapping(),
			showDiagnostics: this.settings.developerDiagnostics,
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
			zoom: state.zoom,
			snapToGrid: state.snapToGrid,
			snapToObjects: state.snapToObjects,
			showDiagnostics: state.showDiagnostics,
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
			this.updateQuickTools();
		}
		this.lastToolbarState = toolbarState;
		this.handles.update(this.handlesState(toolbarState.editable));
		this.retargetFollow();
	}

	/**
	 * Who comments written here are signed by: the name in the settings, or
	 * the Obsidian account signed in on this device, or "Local user".
	 */
	public commentAuthor(): { readonly name: string } {
		let storage: Storage | undefined;
		try {
			storage = ownerDocument(this.root)?.defaultView?.localStorage;
		} catch {
			storage = undefined;
		}
		return { name: commentAuthorName(this.settings, obsidianAccountName(storage)) };
	}

	/** Everyone who has written a comment on this board, and whoever writes here. */
	public commentAuthors(): readonly string[] {
		const names = new Set<string>([this.commentAuthor().name]);
		for (const thread of this.commentThreads()) {
			for (const message of threadMessages(thread)) if (message.author.trim() !== "") names.add(message.author.trim());
		}
		return [...names];
	}

	public commentThreads(): ReturnType<typeof listCommentThreads> {
		const document = this.currentRawDocument;
		let cache = this.commentThreadCache;
		if (cache === undefined || cache.document !== document) {
			// A pin that was moved shows its thread where it was put.
			const places = readRuntime(readRuntime(document, "miroCanvas"), "commentPlaces");
			const decorations = readRuntime(readRuntime(document, "miroCanvas"), "commentDecorations");
			const threads = listCommentThreads(document, { includeResolved: true }).map((thread) => {
				const place = readRuntime(places, commentPlaceKey(thread.origin, thread.id));
				const anchor = place === undefined ? undefined : normalizeAnchor(place);
				const decoration = readRuntime(decorations, commentPlaceKey(thread.origin, thread.id));
				return {...thread, ...(anchor?.valid === true && anchor.anchor !== undefined ? {anchor: anchor.anchor} : {}),
					...(isRecord(decoration) ? {color: decoration.color, locked: decoration.locked} : {})};
			});
			cache = { document, threads: Object.freeze(threads) };
			this.commentThreadCache = cache;
		}
		return cache.threads;
	}

	private updateCommentMarkers(): ReturnType<CommentMarkers["update"]> | undefined {
		const model = this.commentMarkers?.update({
			threads: this.commentThreads(),
			selectedKeys: this.selectedCommentKeys,
			includeResolved: true,
			geometry: this.landingGeometry().geometry,
			boardToViewport: (point) => this.viewport.boardToScreen(point) ?? point,
		});
		this.updateCommentCard(model);
		return model;
	}

	/**
	 * A pin opens its thread beside it, as in Miro; the full panel stays one
	 * click away.  The card follows the pin while the board moves.
	 */
	private openCommentThread(threadId: string, origin: CommentOrigin): void {
		if (this.ensureCommentCard() === undefined) {
			this.options.onOpenCommentThread?.(threadId, origin);
			return;
		}
		this.commentDraft = undefined;
		this.openThread = { id: threadId, origin };
		this.updateCommentMarkers();
	}

	private ensureCommentCard(): CommentThreadCard | undefined {
		const document = ownerDocument(this.root);
		if (this.root === undefined || document === undefined) return undefined;
		if (this.commentCard === undefined) {
			const card = new CommentThreadCard(document, {
				onReply: (id, text, name) => {if(!this.commentLocked(id,"local"))this.mutateComment("reply-comment", (draft) => addReply(draft, id, text, { author: {name: name?.trim() || this.commentAuthor().name} }));},
				onRenameAuthor: (id, messageId, name, origin) => {if(!this.commentLocked(id,origin??"local"))this.mutateComment("rename-comment-author", draft => renameCommentDisplayAuthor(draft, origin ?? "local", id, messageId, name));},
				onResolve: (id, resolved) => {if(!this.commentLocked(id,"local"))this.mutateComment("resolve-comment", (draft) => setCommentResolved(draft, id, resolved));},
				onDelete: (id) => {if(!this.commentLocked(id,"local"))this.mutateComment("delete-comment", draft => deleteLocalComment(draft,id));},
				onDeleteReply: (id, replyId) => {if(!this.commentLocked(id,"local"))this.mutateComment("delete-comment-reply",draft => deleteLocalReply(draft,id,replyId));},
				onAppearance: (id, origin, patch) => this.setCommentAppearance(id, origin, patch),
				onPreviewColor: (id, origin, color) => this.commentMarkers?.previewColor(id, origin, color),
				onHideImported: (id) => {
					if(this.commentLocked(id,"imported"))return;
					this.writeMetadata("hide-imported-comment", draft => {
						const previous = Array.isArray(draft.hiddenImportedComments) ? draft.hiddenImportedComments : [];
						draft.hiddenImportedComments = [...new Set([...previous, id])];
						this.detachMissingCommentAnchors(draft);
						return draft;
					});
					this.refresh();
				},
				onOpenPanel: (id, from) => {
					this.closeCommentThread();
					this.options.onOpenCommentThread?.(id, from);
				},
				onClose: () => this.closeCommentThread(),
				onCreate: (text, name, appearance) => this.createComment(text, name, appearance),
				...(this.options.setIcon === undefined ? {} : { setIcon: this.options.setIcon }),
			});
			this.root.appendChild(card.element);
			// A press anywhere else on the board closes the card, as in Miro.
			const outside = (event: Event): void => {
				const target = event.target as Node | null;
				if ((this.openThread === undefined && !card.composingComment) || target === null) return;
				if (card.element.contains(target) || this.commentMarkers?.element.contains(target)) return;
				this.closeCommentThread();
			};
			this.root.addEventListener("pointerdown", outside, true);
			this.disposers.push(() => this.root?.removeEventListener("pointerdown", outside, true));
			this.commentCard = card;
		}
		return this.commentCard;
	}

	private closeCommentThread(): void {
		this.openThread = undefined;
		this.commentDraft = undefined;
		this.commentCard?.hide();
	}

	private updateCommentCard(model: ReturnType<CommentMarkers["update"]> | undefined): void {
		const open = this.openThread;
		const card = this.commentCard;
		if (open === undefined || card === undefined) return;
		const thread = this.commentThreads().find((item) => item.id === open.id && item.origin === open.origin);
		const marker = model?.markers.find((item) => item.threadId === open.id && item.origin === open.origin);
		if (thread === undefined) {
			this.closeCommentThread();
			return;
		}
		card.show(thread, { editable: this.appearance.settings.reviewMode !== true, authorName: this.commentAuthor().name });
		if (marker !== undefined) card.place(marker.point, clientSize(this.root));
	}

	private mutateComment(action: string, transform: (draft: Record<string, unknown>) => CommentMutationResult): void {
		let problem: string | undefined;
		const result = this.writeMetadata(action, (draft) => {
			const mutation = transform(draft);
			if (!mutation.ok || mutation.metadata === undefined) {
				problem = mutation.diagnostics[0]?.message ?? "The comment could not be changed.";
				throw new Error(problem);
			}
			this.detachMissingCommentAnchors(mutation.metadata);
			return mutation.metadata as Record<string, unknown>;
		});
		if (result?.status !== "applied" && result?.status !== "noop") {
			this.options.onNotice?.(problem ?? result?.diagnostics[0]?.message ?? "The comment could not be saved.");
		}
		this.refresh();
	}

	/**
	 * Move the selection overlays with the canvas between refreshes.
	 *
	 * Native Canvas pans, zooms and drags by rewriting transforms every frame,
	 * while the overlays were only placed on a refresh - up to a polling
	 * interval later - so handles, the toolbar and comment markers were left
	 * behind wherever the node had been.  A mutation callback runs before the
	 * frame is painted; placing them there keeps them on the nodes.  Only
	 * positions are recomputed, from measurements cached per document.
	 */
	private followViewport(): void {
		this.connectorLayer?.render();
		this.updateNativeEdgeLabels();
		this.updateMixedSelectionFrame();
		if (this.disposed) {
			return;
		}
		const previous = this.lastToolbarState;
		if (previous !== undefined) {
			const placement = this.selectionPlacement();
			const { placement: _old, ...rest } = previous;
			const next: SelectionToolbarState = placement === undefined ? rest : { ...rest, placement };
			const signature = safeSignature(next);
			if (signature !== this.lastToolbarSignature) {
				this.lastToolbarSignature = signature;
				this.lastToolbarState = next;
				this.toolbar.update(next);
			}
		}
		this.handles.update(this.handlesState(previous?.editable ?? false));
		this.updateCommentMarkers();
		const size=clientSize(this.root), viewport=this.displayViewport();
		const signature=`${this.lastSceneSignature}|${this.viewportSignature(viewport,size)}`;
		if(signature!==this.lastMinimapSignature) {
			this.minimap=new MinimapModel(this.scene,{width:240,height:160,padding:8,viewport,viewportSize:size,coordinateMode:this.viewport.coordinateMode});
			this.lastMinimapSignature=signature;this.drawMinimap();
		}
	}

	public commentLocked(id: string, origin: CommentOrigin): boolean {
		return this.commentThreads().some(thread => thread.id === id && thread.origin === origin && thread.locked === true);
	}

	private setCommentAppearance(id: string, origin: CommentOrigin, patch: {color?: string; locked?: boolean}): void {
		if (this.appearance.settings.reviewMode || !this.commentThreads().some(thread => thread.id === id && thread.origin === origin)) return;
		if (this.commentLocked(id, origin) && (patch.locked !== false || patch.color !== undefined)) return;
		if (patch.color !== undefined && !/^#[0-9a-f]{6}$/i.test(patch.color)) return;
		this.writeMetadata("comment-appearance", draft => {
			const map: Record<string, unknown> = isRecord(draft.commentDecorations) ? {...draft.commentDecorations} : {};
			const key = commentPlaceKey(origin,id), previous = isRecord(map[key]) ? map[key] : {};
			map[key] = {...previous,...patch};draft.commentDecorations=map;
			return draft;
		});
		this.refresh();
	}
	private rectangleSelectionEnd?:()=>void;
	private selectedRouteEnds=new Map<string,SelectedRouteEnds>();
	private attachRectangleSelection(): void {
		const root=this.root,view=root?.ownerDocument?.defaultView;if(!root||!view)return;
		// A press on the shared frame must be claimed before native Canvas sees a
		// press on empty board space and drops its part of the selection.
		const frameDown=(event:PointerEvent)=>{
			if(!root.contains(event.target as Node))return;
			if(this.closestTarget(event,".miro-canvas-mixed-selection-frame")){this.startSelectionMove(event);return;}
			const marker=event.target instanceof Element ? event.target.closest(".miro-canvas-comment-marker") : null;
			if(marker){
				const key=`${marker.getAttribute("data-comment-origin")}:${marker.getAttribute("data-comment-id")}`;
				if(this.selectedCommentKeys.has(key))this.startSelectionMove(event);
			}
		};
		root.ownerDocument.addEventListener("pointerdown",frameDown,true);
		const down=(event:PointerEvent)=>{
			if(event.defaultPrevented)return;
			if(event.button===0&&!event.shiftKey&&this.selectedCommentKeys.size){
				const id=this.eventElementId(event.target);
				const marker=event.target instanceof Element ? event.target.closest(".miro-canvas-comment-marker") : null;
				const key=marker?`${marker.getAttribute("data-comment-origin")}:${marker.getAttribute("data-comment-id")}`:undefined;
				if((id&&!this.selectedIds.includes(id))||(key&&!this.selectedCommentKeys.has(key)))this.selectedCommentKeys.clear();
			}
			if(this.connectorLayer?.selection().length && this.closestTarget(event,".canvas-selection") && !this.closestTarget(event,".canvas-node-resizer")) {
				if(this.startSelectionMove(event))return;
			}
			if(event.button!==0||this.armedTool!=="select"||this.isSpacePanHeld()||this.inControls(event)
				||matchesPointer(this.settings.panBinding,event)||matchesPointer(this.settings.lassoBinding,event)
				||this.closestTarget(event,".canvas-node,.canvas-edge,.canvas-selection,.miro-canvas-mixed-selection-frame,.miro-board-connector-hit,.miro-board-connector-grip,.miro-board-connector-label,.miro-canvas-native-edge-label,input,textarea,[contenteditable=true]"))return;
			const first={x:event.clientX,y:event.clientY};
			this.rectangleSelectionEnd?.();
			// Own the gesture once. Letting Canvas also see this press creates a
			// second marquee with a different set of selectable element types.
			event.preventDefault();event.stopImmediatePropagation();
			let dragged=false;
			const bounds=boundingRect(root);
			const marquee=root.ownerDocument.createElement("div");
			marquee.className="miro-canvas-rectangle-marquee";
			marquee.hidden=true;root.appendChild(marquee);
			root.setAttribute("data-miro-rectangle-selecting","true");
			const move=(e:PointerEvent)=>{
				if(e.pointerId!==event.pointerId)return;
				dragged ||= Math.hypot(e.clientX-event.clientX,e.clientY-event.clientY)>3;
				if(!dragged||!bounds)return;
				marquee.hidden=false;
				marquee.style.left=`${Math.min(event.clientX,e.clientX)-bounds.left}px`;
				marquee.style.top=`${Math.min(event.clientY,e.clientY)-bounds.top}px`;
				marquee.style.width=`${Math.abs(e.clientX-event.clientX)}px`;
				marquee.style.height=`${Math.abs(e.clientY-event.clientY)}px`;
			};
			const cleanup=()=>{root.removeAttribute("data-miro-rectangle-selecting");marquee.remove();view.removeEventListener("pointermove",move,true);view.removeEventListener("pointerup",up,true);view.removeEventListener("pointercancel",cancel,true);view.removeEventListener("blur",cancel);this.rectangleSelectionEnd=undefined;};
			const up=(e:PointerEvent)=>{
				if(e.pointerId!==event.pointerId)return;
				const wasDragged=dragged || Math.hypot(e.clientX-event.clientX,e.clientY-event.clientY)>3;
				cleanup();
				if(!wasDragged){if(!event.shiftKey){this.callNative("deselectAll");this.connectorLayer?.select([]);this.selectedCommentKeys.clear();this.selectedRouteEnds.clear();this.refresh();}return;}
				const last={x:e.clientX,y:e.clientY};
				const geometry=buildCanvasAnchorGeometry(this.adapter.getDocument());
				const groups=new Set(((readRuntime(this.currentRawDocument,"nodes")??[]) as readonly unknown[])
					.filter(item=>readRuntime(item,"type")==="group").map(item=>readRuntime(item,"id")));
				const caught:unknown[]=[];
				const endpointSelection=event.shiftKey?new Map(this.selectedRouteEnds):new Map<string,SelectedRouteEnds>();
				const catchEnds=(id:string,points:readonly {x:number;y:number}[]):boolean=>{
					const mask=routeEndsInBox(points,first,last);
					if(!mask)return false;
					// Shift-add never turns an already whole-selected edge into a partial one.
					if(!(event.shiftKey&&this.selectedIds.includes(id)&&!endpointSelection.has(id))){
						const prior=endpointSelection.get(id);
						endpointSelection.set(id,prior?{from:prior.from||mask.from,to:prior.to||mask.to,wholeRoute:prior.wholeRoute||mask.wholeRoute}:mask);
					}
					return true;
				};
				for(const node of this.adapter.getNodes()??[]){
					const id=readCanvasElementId(node),rect=boundingRect(readCanvasElementDom(node));
					if(id&&rect&&(groups.has(id)?rectIntersectsBox(rect,first,last,true)
						:pointInSelectionBox({x:(rect.left+rect.right)/2,y:(rect.top+rect.bottom)/2},first,last)))caught.push(node);
				}
				for(const edge of this.adapter.getEdges()??[]){
					const id=readCanvasElementId(edge),route=id===undefined?undefined:geometry.edges?.[id];
					const points=(route?.points??(route?.start&&route.end?[route.start,route.end]:[])).map(p=>this.viewportPoint(p)).filter((p):p is {x:number;y:number}=>p!==undefined);
					if(id&&catchEnds(id,points))caught.push(edge);
				}
				const connectorIds=boardConnectors(this.currentRawDocument).filter(c=>{
					const route=geometry.edges?.[c.id];
					const points=(route?.points??(route?.start&&route.end?[route.start,route.end]:[])).map(p=>this.viewportPoint(p)).filter((p):p is {x:number;y:number}=>p!==undefined);
					return catchEnds(c.id,points);
				}).map(c=>c.id);
				this.selectedRouteEnds=endpointSelection;
				if(!event.shiftKey){this.callNative("deselectAll");this.selectedCommentKeys.clear();}
				for(const item of caught)this.callNative("select",[item]);
				this.connectorLayer?.select([...new Set([...(event.shiftKey?this.connectorLayer.selection():[]),...connectorIds])]);
				for(const [key,point] of Object.entries(geometry.comments??{})){
					const at=this.viewportPoint(point);
					// The 32 px avatar sits above and to the right of its anchor.
					if(at&&pointInSelectionBox({x:at.x+16,y:at.y-16},first,last))
						this.selectedCommentKeys.add(key);
				}
				this.refresh();
			};
			const cancel=()=>{cleanup();this.followViewport();};
			view.addEventListener("pointermove",move,true);view.addEventListener("pointerup",up,true);view.addEventListener("pointercancel",cancel,true);view.addEventListener("blur",cancel);
			this.rectangleSelectionEnd=cancel;
		};
		root.addEventListener("pointerdown",down,true);
		this.disposers.push(()=>{this.rectangleSelectionEnd?.();root.ownerDocument.removeEventListener("pointerdown",frameDown,true);root.removeEventListener("pointerdown",down,true);});
	}
	private attachViewportFrames(): void {
		const view=this.root?.ownerDocument?.defaultView;
		if(typeof view?.requestAnimationFrame!=="function")return;
		let frame=0, stopped=false, previous="", dragging=false, geometrySignature="";
		const down=()=>{dragging=true;this.liveGeometryDirty=true;};
		const up=()=>{dragging=false;this.liveGeometryDirty=true;};
		this.root?.addEventListener("pointerdown",down,true);
		view.addEventListener("pointerup",up,true);view.addEventListener("pointercancel",up,true);view.addEventListener("blur",up);
		const tick=()=>{
			if(stopped || this.disposed)return;
			let geometryChanged=false;
			if(dragging || this.liveGeometryDirty){
				this.liveGeometryDirty=false;
				// Native dragging updates runtime geometry before the saved document.
				// Read its current graph, but do not write or add history during preview.
				const document=this.selectionMovePreview ?? this.adapter.getDocument();
				if(isRecord(document)&&Array.isArray(document.nodes)&&Array.isArray(document.edges)){
					const signature=safeSignature({nodes:document.nodes.map(n=>isRecord(n)?[n.id,n.x,n.y,n.width,n.height]:n),edges:document.edges});
					if(signature!==geometrySignature){
						geometrySignature=signature;geometryChanged=true;
						this.currentRawDocument=document;this.landingCache=undefined;
						this.sourceRenderer?.refresh();
						const geometry=this.landingGeometry().geometry;
						this.scene={nodes:document.nodes,edges:[...document.edges,...boardConnectors(document).flatMap(c=>geometry.edges?.[c.id]?[{id:c.id,...geometry.edges[c.id]}]:[])]};
						this.lastSceneSignature=this.sceneSignature(this.scene);
					}
				}
			}
			const signature=this.viewportSignature(this.displayViewport(),clientSize(this.root));
			if(signature!==previous||geometryChanged){previous=signature;this.followViewport();}
			frame=view.requestAnimationFrame(tick);
		};
		frame=view.requestAnimationFrame(tick);
		this.disposers.push(()=>{stopped=true;view.cancelAnimationFrame(frame);this.root?.removeEventListener("pointerdown",down,true);view.removeEventListener("pointerup",up,true);view.removeEventListener("pointercancel",up,true);view.removeEventListener("blur",up);});
	}

	/** Watch the canvas transform and the selected elements, and nothing else. */
	private retargetFollow(): void {
		const canvasEl = readRuntime(this.nativeCanvas(), "canvasEl");
		const selected = [...(this.adapter.getNodes() ?? []), ...(this.adapter.getEdges() ?? [])]
			.filter((item) => {
				const id = readCanvasElementId(item);
				return id !== undefined && this.selectedIds.includes(id);
			})
			.map((item) => readCanvasElementDom(item));
		const targets = [canvasEl, ...selected].filter((item) => isElement(item));
		if (targets.length === this.followTargets.length && targets.every((item, index) => item === this.followTargets[index])) {
			return;
		}
		this.followTargets = targets;
		if (this.followObserver === undefined) {
			const Observer = readRuntime(readRuntime(ownerDocument(this.root), "defaultView"), "MutationObserver");
			if (typeof Observer !== "function") {
				return;
			}
			try {
				this.followObserver = Reflect.construct(Observer, [() => {this.liveGeometryDirty=true;this.followViewport();}]) as NonNullable<M1CanvasSession["followObserver"]>;
			} catch {
				return;
			}
			this.disposers.push(() => {
				this.followObserver?.disconnect();
				this.followObserver = undefined;
			});
		}
		const observer = this.followObserver;
		if (observer === undefined) return;
		observer.disconnect();
		for (const target of targets) {
			try {
				observer.observe(target, { attributes: true, attributeFilter: ["style"] });
			} catch {
				// An element the host has already dropped needs no watching.
			}
		}
	}

	/**
	 * Put the native Canvas menu inside this plugin's toolbar.
	 *
	 * Native Canvas floats its own menu - delete, colour, zoom, group, align,
	 * edit - over every selection, so a selected node carried two menus.  The
	 * menu element is moved, not copied: native Canvas keeps filling it with
	 * its own buttons and submenus on every selection change.  Only its colour
	 * button is hidden, because the toolbar's palettes already hold the Canvas
	 * colours.  Disposal puts the element back where native Canvas keeps it.
	 */
	/**
	 * The creation tools take the place of native Canvas's card menu, whose
	 * buttons move into the tools' "more" menu and keep working there.  A
	 * press on the board uses the armed tool; a letter arms one.
	 */
	private attachQuickTools(): void {
		const tools = this.quickTools;
		const root = this.root;
		if (tools === undefined || root === undefined) return;
		const cardMenu = readRuntime(this.nativeCanvas(), "cardMenuEl");
		if (isElement(cardMenu)) {
			const moved = Array.from(cardMenu.children);
			for (const child of moved) tools.nativeSlot.appendChild(child);
			root.classList.add("miro-canvas-has-tools");
			this.disposers.push(() => {
				root.classList.remove("miro-canvas-has-tools");
				for (const child of moved) {
					try {
						if (child.parentElement === tools.nativeSlot) cardMenu.appendChild(child);
					} catch {
						// A menu native Canvas has already destroyed needs nothing back.
					}
				}
			});
		}
		const down = (event: Event): void => {
			if (event.target instanceof Node && root.contains(event.target)) this.startToolGesture(event as PointerEvent);
		};
		// Claim compatibility mouse events too: native Canvas pans on mousedown.
		const mouseDown = (event: MouseEvent): void => {
			if (!(event.target instanceof Node) || !root.contains(event.target) || this.inControls(event)
				|| this.isSpacePanHeld() || this.closestTarget(event, "input,textarea,[contenteditable=true],.cm-editor")) return;
			if (root.hasAttribute("data-miro-rectangle-selecting") || this.selectionMoveEnd !== undefined
				|| (this.armedTool === "select" && matchesPointer(this.settings.lassoBinding, event))
				|| (this.armedTool === "lasso" && event.button === 0)) {
				event.preventDefault(); event.stopImmediatePropagation();
			}
		};
		const key = (event: Event): void => this.handleToolKey(event as KeyboardEvent);
		const hover = (event: Event): void => this.moveBrush(event as PointerEvent);
		const leave = (): void => this.hideBrush();
		const document = root.ownerDocument;
		document.addEventListener("pointerdown", down, true);
		document.addEventListener("mousedown", mouseDown, true);
		root.addEventListener("pointermove", hover, { passive: true });
		root.addEventListener("pointerleave", leave);
		document.addEventListener("keydown", key);
		this.disposers.push(() => {
			document.removeEventListener("pointerdown", down, true);
			document.removeEventListener("mousedown", mouseDown, true);
			root.removeEventListener("pointermove", hover);
			root.removeEventListener("pointerleave", leave);
			document.removeEventListener("keydown", key);
			this.toolGesture?.end();
			this.panGestureEnd?.();
			this.brush?.remove();
			this.brush = undefined;
			tools.dispose();
		});
		this.updateQuickTools();
	}

	/**
	 * The circle a pen or an eraser acts with, drawn where the pointer is, at
	 * the size it will act: the width of the line, or the eraser's reach.  It
	 * takes the place of the pointer while one of those tools is armed.
	 */
	private moveBrush(event: PointerEvent): void {
		const root = this.root;
		const tool = this.armedTool;
		const target = event.target as Element | null;
		if (root === undefined || !isDrawingTool(tool) || event.pointerType === "touch" || target?.closest?.(PANEL_SELECTOR) != null) {
			this.hideBrush();
			return;
		}
		if (this.brush === undefined) {
			const brush = root.ownerDocument.createElement("div");
			brush.className = "miro-canvas-brush";
			brush.setAttribute("aria-hidden", "true");
			root.appendChild(brush);
			this.brush = brush;
		}
		const brush = this.brush;
		const erasing = tool === "eraser" || tool === "erase-part";
		const zoom = finite(readRuntime(this.viewport.getViewport(), "zoom")) ?? 1;
		const size = erasing
			? this.eraserSize
			: Math.max(4, this.penWidth * zoom * (tool === "highlighter" ? HIGHLIGHTER_SCALE : 1));
		const rect = root.getBoundingClientRect();
		brush.hidden = false;
		brush.setAttribute("data-kind", erasing ? "eraser" : tool === "highlighter" ? "highlighter" : "pen");
		brush.style.width = `${size}px`;
		brush.style.height = `${size}px`;
		brush.style.left = `${event.clientX - rect.left}px`;
		brush.style.top = `${event.clientY - rect.top}px`;
		brush.style.setProperty("--miro-canvas-brush-color", this.penInk());
	}

	private hideBrush(): void {
		if (this.brush !== undefined) this.brush.hidden = true;
	}

	private updateQuickTools(): void {
		const editable = this.appearance.settings.reviewMode !== true;
		if (!editable && this.armedTool !== "select" && this.armedTool !== "lasso") this.armedTool = "select";
		if (!isDrawingTool(this.armedTool)) this.hideBrush();
		this.quickTools?.update({
			connectorColor:this.connectorColor??this.boardInk(), connectorWidth:this.connectorWidth, ...(this.connectorHeadSize === undefined ? {} : {connectorHeadSize: this.connectorHeadSize}),
			showLassoTool: this.settings.showLassoTool, showConnectorTool: this.settings.showConnectorTool,
			editable, armed: this.armedTool, shape: this.toolShape,
			penColor: this.penInk(), penWidth: this.penWidth, eraserSize: this.eraserSize,
		});
		if (this.root !== undefined) writeAttribute(this.root, "data-miro-canvas-tool", this.armedTool);
	}

	private armTool(tool: QuickTool): void {
		this.toolGesture?.end();
		// Review mode keeps the tools that only select.
		this.armedTool = this.appearance.settings.reviewMode === true && tool !== "lasso" ? "select" : tool;
		// Only a tool that really took over puts an open comment away.
		if (this.armedTool !== "select") this.closeCommentThread();
		this.updateQuickTools();
	}

	/** Letters arm tools on the active board, never while text is being written. */
	private handleToolKey(event: KeyboardEvent): void {
		const root = this.root;
		if (root === undefined || event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
		if (root.closest(".workspace-leaf.mod-active") === null) return;
		const target = event.target as HTMLElement | null;
		if (target !== null && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/u.test(target.tagName))) return;
		if (target !== null && target !== root.ownerDocument.body && !root.contains(target)) return;
		if (event.key === "Enter" && this.linePlacing !== undefined) {
			this.linePlacing.finish();
			event.preventDefault();
			return;
		}
		const tool = event.shiftKey ? undefined : QUICK_TOOL_KEYS.get(event.key.toUpperCase());
		if (tool === undefined) return;
		this.armTool(tool);
		event.preventDefault();
	}

	/** A press on the board with a tool armed: drag out the item, or click to drop it. */
	private startToolGesture(event: PointerEvent): void {
		if (this.armedTool === "connector" && this.closestTarget(event, ".miro-canvas-comment-marker") && event.button === 0) {
			this.startLine(lineKind(this.toolShape) ?? lineKind("arrow")!, event);
			return;
		}
		if (this.closestTarget(event, ".miro-board-connector-grip,.miro-board-connector-hit")) return;
		const lasso = this.armedTool === "select" && matchesPointer(this.settings.lassoBinding, event) && !this.isSpacePanHeld();
		const tool = lasso ? "lasso" : this.armedTool;
		const root = this.root;
		if (root === undefined || this.inControls(event) || this.closestTarget(event, "input, textarea, [contenteditable=true], .cm-editor")) return;
		if (!lasso && tool === "select" && matchesPointer(this.settings.panBinding, event)) {
			event.preventDefault(); event.stopImmediatePropagation();
			this.panGestureEnd?.();
			const view = root.ownerDocument.defaultView;
			let last = { x: event.clientX, y: event.clientY };
			const move = (moved: PointerEvent): void => {
				if (moved.pointerId !== event.pointerId) return;
				const direction = this.viewport.coordinateMode === "center" ? -1 : 1;
				this.viewport.panBy((moved.clientX-last.x)*direction, (moved.clientY-last.y)*direction);
				last = { x: moved.clientX, y: moved.clientY };
				this.followViewport();
			};
			const end = (): void => {
				view?.removeEventListener("pointermove", move, true);
				view?.removeEventListener("pointerup", end, true);
				view?.removeEventListener("pointercancel", end, true);
				view?.removeEventListener("blur", end);
				this.panGestureEnd = undefined;
				this.suppressContextUntil = Date.now()+400;
			};
			view?.addEventListener("pointermove", move, true);
			view?.addEventListener("pointerup", end, true);
			view?.addEventListener("pointercancel", end, true);
			view?.addEventListener("blur", end);
			this.panGestureEnd = end;
			return;
		}
		if ((tool === "connector" || (tool === "shape" && lineKind(this.toolShape) !== undefined)) && matchesPointer(this.settings.lineBinding, event)) {
			this.startLine(lineKind("line")!, event);
			return;
		}
		const pointer = typeof event.pointerType === "string" ? event.pointerType : "mouse";
		if (pointer === "pen") {
			this.lastPenAt = Date.now();
			this.stylusSeen = true;
		}
		// Each click of a polyline or a spline being placed adds a point to it.
		if (this.linePlacing !== undefined && event.button === 0 && (event.target as Element | null)?.closest?.(PANEL_SELECTOR) == null) {
			event.preventDefault();
			event.stopImmediatePropagation();
			this.linePlacing.place({ x: event.clientX, y: event.clientY }, event.shiftKey === true);
			return;
		}
		if (tool === "select" || root === undefined || (!lasso && event.button !== 0) || this.toolGesture !== undefined) return;
		const shapeLine = tool === "connector" ? lineKind(this.toolShape) ?? lineKind("arrow") : tool === "shape" ? lineKind(this.toolShape) : undefined;
		if (shapeLine !== undefined) {
			if (pointer === "touch" && Date.now() - this.lastPenAt < STYLUS_HOLD_MS) return;
			if ((event.target as Element | null)?.closest?.(PANEL_SELECTOR) != null) return;
			this.startLine(shapeLine, event);
			return;
		}
		const drawingTool = isDrawingTool(tool) || tool === "lasso";
		const erasing = tool === "eraser" || tool === "erase-part";
		// A stylus rules the board it draws on: while one is in use a touch is a
		// palm or a hand resting, and with a drawing tool armed a finger pans
		// instead of drawing, as Miro's tablets behave.
		if (pointer === "touch" && (Date.now() - this.lastPenAt < STYLUS_HOLD_MS || (drawingTool && this.stylusSeen))) return;
		const target = event.target as Element | null;
		if (target?.closest?.(PANEL_SELECTOR) != null) return;
		const start = { x: event.clientX, y: event.clientY };
		const drawing = tool === "pen" || tool === "highlighter" || tool === "smart" || tool === "lasso";
		if (drawingTool) {
			this.penPoints = [];
			this.penPressures = [];
			this.erasing.clear();
		}
		let from: { readonly nodeId: string; readonly anchor: CanvasAnchor; readonly board: { readonly x: number; readonly y: number } } | undefined;
		if (tool === "connector") {
			const landing = this.connectorLanding(start, undefined, undefined);
			// Started on empty board, a connection line is an arrow of its own.
			if (landing?.nodeId === undefined) {
				this.startLine(lineKind("arrow")!, event);
				return;
			}
			from = { nodeId: landing.nodeId, anchor: landing.anchor, board: landing.board };
		}
		event.preventDefault();
		// Native Canvas listens on this same element: stopping the event from
		// travelling on is not enough, it must not reach the listeners here
		// either, or the board starts its own selection box under the tool.
		event.stopImmediatePropagation();
		const document = root.ownerDocument;
		const view = document.defaultView;
		const svg = drawing || erasing;
		const ghost = svg
			? document.createElementNS("http://www.w3.org/2000/svg", "svg") as unknown as HTMLElement
			: document.createElement("div");
		ghost.setAttribute("class", `miro-canvas-tool-ghost miro-canvas-tool-ghost--${tool}`);
		// A lasso shows the ring it closes; an eraser the trail it wipes; a pen
		// the line it will leave.
		const line = svg ? document.createElementNS("http://www.w3.org/2000/svg", tool === "lasso" ? "polygon" : "polyline") : undefined;
		const zoom = finite(readRuntime(this.viewport.getViewport(), "zoom")) ?? 1;
		if (line !== undefined) {
			line.setAttribute("class", "miro-canvas-tool-ghost__line");
			line.setAttribute("stroke-linecap", "round");
			line.setAttribute("stroke-linejoin", "round");
			if (drawing && tool !== "lasso") {
				line.setAttribute("fill", "none");
				line.setAttribute("stroke", this.penInk());
				line.setAttribute("stroke-width", String(Math.max(1, this.penWidth * zoom * (tool === "highlighter" ? HIGHLIGHTER_SCALE : 1))));
				if (tool === "highlighter") line.setAttribute("stroke-opacity", String(HIGHLIGHTER_OPACITY));
				if (tool === "smart") line.setAttribute("stroke-dasharray", "4 4");
			}
			if (erasing) line.setAttribute("stroke-width", String(this.eraserSize));
			ghost.appendChild(line);
		}
		root.appendChild(ghost);
		const rootRect = root.getBoundingClientRect();
		const origin = from === undefined ? start : this.viewportPoint(from.board) ?? start;
		// The preview grows by the points added, not redrawn from the start.
		const shown: string[] = [];
		// With Shift held a pen draws straight: from the point the line had
		// reached when Shift went down to the pointer.  Letting go carries on
		// freehand from the end of the straight part.
		let straightFrom: number | undefined;
		const draw = (point: { readonly x: number; readonly y: number }, straight = false): void => {
			if (drawingTool) {
				if (straight && (tool === "pen" || tool === "highlighter") && this.penPoints.length > 0) {
					straightFrom ??= this.penPoints.length - 1;
					const anchor = shown[straightFrom]!.split(",").map(Number) as [number, number];
					const end = snapAngle({ x: anchor[0] + rootRect.left, y: anchor[1] + rootRect.top }, point);
					const board = this.boardPoint(end);
					if (board === undefined) return;
					this.penPoints.length = straightFrom + 1;
					shown.length = straightFrom + 1;
					this.penPoints.push(board);
					shown.push(`${end.x - rootRect.left},${end.y - rootRect.top}`);
					line?.setAttribute("points", shown.join(" "));
					return;
				}
				straightFrom = undefined;
				const board = this.boardPoint(point);
				if (board === undefined) return;
				const previous = this.penPoints[this.penPoints.length - 1];
				if (previous !== undefined && Math.hypot(board.x - previous.x, board.y - previous.y) < 1) return;
				this.penPoints.push(board);
				shown.push(`${point.x - rootRect.left},${point.y - rootRect.top}`);
				line?.setAttribute("points", shown.join(" "));
				if (erasing) {
					for (const id of this.drawingsUnder(board, previous)) {
						if (this.erasing.has(id)) continue;
						this.erasing.add(id);
						this.markErasing(id, true);
					}
				}
				return;
			}
			if (tool === "connector") {
				// A line from where the connector leaves to the pointer.
				const dx = point.x - origin.x, dy = point.y - origin.y;
				ghost.style.left = `${origin.x - rootRect.left}px`;
				ghost.style.top = `${origin.y - rootRect.top}px`;
				ghost.style.width = `${Math.hypot(dx, dy)}px`;
				ghost.style.transform = `rotate(${Math.atan2(dy, dx)}rad)`;
				return;
			}
			ghost.style.left = `${Math.min(start.x, point.x) - rootRect.left}px`;
			ghost.style.top = `${Math.min(start.y, point.y) - rootRect.top}px`;
			ghost.style.width = `${Math.abs(point.x - start.x)}px`;
			ghost.style.height = `${Math.abs(point.y - start.y)}px`;
		};
		draw(start);
		const move = (moved: Event): void => {
			const point = moved as PointerEvent;
			if (point.pointerType === "pen") {
				this.lastPenAt = Date.now();
				// A stylus reports how hard it is pressed; a mouse always says 0.5.
				if (drawing && point.pressure > 0) this.penPressures.push(point.pressure);
			}
			draw({ x: point.clientX, y: point.clientY }, point.shiftKey === true);
		};
		const up = (released: Event): void => {
			const pointer = released as PointerEvent;
			const gesture = this.toolGesture;
			end();
			if (gesture !== undefined) this.finishToolGesture(gesture.tool, start, { x: pointer.clientX, y: pointer.clientY }, gesture.from);
		};
		const cancel = (): void => {
			end();
			this.penPoints = [];
			this.clearErasing();
		};
		const end = (): void => {
			view?.removeEventListener("pointermove", move, true);
			view?.removeEventListener("pointerup", up, true);
			view?.removeEventListener("pointercancel", cancel, true);
			ghost.remove();
			this.toolGesture = undefined;
		};
		view?.addEventListener("pointermove", move, true);
		view?.addEventListener("pointerup", up, true);
		view?.addEventListener("pointercancel", cancel, true);
		this.toolGesture = { tool, start, ...(from === undefined ? {} : { from }), ghost, end };
	}

	private finishToolGesture(
		tool: QuickTool,
		start: { readonly x: number; readonly y: number },
		end: { readonly x: number; readonly y: number },
		from: { readonly nodeId: string; readonly anchor: CanvasAnchor; readonly board: { readonly x: number; readonly y: number } } | undefined,
	): void {
		// The click that ends the press must not reach the board, which would end
		// the new item's editing or clear the selection.
		this.swallowClickUntil = Date.now() + 400;
		// A drawing tool stays armed for the next stroke, as in Miro; every
		// other tool is used once and hands the board back to the select tool.
		if (!isDrawingTool(tool)) this.armedTool = "select";
		this.updateQuickTools();
		const a = this.boardPoint(start);
		const b = this.boardPoint(end);
		if (a === undefined || b === undefined) return;
		if (tool === "pen" || tool === "highlighter") {
			this.drawStroke(tool);
			return;
		}
		if (tool === "smart") {
			this.drawSmart();
			return;
		}
		if (tool === "eraser") {
			this.eraseDrawings();
			return;
		}
		if (tool === "erase-part") {
			this.erasePartOfDrawings();
			return;
		}
		if (tool === "lasso") {
			this.selectLassoed();
			return;
		}
		const dragged = Math.hypot(end.x - start.x, end.y - start.y) > 6;
		if (tool === "connector" && from !== undefined) {
			this.connectFromTool(from, end);
			return;
		}
		if (tool === "comment") {
			this.composeComment(b, end);
			return;
		}
		if (tool === "link") {
			this.promptLink(a, start);
			return;
		}
		const size = tool === "shape" ? { width: 200, height: 200 }
			: LOCAL_ITEM_SIZES[tool === "sticky" ? "sticky_note" : tool as "text" | "code" | "frame" | "table"];
		const rect = dragged
			? { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.max(20, Math.abs(b.x - a.x)), height: Math.max(20, Math.abs(b.y - a.y)) }
			// Text starts where it was clicked; everything else is centred there.
			: tool === "text"
				? { x: a.x, y: a.y - size.height / 2, ...size }
				: { x: a.x - size.width / 2, y: a.y - size.height / 2, ...size };
		this.readInteractionState();
		this.authoring ??= createCanvasAuthoring(this.view);
		let created: { readonly ok: boolean; readonly nodeId?: string; readonly diagnostics: readonly { readonly level: string; readonly message: string }[] };
		if (tool === "shape") {
			created = this.authoring.createShape({ shape: this.toolShape, text: "", ...rect });
		} else {
			const item: LocalItem = tool === "sticky" ? { type: "sticky_note", color: "light_yellow" }
				: tool === "code" ? { type: "code", title: "Code block" }
					: tool === "table" ? { type: "table", title: "Grid" }
						: { type: tool as "text" | "frame" };
			const frames = (readRuntime(this.currentRawDocument, "nodes") as readonly unknown[] | undefined ?? [])
				.filter((node) => readRuntime(node, "type") === "group").length;
			created = this.authoring.createItem({
				item, ...rect,
				...(tool === "code" ? { text: "```\n\n```" } : {}),
				...(tool === "table" ? { text: TABLE_TEMPLATE } : {}),
				...(tool === "frame" ? { label: `Frame ${frames + 1}` } : {}),
			});
		}
		if (!created.ok || created.nodeId === undefined) {
			this.addDiagnostic(firstProblem(created.diagnostics) ?? "Canvas rejected the new item.");
			this.refresh();
			return;
		}
		this.refresh();
		const id = created.nodeId;
		// After the press has finished, so its last events leave the caret alone.
		// A code block is written between its fences.
		if (tool !== "frame") ownerDocument(this.root)?.defaultView?.setTimeout(() => this.editNode(id, tool === "code" ? 1 : undefined), 0);
	}

	/**
	 * Draw a line from a press: dragged out for a line, an arrow or a curve,
	 * or a click at a time for a polyline or a spline, which Enter, a
	 * double-click or a click on its last point finishes.  Shift keeps each
	 * stretch level, upright or at 45 degrees.
	 */
	private startLine(spec: LineKindSpec, event: PointerEvent): void {
		const root = this.root;
		const first = this.boardPoint({ x: event.clientX, y: event.clientY });
		if (root === undefined || first === undefined) return;
		event.preventDefault();
		event.stopImmediatePropagation();
		const document = root.ownerDocument;
		const view = document.defaultView;
		const ghost = document.createElementNS("http://www.w3.org/2000/svg", "svg");
		ghost.setAttribute("class", "miro-canvas-tool-ghost miro-canvas-tool-ghost--line");
		const shape = document.createElementNS("http://www.w3.org/2000/svg", spec.block === true ? "polygon" : "path");
		shape.setAttribute("class", "miro-canvas-tool-ghost__line");
		ghost.appendChild(shape);
		root.appendChild(ghost);
		const rootRect = root.getBoundingClientRect();
		const local = (point: StrokePoint): StrokePoint => {
			const screen = this.viewportPoint(point) ?? point;
			return { x: screen.x - rootRect.left, y: screen.y - rootRect.top };
		};
		const course = (tip: StrokePoint, placed: readonly StrokePoint[]): StrokePoint[] =>
			spec.input === "points" ? [...placed, tip]
				: spec.route === "curved" ? [placed[0]!, bowPoint(placed[0]!, tip), tip] : [placed[0]!, tip];
		const width = this.connectorWidth;
		const show = (tip: StrokePoint, placed: readonly StrokePoint[]): void => {
			const through = course(tip, placed);
			if (spec.block === true) {
				shape.setAttribute("points", blockArrowOutline(local(through[0]!), local(tip), width * this.zoom(), this.connectorHeadSize === undefined ? undefined : this.connectorHeadSize * this.zoom())
					.map((point) => `${point.x},${point.y}`).join(" "));
				return;
			}
			const plan = planLine(spec.route, through);
			shape.setAttribute("d", routePath(plan.start, plan.segments, local));
		};
		// With Shift a stretch keeps to level, upright or 45 degrees.
		const aim = (client: StrokePoint, from: StrokePoint, straight: boolean): StrokePoint | undefined => {
			if (!straight) return this.boardPoint(client);
			const anchor = this.viewportPoint(from);
			return anchor === undefined ? this.boardPoint(client) : this.boardPoint(snapAngle(anchor, client));
		};
		const points: StrokePoint[] = [first];
		let tip = first;
		show(tip, points);
		let done = false;
		const swallow = (dbl: Event): void => {
			// A later double-click on an interactive overlay is not the
			// gesture that finished this line.
			if (this.closestTarget(dbl, ".miro-canvas-native-edge-label,.miro-board-connector-label")) return;
			dbl.preventDefault();
			dbl.stopImmediatePropagation();
		};
		const end = (): void => {
			if (done) return;
			done = true;
			view?.removeEventListener("pointermove", move, true);
			view?.removeEventListener("pointerup", up, true);
			view?.removeEventListener("pointercancel", cancel, true);
			ghost.remove();
			this.toolGesture = undefined;
			this.linePlacing = undefined;
			// The double-click that finishes a line must not make a card as well.
			view?.setTimeout(() => root.removeEventListener("dblclick", swallow, true), 500);
		};
		root.addEventListener("dblclick", swallow, true);
		const move = (moved: Event): void => {
			const pointer = moved as PointerEvent;
			if (pointer.pointerId !== event.pointerId) return;
			const from = spec.input === "points" ? points[points.length - 1]! : first;
			const next = aim({ x: pointer.clientX, y: pointer.clientY }, from, pointer.shiftKey === true);
			if (next === undefined) return;
			tip = next;
			show(tip, points);
		};
		const cancel = (): void => {
			end();
			this.armTool("select");
		};
		const up = (released: Event): void => {
			const pointer = released as PointerEvent;
			if (pointer.pointerId !== event.pointerId) return;
			const at = aim({ x: pointer.clientX, y: pointer.clientY }, first, pointer.shiftKey === true) ?? tip;
			end();
			if (event.button === 2) this.suppressContextUntil = Date.now() + 400;
			// A click selects the tool; only an intentional drag creates a line.
			const reach = Math.hypot(at.x - first.x, at.y - first.y) * this.zoom();
			if (reach >= 6) this.createLine(spec, course(at, [first]));
		};
		view?.addEventListener("pointermove", move, true);
		view?.addEventListener("pointercancel", cancel, true);
		if (spec.input === "drag") view?.addEventListener("pointerup", up, true);
		this.toolGesture = { tool: "shape", start: { x: event.clientX, y: event.clientY }, ghost: ghost as unknown as HTMLElement, end };
		if (spec.input !== "points") return;
		const finish = (): void => {
			end();
			this.createLine(spec, points);
		};
		this.linePlacing = {
			spec, points, finish,
			place: (client, straight) => {
				const point = aim(client, points[points.length - 1]!, straight);
				if (point === undefined) return;
				const last = this.viewportPoint(points[points.length - 1]!);
				// A second click where the last one was is a double-click: done.
				if (last !== undefined && Math.hypot(client.x - last.x, client.y - last.y) < 6) {
					finish();
					return;
				}
				points.push(point);
				tip = point;
				show(tip, points);
				if (points.length >= MAX_LINE_POINTS) finish();
			},
		};
	}

	/** The board's zoom: screen pixels to a board unit. */
	private zoom(): number {
		const zoom = finite(readRuntime(this.viewport.getViewport(), "zoom")) ?? 1;
		return zoom > 0 ? zoom : 1;
	}

	/** Put a finished line on the board, selected, with the select tool back. */
	private createLine(spec: LineKindSpec, points: readonly StrokePoint[]): void {
		this.swallowClickUntil = Date.now() + 400;
		this.armedTool = "connector";
		this.updateQuickTools();
		if (points.length < 2) {
			this.refresh();
			return;
		}
		// Every drawing mode creates the same independent connector record.
		// Arrowheads are style; removing one never removes its anchors.
		const from = this.connectorLanding(this.viewportPoint(points[0]!) ?? points[0]!, undefined, points[points.length - 1], "");
		const to = this.connectorLanding(this.viewportPoint(points[points.length - 1]!) ?? points[points.length - 1]!, from?.nodeId, points[0], "");
		if (from === undefined || to === undefined) {
			this.options.onNotice?.("Line not placed: an end was put down where the connector settings do not let it hold. Allow unattached ends to draw on empty board.");
			this.refresh(); return;
		}
		this.writeBoardConnectors([{id:newCanvasId(), from:from.anchor,
			to:to.anchor, route:spec.route, color:this.connectorColor??this.boardInk(), width:this.connectorWidth,
			...(this.connectorHeadSize === undefined ? {} : {headSize: this.connectorHeadSize}),
			startCap:"none",endCap:spec.endCap??(spec.block?"stealth":"none"),waypoints:points.slice(1,-1),...(spec.block?{block:true as const}:{})}]);
		return;
	}
	/** Ink that shows on the board whatever its theme: near-black on light, near-white on dark. */
	private boardInk(): string {
		const theme = this.root === undefined ? undefined : this.root.getAttribute("data-miro-canvas-resolved-theme");
		return theme === "dark" ? "#e6e6e6" : "#1a1a1a";
	}

	/**
	 * What the pen draws with: the colour picked for it, or the board's own
	 * ink, so a first stroke is never invisible on a dark board.
	 */
	private penInk(): string {
		if (this.penColor !== undefined) return this.penColor;
		const theme = this.root === undefined ? undefined : this.root.getAttribute("data-miro-canvas-resolved-theme");
		return theme === "dark" ? "#ffffff" : "#1a1a1a";
	}

	/**
	 * How much a stylus's pressure widens or narrows the line.
	 *
	 * The middle of the range leaves the chosen thickness alone, so a mouse,
	 * a finger and an evenly pressed stylus all draw the line that was asked
	 * for.  The typical pressure of the stroke is used, not its peak, which a
	 * single hard moment would otherwise decide.
	 */
	private pressureScale(): number {
		const samples = [...this.penPressures].sort((left, right) => left - right);
		if (samples.length === 0) return 1;
		const median = samples[Math.floor(samples.length / 2)]!;
		return Math.min(Math.max(0.5 + median, MIN_PRESSURE_SCALE), MAX_PRESSURE_SCALE);
	}

	/** Dims a drawing the eraser has caught, so a person sees what will go. */
	private markErasing(id: string, caught: boolean): void {
		const node = (this.adapter.getNodes() ?? []).find((item) => readCanvasElementId(item) === id);
		const element = readCanvasElementDom(node);
		if (!isElement(element)) return;
		if (caught) element.classList.add("miro-canvas-erasing");
		else element.classList.remove("miro-canvas-erasing");
	}

	private clearErasing(): void {
		for (const id of this.erasing) this.markErasing(id, false);
		this.erasing.clear();
	}

	/** The drawings the eraser is over at a board point, or crossed coming from the one before. */
	private drawingsUnder(
		board: { readonly x: number; readonly y: number },
		previous?: { readonly x: number; readonly y: number },
	): readonly string[] {
		const { geometry, scene } = this.landingGeometry();
		const zoom = finite(readRuntime(this.viewport.getViewport(), "zoom")) ?? 1;
		const reach = this.eraserSize / 2 / zoom;
		const found: string[] = [];
		for (const [id, item] of scene.items) {
			const stroke = item.structured?.stroke;
			const rect = geometry.nodes?.[id];
			if (stroke === undefined || rect === undefined) continue;
			const hit = previous === undefined
				? strokeHitsPoint(stroke, rect, board, reach)
				: strokeHitsSegment(stroke, rect, previous, board, reach);
			if (hit) found.push(id);
		}
		return found;
	}

	/**
	 * Turns a rough stroke into the shape it was meant to be, as Miro's smart
	 * drawing does; a stroke that says nothing in particular is kept as the
	 * drawing it is, and a straight one between two items becomes a connector.
	 */
	private drawSmart(): void {
		const zoom = finite(readRuntime(this.viewport.getViewport(), "zoom")) ?? 1;
		const points = simplifyPoints(this.penPoints, 0.5 / zoom);
		const shape = recogniseStroke(points);
		if (shape === undefined) {
			this.drawStroke("pen");
			return;
		}
		if (shape.kind === "line") {
			const from = this.connectorLanding(this.viewportPoint(shape.from) ?? { x: 0, y: 0 }, undefined, undefined);
			const to = from?.nodeId === undefined
				? undefined
				: this.connectorLanding(this.viewportPoint(shape.to) ?? { x: 0, y: 0 }, from.nodeId, from.board);
			if (from?.nodeId !== undefined && to?.nodeId !== undefined) {
				this.penPoints = [];
				this.connectFromTool({ nodeId: from.nodeId, anchor: from.anchor, board: from.board }, this.viewportPoint(shape.to) ?? { x: 0, y: 0 });
				return;
			}
			// A line going nowhere in particular stays a drawing, drawn straight.
			this.penPoints = [shape.from, shape.to];
			this.drawStroke("pen");
			return;
		}
		this.penPoints = [];
		this.readInteractionState();
		this.authoring ??= createCanvasAuthoring(this.view);
		const created = this.authoring.createShape({
			shape: shape.kind === "ellipse" ? "ellipse" : shape.kind,
			text: "",
			x: Math.round(shape.box.x), y: Math.round(shape.box.y),
			width: Math.round(shape.box.width), height: Math.round(shape.box.height),
		});
		if (!created.ok) this.addDiagnostic(firstProblem(created.diagnostics) ?? "Canvas rejected the shape.");
		this.refresh();
	}

	/** Keeps the stroke a pen gesture drew, as one item of its own. */
	private drawStroke(tool: "pen" | "highlighter"): void {
		const zoom = finite(readRuntime(this.viewport.getViewport(), "zoom")) ?? 1;
		// The line is kept to the shape a person drew, not to every point the
		// pointer reported: within half a pixel on screen.  A stroke that still
		// has more points than a stored one may hold is simplified harder, or
		// the board would refuse to keep it at all.
		let tolerance = 0.5 / zoom;
		let points = simplifyPoints(this.penPoints, tolerance);
		while (points.length > MAX_STROKE_POINTS) {
			tolerance *= 2;
			points = simplifyPoints(this.penPoints, tolerance);
		}
		this.penPoints = [];
		if (points.length === 0) return;
		const width = Math.round(this.penWidth * (tool === "highlighter" ? HIGHLIGHTER_SCALE : 1) * this.pressureScale() * 100) / 100;
		this.penPressures = [];
		const rect = strokeBounds(points.length === 1 ? [points[0]!, points[0]!] : points, width);
		const stroke = {
			color: this.penInk(),
			width,
			...(tool === "highlighter" ? { opacity: HIGHLIGHTER_OPACITY } : {}),
			box: { width: Math.round(rect.width * 100) / 100, height: Math.round(rect.height * 100) / 100 },
			points: points.flatMap((point) => [
				Math.round((point.x - rect.x) * 100) / 100,
				Math.round((point.y - rect.y) * 100) / 100,
			]),
		};
		// A single tap leaves a dot: two points at the same place.
		if (stroke.points.length === 2) stroke.points.push(stroke.points[0]!, stroke.points[1]!);
		this.readInteractionState();
		this.authoring ??= createCanvasAuthoring(this.view);
		const created = this.authoring.createItem({
			item: { type: "drawing", stroke },
			x: rect.x, y: rect.y, width: rect.width, height: rect.height,
		});
		if (!created.ok) this.addDiagnostic(firstProblem(created.diagnostics) ?? "Canvas rejected the drawing.");
		this.refresh();
	}

	/**
	 * Selects what a lasso went round, as Miro's does, and hands the board back
	 * to the select tool so the catch can be moved at once.
	 */
	private selectLassoed(): void {
		const ring = this.penPoints;
		this.penPoints = [];
		this.selectedRouteEnds.clear();
		this.armedTool = "select";
		this.updateQuickTools();
		if (ring.length < 3) return;
		const geometry = this.landingGeometry().geometry;
		const caught: unknown[] = [];
		const groups = new Set(((readRuntime(this.currentRawDocument, "nodes") ?? []) as readonly unknown[])
			.filter((item) => readRuntime(item, "type") === "group").map((item) => readRuntime(item, "id")));
		for (const node of this.adapter.getNodes() ?? []) {
			const id = readCanvasElementId(node);
			const rect = id === undefined ? undefined : geometry.nodes?.[id];
			if (rect === undefined) continue;
			// An item is caught when the ring goes round its middle; a frame or a
			// group only when the ring goes round all of it, or circling a few
			// items inside a large frame would take the frame with them.
			const corners = [
				{ x: rect.x, y: rect.y }, { x: rect.x + rect.width, y: rect.y },
				{ x: rect.x + rect.width, y: rect.y + rect.height }, { x: rect.x, y: rect.y + rect.height },
			];
			const inside = groups.has(id!)
				? corners.every((corner) => pointInLasso(ring, corner))
				: pointInLasso(ring, { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 });
			if (inside) caught.push(node);
		}
		// A long connector must not pull the shared frame far outside the ring.
		for (const edge of this.adapter.getEdges() ?? []) {
			const id = readCanvasElementId(edge);
			const route = id === undefined ? undefined : geometry.edges?.[id];
			const points=route?.points??(route?.start&&route.end?[route.start,route.end]:[]);
			if (points.length>=2 && points.every(point=>pointInLasso(ring,point))) caught.push(edge);
		}
		const connectors=boardConnectors(this.currentRawDocument).filter(c=>{
			const route=geometry.edges?.[c.id],points=route?.points??(route?.start&&route.end?[route.start,route.end]:[]);
			return points.length>=2&&points.every(point=>pointInLasso(ring,point));
		});
		this.selectedCommentKeys=new Set(Object.entries(geometry.comments??{})
			.filter(([,point])=>pointInLasso(ring,point)).map(([key])=>key));
		this.callNative("deselectAll");
		for (const node of caught) this.callNative("select", [node]);
		this.connectorLayer?.select(connectors.map(c=>c.id));
		this.refresh();
	}

	/**
	 * Takes only the part of each drawing the eraser went over, leaving the
	 * rest of the stroke where it was; a drawing erased away altogether goes
	 * with the others.
	 */
	private erasePartOfDrawings(): void {
		const ids = [...this.erasing];
		const path = this.penPoints;
		this.clearErasing();
		this.penPoints = [];
		if (ids.length === 0 || path.length === 0) return;
		const { geometry, scene } = this.landingGeometry();
		const zoom = finite(readRuntime(this.viewport.getViewport(), "zoom")) ?? 1;
		const changes: { readonly id: string; readonly item: LocalItem }[] = [];
		const gone: string[] = [];
		for (const id of ids) {
			const stroke = scene.items.get(id)?.structured?.stroke;
			const rect = geometry.nodes?.[id];
			if (stroke === undefined || rect === undefined || !(rect.width > 0) || !(rect.height > 0)) continue;
			// The eraser's own line is measured in the stroke's space, as its
			// width and its points are.
			const scaleX = stroke.box.width / rect.width;
			const scaleY = stroke.box.height / rect.height;
			const local = path.flatMap((point) => [(point.x - rect.x) * scaleX, (point.y - rect.y) * scaleY]);
			// Only what the ring covers goes: the line's own middle within the
			// eraser's reach, not everything its width happens to touch.
			const reach = (this.eraserSize / 2 / zoom) * Math.min(scaleX, scaleY);
			const left = eraseFromStroke(stroke.points, stroke.breaks ?? [], local, reach);
			if (left === undefined) {
				gone.push(id);
				continue;
			}
			if (!left.changed) continue;
			changes.push({ id, item: { type: "drawing", stroke: { ...stroke, points: left.points, ...(left.breaks.length === 0 ? {} : { breaks: left.breaks }) } } });
		}
		// A locked drawing is left alone rather than refusing the whole sweep,
		// and what is trimmed and what is removed go in one step, undone as one.
		this.readInteractionState();
		const updates = changes.filter((change) => this.drawingEditable(change.id, "edit"));
		const removals = gone.filter((id) => this.drawingEditable(id, "delete"));
		if (updates.length + removals.length < changes.length + gone.length) {
			this.options.onNotice?.("Locked drawings were left as they are.");
		}
		if (updates.length === 0 && removals.length === 0) {
			this.refresh();
			return;
		}
		this.authoring ??= createCanvasAuthoring(this.view);
		const result = this.authoring.changeItems({ updates, removals });
		if (!result.ok) this.addDiagnostic(firstProblem(result.diagnostics) ?? "Canvas rejected the erase.");
		this.refresh();
	}

	/** Whether the board allows a drawing to be changed that way now. */
	private drawingEditable(id: string, operation: "edit" | "delete"): boolean {
		const decision = decideEditOperation(this.policy, operation, [id]);
		return decision.valid && decision.allowed;
	}

	private eraseDrawings(): void {
		const caught = [...this.erasing];
		this.clearErasing();
		this.penPoints = [];
		if (caught.length === 0) return;
		this.readInteractionState();
		const ids = caught.filter((id) => this.drawingEditable(id, "delete"));
		if (ids.length < caught.length) this.options.onNotice?.("Locked drawings were left as they are.");
		if (ids.length === 0) return;
		this.authoring ??= createCanvasAuthoring(this.view);
		const result = this.authoring.deleteItems({ ids });
		if (!result.ok) this.addDiagnostic(firstProblem(result.diagnostics) ?? "Canvas rejected the erase.");
		this.refresh();
	}

	/** Selects a node just made and puts the caret in it, as native Canvas does. */
	private editNode(id: string, line?: number): void {
		const canvas = this.nativeCanvas();
		const nodes = readRuntime(canvas, "nodes");
		const node = nodes instanceof Map ? nodes.get(id) : undefined;
		if (node === undefined) return;
		this.callNative("selectOnly", [node]);
		const start = readRuntime(node, "startEditing");
		if (typeof start === "function") {
			try {
				Reflect.apply(start, node, []);
			} catch {
				// A node that cannot be edited yet stays selected.
			}
		}
		if (line === undefined) return;
		const child = readRuntime(node, "child");
		const editor = readRuntime(child, "editor") ?? readRuntime(readRuntime(child, "editMode"), "editor");
		const setCursor = readRuntime(editor, "setCursor");
		if (typeof setCursor !== "function") return;
		try {
			Reflect.apply(setCursor, editor, [{ line, ch: 0 }]);
		} catch {
			// The caret stays where the editor put it.
		}
	}

	private connectFromTool(
		from: { readonly nodeId: string; readonly anchor: CanvasAnchor; readonly board: { readonly x: number; readonly y: number } },
		end: { readonly x: number; readonly y: number },
	): void {
		const landing = this.connectorLanding(end, from.nodeId, from.board, "");
		if (landing === undefined) return;
		this.writeBoardConnectors([{id:newCanvasId(),from:from.anchor,to:landing.anchor,route:"straight",color:this.boardInk(),width:2,startCap:"none",endCap:"arrow"}]);
	}

	/** A comment pinned where the board was clicked: on the item there, or on the board. */
	private composeComment(board: { readonly x: number; readonly y: number }, client: { readonly x: number; readonly y: number }): void {
		const anchor = this.commentAnchorAt(board);
		const card = this.ensureCommentCard();
		if (card === undefined || this.root === undefined) return;
		this.openThread = undefined;
		this.commentDraft = anchor;
		card.compose(this.commentAuthor().name);
		const rootRect = this.root.getBoundingClientRect();
		card.place({ x: client.x - rootRect.left, y: client.y - rootRect.top }, clientSize(this.root));
	}

	/** What a comment put at a board point holds on to: the smallest item there, or the board. */
	private commentAnchorAt(board: { readonly x: number; readonly y: number }): CanvasAnchor {
		let anchor: CanvasAnchor = { type: "free", x: Math.round(board.x * 100) / 100, y: Math.round(board.y * 100) / 100 };
		let smallest = Number.POSITIVE_INFINITY;
		for (const [nodeId, rect] of Object.entries(this.landingGeometry().geometry.nodes ?? {})) {
			if (!(rect.width > 0) || !(rect.height > 0) || !insideRect(rect, board)) continue;
			const area = rect.width * rect.height;
			if (area >= smallest) continue;
			smallest = area;
			anchor = {
				type: "node", nodeId,
				u: Math.round(((board.x - rect.x) / rect.width) * 1000) / 1000,
				v: Math.round(((board.y - rect.y) / rect.height) * 1000) / 1000,
			};
		}
		return anchor;
	}

	/**
	 * A pin put down somewhere else: its thread now holds on to what it was
	 * dropped on.  The place is the plugin's own record, so a Miro comment,
	 * whose export is never rewritten, moves the same way a local one does.
	 */
	private moveCommentThread(threadId: string, origin: CommentOrigin, point: { readonly x: number; readonly y: number }): void {
		this.commentMovePreview = undefined;
		if (this.commentLocked(threadId, origin)) { this.refresh(); return; }
		const board = this.boardPoint(point);
		if (board === undefined) {
			this.refresh();
			return;
		}
		const anchor = this.commentAnchorAt(board);
		this.writeMetadata("move-comment", (draft) => {
			const places = readRuntime(draft, "commentPlaces");
			draft.commentPlaces = { ...(isObject(places) ? places : {}), [commentPlaceKey(origin, threadId)]: anchor };
			return draft;
		});
		this.refresh();
	}

	private createComment(text: string, name?: string, appearance?: {color: string; locked: boolean}): void {
		const anchor = this.commentDraft;
		let createdId: string | undefined;
		this.mutateComment("add-comment", (draft) => {
			const result = addLocalComment(draft, { text, ...(anchor === undefined ? {} : { anchor }),
				...(appearance && /^#[0-9a-f]{6}$/i.test(appearance.color) ? {color: appearance.color, locked: appearance.locked} : {}) },
				{ author: {name: name?.trim() || this.commentAuthor().name} });
			createdId = result.comment?.id;
			return result;
		});
		this.commentDraft = undefined;
		if (createdId === undefined) return;
		this.openThread = { id: createdId, origin: "local" };
		this.updateCommentMarkers();
	}

	/** A small field for the address of a link dropped on the board. */
	private promptLink(board: { readonly x: number; readonly y: number }, client: { readonly x: number; readonly y: number }): void {
		const root = this.root;
		if (root === undefined) return;
		const document = root.ownerDocument;
		const form = document.createElement("form");
		form.className = "miro-canvas-link-prompt";
		const rootRect = root.getBoundingClientRect();
		form.style.left = `${client.x - rootRect.left}px`;
		form.style.top = `${client.y - rootRect.top}px`;
		const input = document.createElement("input");
		input.type = "url";
		input.placeholder = "Paste a web address";
		input.setAttribute("aria-label", "Web address");
		form.appendChild(input);
		const outside = (event: Event): void => {
			const target = event.target as Node | null;
			if (target !== null && form.contains(target)) return;
			close();
		};
		let closed = false;
		const close = (): void => {
			if (closed) return;
			closed = true;
			document.removeEventListener("pointerdown", outside, true);
			try {
				form.remove();
			} catch {
				// Something else already took the field away.
			}
		};
		// A board closed with the field still open takes the field with it.
		this.disposers.push(close);
		for (const type of ["pointerdown", "keydown", "keyup", "dblclick"]) {
			form.addEventListener(type, (event) => {
				if (type === "keydown" && (event as KeyboardEvent).key === "Escape") close();
				event.stopPropagation();
			});
		}
		// A press anywhere else on the board puts the field away, as Escape does.
		document.addEventListener("pointerdown", outside, true);
		form.addEventListener("submit", (event) => {
			event.preventDefault();
			const url = input.value.trim();
			close();
			if (url.length === 0) return;
			this.readInteractionState();
			this.authoring ??= createCanvasAuthoring(this.view);
			const size = { width: 400, height: 240 };
			const created = this.authoring.createItem({
				item: { type: "link" }, url, x: board.x - size.width / 2, y: board.y - size.height / 2, ...size,
			});
			if (!created.ok) this.options.onNotice?.(firstProblem(created.diagnostics) ?? "Canvas rejected the link.");
			this.refresh();
		});
		root.appendChild(form);
		input.focus();
	}

	private adoptNativeMenu(): void {
		if (!this.settings.selectionToolbarEnabled) return;
		const slot = this.toolbar.nativeSlot;
		const menu = readRuntime(this.nativeCanvas(), "menu");
		const menuEl = readRuntime(menu, "menuEl");
		const container = readRuntime(menu, "containerEl");
		if (!isElement(slot) || !isElement(menuEl) || !isElement(container) || menuEl.parentElement === slot) return;
		const root = this.root;
		const document = ownerDocument(root);
		if (root === undefined || document === undefined) return;
		// Native Canvas deliberately empties its menu while the board is being
		// panned.  Since that menu now lives inside our toolbar, its disappearance
		// used to make the whole row jump narrower under a held middle button.  A
		// non-interactive snapshot keeps the row visually stable for that gesture;
		// the real native buttons remain the only controls before and afterwards.
		const snapshot = menuEl.cloneNode(false) as HTMLElement;
		snapshot.classList.add("miro-canvas-toolbar__native-snapshot");
		snapshot.setAttribute("aria-hidden", "true");
		snapshot.setAttribute("inert", "");
		snapshot.hidden = true;
		try {
			slot.appendChild(menuEl);
			slot.appendChild(snapshot);
		} catch {
			return;
		}
		let middlePointer: number | undefined;
		const hideSnapshot = (): void => {
			middlePointer = undefined;
			snapshot.hidden = true;
		};
		const down = (event: Event): void => {
			const pointer = event as PointerEvent;
			if (pointer.button !== 1 || menuEl.children.length === 0) return;
			middlePointer = pointer.pointerId;
			snapshot.replaceChildren(...Array.from(menuEl.children, (child) => child.cloneNode(true)));
			snapshot.hidden = false;
			// Keep the fallback armed: native menu clearing may happen on a later frame.
			// CSS hides it whenever the real menu is populated.
		};
		const up = (event: Event): void => {
			const pointer = event as PointerEvent;
			if (middlePointer === undefined || (pointer.pointerId !== undefined && pointer.pointerId !== middlePointer)) return;
			hideSnapshot();
		};
		root.addEventListener("pointerdown", down, true);
		document.addEventListener("pointerup", up, true);
		document.addEventListener("pointercancel", up, true);
		document.defaultView?.addEventListener("blur", hideSnapshot);
		this.disposers.push(() => {
			root.removeEventListener("pointerdown", down, true);
			document.removeEventListener("pointerup", up, true);
			document.removeEventListener("pointercancel", up, true);
			document.defaultView?.removeEventListener("blur", hideSnapshot);
			snapshot.remove();
			try {
				if (menuEl.parentElement === slot) container.prepend(menuEl);
			} catch {
				// A container native Canvas has already destroyed needs nothing back.
			}
		});
	}

	/** The native Canvas runtime this session drives, found the way the adapter finds it. */
	private nativeCanvas(): UnknownRecord | undefined {
		const observed = this.adapter.read("getData");
		const canvas = [this.view, ...["canvas", "_canvas", "canvasView", "canvasRuntime"]
			.map((key) => readRuntime(this.view, key))]
			.find((candidate) => isObject(candidate) && observed !== undefined && readRuntime(candidate, "getData") === observed);
		return isObject(canvas) ? canvas as UnknownRecord : undefined;
	}

	private handlesState(editable: boolean): SelectionHandlesState {
		// Independent connectors own their SVG handles. Never render the native
		// endpoint editor over them (it also uses a different coordinate origin).
		if (this.connectorLayer?.selection().length || this.selectedCommentKeys.size) return { selectedIds: [], rotation: 0, editable, isEdge: false };
		const id = this.selectedIds[0];
		const { geometry, scene } = this.landingGeometry();
		return {
			selectedIds: this.selectedIds,
			rotation: id === undefined
				? 0
				: this.rotationPreview?.id === id
					? this.rotationPreview.rotation
					: scene.items.get(id)?.rotation ?? this.rotationFor(id),
			editable,
			isEdge: id !== undefined && (geometry.edges?.[id] !== undefined || this.lineOf(id) !== undefined),
			...(id !== undefined && this.lineOf(id) !== undefined ? { freeEnds: true } : {}),
			...(() => {
				const origin = this.overlayOrigin();
				return origin === undefined ? {} : { origin: { x: origin.left, y: origin.top } };
			})(),
			...(id === undefined ? {} : { shape: this.selectedShape(id) }),
			...(id === undefined ? {} : { rect: this.handleRect(id) }),
			...(id === undefined || (geometry.edges?.[id] === undefined && this.lineOf(id) === undefined) ? {} : { endpoints: this.connectorEnds(id) }),
			...(() => {
				const grips = id === undefined || (geometry.edges?.[id] === undefined && this.lineOf(id) === undefined) ? undefined : this.routeGrips(id);
				return grips === undefined ? {} : { routeGrips: grips };
			})(),
			...(() => {
				// Native Canvas never lets a node shrink below its own minimum.
				const least = finite(readRuntime(readRuntime(this.nativeCanvas(), "config"), "minContainerDimension"));
				const zoom = finite(readRuntime(this.viewport.getViewport(), "zoom"));
				return least === undefined || zoom === undefined ? {} : { minSize: least * zoom };
			})(),
		};
	}

	private selectedShape(id: string): string | undefined {
		const document = this.currentRawDocument;
		let cache = this.shapeCache;
		if (cache === undefined || cache.document !== document) {
			cache = { document, shapes: new Map() };
			this.shapeCache = cache;
		}
		if (!cache.shapes.has(id)) {
			cache.shapes.set(id, resolveSelectionToolbarPresentation(document, id).style.shape);
		}
		return cache.shapes.get(id);
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
	/**
	 * The overlay's own origin, not the Canvas root's.
	 *
	 * The overlay is absolutely positioned, so its coordinates start at its
	 * containing block - the nearest positioned ancestor, which is not always
	 * the root this session measured.  Assuming the root shifted the frame by a
	 * constant, and a frame that turns about its own centre while sitting
	 * beside the node reads as rotating about a different point entirely.
	 */
	private overlayOrigin(): { readonly left: number; readonly top: number } | undefined {
		return boundingRect(isElement(this.handles.element) ? this.handles.element : this.root)
			?? boundingRect(this.root);
	}

	private handleRect(id: string): HandleRect | undefined {
		if (this.root === undefined) {
			return undefined;
		}
		const rootRect = this.overlayOrigin();
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
		const presentation = resolveSelectionToolbarPresentation(this.currentRawDocument, id);
		const independent=boardConnectors(this.currentRawDocument).find(c=>c.id===id);
		const placement = this.selectionPlacement();
		const kinds = this.selectionKinds();
		const link = this.selectedLink();
		return {
			selectedIds: this.selectedIds,
			kinds,
			editable: !state.reviewMode && !lockedSelection,
			locked: lockedSelection,
			reviewMode: state.reviewMode,
			...(state.reviewMode
				? { blockedReason: "Review mode is on; formatting is disabled." }
				: lockedSelection
					? { blockedReason: "This selection is locked. Unlock it to change formatting." }
					: {}),
			typography: presentation.typography,
			colors: presentation.colors,
			palette: this.appearance.settings.palette,
			// A note is filled from Miro's own sticky colours, as Miro offers them.
			...(kinds.length > 0 && kinds.every((kind) => kind === "sticky") ? { fillPalette: STICKY_PALETTE } : {}),
			// A frame takes quieter, see-through fills, so its items stay the thing seen.
			...(kinds.length > 0 && kinds.every((kind) => kind === "frame") ? { fillPalette: FRAME_PALETTE } : {}),
			recentColors: this.appearance.settings.recentColors,
			...presentation.style,
			...(independent?{connector:{route:independent.route,startCap:independent.startCap as never,endCap:connectorEndCap(independent) as never,width:independent.width,...(independent.headSize === undefined ? {} : {headSize: independent.headSize}),strokeStyle:independent.strokeStyle??"solid",waypoints:independent.waypoints??[]},colors:{...presentation.colors,edge:independent.color}}:{}),
			independentSelection: !!this.connectorLayer?.selection().length,
			independentOnly: this.selectedIds.length>0 && this.selectedIds.every(id=>this.connectorLayer?.selection().includes(id)),
			canEditConnectorLabel: this.selectedIds.length===1 && kinds.includes("edge"),
			...(placement === undefined ? {} : { placement }),
			...(link === undefined ? {} : { link }),
		};
	}

	/** The web address of the one selected link node; nothing else is opened from the board. */
	private selectedLink(): string | undefined {
		if (this.selectedIds.length !== 1) {
			return undefined;
		}
		const nodes = readRuntime(this.currentRawDocument, "nodes");
		const node = Array.isArray(nodes)
			? (nodes as readonly unknown[]).find((item) => readRuntime(item, "id") === this.selectedIds[0])
			: undefined;
		const url = readRuntime(node, "type") === "link" ? readRuntime(node, "url") : undefined;
		if (typeof url !== "string") {
			return undefined;
		}
		try {
			const protocol = new URL(url).protocol;
			return protocol === "http:" || protocol === "https:" ? url : undefined;
		} catch {
			return undefined;
		}
	}

	private openSelectedLink(): void {
		const url = this.selectedLink();
		const view = ownerDocument(this.root)?.defaultView;
		// Obsidian hands a new window's web address to the system browser.
		if (url !== undefined) view?.open(url, "_blank", "noopener");
	}

	/** A board rectangle for a node the file still has. */
	private nodeRect(id: string): SlideRect | undefined {
		const nodes = readRuntime(this.currentRawDocument, "nodes");
		const node = Array.isArray(nodes)
			? (nodes as readonly unknown[]).find((item) => readRuntime(item, "id") === id)
			: undefined;
		const x = finite(readRuntime(node, "x")), y = finite(readRuntime(node, "y"));
		const width = finite(readRuntime(node, "width")), height = finite(readRuntime(node, "height"));
		return x === undefined || y === undefined || width === undefined || height === undefined || !(width > 0) || !(height > 0)
			? undefined
			: { x, y, width, height };
	}

	private showRect(rect: SlideRect): void {
		if (this.root === undefined) return;
		this.viewport.fitToBounds(rect, clientSize(this.root));
		this.refresh();
	}

	/** A presentation's bar: show its slides one by one, or all of them at once. */
	private runDeckAction(deckId: string, action: DeckAction): void {
		if (this.root === undefined || this.disposed) return;
		const slides = buildSourceScene(this.currentRawDocument).items.get(deckId)?.structured?.deck?.slides ?? [];
		if (action === "fit") {
			const rect = this.nodeRect(deckId);
			if (rect !== undefined) this.showRect(rect);
			return;
		}
		this.callNative("deselectAll");
		this.slideShow ??= new SlideShow(this.root, {
			rectOf: (id) => this.nodeRect(id),
			show: (rect) => this.showRect(rect),
			...(this.options.setIcon === undefined ? {} : { setIcon: this.options.setIcon }),
		});
		this.slideShow.start(slides);
	}

	private selectionKinds(): readonly SelectionKind[] {
		const edgeIds = new Set(collectCanvasElementIds(this.adapter.getEdges() ?? []));
		for(const c of boardConnectors(this.currentRawDocument))edgeIds.add(c.id);
		const source = buildSourceScene(this.currentRawDocument);
		const nodes = readRuntime(this.currentRawDocument, "nodes");
		const kinds = new Set<SelectionKind>();
		for (const id of this.selectedIds) {
			if (edgeIds.has(id)) {
				kinds.add("edge");
				continue;
			}
			const node = Array.isArray(nodes)
				? (nodes as readonly unknown[]).find((item) => readRuntime(item, "id") === id)
				: undefined;
			const descriptor = source.items.get(id);
			// A line is set like a connector: its ends, route, dashes and colour.
			if (descriptor?.structured?.line !== undefined) {
				kinds.add("edge");
				continue;
			}
			// Any card that only holds text can be given a shape, as a shape can.
			if (takesShape(descriptor, readRuntime(node, "type"))) {
				kinds.add("shape");
				continue;
			}
			const kind = descriptor?.kind;
			if (kind !== undefined) {
				kinds.add(kind === "connector" ? "edge" : kind === "code" ? "text" : kind === "group" ? "frame" : kind);
				continue;
			}
			kinds.add(readRuntime(node, "type") === "file" ? "media" : readRuntime(node, "type") === "group" ? "frame" : "text");
		}
		return [...kinds];
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
		let bottom = Number.NEGATIVE_INFINITY;
		for (const element of [...(this.adapter.getNodes() ?? []), ...(this.adapter.getEdges() ?? [])]) {
			const id = readCanvasElementId(element);
			if (id === undefined || !this.selectedIds.includes(id)) {
				continue;
			}
			// An edge has no HTML element, only its SVG line group; without it a
			// selected connector had no toolbar - and, with the native menu
			// adopted into the toolbar, no menu at all.
			const rect = boundingRect(readCanvasElementDom(element) ?? readRuntime(element, "lineGroupEl"));
			if (rect === undefined) {
				continue;
			}
			left = Math.min(left, rect.left);
			top = Math.min(top, rect.top);
			right = Math.max(right, rect.right);
			bottom = Math.max(bottom, rect.bottom);
		}
		const geometry=buildCanvasAnchorGeometry(this.currentRawDocument);
		for(const id of this.connectorLayer?.selection()??[]){
			const route=geometry.edges?.[id];
			for(const p of route?.points ?? (route?.start&&route.end?[route.start,route.end]:[])){
				const at=this.viewportPoint(p);if(!at)continue;
				left=Math.min(left,at.x);right=Math.max(right,at.x);top=Math.min(top,at.y);bottom=Math.max(bottom,at.y);
			}
		}
		if (!Number.isFinite(left) || !Number.isFinite(top) || !Number.isFinite(right)) {
			return undefined;
		}
		// The toolbar is centred over the selection, but never off the view: a
		// selection at an edge, or a narrow screen, would otherwise put its
		// controls out of reach.  Without room above, it hangs below instead.
		const area = clientSize(this.root);
		const self = boundingRect(this.toolbar.element);
		const width = self === undefined ? 320 : self.right - self.left;
		const height = self === undefined ? 40 : self.bottom - self.top;
		const margin = 8;
		const half = Math.min(width, Math.max(area.width - margin * 2, 0)) / 2;
		const centre = (left + right) / 2 - rootRect.left;
		const x = Math.min(Math.max(centre, half + margin), Math.max(half + margin, area.width - half - margin));
		const above = top - rootRect.top;
		const below = above >= height + margin + 12 ? undefined : true;
		return {
			x,
			y: below === undefined ? above : Math.min(bottom - rootRect.top, Math.max(0, area.height - height - margin - 12)),
			...(below === undefined ? {} : { below }),
		};
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
		const slot = readRuntime(action, "slot");
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
			const merged=mergeAppearanceMetadata(draft, next, previous);
			if(slot==="edge"){
				const connectors=boardConnectors(merged);
				const color=readRuntime(action,"color");
				merged.connectors=Object.fromEntries(connectors.map(c=>[c.id,this.selectedIds.includes(c.id)?{...c,color:typeof color==="string"&&/^#[0-9a-f]{6}$/i.test(color)?color:"#1a1a1a"}:c]));
			}
			return merged;
		});
		// Obsidian's own colour also lives on the element as a Canvas preset,
		// tinting a node's fill and border and a connector's line.  It is taken
		// off after the metadata commit, which refuses a graph that changed
		// under it, and saved the way Canvas saves its own colour menu.
		if (type === APPEARANCE_ACTIONS.resetColor && (slot === "fill" || slot === "border" || slot === "edge")
			&& this.clearNativeColors(this.selectedIds)) {
			this.adapter.requestSave();
			this.refresh();
		}
		// Picking a highlight colour marks the text; picking none takes the marks off.
		if (type === APPEARANCE_ACTIONS.setColor && slot === "highlight") {
			this.markSelectedText(readRuntime(action, "color") !== null);
		}
	}

	/**
	 * Mark the text being written, when some of it is selected, or the whole
	 * of each selected card; or take every mark off.  The marks are written in
	 * the text itself - Markdown's ==, or <mark> in an HTML card - after the
	 * colour is stored, since the metadata writer refuses a graph that changed
	 * under it.
	 */
	private markSelectedText(on: boolean): void {
		let changed = false;
		for (const node of this.adapter.getNodes() ?? []) {
			const id = readCanvasElementId(node);
			if (id === undefined || !this.selectedIds.includes(id)) continue;
			const text = readRuntime(node, "text");
			if (typeof text !== "string") continue;
			const child = readRuntime(node, "child");
			const editor = readRuntime(child, "editor") ?? readRuntime(readRuntime(child, "editMode"), "editor");
			const selected = readRuntime(node, "isEditing") === true && isObject(editor) ? callRuntime(editor, "getSelection") : undefined;
			if (on && typeof selected === "string" && selected !== "") {
				callRuntime(editor, "replaceSelection", markSelection(selected, isHtmlText(text)));
				continue;
			}
			const next = on ? highlightText(text) : unhighlightText(text);
			if (next === text || typeof readRuntime(node, "setText") !== "function") continue;
			callRuntime(node, "setText", next);
			changed = true;
		}
		if (changed) this.adapter.requestSave();
		this.refresh();
	}

	/** Take native Canvas colour presets off elements, the way its own colour menu does. */
	private clearNativeColors(ids: readonly string[]): boolean {
		let cleared = false;
		for (const item of [...(this.adapter.getNodes() ?? []), ...(this.adapter.getEdges() ?? [])]) {
			const id = readCanvasElementId(item);
			const color = readRuntime(item, "color");
			const setColor = readRuntime(item, "setColor");
			if (id === undefined || !ids.includes(id) || typeof color !== "string" || color === "" || typeof setColor !== "function") continue;
			try {
				Reflect.apply(setColor, item, ["", false]);
				cleared = true;
			} catch {
				this.addDiagnostic("Canvas refused to clear its own color on an element.");
			}
		}
		return cleared;
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
				settings.minimapVisible = !this.minimapShown();
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
		} else if (action === "zoom-50" || action === "zoom-200") {
			applied = this.viewport.setZoom(action === "zoom-50" ? 0.5 : 2);
		} else if (action === "zoom-fit") {
			applied = this.viewport.fitToBounds(this.minimap?.contentBounds, clientSize(this.root));
		} else if (action === "undo" || action === "redo") {
			// Native history holds every edit this plugin makes, so it undoes them all alike.
			applied = this.callNative(action);
		} else if (action === "toggle-snap-grid" || action === "toggle-snap-objects") {
			const grid = action === "toggle-snap-grid";
			const current = this.nativeSnapping()[grid ? "snapToGrid" : "snapToObjects"];
			applied = current !== undefined && this.callNative(grid ? "toggleGridSnapping" : "toggleObjectSnapping", [!current]);
		}
		if (!applied) {
			this.addDiagnostic(`Navigation action "${action}" is unavailable in this Canvas runtime.`);
		}
		this.refresh();
	}

	/** A board shows its minimap as it was last set, or as the plugin settings say for a new board. */
	private minimapShown(): boolean {
		const stored = this.appearance.settings.minimapVisible;
		return typeof stored === "boolean" ? stored : this.settings.minimapVisible;
	}

	/** Obsidian's own snapping switches, as its Canvas settings menu shows them. */
	private nativeSnapping(): { snapToGrid?: boolean; snapToObjects?: boolean } {
		const options = readRuntime(this.nativeCanvas(), "options");
		const grid = readRuntime(options, "snapToGrid");
		const objects = readRuntime(options, "snapToObjects");
		return {
			...(typeof grid === "boolean" ? { snapToGrid: grid } : {}),
			...(typeof objects === "boolean" ? { snapToObjects: objects } : {}),
		};
	}

	/**
	 * Copy and paste with what the plugin knows of each item.  A copy adds
	 * the plugin's record to what native Canvas puts on the clipboard; a paste
	 * of such a copy is laid down here, record and all, in one history step.
	 * Files copied in the file explorer, or named by a link, are pasted as
	 * nodes pointing at them.  Anything else is left to native Canvas.
	 */
	private attachClipboard(): void {
		const root = this.root;
		const document = root?.ownerDocument;
		if (root === undefined || typeof document?.addEventListener !== "function" || typeof root.addEventListener !== "function") return;
		const onBoard = (): boolean => {
			const active = document.activeElement;
			return active !== null && (active === root || root.contains?.(active) === true || active === document.body && root.closest?.(".workspace-leaf.mod-active") !== null)
				&& active.closest?.("input, textarea, [contenteditable=true], .cm-editor") == null;
		};
		const execute = (action:"copy"|"cut"|"paste"): boolean => {
			const bridge=this.options.desktopClipboard;
			if(!bridge) return document.execCommand?.(action) ?? false;
			try {
				const data=new DataTransfer();
				if(action==="paste") data.setData("text/plain",bridge.readText());
				const event=new ClipboardEvent(action==="cut"?"copy":action,{clipboardData:data,bubbles:true,cancelable:true});
				root.dispatchEvent(event);
				if(!event.defaultPrevented) return false;
				if(action!=="paste") bridge.writeText(data.getData("text/plain"));
				// Cut only after the OS clipboard has accepted the complete payload.
				if(action==="cut") root.dispatchEvent(new ClipboardEvent("cut",{clipboardData:data,bubbles:true,cancelable:true}));
				return true;
			} catch {this.options.onNotice?.("System clipboard was unavailable; the selection was not cut.");return false;}
		};
		this.clipboardCommand=execute;
		const copy = (event: Event): void => {
			if (!onBoard()) return;
			const data = readRuntime(event, "clipboardData") as DataTransfer | undefined;
			const record = this.clipboardRecord();
			if (data === undefined || record === undefined) return;
			if (event.type === "cut" && !this.editAllowed("delete", this.selectedIds)) {
				event.preventDefault();
				event.stopImmediatePropagation();
				return;
			}
			const ids = new Set(this.selectedIds);
			const nodes = (readRuntime(this.currentRawDocument, "nodes") as Record<string, unknown>[] ?? []).filter(node => ids.has(node.id as string));
			const edges = (readRuntime(this.currentRawDocument, "edges") as Record<string, unknown>[] ?? []).filter(edge => ids.has(edge.id as string) || (ids.has(edge.fromNode as string) && ids.has(edge.toNode as string)));
			const all=boardConnectors(this.currentRawDocument), geometry=buildCanvasAnchorGeometry(this.currentRawDocument);
			const included=new Set(all.filter(c=>ids.has(c.id)||[c.from,c.to].every(a=>(a.type==="node"||a.type==="image")&&ids.has(a.nodeId))).map(c=>c.id));
			const connectors=all.filter(c=>included.has(c.id)).map(c=>{
				const end=(a:CanvasAnchor,p:{x:number;y:number}|undefined):CanvasAnchor=>{
					if((a.type==="node"||a.type==="image")&&ids.has(a.nodeId)||a.type==="edge"&&(included.has(a.edgeId)||edges.some(e=>e.id===a.edgeId)))return a;
					return p?{type:"free",x:p.x,y:p.y}:a;
				};
				return {...c,from:end(c.from,geometry.edges?.[c.id]?.start),to:end(c.to,geometry.edges?.[c.id]?.end)};
			});
			const points: {x:number;y:number}[] = [];
			for (const node of nodes) {
				if ([node.x,node.y,node.width,node.height].every(v=>typeof v==="number"&&Number.isFinite(v))) {
					points.push({x:node.x as number,y:node.y as number},{x:(node.x as number)+(node.width as number),y:(node.y as number)+(node.height as number)});
				}
			}
			for (const c of connectors) points.push(...(geometry.edges?.[c.id]?.points ?? []));
			const bounds = points.reduce((box, p) => ({
				left: Math.min(box.left, p.x), right: Math.max(box.right, p.x),
				top: Math.min(box.top, p.y), bottom: Math.max(box.bottom, p.y),
			}), {left: Infinity, right: -Infinity, top: Infinity, bottom: -Infinity});
			const center = points.length ? {x:(bounds.left+bounds.right)/2,y:(bounds.top+bounds.bottom)/2} : undefined;
			const graph = { nodes, edges, ...(connectors.length?{connectors}:{}), ...(center?{center}:{}) };
			try {
				data.setData(CLIPBOARD_TYPE, JSON.stringify(record));
				data.setData(CANVAS_CLIPBOARD_TYPE, JSON.stringify(graph));
				data.setData("text/plain", JSON.stringify({ miroCanvasClipboard: 1, graph, record }));
			} catch {
				return; // A failed copy must never delete the selection.
			}
			event.preventDefault();
			event.stopImmediatePropagation();
			if (event.type === "cut") {
				this.deleteBoardSelection();
			}
		};
		const paste = (event: Event): void => {
			if (!onBoard() || event.defaultPrevented) return;
			const data = readRuntime(event, "clipboardData") as DataTransfer | undefined;
			if (data === undefined || !this.editAllowed("paste", [])) return;
			const read = (type: string): string => {
				try {
					return data.getData(type);
				} catch {
					return "";
				}
			};
			let graphText = read(CANVAS_CLIPBOARD_TYPE), recordText = read(CLIPBOARD_TYPE);
			try {
				const text = JSON.parse(read("text/plain"));
				if (text?.miroCanvasClipboard === 1) { graphText ||= JSON.stringify(text.graph); recordText ||= JSON.stringify(text.record); }
			} catch { /* Ordinary text belongs to native Canvas. */ }
			const handled = this.pasteCopy(graphText, recordText)
				|| this.pasteLinkedFiles(read("obsidian/files"), read("text/plain"));
			if (!handled) return;
			event.preventDefault();
			event.stopImmediatePropagation();
		};
		const track = (event: Event): void => {
			if (this.inControls(event)) return;
			const x = finite(readRuntime(event, "clientX")), y = finite(readRuntime(event, "clientY"));
			if (x !== undefined && y !== undefined) this.lastPointer = { x, y, at: Date.now() };
		};
		const key = (event: KeyboardEvent): void => {
			if (!onBoard() || !(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return;
			const command = ({ KeyC: "copy", KeyX: "cut", KeyV: "paste" } as Record<string, "copy"|"cut"|"paste">)[event.code];
			if (command === undefined) return;
			// Capture before Obsidian's hotkey scope; physical codes also work in Russian layouts.
			if (execute(command)) { event.preventDefault(); event.stopImmediatePropagation(); }
		};
		const context = (event: MouseEvent): void => {
			if (!this.inControls(event) && ((this.armedTool === "select" && !this.isSpacePanHeld() && (matchesPointer(this.settings.lassoBinding, event) || matchesPointer(this.settings.panBinding, event)))
				|| this.panGestureEnd !== undefined || this.toolGesture !== undefined || Date.now() < this.suppressContextUntil
				|| ((this.armedTool === "connector" || (this.armedTool === "shape" && lineKind(this.toolShape) !== undefined)) && matchesPointer(this.settings.lineBinding, event)))) {
				event.preventDefault(); event.stopImmediatePropagation(); return;
			}
			if (this.options.onClipboardMenu === undefined || this.inControls(event) || this.closestTarget(event, "input, textarea, [contenteditable=true], .cm-editor")) return;
			this.readInteractionState();
			if (this.selectedIds.length === 0) return;
			event.preventDefault(); event.stopImmediatePropagation();
			this.options.onClipboardMenu(event, action => {
				root.focus();
				if (!execute(action)) this.options.onNotice?.("Clipboard action was unavailable. Focus the canvas and use Ctrl+C, Ctrl+X or Ctrl+V.");
			}, () => { this.callNative("onSelectionContextMenu", [event]); });
		};
		const keyTarget = document.defaultView ?? document;
		keyTarget.addEventListener("keydown", key as EventListener, true);
		root.addEventListener("contextmenu", context, true);
		document.addEventListener("copy", copy, true);
		document.addEventListener("cut", copy, true);
		document.addEventListener("paste", paste, true);
		root.addEventListener("pointermove", track, { passive: true });
		root.addEventListener("pointerdown", track, { capture: true, passive: true });
		this.disposers.push(() => {
			keyTarget.removeEventListener("keydown", key as EventListener, true);
			root.removeEventListener("contextmenu", context, true);
			document.removeEventListener("copy", copy, true);
			document.removeEventListener("cut", copy, true);
			document.removeEventListener("paste", paste, true);
			root.removeEventListener("pointermove", track);
			root.removeEventListener("pointerdown", track, true);
		});
	}

	/** The plugin's record of what is selected, as a copy carries it. */
	private clipboardRecord(): { readonly version: 1; readonly board: string; readonly items: Record<string, ClipboardItem> } | undefined {
		this.readInteractionState();
		if (this.selectedIds.length === 0) return undefined;
		const scene = this.landingGeometry().scene;
		const overrides = readRuntime(readRuntime(this.currentRawDocument, "miroCanvas"), "localOverrides");
		const items: Record<string, ClipboardItem> = {};
		// The connectors between selected nodes go with them, as native Canvas copies them.
		const edges = (readRuntime(this.currentRawDocument, "edges") ?? []) as readonly unknown[];
		const ids = new Set(this.selectedIds);
		for (const edge of edges) {
			const id = readRuntime(edge, "id");
			if (typeof id === "string" && ids.has(readRuntime(edge, "fromNode") as string) && ids.has(readRuntime(edge, "toNode") as string)) ids.add(id);
		}
		for (const id of ids) {
			const override = readRuntime(overrides, id);
			const sourceId = scene.items.get(id)?.sourceId;
			if (!isObject(override) && sourceId === undefined) continue;
			items[id] = {
				...(isObject(override) ? { override: JSON.parse(JSON.stringify(override)) as Record<string, unknown> } : {}),
				...(sourceId === undefined ? {} : { sourceId }),
			};
		}
		const board = readRuntime(readRuntime(this.view, "file"), "path");
		return { version: 1, board: typeof board === "string" ? board : "", items };
	}

	/** Where a paste lands: under the pointer when it is on the board, else the middle of the view. */
	private pastePoint(): { readonly x: number; readonly y: number } | undefined {
		const pointer = this.lastPointer;
		const rect = this.root === undefined ? undefined : boundingRect(this.root);
		if (pointer !== undefined && rect !== undefined
			&& pointer.x >= rect.left && pointer.x <= rect.right && pointer.y >= rect.top && pointer.y <= rect.bottom) {
			return this.boardPoint(pointer);
		}
		const centre = readRuntime(this.nativeCanvas(), "posCenter");
		if (typeof centre !== "function") return undefined;
		try {
			const point = Reflect.apply(centre, this.nativeCanvas(), []) as { x?: unknown; y?: unknown };
			const x = finite(point?.x), y = finite(point?.y);
			return x === undefined || y === undefined ? undefined : { x, y };
		} catch {
			return undefined;
		}
	}

	/** Paste a copy made with this plugin, its record included; false leaves the paste to native Canvas. */
	private pasteCopy(canvasText: string, recordText: string): boolean {
		const canvas = readCanvasClipboard(canvasText);
		const record = readClipboardRecord(recordText);
		if (canvas === undefined || record === undefined || canvas.nodes.length === 0 && !canvas.connectors?.length) return false;
		const target = this.pastePoint();
		const centre = canvas.center;
		const offset = target === undefined || centre === undefined ? { x: 40, y: 40 } : { x: target.x - centre.x, y: target.y - centre.y };
		const board = readRuntime(readRuntime(this.view, "file"), "path");
		const sources = new Set([...this.landingGeometry().scene.items.values()].map((item) => item.sourceId).filter((id) => id !== undefined));
		const plan = planPaste(canvas, record, {
			offset,
			newId: newCanvasId,
			// A Miro item is shown again only on the board that has it.
			sourceExists: (sourceId) => record.board === board && sources.has(sourceId),
		});
		this.readInteractionState();
		this.authoring ??= createCanvasAuthoring(this.view);
		const result = this.authoring.insertGraph(plan);
		if (!result.ok) {
			this.addDiagnostic(firstProblem(result.diagnostics) ?? "Canvas rejected the paste.");
			this.refresh();
			return true;
		}
		this.refresh();
		const pasted = new Set(plan.nodes.map((node) => node.id as string));
		this.callNative("deselectAll");
		this.connectorLayer?.select(plan.connectors?.map(c=>c.id) ?? []);
		for (const node of this.adapter.getNodes() ?? []) {
			const id = readCanvasElementId(node);
			if (id !== undefined && pasted.has(id)) this.callNative("select", [node]);
		}
		this.readInteractionState();
		this.refresh();
		return true;
	}
	private selectionMovePreview?: Record<string,unknown>;
	private selectionMoveIds?: readonly string[];
	private selectionMoveEnd?: ()=>void;
	private mixedSelectionFrame?: HTMLElement;
	/** One draggable frame around every multi-item selection, however it was made. */
	private updateMixedSelectionFrame(): void {
		const root = this.root;
		if (!root) return;
		// The marquee is the only live frame while the button is held.
		if (root.hasAttribute("data-miro-rectangle-selecting")) return;
		const connectorIds = this.connectorLayer?.selection() ?? [];
		const nativeIds = new Set((this.adapter.getSelection() ?? []).flatMap(item => allIds([item])));
		const activeEnds=[...this.selectedRouteEnds.keys()].filter(id=>nativeIds.has(id)||connectorIds.includes(id));
		const framed = new Set([...nativeIds,...connectorIds,...this.selectedCommentKeys]).size > 1
			|| activeEnds.length>0;
		if (framed) root.classList.add("miro-canvas-mixed-selection");
		else root.classList.remove("miro-canvas-mixed-selection");
		if (framed && (connectorIds.length > 0 || this.selectedCommentKeys.size > 0 || activeEnds.length > 0)) root.classList.add("miro-canvas-mixed-selection--independent");
		else root.classList.remove("miro-canvas-mixed-selection--independent");
		if (!framed) {this.mixedSelectionFrame?.remove();this.mixedSelectionFrame=undefined;return;}
		const box = boundingRect(root);
		if (!box) return;
		let left=Infinity,top=Infinity,right=-Infinity,bottom=-Infinity;
		const add = (x:number,y:number):void => {left=Math.min(left,x);right=Math.max(right,x);top=Math.min(top,y);bottom=Math.max(bottom,y);};
		for (const element of this.adapter.getNodes() ?? []) {
			if (!nativeIds.has(readCanvasElementId(element) ?? "")) continue;
			const rect = boundingRect(readCanvasElementDom(element));
			if(rect){add(rect.left-box.left,rect.top-box.top);add(rect.right-box.left,rect.bottom-box.top);}
		}
		const geometry=this.landingGeometry().geometry;
		for(const id of [...nativeIds,...connectorIds]){
			const route=geometry.edges?.[id];
			const mask=this.selectedRouteEnds.get(id);
			const points=mask&&route?[...(mask.from&&route.start?[route.start]:[]),...(mask.to&&route.end?[route.end]:[]),...(mask.wholeRoute?route.points??[]:[])]
				:route?.points??(route?.start&&route.end?[route.start,route.end]:[]);
			for(const p of points){
				const at=this.viewportPoint(p);if(at)add(at.x-box.left,at.y-box.top);
			}
		}
		for(const key of this.selectedCommentKeys){
			const point=geometry.comments?.[key],at=point&&this.viewportPoint(point);
			if(at){add(at.x-box.left,at.y-box.top-32);add(at.x-box.left+32,at.y-box.top);}
		}
		if(!Number.isFinite(left)||!Number.isFinite(right)||!Number.isFinite(bottom)){
			root.classList.remove("miro-canvas-mixed-selection");
			this.mixedSelectionFrame?.remove();this.mixedSelectionFrame=undefined;return;
		}
		if(!this.mixedSelectionFrame){
			const frame=root.ownerDocument.createElement("div");frame.className="miro-canvas-mixed-selection-frame";
			frame.setAttribute("aria-label","Move selected elements");
			for(const side of ["top","right","bottom","left"]){
				const grab=root.ownerDocument.createElement("div");grab.className=`miro-canvas-mixed-selection-frame__${side}`;
				frame.appendChild(grab);
			}
			root.appendChild(frame);this.mixedSelectionFrame=frame;
		}
		const pad=8,frame=this.mixedSelectionFrame;
		frame.style.left=`${left-pad}px`;frame.style.top=`${top-pad}px`;
		frame.style.width=`${right-left+pad*2}px`;frame.style.height=`${bottom-top+pad*2}px`;
	}
	private startSelectionMove(event: PointerEvent): boolean {
		this.readInteractionState();
		const commentIds=[...this.selectedCommentKeys].map(key=>{
			const separator=key.indexOf(":");return separator<0?undefined:commentSelectionId(key.slice(0,separator) as CommentOrigin,key.slice(separator+1));
		}).filter((id):id is string=>id!==undefined);
		const ids=[...this.selectedIds,...commentIds];
		if(event.button!==0 || event.shiftKey || !ids.length || ids.length<2&&!this.selectedRouteEnds.has(ids[0]!)
			|| this.closestTarget(event,"input,textarea,[contenteditable=true],.cm-editor"))return false;
		const target=this.eventElementId(event.target);
		if(target && !this.selectedIds.includes(target))return false;
		const connectorIds=[...(this.connectorLayer?.selection()??[])], original=this.adapter.getDocument();
		const routeEnds=Object.fromEntries([...this.selectedRouteEnds].filter(([id])=>ids.includes(id)));
		const first=this.boardPoint({x:event.clientX,y:event.clientY}), view=this.root?.ownerDocument.defaultView;
		if(!first || !view || !isRecord(original))return false;
		event.preventDefault();event.stopImmediatePropagation();
		if([...this.selectedCommentKeys].some(key=>{const separator=key.indexOf(":");return this.commentLocked(key.slice(separator+1),key.slice(0,separator) as CommentOrigin);})){this.options.onNotice?.("A locked comment cannot be moved.");return true;}
		if(!this.editAllowed("move",ids))return true;
		this.selectionMoveEnd?.();
		this.selectionMoveIds=ids;
		const dom=(this.adapter.getNodes()??[]).filter(n=>ids.includes(readCanvasElementId(n)??"")).map(n=>readCanvasElementDom(n)).filter(isElement);
		const styles=dom.map(el=>({el,value:el.style.getPropertyValue("translate"),priority:el.style.getPropertyPriority("translate")}));
		let dx=0,dy=0,changed=false;
		const move=(e:PointerEvent)=>{
			if(e.pointerId!==event.pointerId)return;
			const at=this.boardPoint({x:e.clientX,y:e.clientY});if(!at)return;
			dx=at.x-first.x;dy=at.y-first.y;changed ||= Math.hypot(e.clientX-event.clientX,e.clientY-event.clientY)>3;
			if(!changed)return;
			this.selectionMovePreview=translateBoardSelection(original,ids,dx,dy,routeEnds);
			this.currentRawDocument=this.selectionMovePreview;this.landingCache=undefined;
			for(const {el} of styles)el.style.setProperty("translate",`${dx}px ${dy}px`);
			this.liveGeometryDirty=true;this.sourceRenderer?.refresh();this.connectorLayer?.render();this.followViewport();
		};
		const cleanup=()=>{
			view.removeEventListener("pointermove",move,true);view.removeEventListener("pointerup",up,true);view.removeEventListener("pointercancel",cancel,true);view.removeEventListener("blur",cancel);
			for(const {el,value,priority} of styles){if(value)el.style.setProperty("translate",value,priority);else el.style.removeProperty("translate");}
			this.selectionMovePreview=undefined;this.selectionMoveIds=undefined;this.selectionMoveEnd=undefined;this.landingCache=undefined;
		};
		const cancel=()=>{cleanup();this.refresh();};
		const restoreSelection=()=>{
			if(this.disposed)return;
			const nativeIds=ids.filter(id=>!connectorIds.includes(id)&&!selectedComment(id));
			const selected=(this.adapter.getSelection()??[]).flatMap(item=>allIds([item]));
			if(selected.length!==nativeIds.length || nativeIds.some(id=>!selected.includes(id))){
				this.callNative("deselectAll");
				for(const item of [...(this.adapter.getNodes()??[]),...(this.adapter.getEdges()??[])])
					if(nativeIds.includes(readCanvasElementId(item)??""))this.callNative("select",[item]);
			}
			const retained=this.connectorLayer?.selection()??[];
			if(retained.length!==connectorIds.length || connectorIds.some(id=>!retained.includes(id)))this.connectorLayer?.select(connectorIds);
			this.refresh();
		};
		const up=(e:PointerEvent)=>{
			if(e.pointerId!==event.pointerId)return;move(e);cleanup();
			if(changed){
				this.authoring??=createCanvasAuthoring(this.view);
				const result=this.authoring.moveSelection(ids,dx,dy,original,routeEnds);
				if(!result.ok)this.options.onNotice?.("Selection move was refused because the board changed or an item is locked.");
				else {
					restoreSelection();
					// Native Canvas may finish its own pointer-up after this capture
					// listener; restore once more after that event dispatch.
					queueMicrotask(restoreSelection);
				}
			}
			this.refresh();
		};
		view.addEventListener("pointermove",move,true);view.addEventListener("pointerup",up,true);view.addEventListener("pointercancel",cancel,true);view.addEventListener("blur",cancel);
		this.selectionMoveEnd=cancel;return true;
	}
	private deleteBoardSelection(): void {
		this.readInteractionState();
		if(!this.selectedIds.length || !this.editAllowed("delete",this.selectedIds))return;
		this.authoring ??= createCanvasAuthoring(this.view);
		const result=this.authoring.deleteItems({ids:this.selectedIds});
		if(result.ok){this.connectorLayer?.reset();this.callNative("deselectAll");}
		else this.options.onNotice?.(firstProblem(result.diagnostics)??"Delete was refused.");
		this.refresh();
	}

	private previewCommentMove(threadId: string, origin: CommentOrigin, point: { readonly x: number; readonly y: number }): void {
		if (this.commentLocked(threadId, origin)) return;
		const board = this.boardPoint(point), document = this.adapter.getDocument();
		if (!board || !isRecord(document)) return;
		const metadata = isRecord(document.miroCanvas) ? document.miroCanvas : {};
		const places = isRecord(metadata.commentPlaces) ? metadata.commentPlaces : {};
		this.commentMovePreview = { ...document, miroCanvas: { ...metadata,
			commentPlaces: { ...places, [commentPlaceKey(origin, threadId)]: { type: "free", x: board.x, y: board.y } } } };
		this.connectorLayer?.render();
		this.sourceRenderer?.refresh();
	}

	private cancelCommentMove(): void {
		if (!this.commentMovePreview) return;
		this.commentMovePreview = undefined;
		this.connectorLayer?.render();
		this.sourceRenderer?.refresh();
	}

	/** Deleting a pin preserves its connections as free endpoints in the same undo step. */
	private detachMissingCommentAnchors(draft: Record<string, unknown>): void {
		const before = this.landingGeometry().geometry;
		const document = isRecord(this.currentRawDocument) ? this.currentRawDocument : {};
		const after = buildCanvasAnchorGeometry({...document, miroCanvas: draft});
		const detach = (raw: unknown, id: string, end: "from" | "to"): unknown => {
			const a = normalizeAnchor(raw).anchor;
			if (a?.type !== "comment" || after.comments?.[`${a.origin}:${a.commentId}`]) return raw;
			const p = end === "from" ? before.edges?.[id]?.start : before.edges?.[id]?.end;
			if (!p || !this.editAllowed("edit", [id])) throw new Error("A connected line is locked or its comment position is unavailable.");
			return {type: "free", x: p.x, y: p.y};
		};
		if (isRecord(draft.connectors)) for (const [id, c] of Object.entries(draft.connectors)) {
			if (isRecord(c)) draft.connectors[id] = {...c, from: detach(c.from, id, "from"), to: detach(c.to, id, "to")};
		}
		if (isRecord(draft.localOverrides)) for (const [id, o] of Object.entries(draft.localOverrides)) {
			if (!isRecord(o) || !isRecord(o.connectorAnchors)) continue;
			const anchors = {...o.connectorAnchors};
			for (const end of ["from", "to"] as const) if (anchors[end]) anchors[end] = detach(anchors[end], id, end);
			draft.localOverrides[id] = {...o, connectorAnchors: anchors};
		}
	}

	/** Paste files the clipboard names as nodes pointing at them; false when it names none this vault has. */
	private pasteLinkedFiles(filesText: string, text: string): boolean {
		const app = readRuntime(this.view, "app");
		const vault = readRuntime(app, "vault");
		const cache = readRuntime(app, "metadataCache");
		const source = readRuntime(readRuntime(this.view, "file"), "path");
		const files = linkedFilePaths({ files: filesText, text }).flatMap((path) => {
			const exact = callRuntime(vault, "getAbstractFileByPath", path);
			const found = isObject(exact) && typeof readRuntime(exact, "extension") === "string"
				? exact
				: callRuntime(cache, "getFirstLinkpathDest", path, typeof source === "string" ? source : "");
			return isObject(found) && typeof readRuntime(found, "extension") === "string" ? [found] : [];
		});
		const point = this.pastePoint();
		if (files.length === 0 || point === undefined) return false;
		const created = callRuntime(this.nativeCanvas(), "createFileNodes", files, point);
		if (!Array.isArray(created)) return false;
		this.adapter.requestSave();
		this.callNative("deselectAll");
		for (const node of created) this.callNative("select", [node]);
		this.refresh();
		return true;
	}

	private callNative(method: string, args: readonly unknown[] = []): boolean {
		const canvas = this.nativeCanvas();
		const run = readRuntime(canvas, method);
		if (typeof run !== "function") return false;
		try {
			Reflect.apply(run, canvas, args);
			return true;
		} catch {
			return false;
		}
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
			{ id: "source-inspector", label: "Open source & provenance", description: "Read-only completeness, provenance and unknown-field summary", run: () => this.openSourceInspector() },
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
		inner = false,
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
		// Only the slots a board sets are painted; the rest keep Obsidian's colours.
		if (colors !== undefined) {
			if (isEdge) {
				if (colors.edge !== undefined) {
					// Native Canvas paints a connector's line and arrowhead from
					// --canvas-color, which an inherited stroke never reaches.
					const edge = colorToCss(colors.edge);
					this.setAppearanceStyle(element, "--canvas-color", edge);
					this.setAppearanceStyle(element, "color", edge);
				}
			} else {
				if (colors.text !== undefined) this.setAppearanceStyle(element, "color", colorToCss(colors.text));
				// A fill that lets the board show through is painted once, on
				// the node itself; painted on every surface it would thicken with
				// each layer, as a frame's quiet fills did.
				if (colors.fill !== undefined) {
					this.setAppearanceStyle(element, "background-color", inner && seeThrough(colors.fill) ? "transparent" : colorToCss(colors.fill));
				}
				if (colors.border !== undefined) this.setAppearanceStyle(element, "border-color", colorToCss(colors.border));
				// The card's marks take its highlight colour, with ink that reads on it.
				if (colors.highlight !== undefined && colors.highlight !== null) {
					this.setAppearanceStyle(element, "--miro-highlight", colorToCss(colors.highlight));
					this.setAppearanceStyle(element, "--miro-highlight-ink", readableInk(colorToCss(colors.highlight).slice(0, 7)));
				}
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
				this.applyElementAppearance(content, override?.typography, override?.colors, false, true);
			}
		}
		for (const edge of this.scene.edges) {
			const id = readCanvasElementId(edge);
			const colors = id === undefined ? undefined : this.appearance.localOverrides[id]?.colors;
			if (colors?.edge === undefined) {
				continue;
			}
			// A connector has no HTML element of its own: its line and its
			// arrowhead are SVG groups, and both take the colour.
			for (const key of ["lineGroupEl", "lineEndGroupEl"]) {
				const group = readRuntime(edge, key);
				if (isElement(group)) this.applyElementAppearance(group, undefined, colors, true);
			}
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
			// An edge is a line between its ends.  Filling its bounding box drew a
			// grey slab for every connector, larger the further it reached.
			context.strokeStyle = "rgba(150, 150, 150, 0.85)";
			context.lineWidth = 1;
			for (const item of model.edgeItems) {
				if (item.mapLine === undefined) {
					continue;
				}
				context.beginPath();
				context.moveTo(item.mapLine[0].x, item.mapLine[0].y);
				context.lineTo(item.mapLine[1].x, item.mapLine[1].y);
				context.stroke();
			}
			// Each kind of item keeps a colour of its own, and a sticky note its
			// own fill; frames are outlined first, under what stands on them.
			const scene = this.landingGeometry().scene;
			const nodes = new Map(((readRuntime(this.currentRawDocument, "nodes") ?? []) as readonly unknown[])
				.map((node) => [readRuntime(node, "id"), node] as const));
			const painted = model.nodeItems.flatMap((item) => {
				if (item.mapRect === undefined) return [];
				const node = item.id === undefined ? undefined : nodes.get(item.id);
				const descriptor = item.id === undefined ? undefined : scene.items.get(item.id);
				const category = minimapCategory(readRuntime(node, "type"), readRuntime(node, "file"), descriptor);
				const own = descriptor?.css["background-color"];
				const color = category === "sticky" && own !== undefined && /^#[0-9a-f]{6}$/iu.test(own) ? own : MINIMAP_COLORS[category];
				return [{ rect: item.mapRect, category, color }];
			});
			context.lineWidth = 1;
			for (const { rect, color } of painted.filter((entry) => entry.category === "frame")) {
				context.fillStyle = "rgba(150, 150, 150, 0.08)";
				context.fillRect(rect.x, rect.y, Math.max(1, rect.width), Math.max(1, rect.height));
				context.strokeStyle = color;
				context.strokeRect(rect.x + 0.5, rect.y + 0.5, Math.max(1, rect.width - 1), Math.max(1, rect.height - 1));
			}
			context.globalAlpha = 0.85;
			for (const { rect, color } of painted.filter((entry) => entry.category !== "frame")) {
				context.fillStyle = color;
				context.fillRect(rect.x, rect.y, Math.max(1, rect.width), Math.max(1, rect.height));
			}
			context.globalAlpha = 1;
			if (model.viewportRect !== undefined) {
				// A 2D context cannot resolve a CSS variable; read the theme's colour.
				const accent = readStyleValue(canvas, "--interactive-accent") ?? "#7c3aed";
				context.strokeStyle = accent;
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
		this.selectedIds = [...new Set([...(selection === undefined ? [] : allIds(selection)),...(this.connectorLayer?.selection() ?? [])])];
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

	/**
	 * Fails closed on an unverifiable policy as well as a verified refusal: if
	 * the metadata cannot be read, a lock in it cannot be read either, so
	 * letting a native edit through could modify a locked element. The cost is
	 * that the host's own calls are dropped too, which is why the reason is
	 * now reported rather than swallowed.
	 */
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
		const canvas = this.nativeCanvas();
		if (canvas === undefined) {
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
				if(key.endsWith("Selection") && ids.length){this.deleteBoardSelection();return undefined;}
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
			if(this.closestTarget(event,".miro-canvas-native-edge-label,.miro-board-connector-label"))return;
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
		listen("pointerdown", (event) => this.grabConnectorLine(event));
		listen("pointerdown", (event) => this.grabDrawnLine(event));
		listen("click", (event) => {
			if (Date.now() > this.swallowClickUntil) return;
			this.swallowClickUntil = 0;
			try {
				event.preventDefault();
				event.stopImmediatePropagation();
			} catch {
				// Nothing else to stop.
			}
		});
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
			this.handles.cancelGesture();
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
		this.selectionMoveEnd?.();
		this.slideShow?.stop();
		this.controls.dispose();
		this.connectorLayer?.dispose();
		this.nativeEdgeLabels?.dispose();
		this.toolbar.dispose();
		this.handles.dispose();
		this.commentMarkers?.destroy();
		this.mixedSelectionFrame?.remove();this.mixedSelectionFrame=undefined;
		this.root?.classList.remove("miro-canvas-mixed-selection");
		this.commentCard?.destroy();
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
