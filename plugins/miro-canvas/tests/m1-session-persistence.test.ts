import { afterEach, describe, expect, it, vi } from "vitest";
import { M1CanvasSession } from "../src/m1-session";
import { MetadataWriter } from "../src/metadata-writer";
import { createObsidianMetadataStore } from "../src/obsidian-metadata-store";

// Native Canvas rebuilds its document from its own model when it saves and
// keeps only the keys it owns.  This fixture reproduces exactly that, which is
// what makes every metadata write fail against a real Obsidian runtime.
vi.mock("../src/m1-controls", () => ({
	M1Controls: class {
		element = new HostElement("miro-canvas-panel");
		minimapElement = new HostElement();
		constructor(public actions: unknown) {}
		update() {}
		dispose() {}
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
	closest(): HostElement | null { return null; }
}

type Data = Record<string, any>;
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const sessions: M1CanvasSession[] = [];
afterEach(() => { sessions.splice(0).forEach((session) => session.dispose()); vi.restoreAllMocks(); });

function fixture(options: {
	readonly hostKeepsMiroCanvas?: boolean;
	readonly hostNormalizesNodes?: boolean;
	readonly hostEmitsUndefinedFields?: boolean;
	readonly foreignRootKey?: boolean;
} = {}) {
	const root = new HostElement("canvas-wrapper");
	const initial: Data = {
		nodes: [{ id: "n1", type: "text", text: "n1", x: 0, y: 0, width: 100, height: 80 }],
		edges: [],
		miroCanvas: { schemaVersion: 1, settings: {}, localOverrides: {} },
		miroSource: { items: [{ id: "n1" }] },
		...(options.foreignRootKey === true ? { advancedCanvas: { theirs: true } } : {}),
	};
	const canvas = {
		wrapperEl: root,
		nodes: new Map(), edges: new Map(), selection: new Set<unknown>(),
		data: clone(initial) as Data,
		readonly: false,
		historyRequests: [] as boolean[],
		/** Rebuilds from the model: unknown root keys are not carried over. */
		getData(): Data {
			const rebuilt: Data = { nodes: clone(this.data.nodes), edges: clone(this.data.edges) };
			// Some hosts also write their own defaults back into every node.
			if (options.hostNormalizesNodes === true) {
				rebuilt.nodes = rebuilt.nodes.map((node: Data) => ({ ...node, color: "" }));
			}
			// An absent optional field left as `undefined` is normal for a model
			// rebuild and is exactly what JSON serialization drops.
			if (options.hostEmitsUndefinedFields === true) {
				rebuilt.nodes = rebuilt.nodes.map((node: Data) => ({ ...node, color: undefined }));
			}
			if (options.hostKeepsMiroCanvas === true) rebuilt.miroCanvas = { schemaVersion: 1, hostOwned: true };
			return rebuilt;
		},
		setViewport() {}, requestRender() {},
		setReadonly(value: boolean) { this.readonly = value; },
		requestSave(addHistory: boolean) {
			this.historyRequests.push(addHistory);
			// The save path replaces the live root with the host's own rebuild.
			if (addHistory) this.data = this.getData();
		},
	};
	const runtimeNode = { id: "n1", data: clone(initial.nodes[0]), nodeEl: root };
	canvas.nodes.set("n1", runtimeNode);
	const view = { canvas };
	const probe = createObsidianMetadataStore(view);
	expect(probe.store).toBeDefined();
	const writer = new MetadataWriter(probe.store!);
	const session = new M1CanvasSession(view, writer);
	sessions.push(session);
	return { root, canvas, session, initial, runtimeNode, writer };
}

describe("M1 session document persistence", () => {
	it("carries the plugin's root keys across a native document rebuild", () => {
		const { canvas, session } = fixture();
		// Without the session the host drops both keys; that is the defect.
		expect(canvas.getData()).not.toHaveProperty("miroCanvas");
		expect(canvas.getData()).not.toHaveProperty("miroSource");

		expect(session.mount()).toBe(true);
		const rebuilt = canvas.getData();
		expect(rebuilt.miroCanvas).toEqual({ schemaVersion: 1, settings: {}, localOverrides: {} });
		expect(rebuilt.miroSource).toEqual({ items: [{ id: "n1" }] });
		expect(rebuilt.nodes).toHaveLength(1);
	});

	it("never overwrites a value the host produced itself", () => {
		const { canvas, session } = fixture({ hostKeepsMiroCanvas: true });
		session.mount();
		expect(canvas.getData().miroCanvas).toEqual({ schemaVersion: 1, hostOwned: true });
	});

	it("applies a metadata write against a host that rebuilds the document on save", () => {
		const { canvas, session } = fixture();
		session.mount();
		// The mutate callback receives and returns the miroCanvas metadata itself.
		const result = session.writeMetadata("set-display-theme", (draft) => ({
			...draft,
			schemaVersion: 1,
			settings: { displayTheme: "dark" },
		}));
		expect(result?.status).toBe("applied");
		expect(canvas.data.miroCanvas).toEqual({
			schemaVersion: 1, settings: { displayTheme: "dark" }, localOverrides: {},
		});
		// Source evidence must survive the host's rebuild untouched.
		expect(canvas.data.miroSource).toEqual({ items: [{ id: "n1" }] });
		expect(session.diagnostics.some((item) => item.includes("did not accept"))).toBe(false);
	});

	it("commits one rotation gesture through metadata and replays it without losing source fields", () => {
		const { canvas, session, runtimeNode, writer } = fixture();
		canvas.data.miroCanvas.localOverrides.n1 = { futureOverride: { keep: true } };
		canvas.data.miroCanvas.futureMetadata = ["keep"];
		session.mount();
		canvas.selection.add(runtimeNode);
		session.refresh();
		session.setElementRotation("n1", 37);

		expect(canvas.historyRequests).toEqual([true]);
		expect(canvas.data).toHaveProperty("miroCanvas.localOverrides.n1.rotation", 37);
		expect(canvas.data).toHaveProperty("miroCanvas.localOverrides.n1.futureOverride.keep", true);
		expect(canvas.data).toHaveProperty("miroCanvas.futureMetadata.0", "keep");
		expect(canvas.data.miroSource).toEqual({ items: [{ id: "n1" }] });

		expect(writer.undo().status).toBe("applied");
		expect(canvas.data.miroCanvas.localOverrides.n1).not.toHaveProperty("rotation");
		expect(writer.redo().status).toBe("applied");
		expect(canvas.data).toHaveProperty("miroCanvas.localOverrides.n1.rotation", 37);
	});

	it("accepts a host that also normalizes nodes, and says so instead of hiding it", () => {
		const { canvas, session } = fixture({ hostNormalizesNodes: true });
		session.mount();
		const result = session.writeMetadata("set-display-theme", (draft) => ({
			...draft,
			schemaVersion: 1,
			settings: { displayTheme: "dark" },
		}));
		expect(result?.status).toBe("applied");
		expect(canvas.data.miroCanvas).toHaveProperty("settings.displayTheme", "dark");
		expect(canvas.data.nodes[0]).toHaveProperty("color", "");
		expect(session.diagnostics.some((item) => item.includes("rebuilt"))).toBe(true);
	});

	it("applies a write when the host rebuild carries values JSON would drop", () => {
		const { canvas, session } = fixture({ hostEmitsUndefinedFields: true });
		session.mount();
		const result = session.writeMetadata("set-display-theme", (draft) => ({
			...draft,
			schemaVersion: 1,
			settings: { displayTheme: "dark" },
		}));
		expect(result?.status).toBe("applied");
		expect(canvas.data.miroCanvas).toHaveProperty("settings.displayTheme", "dark");
		expect(canvas.data.miroSource).toEqual({ items: [{ id: "n1" }] });
	});

	it("carries another plugin's root key across the rebuild but never the graph", () => {
		const { canvas, session } = fixture({ foreignRootKey: true });
		session.mount();
		const rebuilt = canvas.getData();
		expect(rebuilt.advancedCanvas).toEqual({ theirs: true });
		// The host owns nodes and edges; the hook must not restore its own copy.
		canvas.data.nodes = [];
		expect(canvas.getData().nodes).toEqual([]);
	});

	it("restores the host's own getData on dispose", () => {
		const { canvas, session } = fixture();
		const original = Object.getPrototypeOf(canvas) === Object.prototype ? canvas.getData : undefined;
		expect(original).toBeDefined();
		session.mount();
		expect(canvas.getData).not.toBe(original);
		session.dispose();
		expect(canvas.getData).toBe(original);
		expect(canvas.getData()).not.toHaveProperty("miroSource");
	});
});
