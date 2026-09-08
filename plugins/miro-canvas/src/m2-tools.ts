import type { M1CanvasSession } from "./m1-session";
import { CommentsPanel } from "./comments-panel";
import { addAnchor, normalizeAnchor, resolveAnchor, type CanvasAnchor } from "./anchors";
import {
  addLocalComment, editLocalComment, deleteLocalComment, addReply, setCommentResolved,
  listCommentThreads, type CommentMutationResult, type CommentScope, type CommentThread,
} from "./local-comments";
import { readCanvasElementFile, readCanvasElementId, readCanvasElementType } from "./canvas-elements";
import { createCanvasAuthoring, type CanvasAuthoring } from "./canvas-authoring";
import { buildCanvasAnchorGeometry } from "./connector-endpoints";
import { DocumentControls } from "./document-controls";
import type { DocumentHost } from "./document-viewer";

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "avif"]);
const SHAPE_OPTIONS = [
  ["rectangle", "Rectangle"],
  ["round_rectangle", "Rounded rectangle"],
  ["ellipse", "Ellipse"],
  ["triangle", "Triangle"],
  ["diamond", "Diamond"],
  ["star", "Star"],
] as const;

type AnchorPickKind = "free" | "selection" | "node" | "image" | "edge";

interface SelectOption {
  readonly value: string;
  readonly label: string;
}

function isImageCanvasNode(node: unknown): boolean {
  const file = readCanvasElementFile(node);
  if (!file) return false;
  const name = file.split(/[\\/]/u).pop() ?? "";
  const dot = name.lastIndexOf(".");
  return dot >= 0 && IMAGE_EXTENSIONS.has(name.slice(dot + 1).toLowerCase());
}

function basename(path: string): string {
  return path.split(/[\\/]/u).pop() ?? path;
}

function humanizeToken(value: string): string {
  const spaced = value.replace(/[_-]+/gu, " ").trim();
  return spaced.length > 0 ? `${spaced[0]!.toUpperCase()}${spaced.slice(1)}` : "Node";
}

function elementLabel(element: unknown, edge: boolean): string | undefined {
  const id = readCanvasElementId(element);
  if (id === undefined) return undefined;
  if (edge) return `Connector — ${id}`;
  const file = readCanvasElementFile(element);
  if (file !== undefined) {
    return `${isImageCanvasNode(element) ? "Image" : "File"}: ${basename(file)} — ${id}`;
  }
  const type = readCanvasElementType(element);
  return `${humanizeToken(type ?? "node")} — ${id}`;
}

function appendLabeled<T extends HTMLInputElement | HTMLSelectElement>(
  document: Document,
  parent: HTMLElement,
  label: string,
  control: T,
): T {
  const wrapper = document.createElement("label");
  wrapper.className = "miro-canvas-m2-tools__field";
  const text = document.createElement("span");
  text.textContent = label;
  control.setAttribute("aria-label", label);
  wrapper.append(text, control);
  parent.append(wrapper);
  return control;
}

/** M2 UI wiring. Graph writes use CanvasAuthoring; local metadata uses the M1 writer. */
export class M2CanvasTools {
  readonly element: HTMLElement;
  private readonly comments: CommentsPanel;
  private readonly status: HTMLElement;
  private readonly x: HTMLInputElement;
  private readonly y: HTMLInputElement;
  private readonly anchorTarget: HTMLSelectElement;
  private readonly authoring: CanvasAuthoring;
  private readonly connectorEdge: HTMLSelectElement;
  private readonly connectorEnd: HTMLSelectElement;
  private anchorKind: AnchorPickKind | undefined;
  private scope: CommentScope = "board";
  private documents: DocumentControls | undefined;
  private pollTimer: number | undefined;
  private anchorOptionsKey = "";
  private connectorOptionsKey = "";
  private disposed = false;

  constructor(
    private readonly session: M1CanvasSession,
    documentHost: DocumentHost,
    private readonly document: Document,
  ) {
    session.refresh();
    this.authoring = createCanvasAuthoring(session.view);
    this.element = document.createElement("div");
    this.element.className = "miro-canvas-m2-tools";
    this.status = document.createElement("p");
    this.status.className = "miro-canvas-m2-tools__status";
    this.status.setAttribute("role", "status");
    this.element.append(this.status);

    const shapeFields = document.createElement("fieldset");
    shapeFields.className = "miro-canvas-m2-tools__section miro-canvas-m2-tools__section--shape";
    const shapeLegend = document.createElement("legend");
    shapeLegend.textContent = "Create shape";
    shapeFields.append(shapeLegend);
    const shapeGrid = document.createElement("div");
    shapeGrid.className = "miro-canvas-m2-tools__grid";
    shapeFields.append(shapeGrid);
    const shape = appendLabeled(document, shapeGrid, "Shape kind", document.createElement("select"));
    for (const [value, label] of SHAPE_OPTIONS) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = label;
      shape.append(option);
    }
    const shapeText = appendLabeled(document, shapeGrid, "Shape text", document.createElement("input"));
    shapeText.type = "text";
    shapeText.value = "Shape";
    const shapeNumber = (label: string, value: string) => {
      const input = document.createElement("input");
      input.type = "number";
      input.step = "any";
      input.value = value;
      return appendLabeled(document, shapeGrid, label, input);
    };
    const shapeX = shapeNumber("Shape X", "100");
    const shapeY = shapeNumber("Shape Y", "100");
    const shapeWidth = shapeNumber("Shape width", "240");
    const shapeHeight = shapeNumber("Shape height", "140");
    const createShape = document.createElement("button");
    createShape.type = "button";
    createShape.textContent = "Create shape";
    createShape.className = "miro-canvas-m2-tools__primary-action";
    createShape.addEventListener("click", () => {
      const readNumber = (input: HTMLInputElement, label: string, positive = false): number | undefined => {
        const raw = input.value.trim();
        if (raw.length === 0) {
          this.status.textContent = `${label} is required.`;
          return undefined;
        }
        const value = Number(raw);
        if (!Number.isFinite(value)) {
          this.status.textContent = `${label} must be a finite number.`;
          return undefined;
        }
        if (positive && value <= 0) {
          this.status.textContent = `${label} must be greater than zero.`;
          return undefined;
        }
        return value;
      };
      const x = readNumber(shapeX, "Shape X");
      const y = readNumber(shapeY, "Shape Y");
      const width = readNumber(shapeWidth, "Shape width", true);
      const height = readNumber(shapeHeight, "Shape height", true);
      if (x === undefined || y === undefined || width === undefined || height === undefined) return;
      const result = this.authoring.createShape({
        shape: shape.value,
        text: shapeText.value,
        x,
        y,
        width,
        height,
      });
      this.status.textContent = result.ok ? `Created shape ${result.nodeId ?? ""}.`
        : result.diagnostics[0]?.message ?? "Shape creation was rejected.";
      this.refreshFromNative();
    });
    shapeFields.append(createShape);
    this.element.append(shapeFields);

    const anchorFields = document.createElement("fieldset");
    anchorFields.className = "miro-canvas-m2-tools__section miro-canvas-m2-tools__section--anchor";
    const legend = document.createElement("legend");
    legend.textContent = "Anchor coordinates (board X/Y or relative U/V, edge T)";
    anchorFields.append(legend);
    const anchorGrid = document.createElement("div");
    anchorGrid.className = "miro-canvas-m2-tools__grid";
    anchorFields.append(anchorGrid);
    const number = (name: string) => {
      const input = document.createElement("input");
      input.type = "number";
      input.step = "any";
      input.value = "0.5";
      return appendLabeled(document, anchorGrid, name, input);
    };
    this.x = number("Anchor X, U or T");
    this.y = number("Anchor Y or V");
    this.anchorTarget = appendLabeled(document, anchorGrid, "Anchor target", document.createElement("select"));
    const save = document.createElement("button");
    save.textContent = "Save anchor";
    save.type = "button";
    save.className = "miro-canvas-m2-tools__primary-action";
    save.addEventListener("click", () => {
      if (this.anchorKind === undefined) { this.status.textContent = "Choose an anchor type below first."; return; }
      const current = this.currentAnchor(true);
      if (!current.ok || current.anchor === undefined) return;
      this.mutate("add-anchor", (draft) => addAnchor(draft, current.anchor!));
    });
    anchorFields.append(save);
    this.element.append(anchorFields);

    const connectorFields = document.createElement("fieldset");
    connectorFields.className = "miro-canvas-m2-tools__section miro-canvas-m2-tools__section--connector";
    const connectorLegend = document.createElement("legend");
    connectorLegend.textContent = "Connector endpoint";
    connectorFields.append(connectorLegend);
    const connectorGrid = document.createElement("div");
    connectorGrid.className = "miro-canvas-m2-tools__grid";
    connectorFields.append(connectorGrid);
    this.connectorEdge = appendLabeled(document, connectorGrid, "Connector", document.createElement("select"));
    this.connectorEnd = appendLabeled(document, connectorGrid, "Connector end", document.createElement("select"));
    for (const [value, label] of [["from", "From"], ["to", "To"]] as const) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = label;
      this.connectorEnd.append(option);
    }
    const setEndpoint = document.createElement("button");
    setEndpoint.type = "button";
    setEndpoint.textContent = "Set connector endpoint";
    setEndpoint.className = "miro-canvas-m2-tools__primary-action";
    setEndpoint.addEventListener("click", () => {
      if (this.anchorKind === undefined) { this.status.textContent = "Choose an anchor before editing a connector endpoint."; return; }
      if (this.connectorEdge.value.length === 0) { this.status.textContent = "Choose a connector to edit."; return; }
      const current = this.currentAnchor(true);
      if (!current.ok || current.anchor === undefined) return;
      const result = this.authoring.updateConnectorEndpoint({
        edgeId: this.connectorEdge.value,
        end: this.connectorEnd.value === "to" ? "to" : "from",
        anchor: current.anchor,
      });
      this.status.textContent = result.ok ? "Connector endpoint saved in native Canvas history."
        : result.diagnostics[0]?.message ?? "Connector endpoint edit was rejected.";
      this.refreshFromNative();
    });
    connectorFields.append(setEndpoint);
    this.element.append(connectorFields);

    const geometryFields = document.createElement("fieldset");
    geometryFields.className = "miro-canvas-m2-tools__section miro-canvas-m2-tools__section--geometry";
    const geometryLegend = document.createElement("legend");
    geometryLegend.textContent = "Rotation and layer order";
    geometryFields.append(geometryLegend);
    const geometryGrid = document.createElement("div");
    geometryGrid.className = "miro-canvas-m2-tools__grid";
    geometryFields.append(geometryGrid);
    const geometryActions = document.createElement("div");
    geometryActions.className = "miro-canvas-m2-tools__actions";
    const rotation = document.createElement("input");
    rotation.type = "number";
    rotation.step = "any";
    rotation.value = "0";
    appendLabeled(document, geometryGrid, "Rotation degrees", rotation);
    const applyRotation = document.createElement("button");
    applyRotation.type = "button";
    applyRotation.textContent = "Apply rotation";
    applyRotation.addEventListener("click", () => {
      const id = this.session.snapshot.selectedIds[0];
      const value = rotation.value.trim().length > 0 ? Number(rotation.value) : Number.NaN;
      if (id === undefined) { this.status.textContent = "Select one Canvas element to rotate."; return; }
      if (!Number.isFinite(value)) { this.status.textContent = "Rotation must be a finite number."; return; }
      const result = this.authoring.updateRotation({ id, rotation: value });
      this.status.textContent = result.ok ? "Rotation saved in native Canvas history."
        : result.diagnostics[0]?.message ?? "Rotation was rejected.";
      this.refreshFromNative();
    });
    geometryActions.append(applyRotation);
    const layerActions = [
      ["back", "Send to back"], ["backward", "Move backward"],
      ["forward", "Move forward"], ["front", "Bring to front"],
    ] as const;
    for (const [direction, label] of layerActions) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = label;
      button.addEventListener("click", () => {
        const id = this.session.snapshot.selectedIds[0];
        if (id === undefined) { this.status.textContent = "Select one Canvas element to reorder."; return; }
        const result = this.authoring.changeZOrder({ id, direction });
        this.status.textContent = result.ok ? "Layer order saved in native Canvas history."
          : result.diagnostics[0]?.message ?? "Layer order change was rejected.";
        this.refreshFromNative();
      });
      geometryActions.append(button);
    }
    geometryFields.append(geometryActions);
    this.element.append(geometryFields);

    this.comments = new CommentsPanel({
      onAddComment: (text) => {
        const current = this.currentAnchor(true);
        if (!current.ok) return;
        this.mutate("add-comment", (draft) => addLocalComment(draft, { text, ...(current.anchor ? { anchor: current.anchor } : {}) }));
      },
      onEditComment: (id, text) => this.mutate("edit-comment", (draft) => editLocalComment(draft, id, text)),
      onDeleteComment: (id) => this.mutate("delete-comment", (draft) => deleteLocalComment(draft, id)),
      onReplyComment: (id, text) => this.mutate("reply-comment", (draft) => addReply(draft, id, text)),
      onResolveComment: (id, resolved) => this.mutate("resolve-comment", (draft) => setCommentResolved(draft, id, resolved)),
      onFilterChange: (scope) => { this.scope = scope; this.refresh(); },
      onPickAnchor: (kind) => this.pickAnchor(kind),
      onSelectTarget: (thread) => this.focusComment(thread),
    }, { document, className: "miro-canvas-comments-panel miro-canvas-m2-tools__comments" });
    this.element.append(this.comments.element);
    const selection = new Set(session.snapshot.selectedIds);
    const fileNode = session.adapter.getNodes()?.find((node) => selection.has(readCanvasElementId(node) ?? "") && readCanvasElementFile(node));
    const file = readCanvasElementFile(fileNode);
    if (file) {
      this.documents = new DocumentControls(documentHost, file, document);
      this.element.append(this.documents.element);
    } else {
      const hint = document.createElement("p");
      hint.className = "miro-canvas-m2-tools__document-hint";
      hint.textContent = "Select a file node before opening these tools to view a local document.";
      this.element.append(hint);
    }
    this.refresh();
    const window = document.defaultView;
    if (window) this.pollTimer = window.setInterval(() => this.refreshFromNative(), 250);
  }

  private mutate(action: string, transform: (draft: Record<string, unknown>) => Pick<CommentMutationResult, "ok" | "metadata"> & { diagnostics: readonly { message: string }[] }): void {
    const result = this.session.writeMetadata(action, (draft) => {
      const mutation = transform(draft);
      if (!mutation.ok || !mutation.metadata) throw new Error(mutation.diagnostics[0]?.message ?? "Local action rejected.");
      return mutation.metadata;
    });
    this.status.textContent = result?.status === "applied" ? "Saved locally in this Canvas."
      : result?.status === "noop" ? "No changes." : result?.diagnostics[0]?.message ?? "Metadata writer unavailable.";
    this.refresh();
  }

  private numericAnchorValue(input: HTMLInputElement, label: string, report: boolean): number | undefined {
    const raw = input.value.trim();
    const value = raw.length > 0 ? Number(raw) : Number.NaN;
    if (Number.isFinite(value)) return value;
    if (report) this.status.textContent = `${label} must be a finite number.`;
    return undefined;
  }

  private currentAnchor(report: boolean): { readonly ok: boolean; readonly anchor?: CanvasAnchor } {
    if (this.anchorKind === undefined) return { ok: true };
    const x = this.numericAnchorValue(this.x, "Anchor X, U or T", report);
    const y = this.numericAnchorValue(this.y, "Anchor Y or V", report);
    if (x === undefined || y === undefined) return { ok: false };

    let anchor: CanvasAnchor;
    if (this.anchorKind === "free") {
      anchor = { type: "free", x, y };
    } else {
      const id = this.anchorTarget.value;
      if (id.length === 0) {
        if (report) this.status.textContent = "Choose an anchor target.";
        return { ok: false };
      }
      const edges = this.session.adapter.getEdges() ?? [];
      const edge = edges.find((candidate) => readCanvasElementId(candidate) === id);
      const nodes = this.session.adapter.getNodes() ?? [];
      const node = nodes.find((candidate) => readCanvasElementId(candidate) === id);
      const kind = this.anchorKind === "selection"
        ? edge !== undefined ? "edge" : isImageCanvasNode(node) ? "image" : "node"
        : this.anchorKind;
      if (kind === "edge") {
        if (edge === undefined) {
          if (report) this.status.textContent = "The selected anchor target is not a connector.";
          return { ok: false };
        }
        anchor = { type: "edge", edgeId: id, t: x };
      } else {
        if (node === undefined) {
          if (report) this.status.textContent = "The selected anchor target is not a node.";
          return { ok: false };
        }
        if (kind === "image" && !isImageCanvasNode(node)) {
          if (report) this.status.textContent = "Selected file is not a supported image.";
          return { ok: false };
        }
        anchor = { type: kind === "image" ? "image" : "node", nodeId: id, u: x, v: y };
      }
    }
    const normalized = normalizeAnchor(anchor);
    if (!normalized.valid || normalized.anchor === undefined) {
      if (report) this.status.textContent = normalized.diagnostics[0]?.message ?? "Invalid anchor.";
      return { ok: false };
    }
    return { ok: true, anchor: normalized.anchor };
  }

  private pickAnchor(kind: AnchorPickKind): void {
    if (kind !== "free") {
      const selectedId = this.session.snapshot.selectedIds[0];
      if (selectedId !== undefined && Array.from(this.anchorTarget.options).some((option) => option.value === selectedId)) {
        this.anchorTarget.value = selectedId;
      }
    }
    const previous = this.anchorKind;
    this.anchorKind = kind;
    const current = this.currentAnchor(true);
    if (!current.ok || current.anchor === undefined) {
      this.anchorKind = previous;
      return;
    }
    this.status.textContent = "Anchor selected. Add a comment, save it, or use it for a connector endpoint.";
    this.refresh();
  }

  private focusComment(thread: CommentThread): void {
    if (!thread.anchor) return;
    const root = this.session.adapter.getDocument();
    const geometry = buildCanvasAnchorGeometry(root && typeof root === "object" ? root as Record<string, unknown> : {});
    const resolved = resolveAnchor(thread.anchor, geometry);
    const viewport = this.session.viewport.getViewport();
    if (!resolved.point || !viewport) {
      this.status.textContent = resolved.diagnostics[0]?.message ?? "Target geometry is unavailable.";
      return;
    }
    this.session.viewport.setViewport({ ...viewport, x: resolved.point.x, y: resolved.point.y });
    this.refreshFromNative();
  }

  private refreshFromNative(): void {
    if (this.disposed) return;
    this.session.refresh();
    this.refresh();
  }

  private syncSelect(select: HTMLSelectElement, options: readonly SelectOption[], selectedId: string | undefined, key: "anchor" | "connector"): void {
    const nextKey = JSON.stringify(options.map((option) => [option.value, option.label]));
    const currentKey = key === "anchor" ? this.anchorOptionsKey : this.connectorOptionsKey;
    const currentValue = select.value;
    if (nextKey !== currentKey) {
      select.textContent = "";
      const empty = this.document.createElement("option");
      empty.value = "";
      empty.textContent = options.length > 0 ? "Choose…" : "No targets available";
      select.append(empty);
      for (const item of options) {
        const option = this.document.createElement("option");
        option.value = item.value;
        option.textContent = item.label;
        select.append(option);
      }
      if (key === "anchor") this.anchorOptionsKey = nextKey;
      else this.connectorOptionsKey = nextKey;
    }
    const values = new Set(options.map((option) => option.value));
    if (values.has(currentValue)) select.value = currentValue;
    else if (selectedId !== undefined && values.has(selectedId)) select.value = selectedId;
    else select.value = "";
  }

  private refreshTargetSelectors(): void {
    const nodes = this.session.adapter.getNodes() ?? [];
    const edges = this.session.adapter.getEdges() ?? [];
    const anchorOptions: SelectOption[] = [];
    const seen = new Set<string>();
    for (const node of nodes) {
      const id = readCanvasElementId(node);
      const label = elementLabel(node, false);
      if (id !== undefined && label !== undefined && !seen.has(id)) {
        seen.add(id);
        anchorOptions.push({ value: id, label });
      }
    }
    const connectorOptions: SelectOption[] = [];
    for (const edge of edges) {
      const id = readCanvasElementId(edge);
      const label = elementLabel(edge, true);
      if (id === undefined || label === undefined) continue;
      connectorOptions.push({ value: id, label });
      if (!seen.has(id)) {
        seen.add(id);
        anchorOptions.push({ value: id, label });
      }
    }
    const selectedId = this.session.snapshot.selectedIds[0];
    const selectedEdgeId = selectedId !== undefined && connectorOptions.some((option) => option.value === selectedId)
      ? selectedId : undefined;
    this.syncSelect(this.anchorTarget, anchorOptions, selectedId, "anchor");
    this.syncSelect(this.connectorEdge, connectorOptions, selectedEdgeId, "connector");
  }

  refresh(): void {
    this.refreshTargetSelectors();
    const current = this.currentAnchor(false);
    this.comments.update({
      threads: listCommentThreads(this.session.adapter.getDocument(), { includeResolved: true }),
      scope: this.scope, selectedElementIds: this.session.snapshot.selectedIds,
      includeResolved: true, reviewMode: this.session.snapshot.reviewMode,
      anchorDraft: current.ok ? current.anchor : undefined,
    });
  }

  dispose(): void {
    this.disposed = true;
    const window = this.document.defaultView;
    if (window && this.pollTimer !== undefined) window.clearInterval(this.pollTimer);
    this.authoring.dispose();
    this.comments.destroy();
    this.documents?.dispose();
    this.element.remove();
  }
}
