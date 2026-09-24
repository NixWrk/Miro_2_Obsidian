/**
 * English: the reference table.  Every other language provides exactly these
 * keys (the compiler checks it); a string that takes values is a function of
 * them, so each language can put the values where its grammar wants them.
 *
 * Groups follow the part of the interface the words appear in.
 */

export const EN = {
	layer: {
		menu: "Layer",
		front: "Bring to front",
		forward: "Bring forward",
		backward: "Send backward",
		back: "Send to back",
		onlyCards: "Only cards have layers: select a card.",
		notChanged: "The layer order was not changed.",
		selectCard: "Select a card to reorder.",
	},
	export: {
		dialogLabel: "Export",
		close: "Close",
		paperLabel: "Paper",
		landscape: "Landscape",
		portrait: "Portrait",
		pagesLabel: "Pages",
		slidesLabel: "Slides",
		noPages: "No pages yet: add one, or one for each frame.",
		showPage: "Show on the board",
		earlier: "Earlier",
		later: "Later",
		removePage: "Remove page",
		addPage: "Add page",
		addPageHint: "Add a page in the middle of the view",
		addFramePages: "A page per frame",
		addFramePagesHint: "Add a page around each frame",
		noFrames: "This board has no frames.",
		qualityLabel: "Quality",
		standard: "Standard",
		high: "High",
		standardHint: "Pages 2000 pixels across",
		highHint: "Pages 3000 pixels across",
		exportPdf: "Export PDF",
		exportPptx: "Export PowerPoint",
		unavailable: "Exporting needs Obsidian on a computer.",
		boardMenuLabel: "Export to PDF or PowerPoint",
		deckBarLabel: "Export slides as PDF or PowerPoint",
		boardTitle: "Export board",
		slidesTitle: (name: string) => `Export ${name}`,
		slidesFallbackTitle: "slides",
		pageFallback: (number: number) => `Page ${number}`,
		frameFallback: (number: number) => `Frame ${number}`,
		slideFallback: (number: number) => `Slide ${number}`,
		progressTitle: "Exporting",
		stop: "Stop",
		capturing: "Taking pictures of the pages…",
		capturingProgress: (done: number, total: number) => `Taking pictures: ${done} of ${total}`,
		writingPdf: "Writing the PDF…",
		writingPptx: "Writing the presentation…",
		exportedTo: (path: string) => `Exported to ${path}`,
		exportStopped: "Export stopped.",
		exportFailed: "The export failed.",
		pageNotDrawn: "The page could not be drawn.",
		pageNotEncoded: "The page could not be encoded.",
	},
	deck: {
		present: "Present slides",
		fit: "Show all slides",
		untitled: "Slides",
	},
	commands: {
		prefix: "Miro Canvas",
	},
};

/**
 * The shape every language's table has: the English keys, with each string
 * any string and each function taking the same values.
 */
type Widen<T> = {
	readonly [K in keyof T]: T[K] extends string
		? string
		: T[K] extends (...values: infer V) => string
			? (...values: V) => string
			: Widen<T[K]>;
};

export type Messages = Widen<typeof EN>;
