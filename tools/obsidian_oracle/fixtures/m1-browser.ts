import { M1CanvasSession } from "../../../plugins/miro-canvas/src/m1-session";
import { normalizeSettings } from "../../../plugins/miro-canvas/src/settings";
import { M2CanvasTools } from "../../../plugins/miro-canvas/src/m2-tools";
import { MetadataWriter } from "../../../plugins/miro-canvas/src/metadata-writer";
import { createObsidianMetadataStore } from "../../../plugins/miro-canvas/src/obsidian-metadata-store";
import type { LocalDocument } from "../../../plugins/miro-canvas/src/document-viewer";

// Browser DOM integration fixture, NOT a substitute for the real-Obsidian gate.
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const root = document.createElement("div");
root.className = "canvas-wrapper";
root.tabIndex = 0;
root.style.cssText = "position:relative;width:1500px;height:800px;background:#fafafa";
document.body.append(root);

// Native Canvas owns this menu and empties it while middle-button panning.
// The plugin adopts the actual element into its selection toolbar.
const nativeMenuContainer = document.createElement("div");
nativeMenuContainer.className = "canvas-menu-container";
const nativeMenu = nativeMenuContainer.appendChild(document.createElement("div"));
nativeMenu.className = "canvas-menu";
for (const label of ["Delete", "Zoom to selection", "Edit"]) {
  const button = nativeMenu.appendChild(document.createElement("button"));
  button.className = "clickable-icon";
  button.setAttribute("aria-label", label);
  button.textContent = label.slice(0, 1);
}
root.append(nativeMenuContainer);

type RuntimeElement = Record<string, unknown> & {
  getData: () => Record<string, unknown>;
  nodeEl?: HTMLElement;
  contentEl?: HTMLElement;
  labelEl?: HTMLElement;
  edgeEl?: HTMLElement;
};

const nodeData = {
  id: "n1", type: "text", text: "Canvas text with native DOM inheritance",
  x: 40, y: 100, width: 300, height: 200, unknownNode: { preserved: "n1" },
};
const fileData = {
  id: "file", type: "file", file: "attachments/Spec.pdf",
  x: 400, y: 100, width: 250, height: 200, unknownNode: { preserved: "file" },
};
const imageData = {
  id: "image", type: "file", file: "attachments/Diagram.png",
  x: 400, y: 350, width: 250, height: 200,
};
const edgeData = {
  id: "e1", fromNode: "n1", fromSide: "right", toNode: "file", toSide: "left",
  label: "Synthetic edge", unknownEdge: { preserved: true },
};
const initial = {
  nodes: [nodeData, fileData, imageData],
  edges: [edgeData],
  miroSource: {
    items: [
      { id: "n1", type: "text", geometry: { rotation: 0 }, style: { color: "#17365d", fontSize: "19" }, data: { content: "immutable" }, future: { keep: true } },
      { id: "file", type: "document", style: { opacity: "1" }, future: { keep: true } },
      { id: "image", type: "image", style: { borderColor: "#336699", borderWidth: "2" }, future: { keep: true } },
      { id: "e1", type: "connector", shape: "curved", style: { strokeColor: "#884422", strokeWidth: "3", endStrokeCap: "arrow" }, future: { keep: true } },
    ],
    zOrder: ["file", "n1", "image", "e1"],
    futureSource: { keep: true },
  },
  unknownRoot: { preserved: ["root", 2] },
};

const nodes = new Map<string, RuntimeElement>();
const edges = new Map<string, RuntimeElement>();
const selection = new Set<RuntimeElement>();

const finite = (value: unknown, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

function makeNode(data: Record<string, unknown>, previous?: RuntimeElement): RuntimeElement {
  const source = clone(data);
  const id = String(source.id ?? "");
  const nodeEl = previous?.nodeEl ?? document.createElement("div");
  nodeEl.className = "canvas-node";
  nodeEl.dataset.nodeId = id;
  nodeEl.style.position = "absolute";
  nodeEl.style.left = `${finite(source.x, 0)}px`;
  nodeEl.style.top = `${finite(source.y, 0)}px`;
  nodeEl.style.width = `${finite(source.width, 200)}px`;
  nodeEl.style.height = `${finite(source.height, 120)}px`;
  if (!nodeEl.isConnected) root.append(nodeEl);

  let contentEl = previous?.contentEl;
  let labelEl = previous?.labelEl;
  if (source.type === "file") {
    contentEl?.remove();
    contentEl = undefined;
    labelEl ??= document.createElement("div");
    labelEl.className = "canvas-node-label";
    labelEl.textContent = String(source.file ?? "").split(/[\\/]/u).pop() ?? "";
    if (!labelEl.isConnected) nodeEl.append(labelEl);
  } else {
    labelEl?.remove();
    labelEl = undefined;
    contentEl ??= document.createElement("div");
    contentEl.className = "canvas-node-content markdown-preview-view";
    contentEl.textContent = String(source.text ?? "");
    if (!contentEl.isConnected) nodeEl.append(contentEl);
  }

  const element = previous ?? ({} as RuntimeElement);
  Object.assign(element, source, {
    nodeEl,
    getData: () => ({
      ...clone(source),
      x: Number.parseFloat(nodeEl.style.left) || 0,
      y: Number.parseFloat(nodeEl.style.top) || 0,
      width: Number.parseFloat(nodeEl.style.width) || finite(source.width, 200),
      height: Number.parseFloat(nodeEl.style.height) || finite(source.height, 120),
    }),
  });
  if (contentEl) element.contentEl = contentEl; else delete element.contentEl;
  if (labelEl) element.labelEl = labelEl; else delete element.labelEl;
  return element;
}

function makeEdge(data: Record<string, unknown>, previous?: RuntimeElement): RuntimeElement {
  const source = clone(data);
  const id = String(source.id ?? "");
  const edgeEl = previous?.edgeEl ?? document.createElement("div");
  edgeEl.className = "canvas-edge";
  edgeEl.dataset.edgeId = id;
  if (!edgeEl.isConnected) root.append(edgeEl);
  let labelEl = previous?.labelEl;
  if (typeof source.label === "string" && source.label) {
    labelEl ??= document.createElement("div");
    labelEl.className = "canvas-edge-label";
    labelEl.textContent = source.label;
    if (!labelEl.isConnected) edgeEl.append(labelEl);
  } else { labelEl?.remove(); labelEl = undefined; }
  const element = previous ?? ({} as RuntimeElement);
  Object.assign(element, source, { edgeEl, getData: () => clone(source) });
  if (labelEl) element.labelEl = labelEl; else delete element.labelEl;
  return element;
}

const selectedIds = (): string[] => [...selection].map((value) => String(value.getData().id ?? ""));

function rebuildGraph(data: Record<string, unknown>, keepSelection = selectedIds()): void {
  const previousNodes = new Map(nodes);
  const previousEdges = new Map(edges);
  nodes.clear();
  edges.clear();
  for (const value of Array.isArray(data.nodes) ? data.nodes : []) {
    if (!value || typeof value !== "object") continue;
    const id = String((value as Record<string, unknown>).id ?? "");
    const node = makeNode(value as Record<string, unknown>, previousNodes.get(id));
    nodes.set(String(node.getData().id ?? ""), node);
    previousNodes.delete(id);
  }
  for (const value of Array.isArray(data.edges) ? data.edges : []) {
    if (!value || typeof value !== "object") continue;
    const id = String((value as Record<string, unknown>).id ?? "");
    const edge = makeEdge(value as Record<string, unknown>, previousEdges.get(id));
    edges.set(String(edge.getData().id ?? ""), edge);
    previousEdges.delete(id);
  }
  for (const value of previousNodes.values()) value.nodeEl?.remove();
  for (const value of previousEdges.values()) value.edgeEl?.remove();
  selection.clear();
  for (const id of keepSelection) {
    const selected = nodes.get(id) ?? edges.get(id);
    if (selected) selection.add(selected);
  }
}

rebuildGraph(initial as unknown as Record<string, unknown>, ["n1"]);
const history = [clone(initial) as unknown as Record<string, unknown>];
let historyIndex = 0;
let saves = 0;
const runtime = {
  wrapperEl: root, nodes, edges, selection,
  menu: { menuEl: nativeMenu, containerEl: nativeMenuContainer },
  data: clone(initial) as unknown as Record<string, unknown>, readonly: false,
  x: 0, y: 0, zoom: 0, tx: 0, ty: 0, tZoom: 0, scale: 1,
  setViewport(x: number, y: number, zoom: number) {
    this.x = this.tx = x; this.y = this.ty = y; this.zoom = this.tZoom = zoom; this.scale = 2 ** zoom;
  },
  markViewportChanged() {},
  getData() {
    return {
      ...clone(this.data),
      nodes: [...this.nodes.values()].map((node) => node.getData()),
      edges: [...this.edges.values()].map((edge) => edge.getData()),
    };
  },
  importData(value: Record<string, unknown>) {
    const next = clone(value);
    this.data = next;
    rebuildGraph(next);
  },
  requestSave(addHistory: boolean) {
    saves += 1;
    this.data = this.getData();
    if (addHistory) {
      history.splice(historyIndex + 1);
      history.push(clone(this.data));
      historyIndex += 1;
    }
  },
  setReadonly(value: boolean) { this.readonly = value; },
  select(node: RuntimeElement) { selection.add(node); },
  deselectAll() { selection.clear(); },
  deleteSelection() {
    const ids = new Set(selectedIds());
    const next = this.getData();
    next.nodes = next.nodes.filter(node => !ids.has(String(node.id)));
    next.edges = next.edges.filter(edge => !ids.has(String(edge.id)) && !ids.has(String(edge.fromNode)) && !ids.has(String(edge.toNode)));
    this.importData(next);
    this.requestSave(true);
  },
  undo() { if (historyIndex > 0) this.importData(history[--historyIndex]); },
  redo() { if (historyIndex + 1 < history.length) this.importData(history[++historyIndex]); },
};
const view = { canvas: runtime, getViewType: () => "canvas" };
const writer = new MetadataWriter(createObsidianMetadataStore(view).store!);
let systemClipboard = "";
const session = new M1CanvasSession(view, writer, { settings: normalizeSettings({ connectorAllowFree: true, connectorAttachConnectors: true }), desktopClipboard: {
  readText: () => systemClipboard,
  writeText: text => { systemClipboard = text; },
} });
const mounted = session.mount();

const openCalls: LocalDocument[] = [];
const documentHost = {
  hasFile: (path: string) => path === "attachments/Spec.pdf",
  openFile: (value: LocalDocument) => { openCalls.push(clone(value)); },
};
let m2: M2CanvasTools | undefined;
const select = (...ids: string[]) => {
  runtime.selection.clear();
  for (const id of ids) {
    const value = runtime.nodes.get(id) ?? runtime.edges.get(id);
    if (value) runtime.selection.add(value);
  }
  session.refresh();
  m2?.refresh();
};
const mountM2 = () => {
  if (m2) return true;
  select("file");
  m2 = new M2CanvasTools(session, documentHost, document);
  // Reserve the bottom dock's space; this development-only panel scrolls above it.
  m2.element.style.cssText = "position:absolute;right:0;top:0;z-index:100;width:720px;max-height:680px;overflow:auto;background:#fff;color:#24272f;--text-normal:#24272f;--text-muted:#505461;--background-primary:#fff;--background-secondary:#f2f4f8;--background-modifier-border:#bec4cf";
  root.append(m2.element);
  select("n1");
  return true;
};

const unknownsPreserved = () => {
  const current = runtime.getData() as Record<string, unknown> & {
    nodes?: Record<string, unknown>[];
    edges?: Record<string, unknown>[];
  };
  const currentNode = current.nodes?.find((value) => value.id === "n1");
  const currentFile = current.nodes?.find((value) => value.id === "file");
  const currentEdge = current.edges?.find((value) => value.id === "e1");
  return JSON.stringify(current.unknownRoot) === JSON.stringify(initial.unknownRoot)
    && JSON.stringify(currentNode?.unknownNode) === JSON.stringify(nodeData.unknownNode)
    && JSON.stringify(currentFile?.unknownNode) === JSON.stringify(fileData.unknownNode)
    && JSON.stringify(currentEdge?.unknownEdge) === JSON.stringify(edgeData.unknownEdge)
    && JSON.stringify(current.miroSource) === JSON.stringify(initial.miroSource);
};

const browser: Record<string, unknown> = {
  session, runtime, root, mounted, initial, select, openCalls, mountM2,
  getSaves: () => saves,
  getHistoryLength: () => history.length,
  getHistoryIndex: () => historyIndex,
  sourceUnchanged: () => JSON.stringify(runtime.data.miroSource) === JSON.stringify(initial.miroSource),
  unknownsPreserved,
  dispose: () => { m2?.dispose(); session.dispose(); },
  checkPreexistingReadonly: () => {
    runtime.readonly = true;
    const before = saves;
    const readonlySession = new M1CanvasSession(view, writer);
    readonlySession.mount();
    readonlySession.setTheme("light");
    readonlySession.dispose();
    return { preserved: runtime.readonly, saved: saves !== before };
  },
};
Object.defineProperties(browser, {
  m2: { get: () => m2 },
  node: { get: () => runtime.nodes.get("n1") },
  content: { get: () => runtime.nodes.get("n1")?.contentEl },
  fileNode: { get: () => runtime.nodes.get("file") },
  fileLabel: { get: () => runtime.nodes.get("file")?.labelEl },
  edge: { get: () => runtime.edges.get("e1") },
});
Object.assign(window, { miroBrowser: browser });
