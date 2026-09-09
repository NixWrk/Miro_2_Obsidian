import { afterEach, describe, expect, it, vi } from "vitest";
import { M1CanvasSession } from "../src/m1-session";
import { MetadataWriter } from "../src/metadata-writer";
import { createObsidianMetadataStore } from "../src/obsidian-metadata-store";
import type { M1ControlsActions } from "../src/m1-controls";

// Only the presentation is replaced. Use the real adapter, policy, writer and
// native metadata store. EventTarget supplies cancellation/listener ordering;
// native callbacks below deliberately mutate without consulting the policy.
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
	style = {};
	clientWidth = 800;
	clientHeight = 600;
	classList = { add() {}, remove() {}, contains: () => false };
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
			if (part.startsWith("[") && this.hasAttribute(part.slice(1, -1))) return this;
			if (part.toUpperCase() === this.tagName) return this;
		}
		return this.parentElement?.closest(selector) ?? null;
	}
	emit(type: string, target: unknown = this, props: Record<string, unknown> = {}, cancelable = true) {
		const event = new Event(type, { cancelable, bubbles: true });
		for (const [key, value] of Object.entries({ target, ...props })) Object.defineProperty(event, key, { value });
		this.dispatchEvent(event);
		return event;
	}
}

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
type Data = Record<string, any>;
const sessions: M1CanvasSession[] = [];
afterEach(() => { sessions.splice(0).forEach((session) => session.dispose()); vi.restoreAllMocks(); });

function fixture() {
	const root = new HostElement("canvas-wrapper");
	const nodeData = (id: string) => ({ id, type: "text", text: id, x: 0, y: 0, width: 100, height: 80, futureNode: { keep: id } });
	const initial: Data = {
		nodes: [nodeData("locked"), nodeData("free")], edges: [],
		miroCanvas: { schemaVersion: 1, settings: {}, localOverrides: { locked: { locked: true, futureOverride: [1, 2] } }, futureMetadata: { keep: true } },
		miroSource: { items: [{ id: "locked", future: ["immutable"] }] }, futureRoot: { keep: true },
	};
	class NativeNode {
		nodeEl = root.appendChild(new HostElement("canvas-node"));
		editing = false;
		constructor(public data: Data) {}
		getData() { return clone(this.data); }
		moveTo(point: Data) { Object.assign(this.data, point); return "moved"; }
		moveAndResize(rect: Data) { Object.assign(this.data, rect); }
		resize(rect: Data) { Object.assign(this.data, rect); }
		setText(text: string) { this.data.text = text; }
		setColor(color: string) { this.data.color = color; }
		setData(data: Data) { this.data = clone(data); }
		startEditing() { this.editing = true; }
	}
	const nodes = new Map(initial.nodes.map((data: Data) => [data.id as string, new NativeNode(clone(data))])) as Map<string, NativeNode>;
	const selection = new Set<NativeNode>();
	const history: Data[] = [clone(initial)];
	let index = 0;
	const canvas = {
		wrapperEl: root, nodes, edges: new Map(), selection,
		data: clone(initial), readonly: false,
		getData() { return { ...clone(this.data), nodes: [...nodes.values()].map((node) => node.getData()) }; },
		setViewport() {}, requestRender() {},
		setReadonly(value: boolean) { this.readonly = value; },
		selectOnly(node: NativeNode) { selection.clear(); selection.add(node); },
		select(node: NativeNode) { selection.add(node); },
		removeNode(node: NativeNode) { nodes.delete(node.data.id); },
		removeSelection() { for (const node of selection) this.removeNode(node); },
		requestSave(addHistory: boolean) {
			if (addHistory) { history.splice(index + 1); history.push(this.getData()); index++; }
		},
		importData(data: Data) {
			this.data = clone(data);
			for (const item of data.nodes) {
				const existing = nodes.get(item.id);
				if (existing) existing.setData(item);
				else nodes.set(item.id, new NativeNode(clone(item)));
			}
			for (const node of nodes.values()) if (!data.nodes.some((item: Data) => item.id === node.data.id)) this.removeNode(node);
		},
		undo() { if (index > 0) this.importData(history[--index]); },
		redo() { if (index + 1 < history.length) this.importData(history[++index]); },
	};
	const view = { canvas };
	const store = createObsidianMetadataStore(view).store;
	expect(store).toBeDefined();
	const session = new M1CanvasSession(view, new MetadataWriter(store!));
	sessions.push(session);
	expect(session.mount()).toBe(true);
	const locked = nodes.get("locked")!;
	const free = nodes.get("free")!;
	const actions = (session.controls as unknown as { actions: M1ControlsActions }).actions;
	return { root, canvas, session, locked, free, selection, initial, history, actions };
}

describe("M1 session lock enforcement", () => {
	it.each(["pointerdown", "mousedown"])("blocks %s before native drag/resize initialization and permits selection for unlock", (type) => {
		const { root, canvas, locked, session } = fixture();
		const resizeHandle = locked.nodeEl.appendChild(new HostElement("canvas-node-resizer"));
		const native = vi.fn(() => { locked.data.x = 400; locked.data.width = 900; });
		root.addEventListener(type, native);
		expect(root.emit(type, resizeHandle, { button: 0, buttons: 1 }).defaultPrevented).toBe(true);
		expect(native).not.toHaveBeenCalled();
		expect(canvas.selection.has(locked)).toBe(true);
		session.unlockSelection();
		expect(root.emit(type, resizeHandle, { button: 0, buttons: 1 }).defaultPrevented).toBe(false);
		expect(native).toHaveBeenCalledTimes(1);
	});

	it("keeps the blocked drag origin when pointermove leaves the node and selection changes", () => {
		const { root, locked, selection } = fixture();
		root.emit("pointerdown", locked.nodeEl, { button: 0, buttons: 1 });
		selection.clear();
		const native = vi.fn(() => { locked.data.x = 99; });
		root.addEventListener("pointermove", native);
		expect(root.emit("pointermove", root, { buttons: 1 }).defaultPrevented).toBe(true);
		expect(native).not.toHaveBeenCalled();
		root.emit("pointercancel");
		expect(root.emit("pointermove", root, { buttons: 1 }).defaultPrevented).toBe(false);
	});

	it("blocks double click in native content without relying on data-id decoration", () => {
		const { root, locked } = fixture();
		const content = locked.nodeEl.appendChild(new HostElement());
		const native = vi.fn(() => { locked.editing = true; });
		root.addEventListener("dblclick", native);
		expect(root.emit("dblclick", content).defaultPrevented).toBe(true);
		expect(native).not.toHaveBeenCalled();
		expect(locked.editing).toBe(false);
	});

	it.each(["insertFromPaste", "insertCompositionText", "insertReplacementText", "deleteByCut", "formatFontColor", "futureInput", undefined])("blocks beforeinput %s and noncancelable input from an already focused editor", (inputType) => {
		const { root, locked, selection } = fixture();
		const editor = locked.nodeEl.appendChild(new HostElement("", "TEXTAREA"));
		selection.clear();
		const native = vi.fn(() => { locked.data.text = "bypassed"; });
		root.addEventListener("beforeinput", native);
		root.addEventListener("input", native);
		expect(root.emit("beforeinput", editor, { inputType }).defaultPrevented).toBe(true);
		root.emit("input", editor, { inputType }, false);
		expect(native).not.toHaveBeenCalled();
		expect(locked.data.text).toBe("locked");
	});

	it.each(["Delete", "Backspace", "ArrowRight", "Enter"])("checks live mixed selection on %s even when the target is unlocked", (key) => {
		const { root, free, locked, selection } = fixture();
		selection.add(free); selection.add(locked); // No polling/refresh.
		const native = vi.fn();
		root.addEventListener("keydown", native);
		expect(root.emit("keydown", free.nodeEl, { key }).defaultPrevented).toBe(true);
		expect(native).not.toHaveBeenCalled();
	});

	it("blocks a selection resize and group drag initiated on its free member", () => {
		const { root, free, locked, selection } = fixture();
		selection.add(free); selection.add(locked);
		const handle = root.appendChild(new HostElement("canvas-selection"));
		expect(root.emit("pointerdown", handle, { button: 0 }).defaultPrevented).toBe(true);
		expect(root.emit("pointerdown", free.nodeEl, { button: 0 }).defaultPrevented).toBe(true);
	});

	it("guards native mutations invoked outside the Canvas DOM", () => {
		const { locked, free, canvas, initial, selection } = fixture();
		locked.moveTo({ x: 100 }); locked.moveAndResize({ width: 999 }); locked.resize({ height: 999 });
		locked.setText("changed"); locked.setColor("red"); locked.startEditing();
		locked.setData({ ...locked.getData(), futureNode: "lost" });
		canvas.removeNode(locked);
		selection.add(locked); canvas.removeSelection();
		expect(locked.getData()).toEqual(initial.nodes[0]);
		expect(locked.editing).toBe(false);
		expect(canvas.nodes.has("locked")).toBe(true);
		expect(free.moveTo({ x: 5 })).toBe("moved");
		expect(free.data.x).toBe(5);
	});

	it("uses current policy and selection for property controls and allows explicit unlock", () => {
		const { locked, free, selection, actions, canvas, session, root } = fixture();
		selection.add(free); session.refresh();
		selection.add(locked);
		actions.onAppearance({ type: "set-font-size", fontSize: 30 });
		expect(canvas.data.miroCanvas.localOverrides.free).toBeUndefined();
		const input = new HostElement("", "INPUT");
		root.appendChild(input);
		expect(root.emit("change", input).defaultPrevented).toBe(true);
		session.unlockSelection();
		expect(canvas.data.miroCanvas.localOverrides.locked.locked).toBe(false);
		locked.setText("unlocked");
		expect(locked.data.text).toBe("unlocked");
	});

	it("preserves source/unknown fields and lets native undo/redo restore locked nodes", () => {
		const { root, canvas, session, locked, selection, initial, history } = fixture();
		selection.add(locked);
		session.unlockSelection();
		locked.moveTo({ x: 50 }); locked.setText("after"); canvas.requestSave(true);
		session.lockSelection();
		expect(history).toHaveLength(4);
		canvas.undo(); // Undo lock, without a session refresh.
		canvas.undo(); // Undo the edit.
		expect(locked.data).toEqual(initial.nodes[0]);
		canvas.undo(); // Undo unlock.
		locked.setText("blocked again");
		expect(locked.data.text).toBe("locked");
		canvas.redo(); canvas.redo(); canvas.redo();
		expect(locked.data).toMatchObject({ text: "after", x: 50 });
		locked.moveTo({ x: 600 });
		expect(locked.data.x).toBe(50);
		for (const snapshot of history) {
			expect(snapshot.miroSource).toEqual(initial.miroSource);
			expect(snapshot.futureRoot).toEqual(initial.futureRoot);
			expect(snapshot.miroCanvas.futureMetadata).toEqual(initial.miroCanvas.futureMetadata);
			expect(snapshot.miroCanvas.localOverrides.locked.futureOverride).toEqual([1, 2]);
		}
		for (const [key, shiftKey] of [["z", false], ["z", true], ["y", false]] as const) {
			expect(root.emit("keydown", root, { key, ctrlKey: true, shiftKey }).defaultPrevented).toBe(false);
		}
		for (const inputType of ["historyUndo", "historyRedo"]) expect(root.emit("beforeinput", root, { inputType }).defaultPrevented).toBe(false);
	});

	it.each([null, { schemaVersion: 999 }, { schemaVersion: 1, localOverrides: { locked: { locked: "yes" } } }])("fails closed for malformed or unsupported metadata %j", (metadata) => {
		const { canvas, root, free } = fixture();
		canvas.data.miroCanvas = metadata;
		expect(root.emit("pointerdown", free.nodeEl, { button: 0 }).defaultPrevented).toBe(true);
		free.setText("changed");
		expect(free.data.text).toBe("free");
	});

	it("fails closed for an unreadable or unidentifiable selection", () => {
		const { canvas, root, free } = fixture();
		(canvas.selection as Set<unknown>).add({});
		expect(root.emit("dblclick", free.nodeEl).defaultPrevented).toBe(true);
		Object.defineProperty(canvas, "selection", { get: () => { throw new Error("unavailable"); } });
		free.moveTo({ x: 4 });
		expect(free.data.x).toBe(0);
	});

	it("allows blank pan, middle/space pan, copy and plugin controls while locked", () => {
		const { root, locked, selection, session } = fixture();
		selection.add(locked);
		expect(root.emit("pointerdown", root, { button: 0 }).defaultPrevented).toBe(false);
		expect(root.emit("pointerdown", locked.nodeEl, { button: 1 }).defaultPrevented).toBe(false);
		root.emit("keydown", root, { key: " " });
		expect(root.emit("pointerdown", locked.nodeEl, { button: 0 }).defaultPrevented).toBe(false);
		root.emit("keyup", root, { key: " " });
		expect(root.emit("keydown", locked.nodeEl, { key: "c", ctrlKey: true }).defaultPrevented).toBe(false);
		expect(root.emit("pointerdown", session.controls.element, { button: 0 }).defaultPrevented).toBe(false);
	});

	it("restores instance hooks/listeners on dispose without overwriting a later plugin hook", () => {
		const { root, locked, free, session } = fixture();
		const laterHook = vi.fn();
		free.setText = laterHook;
		session.dispose();
		expect(Object.prototype.hasOwnProperty.call(locked, "setText")).toBe(false);
		expect(free.setText).toBe(laterHook);
		locked.setText("released");
		expect(locked.data.text).toBe("released");
		expect(root.emit("pointerdown", locked.nodeEl, { button: 0 }).defaultPrevented).toBe(false);
	});
});
