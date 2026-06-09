(function () {
  const output = document.getElementById("output");
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

  exportBoardButton.addEventListener("click", () => run(exportBoard));
  exportSelectionButton.addEventListener("click", () => run(exportSelection));
  downloadButton.addEventListener("click", downloadJson);
  copyButton.addEventListener("click", copyJson);
})();
