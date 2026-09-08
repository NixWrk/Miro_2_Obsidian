import { Modal, Notice, Plugin, TFile, type WorkspaceLeaf } from "obsidian";

import {
  inspectAdvancedCanvas,
  inspectCanvasView,
  type AdvancedCanvasInspection,
  type CanvasSessionInspection,
} from "./canvas-session";
import { MetadataWriter, type MetadataWriteResult } from "./metadata-writer";
import {
  createObsidianMetadataStore,
  type ObsidianMetadataStoreProbe,
} from "./obsidian-metadata-store";
import { M1CanvasSession } from "./m1-session";
import { M2CanvasTools } from "./m2-tools";
import { createObsidianDocumentHost } from "./obsidian-document-host";

const NATIVE_CANVAS_VIEW_TYPE = "canvas";

function isNativeCanvasView(view: unknown): boolean {
  if (view === null || (typeof view !== "object" && typeof view !== "function")) {
    return false;
  }

  try {
    const getViewType = (view as { getViewType?: unknown }).getViewType;
    return typeof getViewType === "function" && Reflect.apply(getViewType, view, []) === NATIVE_CANVAS_VIEW_TYPE;
  } catch {
    return false;
  }
}

/**
 * The shell intentionally has no file or network side effects on startup.
 * It probes Advanced Canvas once and reads a native Canvas document only when
 * the active leaf is a Canvas.  All inspection is delegated to read-only
 * adapters; no Canvas save or viewport mutation is part of this lifecycle.
 */
export default class MiroCanvasPlugin extends Plugin {
  private statusBarItem: HTMLElement | null = null;
  private shellDisposed = false;
  private advancedInspection: AdvancedCanvasInspection | null = null;
  private canvasInspection: CanvasSessionInspection | null = null;
  private metadataStoreProbe: ObsidianMetadataStoreProbe | null = null;
  private metadataWriter: MetadataWriter | null = null;
  private currentCanvasView: unknown = null;
  private m1Session: M1CanvasSession | null = null;
  private toolsModal: Modal | null = null;
  private initializationRetry: ReturnType<typeof setTimeout> | null = null;

  override async onload(): Promise<void> {
    this.shellDisposed = false;
    // Advanced Canvas is optional.  Its adapter fails closed, so this probe
    // cannot prevent the native Canvas shell from loading.
    this.advancedInspection = inspectAdvancedCanvas(this.app);

    const statusBarItem = this.addStatusBarItem();
    statusBarItem.addClass("miro-canvas-status");
    statusBarItem.setAttribute(
      "aria-label",
      "Miro Canvas plugin status"
    );
    this.statusBarItem = statusBarItem;
    // Register cleanup as soon as the shell owns a DOM element. This also
    // covers a partially loaded plugin if a later registration throws.
    this.register(() => this.disposeShell());

    this.addCommand({
      id: "show-status",
      name: "Show plugin status",
      callback: () => this.showStatus(),
    });

    this.addCommand({
      id: "initialize-metadata",
      name: "Initialize board metadata",
      checkCallback: (checking) => {
        const writer = this.ensureMetadataWriter();
        if (!writer) {
          return false;
        }
        if (!checking) {
          this.runMetadataAction(
            writer.write("initialize-metadata", () => undefined),
          );
        }
        return true;
      },
    });

    // M1 commands are scoped to the active native Canvas.  The command
    // callbacks never touch the document directly; M1CanvasSession routes
    // explicit mutations through MetadataWriter and camera actions through
    // its safe viewport controller.
    this.addCommand({
      id: "m1-commands",
      name: "Open Miro Canvas controls",
      checkCallback: (checking) => {
        const session = this.activeM1Session();
        if (!session) {
          return false;
        }
        if (!checking) {
          session.openCommands();
        }
        return true;
      },
    });
    this.addCommand({
      id: "local-tools",
      name: "Local shapes, comments, anchors and documents",
      checkCallback: (checking) => this.runM1Command(checking, (session) => this.openLocalTools(session)),
    });
    this.addCommand({
      id: "m1-theme-system",
      name: "Miro Canvas: Use system board theme",
      checkCallback: (checking) => this.runM1Command(checking, (session) => session.setTheme("system")),
    });
    this.addCommand({
      id: "m1-theme-light",
      name: "Miro Canvas: Use light board theme",
      checkCallback: (checking) => this.runM1Command(checking, (session) => session.setTheme("light")),
    });
    this.addCommand({
      id: "m1-theme-dark",
      name: "Miro Canvas: Use dark board theme",
      checkCallback: (checking) => this.runM1Command(checking, (session) => session.setTheme("dark")),
    });
    this.addCommand({
      id: "m1-toggle-review-mode",
      name: "Miro Canvas: Toggle review mode",
      checkCallback: (checking) => this.runM1Command(checking, (session) => session.toggleReviewMode()),
    });
    this.addCommand({
      id: "m1-lock-selection",
      name: "Miro Canvas: Lock selection",
      checkCallback: (checking) => this.runM1Command(checking, (session) => session.lockSelection()),
    });
    this.addCommand({
      id: "m1-unlock-selection",
      name: "Miro Canvas: Unlock selection",
      checkCallback: (checking) => this.runM1Command(checking, (session) => session.unlockSelection()),
    });
    this.addCommand({
      id: "m1-toggle-attachment-names",
      name: "Miro Canvas: Toggle attachment names",
      checkCallback: (checking) => this.runM1Command(checking, (session) => session.toggleAttachmentNames()),
    });
    this.addCommand({
      id: "m1-zoom-in",
      name: "Miro Canvas: Zoom in",
      checkCallback: (checking) => this.runM1Command(checking, (session) => session.navigate("zoom-in")),
    });
    this.addCommand({
      id: "m1-zoom-out",
      name: "Miro Canvas: Zoom out",
      checkCallback: (checking) => this.runM1Command(checking, (session) => session.navigate("zoom-out")),
    });
    this.addCommand({
      id: "m1-zoom-reset",
      name: "Miro Canvas: Reset zoom",
      checkCallback: (checking) => this.runM1Command(checking, (session) => session.navigate("zoom-reset")),
    });
    this.addCommand({
      id: "m1-fit-board",
      name: "Miro Canvas: Fit board",
      checkCallback: (checking) => this.runM1Command(checking, (session) => session.navigate("zoom-fit")),
    });
    this.addCommand({
      id: "m1-toggle-minimap",
      name: "Miro Canvas: Toggle minimap",
      checkCallback: (checking) => this.runM1Command(checking, (session) => session.navigate("toggle-minimap")),
    });

    this.registerEvent(
      this.app.workspace.on(
        "active-leaf-change",
        this.handleActiveLeafChange
      )
    );
    // A Canvas view can be reused for another file, or finish constructing its
    // private runtime after active-leaf-change. Never bind permanently to the
    // half-initialized object or carry a previous file's review overlay across.
    this.registerEvent(this.app.workspace.on("file-open", () => this.handleActiveLeafChange(this.app.workspace.activeLeaf)));
    this.registerEvent(this.app.workspace.on("layout-change", () => {
      if (this.m1Session?.status !== "ready") this.handleActiveLeafChange(this.app.workspace.activeLeaf);
    }));
    this.handleActiveLeafChange(this.app.workspace.activeLeaf);
  }

  override onunload(): void {
    this.disposeShell();
  }

  private readonly handleActiveLeafChange = (
    leaf: WorkspaceLeaf | null,
    attempt = 0,
  ): void => {
    if (this.shellDisposed) return;
    if (this.initializationRetry !== null) clearTimeout(this.initializationRetry);
    this.initializationRetry = null;
    this.toolsModal?.close();
    this.m1Session?.dispose();
    this.m1Session = null;
    const view = leaf?.view;
    if (!isNativeCanvasView(view)) {
      this.canvasInspection = null;
      this.metadataStoreProbe = null;
      this.metadataWriter = null;
      this.currentCanvasView = null;
      this.updateStatus(false);
      return;
    }

    this.currentCanvasView = view;
    this.canvasInspection = inspectCanvasView(view);
    this.metadataStoreProbe = createObsidianMetadataStore(view);
    this.metadataWriter = this.metadataStoreProbe.store
      ? new MetadataWriter(this.metadataStoreProbe.store)
      : null;
    this.m1Session = new M1CanvasSession(view, this.metadataWriter, {
      onNotice: (message) => new Notice(message),
      onStateChange: () => this.updateStatus(true),
    });
    const mounted = this.m1Session.mount();
    this.updateStatus(true);
    if (!mounted && attempt < 20) {
      this.initializationRetry = setTimeout(() => {
        this.initializationRetry = null;
        if (this.app.workspace.activeLeaf === leaf) this.handleActiveLeafChange(leaf, attempt + 1);
      }, 250);
    }
  };

  private activeM1Session(): M1CanvasSession | null {
    const view = this.app.workspace.activeLeaf?.view;
    return this.m1Session !== null && view === this.currentCanvasView
      ? this.m1Session
      : null;
  }

  private runM1Command(checking: boolean, callback: (session: M1CanvasSession) => void): boolean {
    const session = this.activeM1Session();
    if (!session) {
      return false;
    }
    if (!checking) {
      session.refresh();
      callback(session);
    }
    return true;
  }

  private openLocalTools(session: M1CanvasSession): void {
    this.toolsModal?.close();
    const modal = new Modal(this.app);
    this.toolsModal = modal;
    modal.modalEl.classList.add("miro-canvas-local-tools-modal");
    modal.contentEl.classList.add("miro-canvas-local-tools-modal__content");
    modal.setTitle("Miro Canvas · Local tools");
    const tools = new M2CanvasTools(session, createObsidianDocumentHost(
      this.app, (message) => new Notice(message), (value): value is TFile => value instanceof TFile,
    ), modal.contentEl.ownerDocument);
    modal.contentEl.append(tools.element);
    modal.onClose = () => {
      tools.dispose();
      if (this.toolsModal === modal) this.toolsModal = null;
    };
    modal.open();
  }

  private ensureMetadataWriter(): MetadataWriter | null {
    const view = this.app.workspace.activeLeaf?.view;
    if (!isNativeCanvasView(view)) {
      return null;
    }
    if (this.currentCanvasView !== view) {
      this.handleActiveLeafChange(this.app.workspace.activeLeaf);
      return this.metadataWriter;
    }
    if (this.metadataWriter) {
      return this.metadataWriter;
    }

    // Canvas internals can finish initializing after active-leaf-change. A
    // command check may safely retry the read-only capability probe.
    this.metadataStoreProbe = createObsidianMetadataStore(view);
    this.metadataWriter = this.metadataStoreProbe.store
      ? new MetadataWriter(this.metadataStoreProbe.store)
      : null;
    this.m1Session?.setWriter(this.metadataWriter);
    this.updateStatus(true);
    return this.metadataWriter;
  }

  private updateStatus(isCanvas: boolean): void {
    if (!this.statusBarItem) {
      return;
    }

    this.statusBarItem.dataset.miroCanvasState = isCanvas
      ? "canvas"
      : "idle";
    if (!isCanvas) {
      this.statusBarItem.setText("miro-canvas");
      return;
    }

    const inspection = this.canvasInspection;
    if (!inspection) {
      this.statusBarItem.setText("miro-canvas · Canvas");
      return;
    }

    const diagnosticCount = inspection.diagnostics.length
      + (this.metadataStoreProbe?.diagnostics.length ?? 0);
    const issueMarker = diagnosticCount > 0 ? " · ⚠" : "";
    const writerStatus = this.metadataStoreProbe?.status ?? "unavailable";
    const m1Status = this.m1Session?.status ?? "unavailable";
    this.statusBarItem.setText(
      `miro-canvas · Canvas (${inspection.adapter.status}/${inspection.metadata.status}/${writerStatus}/${m1Status})${issueMarker}`,
    );
  }

  private showStatus(): void {
    const advancedStatus = this.advancedInspection?.status ?? "not-probed";
    const inspection = this.canvasInspection;
    if (!inspection) {
      new Notice(`Miro Canvas is loaded offline; native Canvas is inactive. Advanced Canvas: ${advancedStatus}.`);
      return;
    }

    const diagnosticCount = inspection.diagnostics.length
      + (this.metadataStoreProbe?.diagnostics.length ?? 0);
    const diagnosticSuffix = diagnosticCount > 0
      ? ` ${diagnosticCount} diagnostic(s) reported.`
      : "";
    const persistenceStatus = this.metadataStoreProbe?.status ?? "unavailable";
    new Notice(
      `Miro Canvas is loaded offline; adapter ${inspection.adapter.status}, metadata ${inspection.metadata.status}, persistence ${persistenceStatus}. Advanced Canvas: ${advancedStatus}.${diagnosticSuffix}`,
    );
  }

  private runMetadataAction(result: MetadataWriteResult): void {
    if (this.currentCanvasView !== null) {
      this.canvasInspection = inspectCanvasView(this.currentCanvasView);
      this.updateStatus(true);
    }

    if (result.status === "applied") {
      new Notice(`Miro Canvas: ${result.action} applied.`);
      return;
    }
    if (result.status === "noop") {
      new Notice(`Miro Canvas: ${result.action} made no changes.`);
      return;
    }

    const reason = result.diagnostics[0]?.message ?? "The metadata transaction was rejected.";
    new Notice(`Miro Canvas: ${reason}`);
  }

  private disposeShell(): void {
    if (this.shellDisposed) {
      return;
    }

    this.shellDisposed = true;
    if (this.initializationRetry !== null) clearTimeout(this.initializationRetry);
    this.initializationRetry = null;
    this.toolsModal?.close();
    this.toolsModal = null;
    this.canvasInspection = null;
    this.metadataStoreProbe = null;
    this.metadataWriter = null;
    this.m1Session?.dispose();
    this.m1Session = null;
    this.currentCanvasView = null;
    this.advancedInspection = null;
    this.statusBarItem?.remove();
    this.statusBarItem = null;
  }
}
