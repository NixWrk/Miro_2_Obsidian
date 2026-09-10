/**
 * Namespaced, framework-free controls for the M1 Canvas session.
 *
 * The native Canvas remains the editor.  This module only builds a small
 * inspector/toolbar and reports explicit user actions to its host.  It never
 * reads or writes a Canvas file and never injects HTML into a node's text.
 */

import {
	APPEARANCE_ACTIONS,
	type AppearanceAction,
	type AppearanceState,
	type ColorSlot,
	type DisplayTheme,
	type PaletteColor,
	type TypographySettings,
} from "./appearance";
import type { SourceInspection } from "./source-inspector";

export type M1NavigationAction =
	| "zoom-in"
	| "zoom-out"
	| "zoom-reset"
	| "zoom-fit"
	| "toggle-minimap";

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
}

export interface M1ControlsActions {
	readonly onAppearance: (action: AppearanceAction) => void;
	readonly onInteraction: (action: Record<string, unknown>) => void;
	readonly onAttachment: (action: Record<string, unknown>) => void;
	readonly onNavigation: (action: M1NavigationAction) => void;
	readonly openCommandModal: () => void;
	readonly closeCommandModal?: () => void;
}

export interface M1ControlsOptions {
	readonly document?: Document;
	readonly title?: string;
	readonly className?: string;
}

interface ControlRefs {
	readonly theme: HTMLSelectElement;
	readonly review: HTMLInputElement;
	readonly attachmentGlobal: HTMLInputElement;
	readonly attachmentNode: HTMLInputElement;
	readonly lockSelection: HTMLButtonElement;
	readonly unlockSelection: HTMLButtonElement;
	readonly minimap: HTMLButtonElement;
	readonly minimapDock: HTMLElement;
	readonly minimapCanvas: HTMLCanvasElement;
	readonly status: HTMLElement;
	readonly diagnostics: HTMLElement;
	readonly selectionLabel: HTMLElement;
}

const THEME_VALUES: readonly DisplayTheme[] = ["system", "light", "dark"];
const VERTICAL_VALUES = ["top", "center", "bottom"] as const;
const ALIGNMENT_VALUES = ["left", "center", "right", "justify"] as const;

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

function setDisabled(element: HTMLButtonElement | HTMLInputElement | HTMLSelectElement, disabled: boolean): void {
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
	return button;
}

function makeSelect<T extends string>(
	document: Document,
	options: readonly T[],
	labels: Readonly<Record<T, string>>,
	className = "",
): HTMLSelectElement {
	const select = makeElement(document, "select", className);
	for (const value of options) {
		const option = makeElement(document, "option");
		option.value = value;
		setText(option, labels[value]);
		append(select, option);
	}
	return select;
}




/** Build and own the M1 panel DOM. */
export class M1Controls {
	public readonly element: HTMLElement;
	public readonly minimapElement: HTMLElement;
	private readonly document: Document | undefined;
	private readonly actions: M1ControlsActions;
	private readonly refs: ControlRefs | undefined;
	private readonly listeners: Array<() => void> = [];
	private readonly modalListeners: Array<() => void> = [];
	private modal: HTMLElement | null = null;
	private lastState: M1ControlsState | undefined;
	private lastSelectionKey = "";
	private lastDiagnosticsKey = "";

	public constructor(actions: M1ControlsActions, options: M1ControlsOptions = {}) {
		this.actions = actions;
		this.document = options.document
			?? (typeof document !== "undefined" ? document : undefined);
		if (!hasDocument(this.document)) {
			this.element = {} as HTMLElement;
			this.minimapElement = {} as HTMLElement;
			return;
		}
		const root = makeElement(this.document, "section", options.className ?? "miro-canvas-panel");
		root.setAttribute("data-miro-canvas-panel", "true");
		root.setAttribute("aria-label", options.title ?? "Miro Canvas controls");
		this.element = root;
		this.refs = this.build(root);
		this.minimapElement = this.refs.minimapDock;
	}

	private listen<T extends EventTarget>(target: T, event: string, handler: EventListener): void {
		target.addEventListener(event, handler);
		this.listeners.push(() => target.removeEventListener(event, handler));
	}

	private listenModal<T extends EventTarget>(target: T, event: string, handler: EventListener): void {
		target.addEventListener(event, handler);
		this.modalListeners.push(() => target.removeEventListener(event, handler));
	}

	private build(root: HTMLElement): ControlRefs {
		const document = this.document!;
		const header = append(root, makeElement(document, "div", "miro-canvas-panel__header"));
		append(header, makeElement(document, "strong", "miro-canvas-panel__title", "Miro Canvas"));
		const command = makeButton(document, "Commands", "Open Miro Canvas commands", "miro-canvas-panel__commands");
		append(header, command);
		this.listen(command, "click", () => this.actions.openCommandModal());

		const status = append(root, makeElement(document, "div", "miro-canvas-panel__status"));
		status.setAttribute("role", "status");
		const selectionLabel = append(root, makeElement(document, "div", "miro-canvas-panel__selection", "No selection"));

		// Zoom lives with the map it navigates, at the bottom of the Canvas,
		// rather than in the settings panel at the opposite corner.
		const minimapDock = makeElement(document, "aside", "miro-canvas-minimap");
		minimapDock.setAttribute("aria-label", "Canvas navigation");
		const minimapCanvas = makeElement(document, "canvas", "miro-canvas-panel__minimap-canvas");
		minimapCanvas.width = 240;
		minimapCanvas.height = 160;
		minimapCanvas.tabIndex = 0;
		minimapCanvas.setAttribute("role", "img");
		minimapCanvas.setAttribute("aria-label", "Canvas minimap; use arrow keys to pan");
		append(minimapDock, minimapCanvas);
		const navigation = append(minimapDock, makeElement(document, "div", "miro-canvas-minimap__navigation"));
		navigation.setAttribute("role", "toolbar");
		navigation.setAttribute("aria-label", "Canvas navigation");
		const navButtons: Array<[M1NavigationAction, string, string]> = [
			["zoom-out", "−", "Zoom out"],
			["zoom-reset", "100%", "Reset zoom"],
			["zoom-in", "+", "Zoom in"],
			["zoom-fit", "Fit", "Fit board to viewport"],
			["toggle-minimap", "Map", "Show or hide minimap"],
		];
		const minimap = makeButton(document, "Map", "Show or hide minimap", "miro-canvas-minimap__toggle");
		for (const [action, label, title] of navButtons) {
			const button = action === "toggle-minimap" ? minimap : makeButton(document, label, title);
			if (action !== "toggle-minimap") {
				setText(button, label);
			}
			this.listen(button, "click", () => this.actions.onNavigation(action));
			append(navigation, button);
		}

		const themeGroup = append(root, makeElement(document, "div", "miro-canvas-panel__group"));
		setText(append(themeGroup, makeElement(document, "span", "miro-canvas-panel__group-title")), "Board theme");
		const theme = makeSelect(document, THEME_VALUES, { system: "System", light: "Light", dark: "Dark" });
		append(themeGroup, theme);
		this.listen(theme, "change", () => this.actions.onAppearance({
			type: APPEARANCE_ACTIONS.setDisplayTheme,
			displayTheme: theme.value,
		}));


		const safety = append(root, makeElement(document, "div", "miro-canvas-panel__group"));
		setText(append(safety, makeElement(document, "span", "miro-canvas-panel__group-title")), "Safety");
		const reviewLabel = makeElement(document, "label", "miro-canvas-panel__check");
		const review = makeElement(document, "input");
		review.type = "checkbox";
		append(reviewLabel, review);
		append(reviewLabel, makeElement(document, "span", "", "Review mode"));
		append(safety, reviewLabel);
		const lockSelection = makeButton(document, "Lock selection", "Lock selected elements");
		const unlockSelection = makeButton(document, "Unlock selection", "Unlock selected elements");
		append(safety, lockSelection);
		append(safety, unlockSelection);
		this.listen(review, "change", () => this.actions.onInteraction({ type: "set-review-mode", enabled: review.checked }));
		this.listen(lockSelection, "click", () => this.actions.onInteraction({ type: "set-locks", elementIds: this.lastState?.selectedIds ?? [], locked: true }));
		this.listen(unlockSelection, "click", () => this.actions.onInteraction({ type: "set-locks", elementIds: this.lastState?.selectedIds ?? [], locked: false }));

		const attachment = append(root, makeElement(document, "div", "miro-canvas-panel__group"));
		setText(append(attachment, makeElement(document, "span", "miro-canvas-panel__group-title")), "Attachments");
		const attachmentGlobalLabel = makeElement(document, "label", "miro-canvas-panel__check");
		const attachmentGlobal = makeElement(document, "input");
		attachmentGlobal.type = "checkbox";
		append(attachmentGlobalLabel, attachmentGlobal);
		append(attachmentGlobalLabel, makeElement(document, "span", "", "Show attachment names"));
		append(attachment, attachmentGlobalLabel);
		const attachmentNodeLabel = makeElement(document, "label", "miro-canvas-panel__check");
		const attachmentNode = makeElement(document, "input");
		attachmentNode.type = "checkbox";
		append(attachmentNodeLabel, attachmentNode);
		append(attachmentNodeLabel, makeElement(document, "span", "", "Show for selection"));
		append(attachment, attachmentNodeLabel);
		this.listen(attachmentGlobal, "change", () => this.actions.onAttachment({ type: "set-global", visible: attachmentGlobal.checked }));
		this.listen(attachmentNode, "change", () => this.actions.onAttachment({ type: "set-selection", visible: attachmentNode.checked, elementIds: this.lastState?.selectedIds ?? [] }));

		const diagnostics = append(root, makeElement(document, "div", "miro-canvas-panel__diagnostics"));
		diagnostics.setAttribute("role", "log");

		return {
			theme,
			review,
			attachmentGlobal,
			attachmentNode,
			lockSelection,
			unlockSelection,
			minimap,
			minimapDock,
			minimapCanvas,
			status,
			diagnostics,
			selectionLabel,
		};
	}

	private emptyState(): M1ControlsState {
		return {
			appearance: {
				settings: { displayTheme: "system", palette: [], recentColors: [] },
				localOverrides: {},
			},
			selectedIds: [],
			reviewMode: false,
			lockedSelection: false,
			showAttachmentNames: true,
			minimapVisible: true,
			diagnostics: [],
		};
	}




	/** Refresh labels and control values without rebuilding native Canvas DOM. */
	public update(state: M1ControlsState): void {
		this.lastState = state;
		if (this.refs === undefined || !hasDocument(this.document)) {
			return;
		}
		const refs = this.refs;
		this.element.setAttribute("data-miro-canvas-has-selection", state.selectedIds.length > 0 ? "true" : "false");
		const selectionKey = state.selectedIds.join("\u0000");
		// Typography and colors belong to the floating selection toolbar; this
		// panel keeps only the board-wide settings so one selection never opens
		// two menus at once.
		refs.theme.value = state.appearance.settings.displayTheme;
		refs.review.checked = state.reviewMode;
		refs.attachmentGlobal.checked = state.showAttachmentNames;
		refs.attachmentNode.checked = state.selectedAttachmentNames === true;
		refs.minimap.textContent = state.minimapVisible ? "Hide map" : "Show map";
		refs.minimap.setAttribute("aria-pressed", state.minimapVisible ? "true" : "false");
		// The dock also carries zoom, so only the map itself is hidden.
		refs.minimapCanvas.hidden = !state.minimapVisible;
		refs.minimapDock.setAttribute("data-miro-canvas-minimap", state.minimapVisible ? "visible" : "hidden");
		setText(refs.selectionLabel, state.selectedIds.length === 0
			? "No selection"
			: `${state.selectedIds.length} selected`);
		setText(refs.status, state.diagnostics.length === 0 ? "Ready" : `${state.diagnostics.length} diagnostic(s)`);
		setDisabled(refs.lockSelection, state.selectedIds.length === 0 || state.reviewMode);
		setDisabled(refs.unlockSelection, state.selectedIds.length === 0 || state.reviewMode);
		setDisabled(refs.attachmentNode, state.selectedIds.length === 0);
		const diagnosticsKey = state.diagnostics.join("\u0000");
		if (diagnosticsKey !== this.lastDiagnosticsKey) {
			while (refs.diagnostics.firstChild !== null) {
				refs.diagnostics.removeChild(refs.diagnostics.firstChild);
			}
			for (const diagnostic of state.diagnostics) {
				const item = append(refs.diagnostics, makeElement(this.document, "div", "miro-canvas-panel__diagnostic"));
				setText(item, diagnostic);
			}
			this.lastDiagnosticsKey = diagnosticsKey;
		}
		this.lastSelectionKey = selectionKey;
	}

	public get minimapCanvas(): HTMLCanvasElement | undefined {
		return this.refs?.minimapCanvas;
	}

	/** Open a keyboard-friendly command modal rendered with safe DOM APIs. */
	public openCommandModal(commands: readonly M1CommandItem[]): void {
		this.closeCommandModal();
		if (!hasDocument(this.document) || !isDomElement(this.element)) {
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
		this.element.appendChild(modal);
		this.modal = modal;
		heading.focus();
	}

	/** Show only the bounded inspection model; raw source values never enter DOM. */
	public openSourceInspector(inspection: SourceInspection): void {
		this.closeCommandModal();
		if (!hasDocument(this.document) || !isDomElement(this.element)) return;
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
		this.element.appendChild(modal);
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

	/** Remove the panel and all listeners owned by this instance. */
	public dispose(): void {
		this.closeCommandModal();
		for (const dispose of this.listeners.splice(0)) {
			dispose();
		}
		this.element.remove();
		this.minimapElement.remove();
		this.lastState = undefined;
		this.lastSelectionKey = "";
		this.lastDiagnosticsKey = "";
	}
}

export const M1ControlPanel = M1Controls;
