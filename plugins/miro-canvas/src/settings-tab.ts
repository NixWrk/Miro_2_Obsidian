/**
 * The Obsidian-facing settings tab.
 *
 * Everything this tab decides lives in `settings.ts`; the tab itself only
 * renders controls and reports the chosen value, so the bounds and the
 * fallbacks stay testable without an Obsidian runtime.
 */

import { PluginSettingTab, Setting, type App, type Plugin } from "obsidian";

import { authorColor } from "./comment-thread";
import { words } from "./i18n";
import { POINTER_BINDINGS, type PointerBinding } from "./pointer-bindings";
import {
  DEFAULT_COMMENT_AUTHOR,
  SETTING_BOUNDS,
  WHEEL_ZOOM_MODIFIERS,
  pointerBindingLabel,
  type MiroCanvasSettings,
  type WheelZoomModifier,
} from "./settings";

export interface SettingsTabHost {
  readonly settings: MiroCanvasSettings;
  readonly saveSettings: (patch: Partial<MiroCanvasSettings>) => Promise<void>;
  /** Everyone who has written on the open board, for their colours. */
  readonly commentAuthors?: () => readonly string[];
  /** The Obsidian account's name, which signs comments when no name is set. */
  readonly accountName?: () => string | undefined;
  /** Opens the "Import boards from Miro" guide; the same one the first-run question offers. */
  readonly openImportGuide: () => void;
}

export class MiroCanvasSettingTab extends PluginSettingTab {
  private readonly host: SettingsTabHost;

  public constructor(app: App, plugin: Plugin, host: SettingsTabHost) {
    super(app, plugin);
    this.host = host;
  }

  public override display(): void {
    const { containerEl } = this;
    containerEl.empty();
    const labels = words().settings;

    new Setting(containerEl).setName(labels.navigationHeading).setHeading();

    this.slider(containerEl, labels.zoomStepName, labels.zoomStepDesc,
      "zoomStep", (value) => `${Math.round((value - 1) * 100)}%`);

    new Setting(containerEl)
      .setName(labels.zoomToCursorName)
      .setDesc(labels.zoomToCursorDesc)
      .addToggle((toggle) => toggle
        .setValue(this.host.settings.zoomToCursor)
        .onChange((value) => void this.host.saveSettings({ zoomToCursor: value })));

    new Setting(containerEl)
      .setName(labels.wheelModifierName)
      .setDesc(labels.wheelModifierDesc)
      .addDropdown((dropdown) => {
        for (const modifier of WHEEL_ZOOM_MODIFIERS) {
          dropdown.addOption(modifier, modifier === "none" ? labels.noModifier : modifier.toUpperCase());
        }
        dropdown
          .setValue(this.host.settings.wheelZoomModifier)
          .onChange((value) => void this.host.saveSettings({ wheelZoomModifier: value as WheelZoomModifier }));
      });

    new Setting(containerEl)
      .setName(labels.invertWheelName)
      .addToggle((toggle) => toggle
        .setValue(this.host.settings.invertWheelZoom)
        .onChange((value) => void this.host.saveSettings({ invertWheelZoom: value })));

    this.slider(containerEl, labels.minZoomName, labels.minZoomDesc,
      "minZoom", (value) => `${Math.round(value * 100)}%`);
    this.slider(containerEl, labels.maxZoomName, labels.maxZoomDesc,
      "maxZoom", (value) => `${Math.round(value * 100)}%`);

    new Setting(containerEl).setName(labels.panningHeading).setHeading();

    this.slider(containerEl, labels.panStepName, labels.panStepDesc,
      "panStep", (value) => `${value} px`);
    this.slider(containerEl, labels.fastPanName, labels.fastPanDesc,
      "fastPanMultiplier", (value) => `${value}×`);

    new Setting(containerEl).setName(labels.connectorsHeading).setHeading();
    // Where an end of a line or an arrow may be put down.  Existing
    // connections keep their ends whatever is chosen here.
    for (const [key, title, description] of [
      ["connectorAttachNodes", labels.attachNodesName, labels.attachNodesDesc],
      ["connectorAllowFree", labels.allowFreeName, labels.allowFreeDesc],
      ["connectorAttachConnectors", labels.attachConnectorsName, labels.attachConnectorsDesc],
    ] as const) {
      new Setting(containerEl).setName(title)
        .setDesc(description)
        .addToggle((toggle) => toggle.setValue(this.host.settings[key])
          .onChange((value) => void this.host.saveSettings({ [key]: value })));
    }
    new Setting(containerEl).setName(labels.lassoGestureName)
      .setDesc(labels.lassoGestureDesc)
      .addDropdown(dropdown => {
        for (const chord of POINTER_BINDINGS) dropdown.addOption(chord, pointerBindingLabel(chord));
        dropdown.setValue(this.host.settings.lassoBinding).onChange(value => void this.host.saveSettings({ lassoBinding: value as PointerBinding }));
      });
    for (const [key, title] of [["showLassoTool", labels.showLassoName], ["showConnectorTool", labels.showConnectorName]] as const) {
      new Setting(containerEl).setName(title).addToggle(toggle => toggle.setValue(this.host.settings[key])
        .onChange(value => void this.host.saveSettings({ [key]: value })));
    }
    for (const [key, title, description] of [
      ["panBinding", labels.panGestureName, labels.panGestureDesc],
      ["lineBinding", labels.lineGestureName, labels.lineGestureDesc],
    ] as const) {
      new Setting(containerEl).setName(title).setDesc(description).addDropdown(dropdown => {
        for (const chord of POINTER_BINDINGS) dropdown.addOption(chord, pointerBindingLabel(chord));
        dropdown.setValue(this.host.settings[key]).onChange(value => void this.host.saveSettings({ [key]: value as PointerBinding }));
      });
    }

    this.slider(containerEl, labels.magnetName, labels.magnetDesc,
      "connectorMagnet", (value) => `${value} px`);
    this.slider(containerEl, labels.snapName, labels.snapDesc,
      "connectorSnap", (value) => `${value} px`);
    this.slider(containerEl, labels.labelPositionName, labels.labelPositionDesc,
      "connectorLabelPosition", (value) => `${Math.round(value * 100)}%`);

    new Setting(containerEl).setName(labels.keyboardHeading).setHeading();

    new Setting(containerEl)
      .setName(labels.shortcutsName)
      .setDesc(labels.shortcutsDesc(words().commands.resetTools))
      .addButton((button) => button
        .setButtonText(labels.openHotkeys)
        .onClick(() => {
          const setting = (this.app as unknown as {
            setting?: { open?: () => void; openTabById?: (id: string) => void };
          }).setting;
          setting?.open?.();
          setting?.openTabById?.("hotkeys");
        }));

    new Setting(containerEl)
      .setName(labels.interfaceName)
      .setDesc(labels.interfaceDesc)
      .setHeading();

    new Setting(containerEl)
      .setName(labels.minimapDefaultName)
      .addToggle((toggle) => toggle
        .setValue(this.host.settings.minimapVisible)
        .onChange((value) => void this.host.saveSettings({ minimapVisible: value })));

    new Setting(containerEl)
      .setName(labels.toolbarName)
      .setDesc(labels.toolbarDesc)
      .addToggle((toggle) => toggle
        .setValue(this.host.settings.selectionToolbarEnabled)
        .onChange((value) => void this.host.saveSettings({ selectionToolbarEnabled: value })));

    this.comments(containerEl);

    const importLabels = words().importGuide;
    new Setting(containerEl).setName(importLabels.settingsHeading).setHeading();
    new Setting(containerEl)
      .addButton((button) => button
        .setButtonText(importLabels.openGuideButton)
        .onClick(() => this.host.openImportGuide()));

    new Setting(containerEl)
      .setName(labels.developerDiagnosticsName)
      .setDesc(labels.developerDiagnosticsDesc)
      .addToggle((toggle) => toggle
        .setValue(this.host.settings.developerDiagnostics)
        .onChange((value) => void this.host.saveSettings({ developerDiagnostics: value })));
  }

  /** Who signs the comments written here, and the colour each author's pins wear. */
  private comments(containerEl: HTMLElement): void {
    const labels = words().settings;
    new Setting(containerEl).setName(labels.commentsHeading).setHeading();
    const account = this.host.accountName?.();
    new Setting(containerEl)
      .setName(labels.yourNameName)
      .setDesc(account === undefined
        ? labels.yourNameDescDefault(DEFAULT_COMMENT_AUTHOR)
        : labels.yourNameDescAccount(account))
      .addText((text) => text
        .setPlaceholder(account ?? DEFAULT_COMMENT_AUTHOR)
        .setValue(this.host.settings.commentAuthor)
        .onChange((value) => void this.host.saveSettings({ commentAuthor: value })));
    const colors = this.host.settings.commentAuthorColors;
    const authors = [...new Set([...(this.host.commentAuthors?.() ?? []), ...Object.keys(colors)])]
      .sort((a, b) => a.localeCompare(b));
    if (authors.length === 0) {
      new Setting(containerEl).setName(labels.authorColorsName).setDesc(labels.authorColorsDesc);
      return;
    }
    for (const author of authors) {
      new Setting(containerEl)
        .setName(author)
        .setDesc(colors[author] === undefined ? labels.colorMadeUp : labels.colorChosen)
        .addColorPicker((picker) => picker
          .setValue(colors[author] ?? authorColor(author))
          .onChange((value) => void this.host.saveSettings({ commentAuthorColors: { ...this.host.settings.commentAuthorColors, [author]: value } })))
        .addExtraButton((button) => button
          .setIcon("rotate-ccw")
          .setTooltip(labels.resetColorTooltip)
          .setDisabled(colors[author] === undefined)
          .onClick(() => {
            const { [author]: _dropped, ...rest } = this.host.settings.commentAuthorColors;
            void this.host.saveSettings({ commentAuthorColors: rest }).then(() => this.display());
          }));
    }
  }

  private slider(
    container: HTMLElement,
    name: string,
    description: string,
    key: keyof typeof SETTING_BOUNDS,
    format: (value: number) => string,
  ): void {
    const bound = SETTING_BOUNDS[key];
    const setting = new Setting(container).setName(name).setDesc(description);
    const value = this.host.settings[key];
    const currently = words().settings.currently;
    setting.addSlider((slider) => slider
      .setLimits(bound.min, bound.max, bound.step)
      .setValue(value)
      .setDynamicTooltip()
      .onChange((next) => {
        setting.setDesc(`${description} ${currently(format(next))}`);
        void this.host.saveSettings({ [key]: next } as Partial<MiroCanvasSettings>);
      }));
    setting.setDesc(`${description} ${currently(format(value))}`);
  }
}
