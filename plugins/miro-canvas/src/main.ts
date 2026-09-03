import { Notice, Plugin, type WorkspaceLeaf } from "obsidian";

import {
  inspectAdvancedCanvas,
  inspectCanvasView,
  type AdvancedCanvasInspection,
  type CanvasSessionInspection,
} from "./canvas-session";

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
 * The M0 shell intentionally has no file or network side effects on startup.
 * It probes Advanced Canvas once and reads a native Canvas document only when
 * the active leaf is a Canvas.  All inspection is delegated to read-only
 * adapters; no Canvas save or viewport mutation is part of this lifecycle.
 */
export default class MiroCanvasPlugin extends Plugin {
  private statusBarItem: HTMLElement | null = null;
  private shellDisposed = false;
  private advancedInspection: AdvancedCanvasInspection | null = null;
  private canvasInspection: CanvasSessionInspection | null = null;

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

    this.registerEvent(
      this.app.workspace.on(
        "active-leaf-change",
        this.handleActiveLeafChange
      )
    );
    this.handleActiveLeafChange(this.app.workspace.activeLeaf);
  }

  override onunload(): void {
    this.disposeShell();
  }

  private readonly handleActiveLeafChange = (
    leaf: WorkspaceLeaf | null
  ): void => {
    const view = leaf?.view;
    if (!isNativeCanvasView(view)) {
      this.canvasInspection = null;
      this.updateStatus(false);
      return;
    }

    this.canvasInspection = inspectCanvasView(view);
    this.updateStatus(true);
  };

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

    const issueMarker = inspection.diagnostics.length > 0 ? " · ⚠" : "";
    this.statusBarItem.setText(
      `miro-canvas · Canvas (${inspection.adapter.status}/${inspection.metadata.status})${issueMarker}`,
    );
  }

  private showStatus(): void {
    const advancedStatus = this.advancedInspection?.status ?? "not-probed";
    const inspection = this.canvasInspection;
    if (!inspection) {
      new Notice(`Miro Canvas is loaded offline; native Canvas is inactive. Advanced Canvas: ${advancedStatus}.`);
      return;
    }

    const diagnosticSuffix = inspection.diagnostics.length > 0
      ? ` ${inspection.diagnostics.length} diagnostic(s) reported.`
      : "";
    new Notice(
      `Miro Canvas is loaded offline; adapter ${inspection.adapter.status}, metadata ${inspection.metadata.status}. Advanced Canvas: ${advancedStatus}.${diagnosticSuffix}`,
    );
  }

  private disposeShell(): void {
    if (this.shellDisposed) {
      return;
    }

    this.shellDisposed = true;
    this.canvasInspection = null;
    this.advancedInspection = null;
    this.statusBarItem?.remove();
    this.statusBarItem = null;
  }
}
