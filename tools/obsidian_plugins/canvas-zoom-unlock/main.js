const { Notice, Plugin, PluginSettingTab, Setting } = require("obsidian");

const PATCH_KEY = "__canvasZoomUnlockPatch";

const DEFAULT_SETTINGS = {
  minTZoom: -12,
  maxTZoom: 8,
  wheelZoomStep: 0.25,
  wheelRequiresModifier: true,
  patchZoomToFit: true,
  forceUnclampedMode: true,
  debug: false,
};

function finiteNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function normalizeBBox(bbox) {
  if (!bbox) return null;
  const minX = finiteNumber(bbox.minX, NaN);
  const minY = finiteNumber(bbox.minY, NaN);
  const maxX = finiteNumber(bbox.maxX, NaN);
  const maxY = finiteNumber(bbox.maxY, NaN);
  if (![minX, minY, maxX, maxY].every(Number.isFinite)) return null;
  if (maxX <= minX || maxY <= minY) return null;
  return { minX, minY, maxX, maxY };
}

module.exports = class CanvasZoomUnlockPlugin extends Plugin {
  async onload() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    this.patchedPrototypes = [];
    this.patchedCanvases = new Set();
    this.originalScreenshotting = new WeakMap();

    this.addSettingTab(new CanvasZoomUnlockSettingTab(this.app, this));

    this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.patchAllCanvasViews()));
    this.registerEvent(this.app.workspace.on("layout-change", () => this.patchAllCanvasViews()));
    this.registerInterval(window.setInterval(() => this.patchAllCanvasViews(), 1000));

    this.addCommand({
      id: "zoom-in-unlocked",
      name: "Zoom in beyond Canvas limit",
      checkCallback: (checking) => this.withActiveCanvas(checking, (canvas) => this.adjustZoom(canvas, 1)),
    });
    this.addCommand({
      id: "zoom-out-unlocked",
      name: "Zoom out beyond Canvas limit",
      checkCallback: (checking) => this.withActiveCanvas(checking, (canvas) => this.adjustZoom(canvas, -1)),
    });
    this.addCommand({
      id: "zoom-to-fit-unlocked",
      name: "Zoom to fit without Canvas clamp",
      checkCallback: (checking) => this.withActiveCanvas(checking, (canvas) => this.zoomToCanvasContent(canvas)),
    });

    this.patchAllCanvasViews();
    new Notice("Canvas Zoom Unlock loaded");
  }

  onunload() {
    for (const { proto, originals } of this.patchedPrototypes.reverse()) {
      const patch = proto[PATCH_KEY];
      if (!patch || patch.plugin !== this) continue;
      for (const [name, original] of Object.entries(originals)) {
        proto[name] = original;
      }
      delete proto[PATCH_KEY];
    }
    this.restoreUnclampedMode();
  }

  async saveSettings() {
    await this.saveData(this.settings);
    if (!this.settings.forceUnclampedMode) this.restoreUnclampedMode();
    this.patchAllCanvasViews();
  }

  log(...args) {
    if (this.settings.debug) console.debug("[Canvas Zoom Unlock]", ...args);
  }

  clampTZoom(tZoom) {
    const minTZoom = Math.min(this.settings.minTZoom, this.settings.maxTZoom);
    const maxTZoom = Math.max(this.settings.minTZoom, this.settings.maxTZoom);
    return Math.min(maxTZoom, Math.max(minTZoom, finiteNumber(tZoom, 0)));
  }

  tZoomToScale(tZoom) {
    return Math.pow(2, this.clampTZoom(tZoom));
  }

  forceUnclamped(canvas) {
    if (this.settings.forceUnclampedMode) {
      if (!this.originalScreenshotting.has(canvas)) {
        this.originalScreenshotting.set(canvas, canvas.screenshotting);
      }
      canvas.screenshotting = true;
    }
  }

  restoreUnclampedMode() {
    for (const canvas of this.patchedCanvases) {
      if (!this.originalScreenshotting.has(canvas)) continue;
      canvas.screenshotting = this.originalScreenshotting.get(canvas);
    }
    this.originalScreenshotting = new WeakMap();
  }

  withActiveCanvas(checking, run) {
    const canvas = this.getActiveCanvas();
    if (checking) return !!canvas;
    if (!canvas) return false;
    run(canvas);
    return true;
  }

  getActiveCanvas() {
    const activeView = this.app.workspace.activeLeaf && this.app.workspace.activeLeaf.view;
    if (activeView && activeView.getViewType && activeView.getViewType() === "canvas" && activeView.canvas) {
      return activeView.canvas;
    }

    let found = null;
    this.app.workspace.iterateAllLeaves((leaf) => {
      if (found) return;
      const view = leaf.view;
      if (view && view.getViewType && view.getViewType() === "canvas" && view.canvas) {
        found = view.canvas;
      }
    });
    return found;
  }

  patchAllCanvasViews() {
    this.app.workspace.iterateAllLeaves((leaf) => {
      const view = leaf.view;
      if (!view || !view.getViewType || view.getViewType() !== "canvas" || !view.canvas) return;
      this.patchCanvas(view.canvas);
    });
  }

  patchCanvas(canvas) {
    if (!canvas) return;
    this.forceUnclamped(canvas);
    this.patchCanvasPrototype(Object.getPrototypeOf(canvas));

    if (this.patchedCanvases.has(canvas)) return;
    this.patchedCanvases.add(canvas);

    const target = canvas.wrapperEl || canvas.containerEl;
    if (target) {
      this.registerDomEvent(target, "wheel", (event) => this.onWheel(canvas, event), { capture: true });
    }
  }

  patchCanvasPrototype(proto) {
    if (!proto || proto[PATCH_KEY]) return;

    const originals = {};
    const plugin = this;

    if (typeof proto.setViewport === "function") {
      originals.setViewport = proto.setViewport;
      proto.setViewport = function patchedSetViewport(x, y, tZoom, ...rest) {
        const requestedTZoom = Number(tZoom);
        const hasRequestedZoom = Number.isFinite(requestedTZoom);
        const unclampedTZoom = hasRequestedZoom ? plugin.clampTZoom(requestedTZoom) : tZoom;
        const result = originals.setViewport.call(this, x, y, unclampedTZoom, ...rest);
        plugin.forceUnclamped(this);
        if (hasRequestedZoom && Math.abs(finiteNumber(this.tZoom, 0) - unclampedTZoom) > 1e-6) {
          this.tZoom = unclampedTZoom;
          this.zoom = plugin.tZoomToScale(unclampedTZoom);
          this.zoomCenter = null;
          if (typeof this.markViewportChanged === "function") this.markViewportChanged();
        }
        return result;
      };
    }

    if (typeof proto.zoomToBbox === "function") {
      originals.zoomToBbox = proto.zoomToBbox;
      proto.zoomToBbox = function patchedZoomToBbox(bbox, ...rest) {
        plugin.forceUnclamped(this);
        if (plugin.settings.patchZoomToFit && plugin.zoomToBboxUnlocked(this, bbox)) return;
        return originals.zoomToBbox.call(this, bbox, ...rest);
      };
    }

    if (typeof proto.zoomToRealBbox === "function") {
      originals.zoomToRealBbox = proto.zoomToRealBbox;
      proto.zoomToRealBbox = function patchedZoomToRealBbox(bbox, ...rest) {
        plugin.forceUnclamped(this);
        if (plugin.settings.patchZoomToFit && plugin.zoomToBboxUnlocked(this, bbox)) return;
        return originals.zoomToRealBbox.call(this, bbox, ...rest);
      };
    }

    proto[PATCH_KEY] = { plugin, originals };
    this.patchedPrototypes.push({ proto, originals });
    this.log("patched Canvas prototype", Object.keys(originals));
  }

  onWheel(canvas, event) {
    if (this.settings.wheelRequiresModifier && !(event.ctrlKey || event.metaKey || event.altKey)) return;

    const target = canvas.wrapperEl || canvas.containerEl;
    if (!target || typeof target.getBoundingClientRect !== "function") return;

    event.preventDefault();
    event.stopPropagation();
    this.forceUnclamped(canvas);

    const rect = target.getBoundingClientRect();
    const oldTZoom = finiteNumber(canvas.tZoom, 0);
    const oldScale = Math.pow(2, oldTZoom);
    const wheelMagnitude = Math.min(4, Math.max(0.25, Math.abs(event.deltaY || 1) / 100));
    const direction = event.deltaY > 0 ? -1 : 1;
    const newTZoom = this.clampTZoom(oldTZoom + direction * this.settings.wheelZoomStep * wheelMagnitude);
    const newScale = Math.pow(2, newTZoom);

    const localX = event.clientX - rect.left - rect.width / 2;
    const localY = event.clientY - rect.top - rect.height / 2;
    const sceneX = finiteNumber(canvas.tx, 0) + localX / oldScale;
    const sceneY = finiteNumber(canvas.ty, 0) + localY / oldScale;
    const tx = sceneX - localX / newScale;
    const ty = sceneY - localY / newScale;

    this.setViewportUnlocked(canvas, tx, ty, newTZoom);
  }

  adjustZoom(canvas, direction) {
    const target = canvas.wrapperEl || canvas.containerEl;
    this.forceUnclamped(canvas);
    const rect = target && target.getBoundingClientRect ? target.getBoundingClientRect() : null;
    const oldTZoom = finiteNumber(canvas.tZoom, 0);
    const newTZoom = this.clampTZoom(oldTZoom + direction * this.settings.wheelZoomStep);

    if (!rect) {
      this.setViewportUnlocked(canvas, finiteNumber(canvas.tx, 0), finiteNumber(canvas.ty, 0), newTZoom);
      return;
    }

    this.setViewportUnlocked(canvas, finiteNumber(canvas.tx, 0), finiteNumber(canvas.ty, 0), newTZoom);
  }

  setViewportUnlocked(canvas, tx, ty, tZoom) {
    const nextTZoom = this.clampTZoom(tZoom);
    if (typeof canvas.setViewport === "function") {
      canvas.setViewport(tx, ty, nextTZoom);
      return;
    }
    canvas.tx = tx;
    canvas.ty = ty;
    canvas.tZoom = nextTZoom;
    canvas.zoom = this.tZoomToScale(nextTZoom);
    canvas.zoomCenter = null;
    if (typeof canvas.markViewportChanged === "function") canvas.markViewportChanged();
  }

  zoomToBboxUnlocked(canvas, rawBBox) {
    const bbox = normalizeBBox(rawBBox);
    if (!bbox || !canvas.canvasRect || canvas.canvasRect.width === 0 || canvas.canvasRect.height === 0) return false;
    const widthZoom = canvas.canvasRect.width / (bbox.maxX - bbox.minX);
    const heightZoom = canvas.canvasRect.height / (bbox.maxY - bbox.minY);
    const scale = Math.min(widthZoom, heightZoom);
    if (!Number.isFinite(scale) || scale <= 0) return false;

    const tZoom = this.clampTZoom(Math.log2(scale));
    const tx = (bbox.minX + bbox.maxX) / 2;
    const ty = (bbox.minY + bbox.maxY) / 2;
    this.setViewportUnlocked(canvas, tx, ty, tZoom);
    return true;
  }

  getCanvasContentBBox(canvas) {
    if (!canvas || !canvas.nodes || typeof canvas.nodes.values !== "function") return null;
    const boxes = [];
    for (const node of canvas.nodes.values()) {
      let bbox = null;
      if (node && typeof node.getBBox === "function") {
        bbox = node.getBBox();
      } else if (node && typeof node.getData === "function") {
        const data = node.getData();
        if (data) {
          bbox = {
            minX: data.x,
            minY: data.y,
            maxX: data.x + data.width,
            maxY: data.y + data.height,
          };
        }
      }
      const normalized = normalizeBBox(bbox);
      if (normalized) boxes.push(normalized);
    }
    if (!boxes.length) return null;

    const padding = 120;
    return {
      minX: Math.min(...boxes.map((box) => box.minX)) - padding,
      minY: Math.min(...boxes.map((box) => box.minY)) - padding,
      maxX: Math.max(...boxes.map((box) => box.maxX)) + padding,
      maxY: Math.max(...boxes.map((box) => box.maxY)) + padding,
    };
  }

  zoomToCanvasContent(canvas) {
    const bbox = this.getCanvasContentBBox(canvas);
    if (!bbox) {
      new Notice("Canvas Zoom Unlock: no nodes to fit");
      return;
    }
    this.zoomToBboxUnlocked(canvas, bbox);
  }
};

class CanvasZoomUnlockSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "Canvas Zoom Unlock" });
    containerEl.createEl("p", {
      cls: "canvas-zoom-unlock-status",
      text: "Zoom scale is 2^tZoom. Example: -12 is about 1/4096, 8 is 256x.",
    });

    new Setting(containerEl)
      .setName("Minimum tZoom")
      .setDesc("How far Canvas may zoom out. More negative means smaller overview.")
      .addText((text) => text
        .setValue(String(this.plugin.settings.minTZoom))
        .onChange(async (value) => {
          this.plugin.settings.minTZoom = finiteNumber(value, DEFAULT_SETTINGS.minTZoom);
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("Maximum tZoom")
      .setDesc("How far Canvas may zoom in.")
      .addText((text) => text
        .setValue(String(this.plugin.settings.maxTZoom))
        .onChange(async (value) => {
          this.plugin.settings.maxTZoom = finiteNumber(value, DEFAULT_SETTINGS.maxTZoom);
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("Wheel zoom step")
      .setDesc("tZoom delta per modified wheel tick.")
      .addText((text) => text
        .setValue(String(this.plugin.settings.wheelZoomStep))
        .onChange(async (value) => {
          this.plugin.settings.wheelZoomStep = Math.max(0.01, finiteNumber(value, DEFAULT_SETTINGS.wheelZoomStep));
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("Wheel requires Ctrl/Alt/Meta")
      .setDesc("Keeps normal wheel/pan behavior intact. Disable only if you want this plugin to capture every wheel event.")
      .addToggle((toggle) => toggle
        .setValue(this.plugin.settings.wheelRequiresModifier)
        .onChange(async (value) => {
          this.plugin.settings.wheelRequiresModifier = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("Patch zoom to fit")
      .setDesc("Use unclamped zoom for Canvas zoom-to-fit / zoom-to-selection style calls.")
      .addToggle((toggle) => toggle
        .setValue(this.plugin.settings.patchZoomToFit)
        .onChange(async (value) => {
          this.plugin.settings.patchZoomToFit = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("Force internal unclamped mode")
      .setDesc("Sets canvas.screenshotting=true on Canvas views. This mirrors the workaround Advanced Canvas uses for unclamped presentation zoom.")
      .addToggle((toggle) => toggle
        .setValue(this.plugin.settings.forceUnclampedMode)
        .onChange(async (value) => {
          this.plugin.settings.forceUnclampedMode = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("Debug logging")
      .setDesc("Write patch diagnostics to the developer console.")
      .addToggle((toggle) => toggle
        .setValue(this.plugin.settings.debug)
        .onChange(async (value) => {
          this.plugin.settings.debug = value;
          await this.plugin.saveSettings();
        }));
  }
}
