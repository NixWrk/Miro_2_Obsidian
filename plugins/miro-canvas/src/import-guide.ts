/**
 * The "Import boards from Miro" guide.
 *
 * Bringing a Miro board in is not this plugin's job: a separate program,
 * miro2obsidian, does the exporting.  The plugin only points a person at it,
 * opening links in their own browser and copying text for them; it never
 * downloads, installs or runs anything itself, and it never goes to the
 * network on its own (QUAL-003).
 *
 * The guide's content is built here as detached DOM, the way
 * `selection-toolbar.ts` builds its toolbar, so it can be exercised with a
 * fake document.  The surrounding chrome - the modal's title and close
 * control - belongs to Obsidian's own `Modal` in main.ts.
 */

import { currentLocale, words } from "./i18n";

export const RELEASES_URL = "https://github.com/NixWrk/Miro_2_Obsidian/releases/latest";
export const SKILL_INSTALL_URL = "https://github.com/NixWrk/Miro_2_Obsidian#coding-agents";
export const APP_SETUP_URL_EN = "https://github.com/NixWrk/Miro_2_Obsidian/blob/main/docs/MIRO_APP_SETUP.md";
export const APP_SETUP_URL_RU = "https://github.com/NixWrk/Miro_2_Obsidian/blob/main/docs/MIRO_APP_SETUP.ru.md";

/** The step-by-step Miro app guide, in the language in use. */
export function appSetupUrl(): string {
	return currentLocale() === "ru" ? APP_SETUP_URL_RU : APP_SETUP_URL_EN;
}

/** The platform fields the guide reads; a subset of Obsidian's own `Platform`. */
export interface ImportGuidePlatform {
	readonly isPhone: boolean;
	readonly isTablet: boolean;
	readonly isMacOS: boolean;
	readonly isWin: boolean;
	readonly isLinux: boolean;
}

/**
 * The release this device downloads, or undefined on a phone or tablet,
 * which get told to use a computer instead of a download button.
 */
export function downloadSystemName(platform: ImportGuidePlatform): "windows" | "macos" | "linux" | undefined {
	if (platform.isPhone || platform.isTablet) return undefined;
	if (platform.isMacOS) return "macos";
	if (platform.isLinux) return "linux";
	// Every desktop build reports one of the three; Windows is the most
	// common and the safest guess for whatever is left.
	return "windows";
}

/** This vault's folder on disk, when the adapter is a plain filesystem one; its name otherwise. */
export function vaultFolderPath(adapter: unknown, vaultName: string): string {
	const getBasePath = (adapter as { getBasePath?: unknown } | null)?.getBasePath;
	if (typeof getBasePath !== "function") return vaultName;
	try {
		const path = Reflect.apply(getBasePath, adapter, []);
		return typeof path === "string" && path.trim() !== "" ? path : vaultName;
	} catch {
		// A mobile or plugin-backed adapter may expose the member and still
		// throw; the vault's name is always a safe fallback.
		return vaultName;
	}
}

/** The ready-made prompt for an AI coding agent, naming this vault. */
export function importPrompt(vaultPath: string): string {
	return words().importGuide.promptText(vaultPath);
}

/** Obsidian routes a browser tab's `window.open` to the person's own browser. */
export function openExternalLink(url: string): void {
	window.open(url);
}

export interface ImportGuideActions {
	/** Opens an external link in the person's own browser. */
	readonly onOpenLink: (url: string) => void;
	/** Writes text to the system clipboard; the host reports success with its own notice. */
	readonly onCopy: (text: string) => void;
}

export interface ImportGuideOptions {
	readonly document?: Document;
	/** Draws a named Obsidian icon into an element; without it a step shows its number instead. */
	readonly setIcon?: (element: HTMLElement, icon: string) => void;
	readonly platform: ImportGuidePlatform;
	/** This vault's folder path, or its name where no folder path is known. */
	readonly vaultPath: string;
}

function hasDocument(value: unknown): value is Document {
	return value !== null && typeof value === "object"
		&& typeof (value as { createElement?: unknown }).createElement === "function";
}

function append<T extends Node>(parent: Node, child: T): T {
	parent.appendChild(child);
	return child;
}

function make<K extends keyof HTMLElementTagNameMap>(
	document: Document, tag: K, className?: string, text?: string,
): HTMLElementTagNameMap[K] {
	const element = document.createElement(tag);
	if (className !== undefined) element.className = className;
	if (text !== undefined) element.textContent = text;
	return element;
}

function makeButton(document: Document, label: string, className = ""): HTMLButtonElement {
	const button = make(document, "button", `miro-canvas-import-guide__button ${className}`.trim(), label);
	button.type = "button";
	return button;
}

/** A button styled and behaving as a link: every external link goes through the host's one opener. */
function makeLink(
	document: Document, label: string, onOpenLink: (url: string) => void, url: string, className = "",
): HTMLButtonElement {
	const button = makeButton(document, label, `miro-canvas-import-guide__link ${className}`.trim());
	button.addEventListener("click", () => onOpenLink(url));
	return button;
}

function paragraph(document: Document, parent: HTMLElement, text: string): void {
	append(parent, make(document, "p", "miro-canvas-import-guide__text", text));
}

/** One numbered step: an icon and a title, followed by whatever body content it needs. */
function makeStep(
	document: Document, setIcon: ImportGuideOptions["setIcon"], number: number, icon: string, title: string,
): { readonly step: HTMLElement; readonly body: HTMLElement } {
	const step = make(document, "div", "miro-canvas-import-guide__step");
	step.setAttribute("data-step", String(number));
	const header = append(step, make(document, "div", "miro-canvas-import-guide__step-header"));
	const iconEl = append(header, make(document, "span", "miro-canvas-import-guide__step-icon"));
	iconEl.textContent = String(number);
	if (setIcon !== undefined) {
		try {
			setIcon(iconEl, icon);
		} catch {
			// A host that cannot draw the icon still shows the step's number.
		}
	}
	append(header, make(document, "strong", "miro-canvas-import-guide__step-title", title));
	const body = append(step, make(document, "div", "miro-canvas-import-guide__step-body"));
	return { step, body };
}

/**
 * The guide's content: six numbered steps.  A caller (main.ts) puts this into
 * an Obsidian `Modal`'s content element; the modal itself owns the title and
 * close control, so this builder only ever produces detached DOM.
 */
export function buildImportGuide(actions: ImportGuideActions, options: ImportGuideOptions): HTMLElement {
	const document = options.document ?? (typeof window !== "undefined" ? window.document : undefined);
	if (!hasDocument(document)) return {} as HTMLElement;
	const strings = words().importGuide;
	const root = make(document, "div", "miro-canvas-import-guide");

	// 1. Get miro2obsidian.
	{
		const { step, body } = makeStep(document, options.setIcon, 1, "download", strings.step1Title);
		paragraph(document, body, strings.step1Body);
		const system = downloadSystemName(options.platform);
		if (system === undefined) {
			paragraph(document, body, strings.mobileNotice);
		} else {
			const label = system === "macos" ? strings.macos : system === "linux" ? strings.linux : strings.windows;
			append(body, makeLink(document, strings.downloadFor(label), actions.onOpenLink, RELEASES_URL, "miro-canvas-import-guide__download"));
		}
		append(root, step);
	}

	// 2. Or let an AI agent do it.
	{
		const { step, body } = makeStep(document, options.setIcon, 2, "bot", strings.step2Title);
		paragraph(document, body, strings.step2Body);
		const prompt = importPrompt(options.vaultPath);
		const box = append(body, make(document, "textarea", "miro-canvas-import-guide__prompt")) as HTMLTextAreaElement;
		box.readOnly = true;
		box.value = prompt;
		box.setAttribute("aria-label", strings.promptLabel);
		const row = append(body, make(document, "div", "miro-canvas-import-guide__row"));
		const copy = append(row, makeButton(document, strings.copyPrompt));
		copy.addEventListener("click", () => actions.onCopy(prompt));
		append(row, makeLink(document, strings.installSkillLink, actions.onOpenLink, SKILL_INSTALL_URL));
		append(root, step);
	}

	// 3. Create your own Miro app.
	{
		const { step, body } = makeStep(document, options.setIcon, 3, "key-round", strings.step3Title);
		paragraph(document, body, strings.step3Body);
		append(body, makeLink(document, strings.openStepByStepGuide, actions.onOpenLink, appSetupUrl()));
		append(root, step);
	}

	// 4. Export into this vault.
	{
		const { step, body } = makeStep(document, options.setIcon, 4, "folder-open", strings.step4Title);
		paragraph(document, body, strings.step4Body);
		const row = append(body, make(document, "div", "miro-canvas-import-guide__row"));
		append(row, make(document, "code", "miro-canvas-import-guide__path", options.vaultPath));
		const copy = append(row, makeButton(document, strings.copyPath));
		copy.addEventListener("click", () => actions.onCopy(options.vaultPath));
		append(root, step);
	}

	// 5. Open the board.
	{
		const { step, body } = makeStep(document, options.setIcon, 5, "layout-dashboard", strings.step5Title);
		paragraph(document, body, strings.step5Body);
		append(root, step);
	}

	// 6. Afterwards.
	{
		const { step, body } = makeStep(document, options.setIcon, 6, "trash-2", strings.step6Title);
		paragraph(document, body, strings.step6Body);
		append(root, step);
	}

	return root;
}
