import type { M1CanvasSession } from "./m1-session";
import { CommentsPanel } from "./comments-panel";
import { addAnchor, normalizeAnchor, resolveAnchor, type CanvasAnchor } from "./anchors";
import {
  addLocalComment, editLocalComment, deleteLocalComment, addReply, setCommentResolved,
  type CommentMutationResult, type CommentOrigin, type CommentScope, type CommentThread,
} from "./local-comments";
import { readCanvasElementFile, readCanvasElementId, readCanvasElementType } from "./canvas-elements";
import { createCanvasAuthoring, type CanvasAuthoring } from "./canvas-authoring";
import { layerActions } from "./layer-order";
import { words } from "./i18n";
import { SHAPE_CATALOG, shapeCatalogLabel } from "./shape-catalog";
import { buildCanvasAnchorGeometry } from "./connector-endpoints";
import { DocumentControls } from "./document-controls";
import type { DocumentHost } from "./document-viewer";

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "avif"]);
/** Every picture the renderer can draw, once, under the picker's names in the language in use. */
function shapeOptions(): readonly (readonly [string, string])[] {
  return SHAPE_CATALOG.map((item) => [item.kind, shapeCatalogLabel(item)] as const);
}

type AnchorPickKind = "free" | "selection" | "node" | "image" | "edge";

export interface InitialCommentTarget {
  readonly threadId: string;
  readonly origin: CommentOrigin;
}

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
  return spaced.length > 0 ? `${spaced[0]!.toUpperCase()}${spaced.slice(1)}` : words().localTools.nodeFallback;
}

function elementLabel(element: unknown, edge: boolean): string | undefined {
  const id = readCanvasElementId(element);
  if (id === undefined) return undefined;
  if (edge) return words().localTools.connectorOption(id);
  const file = readCanvasElementFile(element);
  if (file !== undefined) {
    return isImageCanvasNode(element) ? words().localTools.imageOption(basename(file), id) : words().localTools.fileOption(basename(file), id);
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
  private initialComment: InitialCommentTarget | undefined;

  constructor(
    private readonly session: M1CanvasSession,
    documentHost: DocumentHost,
    private readonly document: Document,
    initialComment?: InitialCommentTarget,
  ) {
    this.initialComment = initialComment;
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
    shapeLegend.textContent = words().localTools.createShape;
    shapeFields.append(shapeLegend);
    const shapeGrid = document.createElement("div");
    shapeGrid.className = "miro-canvas-m2-tools__grid";
    shapeFields.append(shapeGrid);
    const shape = appendLabeled(document, shapeGrid, words().localTools.shapeKind, document.createElement("select"));
    for (const [value, label] of shapeOptions()) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = label;
      shape.append(option);
    }
    const shapeText = appendLabeled(document, shapeGrid, words().localTools.shapeText, document.createElement("input"));
    shapeText.type = "text";
    shapeText.value = words().localTools.shapeTextDefault;
    const shapeNumber = (label: string, value: string) => {
      const input = document.createElement("input");
      input.type = "number";
      input.step = "any";
      input.value = value;
      return appendLabeled(document, shapeGrid, label, input);
    };
    const shapeX = shapeNumber(words().localTools.shapeX, "100");
    const shapeY = shapeNumber(words().localTools.shapeY, "100");
    const shapeWidth = shapeNumber(words().localTools.shapeWidth, "240");
    const shapeHeight = shapeNumber(words().localTools.shapeHeight, "140");
    const createShape = document.createElement("button");
    createShape.type = "button";
    createShape.textContent = words().localTools.createShape;
    createShape.className = "miro-canvas-m2-tools__primary-action";
    createShape.addEventListener("click", () => {
      const readNumber = (input: HTMLInputElement, label: string, positive = false): number | undefined => {
        const raw = input.value.trim();
        if (raw.length === 0) {
          this.status.textContent = words().localTools.fieldRequired(label);
          return undefined;
        }
        const value = Number(raw);
        if (!Number.isFinite(value)) {
          this.status.textContent = words().localTools.fieldNotFinite(label);
          return undefined;
        }
        if (positive && value <= 0) {
          this.status.textContent = words().localTools.fieldNotPositive(label);
          return undefined;
        }
        return value;
      };
      const x = readNumber(shapeX, words().localTools.shapeX);
      const y = readNumber(shapeY, words().localTools.shapeY);
      const width = readNumber(shapeWidth, words().localTools.shapeWidth, true);
      const height = readNumber(shapeHeight, words().localTools.shapeHeight, true);
      if (x === undefined || y === undefined || width === undefined || height === undefined) return;
      const result = this.authoring.createShape({
        shape: shape.value,
        text: shapeText.value,
        x,
        y,
        width,
        height,
      });
      this.status.textContent = result.ok ? words().localTools.shapeCreated(result.nodeId ?? "")
        : result.diagnostics[0]?.message ?? words().localTools.shapeCreationRejected;
      this.refreshFromNative();
    });
    shapeFields.append(createShape);
    this.element.append(shapeFields);

    const anchorFields = document.createElement("fieldset");
    anchorFields.className = "miro-canvas-m2-tools__section miro-canvas-m2-tools__section--anchor";
    const legend = document.createElement("legend");
    legend.textContent = words().localTools.anchorLegend;
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
    this.x = number(words().localTools.anchorXLabel);
    this.y = number(words().localTools.anchorYLabel);
    this.anchorTarget = appendLabeled(document, anchorGrid, words().localTools.anchorTarget, document.createElement("select"));
    const save = document.createElement("button");
    save.textContent = words().localTools.saveAnchor;
    save.type = "button";
    save.className = "miro-canvas-m2-tools__primary-action";
    save.addEventListener("click", () => {
      if (this.anchorKind === undefined) { this.status.textContent = words().localTools.chooseAnchorTypeFirst; return; }
      const current = this.currentAnchor(true);
      if (!current.ok || current.anchor === undefined) return;
      this.mutate("add-anchor", (draft) => addAnchor(draft, current.anchor!));
    });
    anchorFields.append(save);
    this.element.append(anchorFields);

    const connectorFields = document.createElement("fieldset");
    connectorFields.className = "miro-canvas-m2-tools__section miro-canvas-m2-tools__section--connector";
    const connectorLegend = document.createElement("legend");
    connectorLegend.textContent = words().localTools.connectorLegend;
    connectorFields.append(connectorLegend);
    const connectorGrid = document.createElement("div");
    connectorGrid.className = "miro-canvas-m2-tools__grid";
    connectorFields.append(connectorGrid);
    this.connectorEdge = appendLabeled(document, connectorGrid, words().localTools.connectorField, document.createElement("select"));
    this.connectorEnd = appendLabeled(document, connectorGrid, words().localTools.connectorEndField, document.createElement("select"));
    for (const [value, label] of [["from", words().localTools.endFrom], ["to", words().localTools.endTo]] as const) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = label;
      this.connectorEnd.append(option);
    }
    const setEndpoint = document.createElement("button");
    setEndpoint.type = "button";
    setEndpoint.textContent = words().localTools.setConnectorEndpoint;
    setEndpoint.className = "miro-canvas-m2-tools__primary-action";
    setEndpoint.addEventListener("click", () => {
      if (this.anchorKind === undefined) { this.status.textContent = words().localTools.chooseAnchorBeforeConnector; return; }
      if (this.connectorEdge.value.length === 0) { this.status.textContent = words().localTools.chooseConnectorToEdit; return; }
      const current = this.currentAnchor(true);
      if (!current.ok || current.anchor === undefined) return;
      const result = this.authoring.updateConnectorEndpoint({
        edgeId: this.connectorEdge.value,
        end: this.connectorEnd.value === "to" ? "to" : "from",
        anchor: current.anchor,
      });
      this.status.textContent = result.ok ? words().localTools.connectorEndpointSaved
        : result.diagnostics[0]?.message ?? words().localTools.connectorEndpointRejected;
      this.refreshFromNative();
    });
    connectorFields.append(setEndpoint);
    this.element.append(connectorFields);

    const geometryFields = document.createElement("fieldset");
    geometryFields.className = "miro-canvas-m2-tools__section miro-canvas-m2-tools__section--geometry";
    const geometryLegend = document.createElement("legend");
    geometryLegend.textContent = words().localTools.geometryLegend;
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
    appendLabeled(document, geometryGrid, words().localTools.rotationDegrees, rotation);
    const applyRotation = document.createElement("button");
    applyRotation.type = "button";
    applyRotation.textContent = words().localTools.applyRotation;
    applyRotation.addEventListener("click", () => {
      const id = this.session.snapshot.selectedIds[0];
      const value = rotation.value.trim().length > 0 ? Number(rotation.value) : Number.NaN;
      if (id === undefined) { this.status.textContent = words().localTools.selectOneToRotate; return; }
      if (!Number.isFinite(value)) { this.status.textContent = words().localTools.rotationNotFinite; return; }
		const result = this.session.setElementRotation(id, value);
		this.status.textContent = result?.ok === true ? words().localTools.rotationSaved
			: result?.diagnostics[0]?.message ?? words().localTools.rotationRejected;
      this.refreshFromNative();
    });
    geometryActions.append(applyRotation);
    for (const { direction, label } of layerActions()) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = label;
      button.addEventListener("click", () => {
        const ids = this.session.snapshot.selectedIds;
        if (ids.length === 0) { this.status.textContent = words().layer.selectCard; return; }
        const result = this.authoring.changeZOrder({ ids, direction });
        this.status.textContent = result.ok ? words().localTools.layerOrderSaved
          : result.diagnostics[0]?.message ?? words().localTools.layerOrderRejected;
        this.refreshFromNative();
      });
      geometryActions.append(button);
    }
    geometryFields.append(geometryActions);
    this.element.append(geometryFields);

    this.comments = new CommentsPanel({
      onAddComment: (text, anchor) => {
        const current = anchor ?? this.session.defaultCommentAnchor();
        this.mutate("add-comment", (draft) => addLocalComment(
          draft, { text, ...(current ? { anchor: current } : {}) }, { author: this.session.commentAuthor() },
        ));
      },
      onEditComment: (id, text) => { if (!this.session.commentLocked(id, "local")) this.mutate("edit-comment", (draft) => editLocalComment(draft, id, text)); },
      onDeleteComment: (id) => { if (!this.session.commentLocked(id, "local")) this.mutate("delete-comment", (draft) => deleteLocalComment(draft, id)); },
      onReplyComment: (id, text) => { if (!this.session.commentLocked(id, "local")) this.mutate(
        "reply-comment", (draft) => addReply(draft, id, text, { author: this.session.commentAuthor() }),
      ); },
      onResolveComment: (id, resolved) => { if (!this.session.commentLocked(id, "local")) this.mutate("resolve-comment", (draft) => setCommentResolved(draft, id, resolved)); },
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
      hint.textContent = words().localTools.selectFileHint;
      this.element.append(hint);
    }
    this.refresh();
    const window = document.defaultView;
    if (window) this.pollTimer = window.setInterval(() => this.refreshFromNative(), 250);
  }

  private mutate(action: string, transform: (draft: Record<string, unknown>) => Pick<CommentMutationResult, "ok" | "metadata"> & { diagnostics: readonly { message: string }[] }): void {
    const result = this.session.writeMetadata(action, (draft) => {
      const mutation = transform(draft);
      if (!mutation.ok || !mutation.metadata) throw new Error(mutation.diagnostics[0]?.message ?? words().localTools.localActionRejected);
      return mutation.metadata;
    });
    this.status.textContent = result?.status === "applied" ? words().localTools.savedLocally
      : result?.status === "noop" ? words().localTools.noChanges : result?.diagnostics[0]?.message ?? words().localTools.metadataWriterUnavailable;
    this.refresh();
  }

  private numericAnchorValue(input: HTMLInputElement, label: string, report: boolean): number | undefined {
    const raw = input.value.trim();
    const value = raw.length > 0 ? Number(raw) : Number.NaN;
    if (Number.isFinite(value)) return value;
    if (report) this.status.textContent = words().localTools.fieldNotFinite(label);
    return undefined;
  }

  private currentAnchor(report: boolean): { readonly ok: boolean; readonly anchor?: CanvasAnchor } {
    if (this.anchorKind === undefined) return { ok: true };
    const x = this.numericAnchorValue(this.x, words().localTools.anchorXLabel, report);
    const y = this.numericAnchorValue(this.y, words().localTools.anchorYLabel, report);
    if (x === undefined || y === undefined) return { ok: false };

    let anchor: CanvasAnchor;
    if (this.anchorKind === "free") {
      anchor = { type: "free", x, y };
    } else {
      const id = this.anchorTarget.value;
      if (id.length === 0) {
        if (report) this.status.textContent = words().localTools.chooseAnchorTarget;
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
          if (report) this.status.textContent = words().localTools.targetNotConnector;
          return { ok: false };
        }
        anchor = { type: "edge", edgeId: id, t: x };
      } else {
        if (node === undefined) {
          if (report) this.status.textContent = words().localTools.targetNotNode;
          return { ok: false };
        }
        if (kind === "image" && !isImageCanvasNode(node)) {
          if (report) this.status.textContent = words().localTools.fileNotImage;
          return { ok: false };
        }
        anchor = { type: kind === "image" ? "image" : "node", nodeId: id, u: x, v: y };
      }
    }
    const normalized = normalizeAnchor(anchor);
    if (!normalized.valid || normalized.anchor === undefined) {
      if (report) this.status.textContent = normalized.diagnostics[0]?.message ?? words().localTools.invalidAnchor;
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
    this.status.textContent = words().localTools.anchorSelected;
    this.refresh();
  }

  private focusComment(thread: CommentThread): void {
    if (!thread.anchor) return;
    const root = this.session.adapter.getDocument();
    const geometry = buildCanvasAnchorGeometry(root && typeof root === "object" ? root as Record<string, unknown> : {});
    const resolved = resolveAnchor(thread.anchor, geometry);
    const viewport = this.session.viewport.getViewport();
    if (!resolved.point || !viewport) {
      this.status.textContent = resolved.diagnostics[0]?.message ?? words().localTools.targetGeometryUnavailable;
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
      empty.textContent = options.length > 0 ? words().localTools.choosePlaceholder : words().localTools.noTargetsAvailable;
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
      threads: this.session.commentThreads(),
      scope: this.scope, selectedElementIds: this.session.snapshot.selectedIds,
      includeResolved: true, reviewMode: this.session.snapshot.reviewMode,
      anchorDraft: current.ok ? current.anchor : undefined,
    });
    if (this.initialComment !== undefined
      && this.comments.focusThread(this.initialComment.threadId, this.initialComment.origin)) {
      this.initialComment = undefined;
    }
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
