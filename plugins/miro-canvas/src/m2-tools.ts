import type { M1CanvasSession } from "./m1-session";
import { CommentsPanel } from "./comments-panel";
import { addAnchor, normalizeAnchor, resolveAnchor, type CanvasAnchor, type AnchorGeometry } from "./anchors";
import {
  addLocalComment, editLocalComment, deleteLocalComment, addReply, setCommentResolved,
  listCommentThreads, type CommentMutationResult, type CommentScope, type CommentThread,
} from "./local-comments";
import { readCanvasElementFile, readCanvasElementId, readCanvasElementType } from "./canvas-elements";
import { DocumentControls } from "./document-controls";
import type { DocumentHost } from "./document-viewer";

/** Wiring only: local feature models own mutations, the M1 writer owns persistence. */
export class M2CanvasTools {
  readonly element: HTMLElement;
  private readonly comments: CommentsPanel;
  private readonly status: HTMLElement;
  private readonly x: HTMLInputElement;
  private readonly y: HTMLInputElement;
  private anchor: CanvasAnchor | undefined;
  private scope: CommentScope = "board";
  private documents: DocumentControls | undefined;

  constructor(
    private readonly session: M1CanvasSession,
    documentHost: DocumentHost,
    private readonly document: Document,
  ) {
    session.refresh();
    this.element = document.createElement("div");
    this.element.className = "miro-canvas-m2-tools";
    this.status = document.createElement("p");
    this.status.setAttribute("role", "status");
    this.element.append(this.status);
    const anchorFields = document.createElement("fieldset");
    const legend = document.createElement("legend");
    legend.textContent = "Anchor coordinates (board X/Y or relative U/V, edge T)";
    anchorFields.append(legend);
    const number = (name: string) => {
      const input = document.createElement("input");
      input.type = "number"; input.step = "any"; input.value = "0.5";
      input.setAttribute("aria-label", name); anchorFields.append(input); return input;
    };
    this.x = number("Anchor X, U or T");
    this.y = number("Anchor Y or V");
    const save = document.createElement("button");
    save.textContent = "Save anchor";
    save.type = "button";
    save.addEventListener("click", () => {
      if (!this.anchor) { this.status.textContent = "Choose an anchor type below first."; return; }
      this.mutate("add-anchor", (draft) => addAnchor(draft, this.anchor));
    });
    anchorFields.append(save);
    this.element.append(anchorFields);
    this.comments = new CommentsPanel({
      onAddComment: (text, anchor) => this.mutate("add-comment", (draft) => addLocalComment(draft, { text, ...(anchor ? { anchor } : {}) })),
      onEditComment: (id, text) => this.mutate("edit-comment", (draft) => editLocalComment(draft, id, text)),
      onDeleteComment: (id) => this.mutate("delete-comment", (draft) => deleteLocalComment(draft, id)),
      onReplyComment: (id, text) => this.mutate("reply-comment", (draft) => addReply(draft, id, text)),
      onResolveComment: (id, resolved) => this.mutate("resolve-comment", (draft) => setCommentResolved(draft, id, resolved)),
      onFilterChange: (scope) => { this.scope = scope; this.refresh(); },
      onPickAnchor: (kind) => this.pickAnchor(kind),
      onSelectTarget: (thread) => this.focusComment(thread),
    }, { document });
    this.element.append(this.comments.element);
    const selection = new Set(session.snapshot.selectedIds);
    const fileNode = session.adapter.getNodes()?.find((node) => selection.has(readCanvasElementId(node) ?? "") && readCanvasElementFile(node));
    const file = readCanvasElementFile(fileNode);
    if (file) {
      this.documents = new DocumentControls(documentHost, file, document);
      this.element.append(this.documents.element);
    } else {
      const hint = document.createElement("p");
      hint.textContent = "Select a file node before opening these tools to view a local document.";
      this.element.append(hint);
    }
    this.refresh();
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

  private pickAnchor(kind: "free" | "selection" | "node" | "image" | "edge"): void {
    const x = Number(this.x.value), y = Number(this.y.value);
    if (!Number.isFinite(x) || !Number.isFinite(y)) { this.status.textContent = "Anchor coordinates must be finite."; return; }
    const id = this.session.snapshot.selectedIds[0];
    if (kind === "free") this.anchor = { type: "free", x, y };
    else if (!id) { this.status.textContent = "Select a Canvas element first."; return; }
    else if (kind === "edge" || (kind === "selection" && this.session.adapter.getEdges()?.some((edge) => readCanvasElementId(edge) === id))) {
      this.anchor = { type: "edge", edgeId: id, t: x };
    } else {
      const node = this.session.adapter.getNodes()?.find((node) => readCanvasElementId(node) === id);
      const type = kind === "image" || (kind === "selection" && readCanvasElementType(node) === "file") ? "image" : "node";
      this.anchor = { type, nodeId: id, u: x, v: y };
    }
    const normalized = normalizeAnchor(this.anchor);
    if (!normalized.valid) {
      this.anchor = undefined;
      this.status.textContent = normalized.diagnostics[0]?.message ?? "Invalid anchor.";
      this.refresh();
      return;
    }
    this.status.textContent = "Anchor selected. Add a comment or save the standalone anchor.";
    this.refresh();
  }

  private focusComment(thread: CommentThread): void {
    if (!thread.anchor) return;
    const nodes: Record<string, { x: number; y: number; width: number; height: number }> = {};
    const root = this.session.adapter.getDocument() as { nodes?: unknown[] } | undefined;
    for (const value of Array.isArray(root?.nodes) ? root.nodes : []) {
      if (!value || typeof value !== "object") continue;
      const node = value as Record<string, unknown>;
      if (typeof node.id === "string" && [node.x, node.y, node.width, node.height].every((n) => typeof n === "number" && Number.isFinite(n))) {
        Object.defineProperty(nodes, node.id, { enumerable: true, value: { x: node.x, y: node.y, width: node.width, height: node.height } });
      }
    }
    const geometry: AnchorGeometry = { nodes, images: nodes };
    const resolved = resolveAnchor(thread.anchor, geometry);
    const viewport = this.session.viewport.getViewport();
    if (!resolved.point || !viewport) {
      this.status.textContent = resolved.diagnostics[0]?.message ?? "Target geometry is unavailable.";
      return;
    }
    this.session.viewport.setViewport({ ...viewport, x: resolved.point.x, y: resolved.point.y });
    this.session.refresh();
  }

  refresh(): void {
    this.comments.update({
      threads: listCommentThreads(this.session.adapter.getDocument(), { includeResolved: true }),
      scope: this.scope, selectedElementIds: this.session.snapshot.selectedIds,
      includeResolved: true, reviewMode: this.session.snapshot.reviewMode,
      anchorDraft: this.anchor,
    });
  }

  dispose(): void { this.comments.destroy(); this.documents?.dispose(); this.element.remove(); }
}
