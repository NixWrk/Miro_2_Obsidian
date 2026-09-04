import { M1CanvasSession } from "../../../plugins/miro-canvas/src/m1-session";
import { MetadataWriter } from "../../../plugins/miro-canvas/src/metadata-writer";
import { createObsidianMetadataStore } from "../../../plugins/miro-canvas/src/obsidian-metadata-store";

// Browser DOM integration fixture, NOT a substitute for the real-Obsidian gate.
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const root = document.createElement("div");
root.className = "canvas-wrapper";
root.style.cssText = "position:relative;width:1200px;height:800px;background:#fafafa";
document.body.append(root);
const nodeEl = document.createElement("div");
nodeEl.className = "canvas-node";
nodeEl.dataset.nodeId = "n1";
nodeEl.style.cssText = "position:absolute;left:40px;top:100px;width:300px;height:200px";
const content = document.createElement("div");
content.className = "canvas-node-content markdown-preview-view";
content.textContent = "Canvas text with native DOM inheritance";
nodeEl.append(content);
root.append(nodeEl);
const nodeData = { id: "n1", type: "text", text: content.textContent, x: 40, y: 100, width: 300, height: 200 };
const node = { ...nodeData, nodeEl, contentEl: content, getData: () => clone(nodeData) };
const fileEl = document.createElement("div");
fileEl.className = "canvas-node";
fileEl.dataset.nodeId = "file";
fileEl.style.cssText = "position:absolute;left:400px;top:100px;width:250px;height:200px";
const fileLabel = document.createElement("div");
fileLabel.className = "canvas-node-label";
fileLabel.textContent = "Spec.pdf";
fileEl.append(fileLabel);
root.append(fileEl);
const fileData = { id: "file", type: "file", file: "attachments/Spec.pdf", x: 400, y: 100, width: 250, height: 200 };
const fileNode = { ...fileData, nodeEl: fileEl, labelEl: fileLabel, getData: () => clone(fileData) };
const initial = { nodes: [nodeData, fileData], edges: [], miroSource: { items: [{ id: "n1", data: { content: "immutable" } }] } };
const history = [clone(initial) as Record<string, unknown>];
let historyIndex = 0;
let saves = 0;
const runtime = {
  wrapperEl: root, nodes: new Map<string, typeof node | typeof fileNode>([["n1", node], ["file", fileNode]]), edges: new Map(), selection: new Set([node]),
  data: clone(initial) as Record<string, unknown>, readonly: false,
  x: 0, y: 0, zoom: 0, tx: 0, ty: 0, tZoom: 0, scale: 1,
  setViewport(x: number, y: number, zoom: number) {
    this.x = this.tx = x; this.y = this.ty = y; this.zoom = this.tZoom = zoom; this.scale = 2 ** zoom;
  },
  markViewportChanged() {},
  getData() { return { ...this.data, nodes: [...this.nodes.values()].map((node) => node.getData()), edges: [] }; },
  requestSave(addHistory: boolean) {
    saves += 1;
    this.data = this.getData();
    if (addHistory) { history.splice(historyIndex + 1); history.push(clone(this.data)); historyIndex += 1; }
  },
  setReadonly(value: boolean) { this.readonly = value; },
  undo() { if (historyIndex > 0) this.data = clone(history[--historyIndex]); },
  redo() { if (historyIndex + 1 < history.length) this.data = clone(history[++historyIndex]); },
};
const view = { canvas: runtime, getViewType: () => "canvas" };
const writer = new MetadataWriter(createObsidianMetadataStore(view).store!);
const session = new M1CanvasSession(view, writer);
const mounted = session.mount();
Object.assign(window, { miroBrowser: {
  session, runtime, root, node, content, fileNode, fileLabel, mounted, initial, getSaves: () => saves,
  sourceUnchanged: () => JSON.stringify(runtime.data.miroSource) === JSON.stringify(initial.miroSource),
  dispose: () => session.dispose(),
  checkPreexistingReadonly: () => {
    runtime.readonly = true;
    const before = saves;
    const readonlySession = new M1CanvasSession(view, writer);
    readonlySession.mount();
    readonlySession.setTheme("light");
    readonlySession.dispose();
    return { preserved: runtime.readonly, saved: saves !== before };
  },
} });
