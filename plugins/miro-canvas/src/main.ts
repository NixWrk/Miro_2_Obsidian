import * as obsidian from "obsidian";
import { Menu, Modal, Notice, Platform, Plugin, TFile, setIcon, type Events, type WorkspaceLeaf } from "obsidian";

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
import { M2CanvasTools, type InitialCommentTarget } from "./m2-tools";
import { createObsidianDocumentHost } from "./obsidian-document-host";
import { buildImportGuide, openExternalLink, vaultFolderPath, type ImportGuideActions } from "./import-guide";
import {
  DEFAULT_SETTINGS,
  navigationCommands,
  normalizeSettings,
  obsidianAccountName,
  shouldAskImportQuestion,
  type MiroCanvasSettings,
  type PanDirection,
} from "./settings";
import { MiroCanvasSettingTab } from "./settings-tab";
import { setAuthorColors } from "./comment-thread";
import { layerActions } from "./layer-order";
import { localeFor, setLocale, words } from "./i18n";

const NATIVE_CANVAS_VIEW_TYPE = "canvas";

/**
 * The language Obsidian shows itself in.  `getLanguage` arrived in Obsidian
 * 1.8; before it, Obsidian kept its choice in local storage.
 */
function obsidianLanguage(): string | null {
  const getLanguage = (obsidian as { getLanguage?: () => string }).getLanguage;
  if (typeof getLanguage === "function") {
    try {
      return getLanguage();
    } catch {
      // Fall back to where older Obsidian kept its choice.
    }
  }
  try {
    return window.localStorage.getItem("language");
  } catch {
    return null;
  }
}
const LAYER_MENU_SECTION = "miro-canvas-layer";

/**
 * Put a section of ours just before a menu's "danger" section, so deleting
 * stays the last thing a native Canvas menu offers.  A menu orders its
 * sections as it first meets them, which would put ours after it.
 */
function placeBeforeDanger(menu: Menu, section: string): void {
  const items = (menu as unknown as { items?: unknown }).items;
  const addSections = (menu as unknown as { addSections?: unknown }).addSections;
  if (!Array.isArray(items) || typeof addSections !== "function") return;
  const order: string[] = [];
  for (const item of items) {
    const name = (item as { section?: unknown } | null)?.section;
    if (typeof name === "string" && name !== "" && name !== section && !order.includes(name)) order.push(name);
  }
  const danger = order.indexOf("danger");
  order.splice(danger < 0 ? order.length : danger, 0, section);
  Reflect.apply(addSections, menu, [order]);
}

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
  private importGuideModal: Modal | null = null;
  private initializationRetry: ReturnType<typeof setTimeout> | null = null;
  public canvasSettings: MiroCanvasSettings = DEFAULT_SETTINGS;

  override async onload(): Promise<void> {
    // Every word below, command names included, is in Obsidian's own language.
    setLocale(localeFor(obsidianLanguage()));
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- the tab host reads settings lazily.
    const self = this;
    this.shellDisposed = false;
    // A stored settings file is user-editable and may predate this release,
    // so it is normalized rather than trusted.
    this.canvasSettings = normalizeSettings(await this.loadData());
    setAuthorColors(this.canvasSettings.commentAuthorColors);
    this.addSettingTab(new MiroCanvasSettingTab(this.app, this, {
      get settings(): MiroCanvasSettings { return self.canvasSettings; },
      saveSettings: (patch) => this.saveCanvasSettings(patch),
      commentAuthors: () => this.m1Session?.commentAuthors() ?? [],
      accountName: () => obsidianAccountName(window.localStorage),
      openImportGuide: () => this.openImportGuide(),
    }));
    // Advanced Canvas is optional.  Its adapter fails closed, so this probe
    // cannot prevent the native Canvas shell from loading.
    this.advancedInspection = inspectAdvancedCanvas(this.app);

    const statusBarItem = this.addStatusBarItem();
    statusBarItem.addClass("miro-canvas-status");
    statusBarItem.setAttribute(
      "aria-label",
      words().shell.statusAriaLabel
    );
    this.statusBarItem = statusBarItem;
    // Register cleanup as soon as the shell owns a DOM element. This also
    // covers a partially loaded plugin if a later registration throws.
    this.register(() => this.disposeShell());

    this.addCommand({
      id: "show-status",
      name: words().commands.showStatus,
      callback: () => this.showStatus(),
    });

    this.addCommand({
      id: "initialize-metadata",
      name: words().commands.initializeMetadata,
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
      name: words().commands.openControls,
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
      name: words().commands.localTools,
      checkCallback: (checking) => this.runM1Command(checking, (session) => this.openLocalTools(session)),
    });
    this.addCommand({
      id: "source-provenance-inspector",
      name: words().commands.sourceInspector,
      checkCallback: (checking) => this.runM1Command(checking, (session) => session.openSourceInspector()),
    });
    this.addCommand({
      id: "m1-theme-system",
      name: words().commands.themeSystem,
      checkCallback: (checking) => this.runM1Command(checking, (session) => session.setTheme("system")),
    });
    this.addCommand({
      id: "m1-theme-light",
      name: words().commands.themeLight,
      checkCallback: (checking) => this.runM1Command(checking, (session) => session.setTheme("light")),
    });
    this.addCommand({
      id: "m1-theme-dark",
      name: words().commands.themeDark,
      checkCallback: (checking) => this.runM1Command(checking, (session) => session.setTheme("dark")),
    });
    this.addCommand({
      id: "m1-toggle-review-mode",
      name: words().commands.toggleReviewMode,
      checkCallback: (checking) => this.runM1Command(checking, (session) => session.toggleReviewMode()),
    });
    this.addCommand({
      id: "m1-lock-selection",
      name: words().commands.lockSelection,
      checkCallback: (checking) => this.runM1Command(checking, (session) => session.lockSelection()),
    });
    this.addCommand({
      id: "m1-unlock-selection",
      name: words().commands.unlockSelection,
      checkCallback: (checking) => this.runM1Command(checking, (session) => session.unlockSelection()),
    });
    // Only cards have layers, so the commands are offered only with a card
    // selected.  No default hotkeys: Obsidian's editor uses the bracket keys,
    // and a board's keys are the user's to assign.
    for (const action of layerActions()) {
      this.addCommand({
        id: `layer-${action.direction}`,
        name: action.label,
        checkCallback: (checking) => {
          const session = this.activeM1Session();
          if (session === null || session.layeredCards().length === 0) {
            return false;
          }
          if (!checking) {
            session.changeLayer(action.direction);
          }
          return true;
        },
      });
    }
    // Native Canvas's own menus for a card and for a selection offer the
    // layer order as well; a frame's or a line's menu does not, as neither
    // has a layer.  Obsidian's typings do not name the Canvas menu events.
    const workspaceEvents: Events = this.app.workspace;
    this.registerEvent(workspaceEvents.on("canvas:node-menu", (menu: unknown, node: unknown) => {
      const id = (node as { id?: unknown } | null)?.id;
      if (typeof id === "string") this.addLayerItems(menu, [id]);
    }));
    this.registerEvent(workspaceEvents.on("canvas:selection-menu", (menu: unknown) => {
      this.addLayerItems(menu);
    }));
    // Registered without default hotkeys so Obsidian's own editor can bind
    // them and nothing is taken from the user or another plugin.
    for (const command of navigationCommands()) {
      this.addCommand({
        id: command.id,
        name: command.name,
        checkCallback: (checking) => this.runM1Command(checking, (session) => {
          const direction = command.id.startsWith("m1-pan-")
            ? command.id.slice("m1-pan-".length) as PanDirection
            : undefined;
          if (direction !== undefined) {
            session.pan(direction);
            return;
          }
          session.navigate(command.id.slice("m1-".length) as
            "zoom-in" | "zoom-out" | "zoom-reset" | "zoom-fit" | "toggle-minimap");
        }),
      });
    }

    this.addCommand({
      id: "m1-describe-selection",
      name: words().commands.describeSelection,
      checkCallback: (checking) => this.runM1Command(checking, (session) => {
        const description = session.describeSelection();
        // A notice can be copied out of, which a panel line cannot.
        new Notice(description, 20000);
        console.info(`[miro-canvas] ${description}`);
      }),
    });
    this.addCommand({
      id: "migrate-line-nodes",
      name: words().commands.migrateLines,
      checkCallback: checking => this.runM1Command(checking, session => session.migrateLines()),
    });
    this.addCommand({
      id: "reset-tools",
      name: words().commands.resetTools,
      // No default hotkey: Obsidian would take Escape from every card being
      // written, every label and every field.  The board resets on Escape itself.
      checkCallback: checking => this.runM1Command(checking,session=>session.resetTools()),
    });

    this.addCommand({
      id: "m1-toggle-attachment-names",
      name: words().commands.toggleAttachmentNames,
      checkCallback: (checking) => this.runM1Command(checking, (session) => session.toggleAttachmentNames()),
    });
    this.addCommand({
      id: "m1-zoom-in",
      name: words().commands.zoomIn,
      checkCallback: (checking) => this.runM1Command(checking, (session) => session.navigate("zoom-in")),
    });
    this.addCommand({
      id: "m1-zoom-out",
      name: words().commands.zoomOut,
      checkCallback: (checking) => this.runM1Command(checking, (session) => session.navigate("zoom-out")),
    });
    this.addCommand({
      id: "m1-zoom-reset",
      name: words().commands.zoomReset,
      checkCallback: (checking) => this.runM1Command(checking, (session) => session.navigate("zoom-reset")),
    });
    this.addCommand({
      id: "m1-fit-board",
      name: words().commands.fitBoard,
      checkCallback: (checking) => this.runM1Command(checking, (session) => session.navigate("zoom-fit")),
    });
    this.addCommand({
      id: "m1-toggle-minimap",
      name: words().commands.toggleMinimap,
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
      const currentClosed = this.currentCanvasView !== null && !this.currentCanvasStillOpen();
      if (currentClosed || this.m1Session?.status !== "ready") {
        this.handleActiveLeafChange(this.app.workspace.activeLeaf);
      }
    }));
    this.handleActiveLeafChange(this.app.workspace.activeLeaf);
    // Asked once, after Obsidian's own startup has settled; a plugin-only
    // person can decline it without ever seeing Miro mentioned again outside
    // the settings tab's own button.
    this.app.workspace.onLayoutReady(() => this.maybeAskImportQuestion());
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
    const view = leaf?.view;
    if (!isNativeCanvasView(view)) {
      if (this.currentCanvasStillOpen()) return;
      this.toolsModal?.close();
      this.m1Session?.dispose();
      this.m1Session = null;
      this.canvasInspection = null;
      this.metadataStoreProbe = null;
      this.metadataWriter = null;
      this.currentCanvasView = null;
      this.updateStatus(false);
      return;
    }

    this.toolsModal?.close();
    this.m1Session?.dispose();
    this.m1Session = null;
    this.currentCanvasView = view;
    this.canvasInspection = inspectCanvasView(view);
    this.metadataStoreProbe = createObsidianMetadataStore(view);
    this.metadataWriter = this.metadataStoreProbe.store
      ? new MetadataWriter(this.metadataStoreProbe.store)
      : null;
    this.m1Session = new M1CanvasSession(view, this.metadataWriter, {
      onNotice: (message) => new Notice(message),
      onStateChange: () => this.updateStatus(true),
      setIcon: (element, icon) => setIcon(element, icon),
      onOpenSettings: () => this.openOwnSettings(),
      onConnectorMenu: (event, run) => {
        // The clipboard and danger sections of native Canvas's selection menu.
        const menu = new Menu();
        const connectorMenuLabels = words().shell.connectorMenu;
        for (const [action, title, icon] of [
          ["cut", connectorMenuLabels.cut, "lucide-scissors"],
          ["copy", connectorMenuLabels.copy, "lucide-copy"],
          ["paste", connectorMenuLabels.paste, "lucide-clipboard-check"],
        ] as const) {
          menu.addItem((item) => item.setTitle(title).setIcon(icon).setSection("clipboard").onClick(() => run(action)));
        }
        menu.addItem((item) => item.setTitle(connectorMenuLabels.delete).setIcon("lucide-trash-2").setSection("danger").onClick(() => run("delete")));
        menu.showAtMouseEvent(event);
      },
      onOpenCommentThread: (threadId, origin) => {
        const session = this.activeM1Session();
        if (session !== null) this.openLocalTools(session, { threadId, origin });
      },
      settings: this.canvasSettings,
      ...(this.metadataStoreProbe?.store !== undefined ? {} : {
        persistenceProblem: this.metadataStoreProbe?.diagnostics
          .map((item) => item.message).join(" ") || "no native Canvas runtime was found.",
      }),
    });
    const mounted = this.m1Session.mount();
    this.updateStatus(true);
    // A Canvas leaf can mount before its runtime exposes the data and save
    // members the metadata store needs.  Mounting alone is therefore not
    // enough: without persistence every write is refused, so keep probing.
    if ((!mounted || this.metadataWriter === null) && attempt < 20) {
      this.initializationRetry = setTimeout(() => {
        this.initializationRetry = null;
        if (this.app.workspace.activeLeaf === leaf) this.handleActiveLeafChange(leaf, attempt + 1);
      }, 250);
    }
  };

  private currentCanvasStillOpen(): boolean {
    return this.currentCanvasView !== null
      && this.app.workspace.getLeavesOfType(NATIVE_CANVAS_VIEW_TYPE)
        .some((leaf) => leaf.view === this.currentCanvasView);
  }

  /** Persist a settings change and rebuild the session so it takes effect. */
  public async saveCanvasSettings(patch: Partial<MiroCanvasSettings>): Promise<void> {
    this.canvasSettings = normalizeSettings({ ...this.canvasSettings, ...patch });
    setAuthorColors(this.canvasSettings.commentAuthorColors);
    await this.saveData(this.canvasSettings);
    const leaf = this.app.workspace.activeLeaf;
    if (this.m1Session !== null && leaf !== null && leaf !== undefined) {
      this.handleActiveLeafChange(leaf);
    }
  }

  /** Obsidian's settings, open on this plugin's page. */
  private openOwnSettings(): void {
    const setting = (this.app as unknown as {
      setting?: { open?: () => void; openTabById?: (id: string) => void };
    }).setting;
    setting?.open?.();
    setting?.openTabById?.(this.manifest.id);
  }

  private activeM1Session(): M1CanvasSession | null {
    const view = this.app.workspace.activeLeaf?.view;
    return this.m1Session !== null && view === this.currentCanvasView
      ? this.m1Session
      : null;
  }

  /** The four layer actions in a native Canvas menu, when what it is for holds a card. */
  private addLayerItems(menu: unknown, ids?: readonly string[]): void {
    const session = this.activeM1Session();
    if (session === null || !(menu instanceof Menu)) return;
    session.refresh();
    if (session.layeredCards(ids).length === 0) return;
    for (const action of layerActions()) {
      menu.addItem((item) => item
        .setTitle(action.label)
        .setIcon(action.icon)
        .setSection(LAYER_MENU_SECTION)
        .onClick(() => session.changeLayer(action.direction, ids)));
    }
    placeBeforeDanger(menu, LAYER_MENU_SECTION);
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

  /** The first-run "Import boards from Miro?" question; never asked twice. */
  private maybeAskImportQuestion(): void {
    if (this.shellDisposed || !shouldAskImportQuestion(this.canvasSettings)) return;
    this.openImportQuestion();
  }

  private openImportQuestion(): void {
    const strings = words().importGuide;
    const modal = new Modal(this.app);
    modal.modalEl.classList.add("miro-canvas-import-question-modal");
    modal.setTitle(strings.questionTitle);
    modal.contentEl.createEl("p", { text: strings.questionBody1 });
    modal.contentEl.createEl("p", { text: strings.questionBody2 });
    const buttons = modal.contentEl.createDiv({ cls: "miro-canvas-import-question__buttons" });
    const showMeHow = buttons.createEl("button", { text: strings.showMeHow, cls: "mod-cta" });
    showMeHow.addEventListener("click", () => {
      modal.close();
      this.openImportGuide();
    });
    buttons.createEl("button", { text: strings.notNow }).addEventListener("click", () => modal.close());
    modal.contentEl.createEl("p", { text: strings.notNowNote, cls: "miro-canvas-import-question__note" });
    // Both buttons close the modal, and so does the native close control or
    // Escape; onClose is the one place that records an answer, so the
    // question is put once regardless of how a person leaves it.
    modal.onClose = () => void this.saveCanvasSettings({ importQuestionAnswered: true });
    modal.open();
  }

  /** The same guide the first-run question and the settings tab's button open. */
  private openImportGuide(): void {
    this.importGuideModal?.close();
    const modal = new Modal(this.app);
    this.importGuideModal = modal;
    modal.modalEl.classList.add("miro-canvas-import-guide-modal");
    modal.setTitle(words().importGuide.guideTitle);
    const actions: ImportGuideActions = {
      onOpenLink: (url) => openExternalLink(url),
      onCopy: (text) => {
        void navigator.clipboard.writeText(text).then(
          () => new Notice(words().importGuide.copied),
          () => new Notice(words().importGuide.copyFailed),
        );
      },
    };
    const content = buildImportGuide(actions, {
      document: modal.contentEl.ownerDocument,
      setIcon: (element, icon) => setIcon(element, icon),
      platform: Platform,
      vaultPath: vaultFolderPath(this.app.vault.adapter, this.app.vault.getName()),
    });
    modal.contentEl.append(content);
    modal.onClose = () => {
      if (this.importGuideModal === modal) this.importGuideModal = null;
    };
    modal.open();
  }

  private openLocalTools(session: M1CanvasSession, initialComment?: InitialCommentTarget): void {
    this.toolsModal?.close();
    const modal = new Modal(this.app);
    this.toolsModal = modal;
    modal.modalEl.classList.add("miro-canvas-local-tools-modal");
    modal.contentEl.classList.add("miro-canvas-local-tools-modal__content");
    // Opened from a comment, the dialog is the comments panel and nothing
    // else: the shape, anchor, connector and layer tools have no part in it.
    const commentsOnly = initialComment !== undefined;
    if (commentsOnly) modal.modalEl.classList.add("miro-canvas-local-tools-modal--comments");
    modal.setTitle(commentsOnly ? words().shell.commentsModalTitle : words().shell.localToolsTitle);
    const tools = new M2CanvasTools(session, createObsidianDocumentHost(
      this.app, (message) => new Notice(message), (value): value is TFile => value instanceof TFile,
    ), modal.contentEl.ownerDocument, initialComment);
    if (commentsOnly) tools.element.classList.add("miro-canvas-m2-tools--comments");
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
      new Notice(words().shell.offlineNotice(advancedStatus));
      return;
    }

    const diagnosticCount = inspection.diagnostics.length
      + (this.metadataStoreProbe?.diagnostics.length ?? 0);
    const diagnosticSuffix = diagnosticCount > 0
      ? ` ${words().shell.diagnosticsReported(diagnosticCount)}`
      : "";
    const persistenceStatus = this.metadataStoreProbe?.status ?? "unavailable";
    new Notice(
      words().shell.statusNotice(inspection.adapter.status, inspection.metadata.status, persistenceStatus, advancedStatus) + diagnosticSuffix,
    );
  }

  private runMetadataAction(result: MetadataWriteResult): void {
    if (this.currentCanvasView !== null) {
      this.canvasInspection = inspectCanvasView(this.currentCanvasView);
      this.updateStatus(true);
    }

    if (result.status === "applied") {
      new Notice(words().shell.actionApplied(result.action));
      return;
    }
    if (result.status === "noop") {
      new Notice(words().shell.actionNoop(result.action));
      return;
    }

    // A diagnostic's own message stays in English, as diagnostics for
    // maintainers do; only the fallback sentence is translated.
    const reason = result.diagnostics[0]?.message ?? words().shell.transactionRejected;
    new Notice(words().shell.actionRejected(reason));
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
    this.importGuideModal?.close();
    this.importGuideModal = null;
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
