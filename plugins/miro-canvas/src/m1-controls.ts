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
	readonly fontFamily: HTMLSelectElement;
	readonly fontSize: HTMLInputElement;
	readonly lineHeight: HTMLInputElement;
	readonly verticalAlign: HTMLSelectElement;
	readonly alignment: HTMLSelectElement;
	readonly colorSlot: HTMLSelectElement;
	readonly colorHex: HTMLInputElement;
	readonly clearColor: HTMLButtonElement;
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
	readonly formatButtons: Readonly<Record<"bold" | "italic" | "underline" | "strike", HTMLButtonElement>>;
	readonly colorSwatches: HTMLElement;
	readonly recentSwatches: HTMLElement;
}

const FONT_FAMILIES = ["Inter", "system-ui", "Arial", "Noto Sans", "sans-serif"] as const;
const THEME_VALUES: readonly DisplayTheme[] = ["system", "light", "dark"];
const COLOR_SLOTS: readonly ColorSlot[] = ["text", "fill", "border", "edge"];
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

function makeLabel(document: Document, caption: string, control: HTMLElement): HTMLLabelElement {
	const label = makeElement(document, "label", "miro-canvas-panel__label");
	// Explicitly name the control so native select option text cannot become
	// part of an ambiguous accessible label in browser/Obsidian DOMs.
	control.setAttribute("aria-label", caption);
	append(label, makeElement(document, "span", "miro-canvas-panel__label-text", caption));
	append(label, control);
	return label;
}

function makeButton(document: Document, label: string, title: string, className = ""): HTMLButtonElement {
	const button = makeElement(document, "button", `miro-canvas-panel__button ${className}`.trim(), label);
	button.type = "button";
	button.title = title;
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

function normalizedColor(value: unknown): string | undefined {
	if (typeof value !== "string") {
		return undefined;
	}
	const candidate = value.trim().toLowerCase();
	if (/^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/u.test(candidate)) {
		return candidate.slice(0, 7);
	}
	if (/^#[0-9a-f]{3}$/u.test(candidate)) {
		return `#${candidate[1]}${candidate[1]}${candidate[2]}${candidate[2]}${candidate[3]}${candidate[3]}`;
	}
	return undefined;
}

function selectedColor(state: M1ControlsState, slot: ColorSlot = "text"): string | undefined {
	const id = state.selectedIds[0];
	if (id === undefined) {
		return undefined;
	}
	const colors = state.appearance.localOverrides[id]?.colors;
	if (colors === undefined) {
		return undefined;
	}
	const value = colors[slot];
	return normalizedColor(value ?? undefined);
}

function selectedTypography(state: M1ControlsState): TypographySettings {
	const id = state.selectedIds[0];
	if (id === undefined) {
		return {
			fontFamily: "Inter",
			fontSize: 16,
			format: { bold: false, italic: false, underline: false, strike: false },
			alignment: "left",
		};
	}
	return state.appearance.localOverrides[id]?.typography ?? {
			fontFamily: "Inter",
			fontSize: 16,
			format: { bold: false, italic: false, underline: false, strike: false },
			alignment: "left",
		};
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
	private lastPaletteKey = "";
	private lastRecentKey = "";
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

		const navigation = append(root, makeElement(document, "div", "miro-canvas-panel__group miro-canvas-panel__navigation"));
		setText(append(navigation, makeElement(document, "span", "miro-canvas-panel__group-title")), "Navigation");
		const navButtons: Array<[M1NavigationAction, string, string]> = [
			["zoom-out", "−", "Zoom out"],
			["zoom-reset", "100%", "Reset zoom"],
			["zoom-in", "+", "Zoom in"],
			["zoom-fit", "Fit", "Fit board to viewport"],
			["toggle-minimap", "Map", "Show or hide minimap"],
		];
		const minimap = makeButton(document, "Map", "Show or hide minimap");
		for (const [action, label, title] of navButtons) {
			const button = action === "toggle-minimap" ? minimap : makeButton(document, label, title);
			if (action !== "toggle-minimap") {
				setText(button, label);
			}
			this.listen(button, "click", () => this.actions.onNavigation(action));
			append(navigation, button);
		}
		const minimapDock = makeElement(document, "aside", "miro-canvas-minimap");
		minimapDock.setAttribute("aria-label", "Canvas minimap");
		const minimapCanvas = makeElement(document, "canvas", "miro-canvas-panel__minimap-canvas");
		minimapCanvas.width = 240;
		minimapCanvas.height = 160;
		minimapCanvas.tabIndex = 0;
		minimapCanvas.setAttribute("role", "img");
		minimapCanvas.setAttribute("aria-label", "Canvas minimap; use arrow keys to pan");
		append(minimapDock, minimapCanvas);

		const themeGroup = append(root, makeElement(document, "div", "miro-canvas-panel__group"));
		setText(append(themeGroup, makeElement(document, "span", "miro-canvas-panel__group-title")), "Board theme");
		const theme = makeSelect(document, THEME_VALUES, { system: "System", light: "Light", dark: "Dark" });
		append(themeGroup, theme);
		this.listen(theme, "change", () => this.actions.onAppearance({
			type: APPEARANCE_ACTIONS.setDisplayTheme,
			displayTheme: theme.value,
		}));

		const typographyDetails = append(root, makeElement(document, "details", "miro-canvas-panel__group miro-canvas-panel__selection-only"));
		typographyDetails.open = true;
		const typographySummary = append(typographyDetails, makeElement(document, "summary", "miro-canvas-panel__group-title", "Typography"));
		typographySummary.setAttribute("aria-label", "Typography controls");
		const typographyGrid = append(typographyDetails, makeElement(document, "div", "miro-canvas-panel__grid"));
		const fontFamily = makeSelect(document, FONT_FAMILIES, Object.fromEntries(FONT_FAMILIES.map((item) => [item, item])) as Record<typeof FONT_FAMILIES[number], string>);
		append(typographyGrid, makeLabel(document, "Font", fontFamily));
		const fontSize = makeElement(document, "input");
		fontSize.type = "number";
		fontSize.min = "6";
		fontSize.max = "256";
		fontSize.step = "1";
		append(typographyGrid, makeLabel(document, "Size", fontSize));
		const lineHeight = makeElement(document, "input");
		lineHeight.type = "number";
		lineHeight.min = "0.5";
		lineHeight.max = "4";
		lineHeight.step = "0.05";
		append(typographyGrid, makeLabel(document, "Line height", lineHeight));
		const verticalAlign = makeSelect(document, VERTICAL_VALUES, { top: "Top", center: "Center", bottom: "Bottom" });
		append(typographyGrid, makeLabel(document, "Vertical", verticalAlign));
		const alignment = makeSelect(document, ALIGNMENT_VALUES, { left: "Left", center: "Center", right: "Right", justify: "Justify" });
		append(typographyGrid, makeLabel(document, "Align", alignment));
		const formatButtons = {} as Record<"bold" | "italic" | "underline" | "strike", HTMLButtonElement>;
		const formatRow = append(typographyDetails, makeElement(document, "div", "miro-canvas-panel__row"));
		for (const [format, label, title] of [["bold", "B", "Bold"], ["italic", "I", "Italic"], ["underline", "U", "Underline"], ["strike", "S", "Strikethrough"]] as const) {
			const button = makeButton(document, label, title, `miro-canvas-panel__format miro-canvas-panel__format--${format}`);
			button.setAttribute("aria-pressed", "false");
			formatButtons[format] = button;
			this.listen(button, "click", () => {
				const current = this.lastState === undefined ? false : selectedTypography(this.lastState).format[format];
				this.actions.onAppearance({
					type: APPEARANCE_ACTIONS.setFormat,
					format: { ...selectedTypography(this.lastState ?? this.emptyState()).format, [format]: !current },
				});
			});
			append(formatRow, button);
		}
		this.listen(fontFamily, "change", () => this.actions.onAppearance({ type: APPEARANCE_ACTIONS.setFontFamily, fontFamily: fontFamily.value }));
		this.listen(fontSize, "change", () => this.actions.onAppearance({ type: APPEARANCE_ACTIONS.setFontSize, fontSize: Number(fontSize.value) }));
		this.listen(lineHeight, "change", () => this.actions.onAppearance({
			type: APPEARANCE_ACTIONS.setTypography,
			typography: { lineHeight: Number(lineHeight.value) },
		}));
		this.listen(verticalAlign, "change", () => this.actions.onAppearance({
			type: APPEARANCE_ACTIONS.setTypography,
			typography: { verticalAlign: verticalAlign.value },
		}));
		this.listen(alignment, "change", () => this.actions.onAppearance({ type: APPEARANCE_ACTIONS.setAlignment, alignment: alignment.value }));

		const colors = append(root, makeElement(document, "details", "miro-canvas-panel__group miro-canvas-panel__selection-only"));
		colors.open = true;
		append(colors, makeElement(document, "summary", "miro-canvas-panel__group-title", "Colors"));
		const colorGrid = append(colors, makeElement(document, "div", "miro-canvas-panel__grid"));
		const colorSlot = makeSelect(document, COLOR_SLOTS, { text: "Text", fill: "Fill", border: "Border", edge: "Edge" });
		append(colorGrid, makeLabel(document, "Target", colorSlot));
		const colorHex = makeElement(document, "input");
		colorHex.type = "text";
		colorHex.inputMode = "text";
		colorHex.maxLength = 9;
		colorHex.placeholder = "#RRGGBB";
		append(colorGrid, makeLabel(document, "HEX", colorHex));
		const nativeColor = makeElement(document, "input");
		nativeColor.type = "color";
		nativeColor.setAttribute("aria-label", "Pick a color");
		append(colorGrid, nativeColor);
		const clearColor = makeButton(document, "Clear", "Clear color (transparent)");
		append(colorGrid, clearColor);
		const swatches = append(colors, makeElement(document, "div", "miro-canvas-panel__swatches"));
		const recentSwatches = append(colors, makeElement(document, "div", "miro-canvas-panel__swatches miro-canvas-panel__swatches--recent"));
		this.listen(colorHex, "change", () => this.emitColor(colorHex.value));
		this.listen(nativeColor, "change", () => this.emitColor(nativeColor.value));
		this.listen(clearColor, "click", () => this.emitColor(null));
		this.listen(colorSlot, "change", () => {
			if (this.lastState !== undefined) {
				this.update(this.lastState);
			}
		});
		const swatchClick = (event: Event): void => {
			let target: unknown = event.target;
			if (!isDomElement(target)) {
				return;
			}
			try {
				const closest = target.closest("[data-miro-canvas-color]");
				if (!isDomElement(closest)) {
					return;
				}
				const value = closest.getAttribute("data-miro-canvas-color");
				if (value !== null) {
					this.emitColor(value);
				}
			} catch {
				// A detached swatch cannot produce a color action.
			}
		};
		this.listen(swatches, "click", swatchClick);
		this.listen(recentSwatches, "click", swatchClick);

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
			fontFamily,
			fontSize,
			lineHeight,
			verticalAlign,
			alignment,
			colorSlot,
			colorHex,
			clearColor,
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
			formatButtons,
			colorSwatches: swatches,
			recentSwatches,
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

	private emitColor(value: unknown): void {
		const slot = this.refs?.colorSlot.value;
		if (slot !== "text" && slot !== "fill" && slot !== "border" && slot !== "edge") {
			return;
		}
		if (value !== null && normalizedColor(value) === undefined) {
			return;
		}
		this.actions.onAppearance({ type: APPEARANCE_ACTIONS.setColor, slot, color: value });
	}

	private renderSwatches(container: HTMLElement, colors: readonly PaletteColor[] | readonly string[], recent: boolean): void {
		while (container.firstChild !== null) {
			container.removeChild(container.firstChild);
		}
		if (colors.length === 0) {
			setText(append(container, makeElement(this.document!, "span", "miro-canvas-panel__muted")), recent ? "No recent colors" : "No palette colors");
			return;
		}
		for (const item of colors) {
			const paletteItem: PaletteColor = typeof item === "string"
				? { id: `recent-${item.slice(1)}`, label: item, color: item, source: "custom" }
				: item;
			const button = makeButton(this.document!, "", `${paletteItem.label}: ${paletteItem.color}`, "miro-canvas-panel__swatch");
			button.style.setProperty("--miro-canvas-swatch", paletteItem.color);
			button.dataset.miroCanvasColor = paletteItem.color;
			button.dataset.miroCanvasColorSource = paletteItem.source;
			append(container, button);
		}
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
		const selectionChanged = selectionKey !== this.lastSelectionKey;
		const activeElement = this.document.activeElement;
		const editingControl = activeElement === refs.fontFamily
			|| activeElement === refs.fontSize
			|| activeElement === refs.lineHeight
			|| activeElement === refs.verticalAlign
			|| activeElement === refs.alignment
			|| activeElement === refs.colorHex;
		refs.theme.value = state.appearance.settings.displayTheme;
		const typography = selectedTypography(state);
		if (!editingControl || selectionChanged) {
			refs.fontFamily.value = typography.fontFamily;
			refs.fontSize.value = text(typography.fontSize);
			refs.lineHeight.value = text(typography.lineHeight ?? 1.2);
			refs.verticalAlign.value = typography.verticalAlign ?? "top";
			refs.alignment.value = typography.alignment;
			const slot = COLOR_SLOTS.includes(refs.colorSlot.value as ColorSlot)
				? refs.colorSlot.value as ColorSlot
				: "text";
			refs.colorHex.value = selectedColor(state, slot) ?? "";
		}
		for (const format of ["bold", "italic", "underline", "strike"] as const) {
			refs.formatButtons[format].setAttribute("aria-pressed", typography.format[format] ? "true" : "false");
		}
		refs.review.checked = state.reviewMode;
		refs.attachmentGlobal.checked = state.showAttachmentNames;
		refs.attachmentNode.checked = state.selectedAttachmentNames === true;
		refs.minimap.textContent = state.minimapVisible ? "Hide map" : "Show map";
		refs.minimapDock.hidden = !state.minimapVisible;
		refs.minimapCanvas.hidden = !state.minimapVisible;
		setText(refs.selectionLabel, state.selectedIds.length === 0
			? "No selection"
			: `${state.selectedIds.length} selected`);
		setText(refs.status, state.diagnostics.length === 0 ? "Ready" : `${state.diagnostics.length} diagnostic(s)`);
		setDisabled(refs.lockSelection, state.selectedIds.length === 0 || state.reviewMode);
		setDisabled(refs.unlockSelection, state.selectedIds.length === 0 || state.reviewMode);
		setDisabled(refs.attachmentNode, state.selectedIds.length === 0);
		const paletteKey = state.appearance.settings.palette
			.map((item) => `${item.id}|${item.label}|${item.color}|${item.source}`)
			.join("\u0000");
		if (paletteKey !== this.lastPaletteKey) {
			this.renderSwatches(refs.colorSwatches, state.appearance.settings.palette, false);
			this.lastPaletteKey = paletteKey;
		}
		const recentKey = state.appearance.settings.recentColors.join("\u0000");
		if (recentKey !== this.lastRecentKey) {
			this.renderSwatches(refs.recentSwatches, state.appearance.settings.recentColors, true);
			this.lastRecentKey = recentKey;
		}
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
				command.run();
				this.closeCommandModal();
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
		this.lastPaletteKey = "";
		this.lastRecentKey = "";
		this.lastDiagnosticsKey = "";
	}
}

export const M1ControlPanel = M1Controls;
