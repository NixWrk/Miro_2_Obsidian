/**
 * Namespaced, framework-free controls for the M1 Canvas session.
 *
 * The native Canvas remains the editor.  This module builds one dock in the
 * lower right corner of the board, the way Miro keeps its view controls:
 * the minimap above a single row of small icons - undo and redo, the map,
 * zoom with its percentage, board settings, and a warning badge when there
 * is something to report.  The percentage opens the view menu, the gear the
 * board menu; every word lives in a menu or a hover hint.  The module only
 * reports explicit user actions to its host.  It never reads or writes a
 * Canvas file and never injects HTML into a node's text.
 */

import {
	APPEARANCE_ACTIONS,
	type AppearanceAction,
	type AppearanceState,
	type DisplayTheme,
} from "./appearance";
import { EXPORT_TEXT } from "./board-export";
import type { SourceInspection } from "./source-inspector";
import { BAR_TOOLTIP_DELAY } from "./tooltips";

export type M1NavigationAction =
	| "zoom-in"
	| "zoom-out"
	| "zoom-reset"
	| "zoom-fit"
	| "zoom-50"
	| "zoom-200"
	| "toggle-minimap"
	| "undo"
	| "redo"
	| "toggle-snap-grid"
	| "toggle-snap-objects";

export interface M1CommandItem {
	readonly id: string;
	readonly label: string;
	readonly description?: string;
	readonly run: () => void;
}

export interface M1ControlsState {
	readonly appearance: AppearanceState;
	readonly selectedIds: readonly string[];
	readonly reviewMode: boolean;
	readonly lockedSelection: boolean;
	readonly showAttachmentNames: boolean;
	readonly selectedAttachmentNames?: boolean;
	readonly minimapVisible: boolean;
	readonly diagnostics: readonly string[];
	/** The board scale, 1 for 100%. */
	readonly zoom?: number;
	/** Native Canvas snapping, when the host can read it. */
	readonly snapToGrid?: boolean;
	readonly snapToObjects?: boolean;
	/** False hides the warning badge; diagnostics are still collected. */
	readonly showDiagnostics?: boolean;
}

export interface M1ControlsActions {
	readonly onAppearance: (action: AppearanceAction) => void;
	readonly onInteraction: (action: Record<string, unknown>) => void;
	readonly onAttachment: (action: Record<string, unknown>) => void;
	readonly onNavigation: (action: M1NavigationAction) => void;
	readonly openCommandModal: () => void;
	readonly closeCommandModal?: () => void;
	readonly openSourceInspector?: () => void;
	/** Open this plugin's page in Obsidian's settings. */
	readonly openSettings?: () => void;
	/** Set up an export of the board to PDF or PowerPoint. */
	readonly openExport?: () => void;
}

export interface M1ControlsOptions {
	readonly document?: Document;
	readonly title?: string;
	readonly className?: string;
	/** Draws a named Obsidian icon; without it buttons fall back to glyphs. */
	readonly setIcon?: (element: HTMLElement, icon: string) => void;
}

type MenuName = "view" | "board" | "diagnostics";

interface Menu {
	readonly button: HTMLButtonElement;
	readonly panel: HTMLElement;
}

interface ControlRefs {
	readonly minimapCanvas: HTMLCanvasElement;
	readonly map: HTMLElement;
	readonly bar: HTMLElement;
	readonly minimapToggle: HTMLButtonElement;
	readonly zoomLabel: HTMLButtonElement;
	readonly menus: Readonly<Record<MenuName, Menu>>;
	readonly switches: Readonly<Record<"minimap" | "snapGrid" | "snapObjects" | "review" | "attachments" | "selectionNames", HTMLButtonElement>>;
	readonly themes: readonly HTMLButtonElement[];
	readonly diagnosticsCount: HTMLElement;
	readonly diagnosticsList: HTMLElement;
	readonly status: HTMLElement;
}

const THEMES: readonly { readonly value: DisplayTheme; readonly icon: string; readonly glyph: string; readonly label: string }[] = [
	{ value: "system", icon: "monitor", glyph: "◐", label: "System" },
	{ value: "light", icon: "sun", glyph: "☀", label: "Light" },
	{ value: "dark", icon: "moon", glyph: "☾", label: "Dark" },
];

function hasDocument(value: unknown): value is Document {
	return value !== null && typeof value === "object"
		&& typeof (value as { createElement?: unknown }).createElement === "function"
		&& typeof (value as { createTextNode?: unknown }).createTextNode === "function";
}

function isDomElement(value: unknown): value is HTMLElement {
	if (value === null || (typeof value !== "object" && typeof value !== "function")) {
		return false;
	}
	try {
		const candidate = value as { nodeType?: unknown; appendChild?: unknown; removeChild?: unknown };
		return candidate.nodeType === 1
			&& typeof candidate.appendChild === "function"
			&& typeof candidate.removeChild === "function";
	} catch {
		return false;
	}
}

function text(value: unknown): string {
	return typeof value === "string" ? value : String(value);
}

function setText(element: HTMLElement, value: unknown): void {
	element.textContent = text(value);
}

function setDisabled(element: HTMLButtonElement | HTMLInputElement, disabled: boolean): void {
	element.disabled = disabled;
	element.setAttribute("aria-disabled", disabled ? "true" : "false");
}

function append<T extends Node>(parent: Node, child: T): T {
	parent.appendChild(child);
	return child;
}

function makeElement<K extends keyof HTMLElementTagNameMap>(
	document: Document,
	tag: K,
	className?: string,
	label?: string,
): HTMLElementTagNameMap[K] {
	const element = document.createElement(tag);
	if (className !== undefined) {
		element.className = className;
	}
	if (label !== undefined) {
		setText(element, label);
	}
	return element;
}

function makeButton(document: Document, label: string, title: string, className = ""): HTMLButtonElement {
	const button = makeElement(document, "button", `miro-canvas-panel__button ${className}`.trim(), label);
	button.type = "button";
	// Obsidian renders a tooltip from aria-label; a title would duplicate it.
	button.setAttribute("aria-label", title);
	button.setAttribute("data-tooltip-delay", BAR_TOOLTIP_DELAY);
	return button;
}

/** Build and own the dock DOM. */
export class M1Controls {
	/** The dock; kept under both names so hosts that mount either keep working. */
	public readonly element: HTMLElement;
	public readonly minimapElement: HTMLElement;
	private readonly document: Document | undefined;
	private readonly actions: M1ControlsActions;
	private readonly setIcon: M1ControlsOptions["setIcon"];
	private readonly refs: ControlRefs | undefined;
	private readonly listeners: Array<() => void> = [];
	private readonly modalListeners: Array<() => void> = [];
	private modal: HTMLElement | null = null;
	private lastState: M1ControlsState | undefined;
	private lastDiagnosticsKey = "";

	public constructor(actions: M1ControlsActions, options: M1ControlsOptions = {}) {
		this.actions = actions;
		this.setIcon = options.setIcon;
		this.document = options.document
			?? (typeof document !== "undefined" ? document : undefined);
		if (!hasDocument(this.document)) {
			this.element = {} as HTMLElement;
			this.minimapElement = this.element;
			return;
		}
		const root = makeElement(this.document, "aside", options.className ?? "miro-canvas-dock");
		root.setAttribute("data-miro-canvas-panel", "true");
		root.setAttribute("aria-label", options.title ?? "Miro Canvas view");
		this.element = root;
		this.minimapElement = root;
		this.refs = this.build(root);
	}

	private listen<T extends EventTarget>(target: T, event: string, handler: EventListener): void {
		target.addEventListener(event, handler);
		this.listeners.push(() => target.removeEventListener(event, handler));
	}

	private listenModal<T extends EventTarget>(target: T, event: string, handler: EventListener): void {
		target.addEventListener(event, handler);
		this.modalListeners.push(() => target.removeEventListener(event, handler));
	}

	/** Draw an Obsidian icon, or a glyph where the host has none to give. */
	private icon(element: HTMLElement, name: string, glyph: string): void {
		if (element.getAttribute?.("data-icon") === name) return;
		element.setAttribute("data-icon", name);
		if (this.setIcon !== undefined) {
			try {
				this.setIcon(element, name);
				return;
			} catch {
				// A host that cannot draw the icon still gets a readable control.
			}
		}
		setText(element, glyph);
	}

	private iconButton(parent: HTMLElement, icon: string, glyph: string, title: string, className = ""): HTMLButtonElement {
		const button = append(parent, makeButton(this.document!, "", title, `miro-canvas-dock__button ${className}`.trim()));
		this.icon(button, icon, glyph);
		return button;
	}

	/** A menu row: an icon, a label, and a switch or a hint at the end. */
	private item(
		panel: HTMLElement, icon: string, glyph: string, label: string,
		options: { readonly toggle?: boolean; readonly hint?: string; readonly run: () => void },
	): HTMLButtonElement {
		const document = this.document!;
		const row = append(panel, makeElement(document, "button", "miro-canvas-dock__item"));
		row.type = "button";
		row.setAttribute("role", options.toggle === true ? "menuitemcheckbox" : "menuitem");
		const mark = append(row, makeElement(document, "span", "miro-canvas-dock__item-icon"));
		this.icon(mark, icon, glyph);
		append(row, makeElement(document, "span", "miro-canvas-dock__item-label", label));
		if (options.toggle === true) {
			row.setAttribute("aria-checked", "false");
			append(row, makeElement(document, "span", "miro-canvas-dock__switch"));
		} else if (options.hint !== undefined) {
			append(row, makeElement(document, "span", "miro-canvas-dock__item-hint", options.hint));
		}
		this.listen(row, "click", () => options.run());
		return row;
	}

	private menu(root: HTMLElement, name: MenuName, button: HTMLButtonElement, title: string): Menu {
		const document = this.document!;
		const panel = append(root, makeElement(document, "div", `miro-canvas-dock__menu miro-canvas-dock__menu--${name}`));
		panel.setAttribute("role", "menu");
		panel.setAttribute("aria-label", `${title} menu`);
		panel.hidden = true;
		button.setAttribute("aria-haspopup", "menu");
		button.setAttribute("aria-expanded", "false");
		const menu = { button, panel };
		this.listen(button, "click", () => this.toggleMenu(name));
		return menu;
	}

	private toggleMenu(name: MenuName): void {
		const refs = this.refs;
		if (refs === undefined) return;
		const open = refs.menus[name].panel.hidden;
		this.closeMenus();
		if (!open) return;
		refs.menus[name].panel.hidden = false;
		refs.menus[name].button.setAttribute("aria-expanded", "true");
	}

	private closeMenus(): void {
		for (const menu of Object.values(this.refs?.menus ?? {})) {
			menu.panel.hidden = true;
			menu.button.setAttribute("aria-expanded", "false");
		}
	}

	private separator(parent: HTMLElement): void {
		append(parent, makeElement(this.document!, "div", "miro-canvas-dock__separator"));
	}

	private build(root: HTMLElement): ControlRefs {
		const document = this.document!;
		const map = append(root, makeElement(document, "div", "miro-canvas-dock__map"));
		const minimapCanvas = makeElement(document, "canvas", "miro-canvas-panel__minimap-canvas");
		minimapCanvas.width = 240;
		minimapCanvas.height = 160;
		minimapCanvas.tabIndex = 0;
		minimapCanvas.setAttribute("role", "img");
		minimapCanvas.setAttribute("aria-label", "Canvas minimap; use arrow keys to pan");
		append(map, minimapCanvas);

		const bar = makeElement(document, "div", "miro-canvas-dock__bar");
		bar.setAttribute("role", "toolbar");
		bar.setAttribute("aria-label", "Canvas navigation");
		const history = append(bar, makeElement(document, "span", "miro-canvas-dock__group"));
		const undo = this.iconButton(history, "undo-2", "↶", "Undo");
		const redo = this.iconButton(history, "redo-2", "↷", "Redo");
		this.listen(undo, "click", () => this.actions.onNavigation("undo"));
		this.listen(redo, "click", () => this.actions.onNavigation("redo"));
		const mapGroup = append(bar, makeElement(document, "span", "miro-canvas-dock__group"));
		const minimapToggle = this.iconButton(mapGroup, "map", "▦", "Show minimap");
		minimapToggle.setAttribute("aria-pressed", "false");
		this.listen(minimapToggle, "click", () => this.actions.onNavigation("toggle-minimap"));
		const zoomGroup = append(bar, makeElement(document, "span", "miro-canvas-dock__group"));
		const zoomOut = this.iconButton(zoomGroup, "minus", "−", "Zoom out");
		const zoomLabel = append(zoomGroup, makeButton(document, "100%", "View and zoom", "miro-canvas-dock__button miro-canvas-dock__zoom"));
		const zoomIn = this.iconButton(zoomGroup, "plus", "+", "Zoom in");
		this.listen(zoomOut, "click", () => this.actions.onNavigation("zoom-out"));
		this.listen(zoomIn, "click", () => this.actions.onNavigation("zoom-in"));
		const boardGroup = append(bar, makeElement(document, "span", "miro-canvas-dock__group"));
		const boardButton = this.iconButton(boardGroup, "settings-2", "⚙", "Board settings");
		const diagnosticsButton = this.iconButton(boardGroup, "triangle-alert", "!", "Diagnostics", "miro-canvas-dock__diagnostics");
		const diagnosticsCount = append(diagnosticsButton, makeElement(document, "span", "miro-canvas-dock__badge"));
		const status = append(boardGroup, makeElement(document, "span", "miro-canvas-dock__status"));
		status.setAttribute("role", "status");

		// View: how the board is shown and snapped.
		const view = this.menu(root, "view", zoomLabel, "View");
		this.item(view.panel, "scan", "⤢", "Fit to screen", { run: () => this.run("zoom-fit") });
		this.item(view.panel, "zoom-out", "−", "Zoom to 50%", { run: () => this.run("zoom-50") });
		this.item(view.panel, "search", "○", "Zoom to 100%", { run: () => this.run("zoom-reset") });
		this.item(view.panel, "zoom-in", "+", "Zoom to 200%", { run: () => this.run("zoom-200") });
		this.separator(view.panel);
		const minimapSwitch = this.item(view.panel, "map", "▦", "Minimap", { toggle: true, run: () => this.actions.onNavigation("toggle-minimap") });
		const snapGrid = this.item(view.panel, "grid", "#", "Snap to grid", { toggle: true, run: () => this.actions.onNavigation("toggle-snap-grid") });
		const snapObjects = this.item(view.panel, "magnet", "⊓", "Snap to objects", { toggle: true, run: () => this.actions.onNavigation("toggle-snap-objects") });

		// Board: how this board looks and behaves, and the way to everything else.
		const board = this.menu(root, "board", boardButton, "Board settings");
		append(board.panel, makeElement(document, "div", "miro-canvas-dock__heading", "Board theme"));
		const themeRow = append(board.panel, makeElement(document, "div", "miro-canvas-dock__segments"));
		const themes = THEMES.map(({ value, icon, glyph, label }) => {
			const button = append(themeRow, makeButton(document, "", `${label} theme`, "miro-canvas-dock__segment"));
			button.setAttribute("data-value", value);
			button.setAttribute("aria-pressed", "false");
			const mark = append(button, makeElement(document, "span", "miro-canvas-dock__item-icon"));
			this.icon(mark, icon, glyph);
			append(button, makeElement(document, "span", "miro-canvas-dock__segment-label", label));
			this.listen(button, "click", () => this.actions.onAppearance({
				type: APPEARANCE_ACTIONS.setDisplayTheme,
				displayTheme: value,
			}));
			return button;
		});
		this.separator(board.panel);
		if (this.actions.openExport !== undefined) {
			const openExport = this.actions.openExport;
			this.item(board.panel, "file-output", "⇩", EXPORT_TEXT.boardMenuLabel, { run: () => this.close(() => openExport()) });
			this.separator(board.panel);
		}
		const review = this.item(board.panel, "eye", "◉", "Review mode", {
			toggle: true,
			run: () => this.actions.onInteraction({ type: "set-review-mode", enabled: this.lastState?.reviewMode !== true }),
		});
		const attachments = this.item(board.panel, "paperclip", "⌘", "Attachment names", {
			toggle: true,
			run: () => this.actions.onAttachment({ type: "set-global", visible: this.lastState?.showAttachmentNames === false }),
		});
		const selectionNames = this.item(board.panel, "text-cursor-input", "T", "Name on selected attachment", {
			toggle: true,
			run: () => this.actions.onAttachment({
				type: "set-selection",
				visible: this.lastState?.selectedAttachmentNames !== true,
				elementIds: this.lastState?.selectedIds ?? [],
			}),
		});
		this.separator(board.panel);
		this.item(board.panel, "command", "⌘", "Commands", { run: () => this.close(() => this.actions.openCommandModal()) });
		if (this.actions.openSourceInspector !== undefined) {
			this.item(board.panel, "file-search", "?", "Source & provenance", { run: () => this.close(() => this.actions.openSourceInspector?.()) });
		}
		if (this.actions.openSettings !== undefined) {
			this.item(board.panel, "settings", "⚙", "Plugin settings", { run: () => this.close(() => this.actions.openSettings?.()) });
		}

		const diagnostics = this.menu(root, "diagnostics", diagnosticsButton, "Diagnostics");
		append(diagnostics.panel, makeElement(document, "div", "miro-canvas-dock__heading", "Diagnostics"));
		const diagnosticsList = append(diagnostics.panel, makeElement(document, "div", "miro-canvas-panel__diagnostics"));
		diagnosticsList.setAttribute("role", "log");

		// The bar goes last so the menus open over the map, above the bar.
		append(root, bar);
		this.listen(root, "keydown", (event) => {
			if ((event as KeyboardEvent).key === "Escape") this.closeMenus();
		});
		const owner = (root as { ownerDocument?: Document }).ownerDocument;
		if (owner !== undefined && owner !== null && typeof owner.addEventListener === "function") {
			// A press anywhere else closes an open menu.
			this.listen(owner, "pointerdown", (event) => {
				const target = (event as Event).target as Node | null;
				const contains = (root as { contains?: (node: Node | null) => boolean }).contains;
				if (typeof contains === "function" && !contains.call(root, target)) this.closeMenus();
			});
		}

		return {
			minimapCanvas,
			map,
			bar,
			minimapToggle,
			zoomLabel,
			menus: { view, board, diagnostics },
			switches: {
				minimap: minimapSwitch, snapGrid, snapObjects, review, attachments, selectionNames,
			},
			themes,
			diagnosticsCount,
			diagnosticsList,
			status,
		};
	}

	/** Run a view action and close its menu. */
	private run(action: M1NavigationAction): void {
		this.closeMenus();
		this.actions.onNavigation(action);
	}

	private close(run: () => void): void {
		this.closeMenus();
		run();
	}

	/** Refresh labels and control values without rebuilding native Canvas DOM. */
	public update(state: M1ControlsState): void {
		this.lastState = state;
		if (this.refs === undefined || !hasDocument(this.document)) {
			return;
		}
		const refs = this.refs;
		this.element.setAttribute("data-miro-canvas-has-selection", state.selectedIds.length > 0 ? "true" : "false");
		const check = (row: HTMLButtonElement, on: boolean | undefined): void => {
			row.setAttribute("aria-checked", on === true ? "true" : "false");
			row.hidden = on === undefined;
		};
		refs.map.hidden = !state.minimapVisible;
		this.element.setAttribute("data-miro-canvas-minimap", state.minimapVisible ? "visible" : "hidden");
		refs.minimapToggle.setAttribute("aria-pressed", state.minimapVisible ? "true" : "false");
		refs.minimapToggle.setAttribute("aria-label", state.minimapVisible ? "Hide minimap" : "Show minimap");
		check(refs.switches.minimap, state.minimapVisible);
		check(refs.switches.snapGrid, state.snapToGrid);
		check(refs.switches.snapObjects, state.snapToObjects);
		check(refs.switches.review, state.reviewMode);
		check(refs.switches.attachments, state.showAttachmentNames);
		check(refs.switches.selectionNames, state.selectedAttachmentNames === true);
		setDisabled(refs.switches.selectionNames, state.selectedIds.length === 0);
		const zoom = state.zoom;
		setText(refs.zoomLabel, zoom === undefined || !Number.isFinite(zoom) ? "—" : `${Math.round(zoom * 100)}%`);
		for (const button of refs.themes) {
			button.setAttribute("aria-pressed", button.getAttribute("data-value") === state.appearance.settings.displayTheme ? "true" : "false");
		}
		const shown = state.showDiagnostics !== false && state.diagnostics.length > 0;
		refs.menus.diagnostics.button.hidden = !shown;
		if (!shown) {
			refs.menus.diagnostics.panel.hidden = true;
			refs.menus.diagnostics.button.setAttribute("aria-expanded", "false");
		}
		setText(refs.diagnosticsCount, state.diagnostics.length);
		refs.menus.diagnostics.button.setAttribute("aria-label", `${state.diagnostics.length} diagnostic(s)`);
		setText(refs.status, state.reviewMode ? "Review" : "");
		refs.status.hidden = !state.reviewMode;
		const diagnosticsKey = state.diagnostics.join("\u0000");
		if (diagnosticsKey !== this.lastDiagnosticsKey) {
			while (refs.diagnosticsList.firstChild !== null) {
				refs.diagnosticsList.removeChild(refs.diagnosticsList.firstChild);
			}
			for (const diagnostic of state.diagnostics) {
				const item = append(refs.diagnosticsList, makeElement(this.document, "div", "miro-canvas-panel__diagnostic"));
				setText(item, diagnostic);
			}
			this.lastDiagnosticsKey = diagnosticsKey;
		}
	}

	public get minimapCanvas(): HTMLCanvasElement | undefined {
		return this.refs?.minimapCanvas;
	}

	/**
	 * Where a dialog is mounted: the document body, so it covers the whole
	 * window.  Inside the dock a dialog was confined to the dock's own box -
	 * its backdrop blur makes it the containing block of fixed children - and
	 * came out cut off.
	 */
	private modalHost(): HTMLElement | undefined {
		const body = (this.document as { body?: unknown } | undefined)?.body;
		if (isDomElement(body)) return body;
		return isDomElement(this.element) ? this.element : undefined;
	}

	/** Open a keyboard-friendly command modal rendered with safe DOM APIs. */
	public openCommandModal(commands: readonly M1CommandItem[]): void {
		this.closeCommandModal();
		this.closeMenus();
		const host = this.modalHost();
		if (!hasDocument(this.document) || host === undefined) {
			return;
		}
		const modal = makeElement(this.document, "div", "miro-canvas-command-modal");
		modal.setAttribute("role", "dialog");
		modal.setAttribute("aria-modal", "true");
		modal.setAttribute("aria-label", "Miro Canvas commands");
		const dialog = append(modal, makeElement(this.document, "div", "miro-canvas-command-modal__dialog"));
		const heading = append(dialog, makeElement(this.document, "h2", "miro-canvas-command-modal__title", "Miro Canvas commands"));
		heading.tabIndex = -1;
		const close = makeButton(this.document, "Close", "Close commands", "miro-canvas-command-modal__close");
		append(dialog, close);
		this.listenModal(close, "click", () => this.closeCommandModal());
		const list = append(dialog, makeElement(this.document, "div", "miro-canvas-command-modal__list"));
		for (const command of commands) {
			const item = append(list, makeElement(this.document, "button", "miro-canvas-command-modal__item"));
			item.type = "button";
			item.dataset.miroCanvasCommand = command.id;
			const label = append(item, makeElement(this.document, "span", "miro-canvas-command-modal__item-label", command.label));
			if (command.description !== undefined) {
				append(item, makeElement(this.document, "small", "miro-canvas-command-modal__item-description", command.description));
			}
			this.listenModal(item, "click", () => {
				this.closeCommandModal();
				command.run();
			});
			if (label.textContent === "") {
				setText(item, command.label);
			}
		}
		this.listenModal(modal, "click", (event) => {
			if (event.target === modal) {
				this.closeCommandModal();
			}
		});
		this.listenModal(modal, "keydown", (event) => {
			if ((event as KeyboardEvent).key === "Escape") this.closeCommandModal();
		});
		host.appendChild(modal);
		this.modal = modal;
		heading.focus();
	}

	/** Show only the bounded inspection model; raw source values never enter DOM. */
	public openSourceInspector(inspection: SourceInspection): void {
		this.closeCommandModal();
		this.closeMenus();
		const host = this.modalHost();
		if (!hasDocument(this.document) || host === undefined) return;
		const modal = makeElement(this.document, "div", "miro-canvas-command-modal miro-canvas-source-inspector");
		modal.setAttribute("role", "dialog");
		modal.setAttribute("aria-modal", "true");
		modal.setAttribute("aria-label", "Miro source and provenance inspector");
		const dialog = append(modal, makeElement(this.document, "div", "miro-canvas-command-modal__dialog miro-canvas-source-inspector__dialog"));
		const heading = append(dialog, makeElement(this.document, "h2", "miro-canvas-command-modal__title", "Source & provenance"));
		heading.tabIndex = -1;
		const close = makeButton(this.document, "Close", "Close source inspector", "miro-canvas-command-modal__close");
		append(dialog, close);
		this.listenModal(close, "click", () => this.closeCommandModal());
		const body = append(dialog, makeElement(this.document, "div", "miro-canvas-source-inspector__body"));
		const addSection = (title: string): HTMLElement => {
			const section = append(body, makeElement(this.document!, "section", "miro-canvas-source-inspector__section"));
			append(section, makeElement(this.document!, "h3", "miro-canvas-source-inspector__heading", title));
			return section;
		};
		const addRows = (section: HTMLElement, rows: readonly (readonly [string, string | number])[]): void => {
			const list = append(section, makeElement(this.document!, "dl", "miro-canvas-source-inspector__summary"));
			for (const [label, value] of rows) {
				append(list, makeElement(this.document!, "dt", undefined, label));
				const detail = append(list, makeElement(this.document!, "dd"));
				setText(detail, value);
			}
		};
		const addCounts = (section: HTMLElement, values: readonly { readonly label: string; readonly count: number }[]): void => {
			const list = append(section, makeElement(this.document!, "ul", "miro-canvas-source-inspector__list"));
			if (values.length === 0) append(list, makeElement(this.document!, "li", undefined, "None"));
			for (const value of values) append(list, makeElement(this.document!, "li", undefined, `${value.label}: ${value.count}`));
		};

		const overview = addSection("Source snapshot");
		addRows(overview, [
			["Status", inspection.status], ["Items", inspection.counts.items], ["Connectors", inspection.counts.connectors],
			["Comments", inspection.counts.comments], ["Assets", inspection.counts.assets], ["Tags", inspection.counts.tags],
		]);
		addCounts(overview, inspection.typeCounts);

		if (inspection.selected.canvasItems > 0) {
			const selected = addSection("Selection");
			addRows(selected, [
				["Canvas items", inspection.selected.canvasItems], ["Matched source items", inspection.selected.matchedSourceItems],
				["With provenance", inspection.selected.itemsWithProvenance],
			]);
			addCounts(selected, inspection.selected.typeCounts);
		}

		const provenance = addSection("Provenance");
		addRows(provenance, [
			["Items with provenance", inspection.provenance.itemsWithProvenance],
			["Available field sources", inspection.provenance.fieldSourceEntries],
			["Selected field sources", inspection.provenance.selectedFieldSourceEntries],
			["Original source copies", inspection.provenance.originalSourceCopies],
		]);

		const completeness = addSection("Completeness & limitations");
		const completenessList = append(completeness, makeElement(this.document, "ul", "miro-canvas-source-inspector__list"));
		for (const flag of inspection.completeness) {
			const item = append(completenessList, makeElement(this.document, "li", undefined, `${flag.path}: ${flag.state}`));
			item.dataset.state = flag.state;
		}
		addRows(completeness, [["Declared limitations", inspection.declaredLimitationCount]]);

		const diagnostics = addSection("Source diagnostics");
		addCounts(diagnostics, inspection.diagnosticCounts);

		const unknown = addSection("Unknown metadata fields");
		const unknownList = append(unknown, makeElement(this.document, "ul", "miro-canvas-source-inspector__list miro-canvas-source-inspector__unknown"));
		if (inspection.unknownFields.length === 0) append(unknownList, makeElement(this.document, "li", undefined, "None"));
		for (const field of inspection.unknownFields) append(unknownList, makeElement(this.document, "li", undefined, `${field.path}: ${field.type}`));
		append(body, makeElement(this.document, "p", "miro-canvas-source-inspector__note",
			inspection.truncated ? "Read-only summary; bounded limits were reached." : "Read-only summary; source values remain in the Canvas file."));

		this.listenModal(modal, "click", (event) => { if (event.target === modal) this.closeCommandModal(); });
		this.listenModal(modal, "keydown", (event) => {
			if ((event as KeyboardEvent).key === "Escape") this.closeCommandModal();
		});
		host.appendChild(modal);
		this.modal = modal;
		heading.focus();
	}

	public closeCommandModal(): void {
		for (const dispose of this.modalListeners.splice(0)) {
			dispose();
		}
		this.modal?.remove();
		this.modal = null;
	}

	/** Remove the dock, any dialog, and all listeners owned by this instance. */
	public dispose(): void {
		this.closeCommandModal();
		for (const dispose of this.listeners.splice(0)) {
			dispose();
		}
		this.element.remove?.();
		this.lastState = undefined;
		this.lastDiagnosticsKey = "";
	}
}

export const M1ControlPanel = M1Controls;
