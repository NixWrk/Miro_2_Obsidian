(function () {
  const output = document.getElementById("output");
  const createGeneratedProbeButton = document.getElementById("create-generated-probe");
  const exportBoardButton = document.getElementById("export-board");
  const exportSelectionButton = document.getElementById("export-selection");
  const downloadButton = document.getElementById("download-json");
  const copyButton = document.getElementById("copy-json");

  let lastPayload = null;

  function toPlain(value, seen) {
    if (value === null || typeof value !== "object") {
      if (typeof value === "function") {
        return undefined;
      }
      return value;
    }

    if (!seen) {
      seen = new WeakSet();
    }
    if (seen.has(value)) {
      return "[Circular]";
    }
    seen.add(value);

    if (Array.isArray(value)) {
      return value.map((item) => toPlain(item, seen)).filter((item) => item !== undefined);
    }

    const plain = {};
    for (const key of Object.keys(value)) {
      const converted = toPlain(value[key], seen);
      if (converted !== undefined) {
        plain[key] = converted;
      }
    }
    return plain;
  }

  function summarize(items) {
    const byType = {};
    for (const item of items) {
      const type = item.type || item.itemType || "unknown";
      byType[type] = (byType[type] || 0) + 1;
    }
    return {
      total: items.length,
      by_type: byType,
    };
  }

  function setPayload(payload) {
    lastPayload = payload;
    output.textContent = JSON.stringify(payload, null, 2);
    downloadButton.disabled = false;
    copyButton.disabled = false;
  }

  function assertMiroReady() {
    if (!window.miro || !window.miro.board) {
      throw new Error("Miro Web SDK is not available. Open this page as a Miro app.");
    }
  }

  function requireBoardMethod(name) {
    if (typeof miro.board[name] !== "function") {
      throw new Error(`miro.board.${name} is not available in this Web SDK runtime`);
    }
    return miro.board[name].bind(miro.board);
  }

  async function getBoardInfo() {
    if (typeof miro.board.getInfo !== "function") {
      return null;
    }
    return toPlain(await miro.board.getInfo());
  }

  async function exportBoard() {
    assertMiroReady();
    const items = await miro.board.get();
    const selection = await miro.board.getSelection();
    const plainItems = items.map((item) => toPlain(item));
    const payload = {
      schema_version: 1,
      source_surface: "web_sdk",
      export_scope: "board",
      exported_at: new Date().toISOString(),
      board: await getBoardInfo(),
      items: plainItems,
      selection: selection.map((item) => toPlain(item)),
      summary: summarize(plainItems),
    };
    setPayload(payload);
  }

  async function createGeneratedProbeItems() {
    assertMiroReady();
    const created = [];
    const failures = [];

    async function create(probeType, action) {
      try {
        const item = await action();
        created.push({ probe_type: probeType, item: toPlain(item) });
        return item;
      } catch (error) {
        failures.push({
          probe_type: probeType,
          error: String(error && error.message ? error.message : error),
        });
        return null;
      }
    }

    const x = 0;
    const y = 2600;
    const tag = await create("tag", () =>
      requireBoardMethod("createTag")({
        title: "miro2obsidian-probe",
        color: "yellow",
      })
    );
    await create("tagged_sticky_note", () =>
      requireBoardMethod("createStickyNote")({
        content: "Sticky note with a Web SDK-created tag",
        tagIds: tag ? [tag.id] : [],
        x,
        y,
        width: 260,
      })
    );
    await create("embed", () =>
      requireBoardMethod("createEmbed")({
        url: "https://youtu.be/aqz-KE-bpKQ",
        previewUrl: "https://miro.com/blog/wp-content/uploads/2020/10/organize-their-Miro-boards-for-trainings-and-workshops-FB.png",
        mode: "modal",
        width: 640,
        height: 360,
        x: x + 460,
        y,
      })
    );
    await create("image", () =>
      requireBoardMethod("createImage")({
        title: "miro2obsidian image probe",
        url: "https://miro.com/blog/wp-content/uploads/2023/10/Frame-12772209-1536x806.png",
        x: x + 1120,
        y,
        width: 420,
      })
    );
    await create("preview", () =>
      requireBoardMethod("createPreview")({
        url: "https://miro.com/",
        x: x + 1640,
        y,
        width: 400,
      })
    );

    const shape = await create("group_shape", () =>
      requireBoardMethod("createShape")({
        content: "Grouped shape",
        x,
        y: y + 520,
        width: 220,
        height: 120,
      })
    );
    const card = await create("group_card", () =>
      requireBoardMethod("createCard")({
        title: "Grouped card",
        x: x + 280,
        y: y + 520,
        width: 260,
      })
    );
    const text = await create("group_text", () =>
      requireBoardMethod("createText")({
        content: "<p>Grouped text</p>",
        x: x + 620,
        y: y + 520,
        width: 260,
      })
    );
    const groupItems = [shape, card, text].filter(Boolean);
    if (groupItems.length >= 2) {
      await create("group", () => requireBoardMethod("group")({ items: groupItems }));
    }

    const plainItems = created.map((entry) => ({
      probe_type: entry.probe_type,
      ...entry.item,
    }));
    const payload = {
      schema_version: 1,
      source_surface: "web_sdk",
      export_scope: "generated_probe",
      exported_at: new Date().toISOString(),
      board: await getBoardInfo(),
      items: plainItems,
      failures,
      summary: summarize(plainItems),
    };
    setPayload(payload);
  }

  async function exportSelection() {
    assertMiroReady();
    const selection = await miro.board.getSelection();
    const plainItems = selection.map((item) => toPlain(item));
    const payload = {
      schema_version: 1,
      source_surface: "web_sdk",
      export_scope: "selection",
      exported_at: new Date().toISOString(),
      board: await getBoardInfo(),
      items: plainItems,
      selection: plainItems,
      summary: summarize(plainItems),
    };
    setPayload(payload);
  }

  function downloadJson() {
    if (!lastPayload) {
      return;
    }
    const blob = new Blob([JSON.stringify(lastPayload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `miro-websdk-export-${lastPayload.export_scope}-${Date.now()}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  async function copyJson() {
    if (!lastPayload) {
      return;
    }
    await navigator.clipboard.writeText(JSON.stringify(lastPayload, null, 2));
    if (window.miro && miro.board && miro.board.notifications) {
      await miro.board.notifications.showInfo("Miro Web SDK export copied");
    }
  }

  async function run(action) {
    output.textContent = "Exporting...";
    downloadButton.disabled = true;
    copyButton.disabled = true;
    try {
      await action();
      if (window.miro && miro.board && miro.board.notifications) {
        await miro.board.notifications.showInfo("Miro Web SDK export ready");
      }
    } catch (error) {
      output.textContent = String(error && error.stack ? error.stack : error);
    }
  }

  createGeneratedProbeButton.addEventListener("click", () => run(createGeneratedProbeItems));
  exportBoardButton.addEventListener("click", () => run(exportBoard));
  exportSelectionButton.addEventListener("click", () => run(exportSelection));
  downloadButton.addEventListener("click", downloadJson);
  copyButton.addEventListener("click", copyJson);
})();
