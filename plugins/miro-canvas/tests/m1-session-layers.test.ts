import { afterEach, describe, expect, it, vi } from "vitest";
import { M1CanvasSession } from "../src/m1-session";
import { MetadataWriter } from "../src/metadata-writer";
import { createObsidianMetadataStore } from "../src/obsidian-metadata-store";
import type { M1ControlsActions } from "../src/m1-controls";

// Only the presentation is replaced; the adapter, the authoring transaction
// and the metadata store are the real ones.
vi.mock("../src/m1-controls", () => ({
	M1Controls: class {
		element = new HostElement("miro-canvas-panel");
		minimapElement = new HostElement();
		constructor(public actions: M1ControlsActions) {}
		update() {}
		dispose() { this.element.remove(); this.minimapElement.remove(); }
	},
}));

class HostElement extends EventTarget {
	nodeType = 1;
	parentElement?: HostElement;
	children: HostElement[] = [];
	attributes = new Map<string, string>();
	classes = new Set<string>();
	properties = new Map<string, string>();
	style = {
		setProperty: (name: string, value: string) => { this.properties.set(name, value); },
		removeProperty: (name: string) => { this.properties.delete(name); },
	};
	clientWidth = 800;
	clientHeight = 600;
	classList = {
		add: (name: string) => { this.classes.add(name); },
		remove: (name: string) => { this.classes.delete(name); },
		contains: (name: string) => this.classes.has(name),
	};
	constructor(public className = "", public tagName = "DIV") { super(); }
	appendChild(child: HostElement) { child.parentElement = this; this.children.push(child); return child; }
	removeChild(child: HostElement) { this.children = this.children.filter((item) => item !== child); }
	remove() { this.parentElement?.removeChild(this); }
	setAttribute(key: string, value: string) { this.attributes.set(key, value); }
	getAttribute(key: string) { return this.attributes.get(key) ?? null; }
	hasAttribute(key: string) { return this.attributes.has(key); }
	removeAttribute(key: string) { this.attributes.delete(key); }
	contains(target: unknown): boolean { return target === this || this.children.some((child) => child.contains(target)); }
	closest(selector: string): HostElement | null {
		for (const part of selector.split(",").map((value) => value.trim())) {
			if (part.startsWith(".") && this.className.split(" ").includes(part.slice(1))) return this;
		}
		return this.parentElement?.closest(selector) ?? null;
	}
	emit(type: string, target: unknown = this, props: Record<string, unknown> = {}) {
		const event = new Event(type, { cancelable: true, bubbles: true });
		for (const [key, value] of Object.entries({ target, ...props })) Object.defineProperty(event, key, { value });
		this.dispatchEvent(event);
		return event;
	}
}

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
type Data = Record<string, any>;
const sessions: M1CanvasSession[] = [];
afterEach(() => { sessions.splice(0).forEach((session) => session.dispose()); vi.restoreAllMocks(); });

/**
 * A board of two overlapping cards and a frame, stacked the way native
 * Canvas stacks them: file order is layer order, and a node whose layer is
 * lower than the one before it is lifted as the board is imported.
 */
function fixture() {
	const root = new HostElement("canvas-wrapper");
	let counter = 0;
	const card = (id: string, x: number) => ({ id, type: "text", text: id, x, y: 0, width: 200, height: 120 });
	const initial: Data = {
		nodes: [{ id: "frame", type: "group", x: -50, y: -50, width: 600, height: 300 }, card("a", 0), card("b", 100)],
		edges: [],
		miroCanvas: { schemaVersion: 1, settings: {}, localOverrides: {} },
	};
	class NativeNode {
		nodeEl = root.appendChild(new HostElement("canvas-node"));
		zIndex = -1;
		renderedZIndex = -1;
		constructor(public data: Data) {}
		get id() { return this.data.id; }
		getData() { return clone(this.data); }
		setData(data: Data) { this.data = clone(data); }
		updateZIndex() {
			this.zIndex = this.data.type === "group" ? -(this.data.width * this.data.height) : ++counter;
			this.renderZIndex();
		}
		renderZIndex() { this.renderedZIndex = this.zIndex; }
	}
	const nodes = new Map<string, NativeNode>();
	const selection = new Set<NativeNode>();
	const history: Data[] = [];
	let index = -1;
	const canvas = {
		wrapperEl: root, nodes, edges: new Map(), selection,
		data: clone(initial), readonly: false,
		getData() {
			const ordered = [...nodes.values()].sort((left, right) => left.zIndex - right.zIndex);
			return { ...clone(this.data), nodes: ordered.map((node) => node.getData()) };
		},
		setViewport() {}, requestRender() {},
		selectOnly(node: NativeNode) { selection.clear(); selection.add(node); },
		select(node: NativeNode) { selection.add(node); },
		requestSave(addHistory: boolean) {
			this.data = this.getData();
			if (addHistory) { history.splice(index + 1); history.push(this.data); index++; }
		},
		importData(data: Data) {
			let previous = 0;
			for (const item of data.nodes) {
				let node = nodes.get(item.id);
				if (node === undefined) {
					node = new NativeNode(clone(item));
					nodes.set(item.id, node);
				} else {
					node.setData(item);
				}
				if (node.zIndex < previous) node.updateZIndex();
				previous = node.zIndex;
			}
			// A new card is lifted when it is first drawn.
			for (const node of nodes.values()) if (node.zIndex < 0 && node.data.type !== "group") node.updateZIndex();
		},
		undo() { if (index > 0) { this.importData(history[--index]); this.data = history[index]; } },
		// Native Canvas lifts every card it starts dragging above all the others.
		handleSelectionDrag() { for (const node of selection) node.updateZIndex(); return "dragging"; },
	};
	canvas.importData(clone(initial));
	canvas.requestSave(true);
	const view = { canvas };
	const store = createObsidianMetadataStore(view).store;
	expect(store).toBeDefined();
	const notices: string[] = [];
	const session = new M1CanvasSession(view, new MetadataWriter(store!), { onNotice: (message) => notices.push(message) });
	sessions.push(session);
	expect(session.mount()).toBe(true);
	const order = () => canvas.getData().nodes.map((node: Data) => node.id);
	return { canvas, session, nodes, selection, order, notices, history };
}

describe("M1 session layer order", () => {
	it("moves a card to the back as one history step", () => {
		const { canvas, session, nodes, selection, order, history } = fixture();
		expect(order()).toEqual(["frame", "a", "b"]);
		selection.add(nodes.get("b")!);
		session.refresh();
		const steps = history.length;
		session.changeLayer("back");
		expect(order()).toEqual(["frame", "b", "a"]);
		expect(history.length).toBe(steps + 1);
		canvas.undo();
		expect(order()).toEqual(["frame", "a", "b"]);
	});

	it("keeps a lone selected card on its own layer, as Miro does", () => {
		const { session, nodes, selection } = fixture();
		const card = nodes.get("a")!;
		selection.add(card);
		session.refresh();
		expect(card.nodeEl.classes.has("miro-canvas-layer-shown")).toBe(true);
		expect(card.nodeEl.properties.get("--miro-canvas-layer")).toBe(String(card.zIndex));
		// After a layer change the card is shown where it now lies.
		session.changeLayer("front");
		expect(card.nodeEl.properties.get("--miro-canvas-layer")).toBe(String(card.zIndex));
		// Two cards, or none, are left as native Canvas draws them.
		selection.add(nodes.get("b")!);
		session.refresh();
		expect(card.nodeEl.classes.has("miro-canvas-layer-shown")).toBe(false);
		selection.clear();
		selection.add(nodes.get("frame")!);
		session.refresh();
		expect(nodes.get("frame")!.nodeEl.classes.has("miro-canvas-layer-shown")).toBe(false);
	});

	it("offers no layer to a frame and says so", () => {
		const { session, nodes, selection, order, notices } = fixture();
		selection.add(nodes.get("frame")!);
		session.refresh();
		expect(session.layeredCards()).toEqual([]);
		session.changeLayer("front");
		expect(order()).toEqual(["frame", "a", "b"]);
		expect(notices).toContain("Only cards have layers: select a card.");
	});

	it("keeps every card on its layer while native Canvas starts a drag", () => {
		const { canvas, session, nodes, selection, order } = fixture();
		selection.add(nodes.get("a")!);
		session.refresh();
		const before = nodes.get("a")!.zIndex;
		expect(canvas.handleSelectionDrag()).toBe("dragging");
		expect(nodes.get("a")!.zIndex).toBe(before);
		expect(nodes.get("a")!.renderedZIndex).toBe(before);
		expect(order()).toEqual(["frame", "a", "b"]);
	});
});
