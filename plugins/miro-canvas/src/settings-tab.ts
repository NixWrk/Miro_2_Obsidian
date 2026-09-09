/**
 * The Obsidian-facing settings tab.
 *
 * Everything this tab decides lives in `settings.ts`; the tab itself only
 * renders controls and reports the chosen value, so the bounds and the
 * fallbacks stay testable without an Obsidian runtime.
 */

import { PluginSettingTab, Setting, type App, type Plugin } from "obsidian";

import {
  SETTING_BOUNDS,
  WHEEL_ZOOM_MODIFIERS,
  type MiroCanvasSettings,
  type WheelZoomModifier,
} from "./settings";

export interface SettingsTabHost {
  readonly settings: MiroCanvasSettings;
  readonly saveSettings: (patch: Partial<MiroCanvasSettings>) => Promise<void>;
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

    new Setting(containerEl).setName("Navigation").setHeading();

    this.slider(containerEl, "Zoom step", "How much one zoom step changes the scale.",
      "zoomStep", (value) => `${Math.round((value - 1) * 100)}%`);

    new Setting(containerEl)
      .setName("Zoom towards the pointer")
      .setDesc("Off zooms towards the center of the view instead.")
      .addToggle((toggle) => toggle
        .setValue(this.host.settings.zoomToCursor)
        .onChange((value) => void this.host.saveSettings({ zoomToCursor: value })));

    new Setting(containerEl)
      .setName("Wheel zoom modifier")
      .setDesc("Which key the wheel needs before it zooms instead of scrolling.")
      .addDropdown((dropdown) => {
        for (const modifier of WHEEL_ZOOM_MODIFIERS) {
          dropdown.addOption(modifier, modifier === "none" ? "No modifier" : modifier.toUpperCase());
        }
        dropdown
          .setValue(this.host.settings.wheelZoomModifier)
          .onChange((value) => void this.host.saveSettings({ wheelZoomModifier: value as WheelZoomModifier }));
      });

    new Setting(containerEl)
      .setName("Invert wheel zoom direction")
      .addToggle((toggle) => toggle
        .setValue(this.host.settings.invertWheelZoom)
        .onChange((value) => void this.host.saveSettings({ invertWheelZoom: value })));

    this.slider(containerEl, "Minimum zoom", "The smallest scale the board may be shown at.",
      "minZoom", (value) => `${Math.round(value * 100)}%`);
    this.slider(containerEl, "Maximum zoom", "The largest scale the board may be shown at.",
      "maxZoom", (value) => `${Math.round(value * 100)}%`);

    new Setting(containerEl).setName("Panning").setHeading();

    this.slider(containerEl, "Pan step", "Board distance moved by one keyboard pan command.",
      "panStep", (value) => `${value} px`);
    this.slider(containerEl, "Fast pan multiplier", "Applied while Shift is held.",
      "fastPanMultiplier", (value) => `${value}×`);

    new Setting(containerEl)
      .setName("Keyboard shortcuts")
      .setDesc("Pan, zoom, minimap, review mode and lock are commands. Assign keys to them in Settings → Hotkeys, filtered by \"Miro Canvas\". No keys are bound by default, so nothing is taken from another plugin.")
      .addButton((button) => button
        .setButtonText("Open hotkeys")
        .onClick(() => {
          const setting = (this.app as unknown as {
            setting?: { open?: () => void; openTabById?: (id: string) => void };
          }).setting;
          setting?.open?.();
          setting?.openTabById?.("hotkeys");
        }));

    new Setting(containerEl).setName("Interface").setHeading();

    new Setting(containerEl)
      .setName("Show the minimap by default")
      .addToggle((toggle) => toggle
        .setValue(this.host.settings.minimapVisible)
        .onChange((value) => void this.host.saveSettings({ minimapVisible: value })));

    new Setting(containerEl)
      .setName("Selection toolbar")
      .setDesc("The formatting toolbar that floats above the selected element.")
      .addToggle((toggle) => toggle
        .setValue(this.host.settings.selectionToolbarEnabled)
        .onChange((value) => void this.host.saveSettings({ selectionToolbarEnabled: value })));

    new Setting(containerEl)
      .setName("Show diagnostics in the panel")
      .setDesc("Reports degraded or host-limited behavior instead of hiding it.")
      .addToggle((toggle) => toggle
        .setValue(this.host.settings.showDiagnostics)
        .onChange((value) => void this.host.saveSettings({ showDiagnostics: value })));
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
    setting.addSlider((slider) => slider
      .setLimits(bound.min, bound.max, bound.step)
      .setValue(value)
      .setDynamicTooltip()
      .onChange((next) => {
        setting.setDesc(`${description} Currently ${format(next)}.`);
        void this.host.saveSettings({ [key]: next } as Partial<MiroCanvasSettings>);
      }));
    setting.setDesc(`${description} Currently ${format(value)}.`);
  }
}
