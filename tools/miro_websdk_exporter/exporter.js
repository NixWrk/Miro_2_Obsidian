/*
 * Miro2Obsidian exporter panel: UI wiring around the capture core.
 * Requires exporter-core.js (window.Miro2ObsidianExporter) and, optionally,
 * handoff.js (window.Miro2ObsidianHandoff) for sending captures to the local
 * miro2obsidian server. Without the server it behaves as a plain download/copy tool.
 */
(function () {
  const exporter = window.Miro2ObsidianExporter;
  const handoff = window.Miro2ObsidianHandoff || null;
  if (!exporter) {
    throw new Error("exporter-core.js must be loaded before exporter.js");
  }

  const output = document.getElementById("output");
  const handoffStatus = document.getElementById("handoff-status");
  const createGeneratedProbeButton = document.getElementById("create-generated-probe");
  const exportBoardButton = document.getElementById("export-board");
  const exportSelectionButton = document.getElementById("export-selection");
  const downloadButton = document.getElementById("download-json");
  const copyButton = document.getElementById("copy-json");
  const sendButton = document.getElementById("send-to-app");

  let lastPayload = null;

  function setHandoffStatus(message) {
    if (handoffStatus) {
      handoffStatus.textContent = message;
    }
  }

  function setPayload(payload) {
    lastPayload = payload;
    output.textContent = JSON.stringify(payload, null, 2);
    downloadButton.disabled = false;
    copyButton.disabled = false;
    if (sendButton) {
      sendButton.disabled = payload.export_scope !== "board";
    }
  }

  async function sendPayload(payload, { automatic }) {
    if (!handoff || !payload || payload.export_scope !== "board") {
      return;
    }
    const session = await handoff.getSession();
    if (!session || !session.accepting) {
      setHandoffStatus(
        automatic
          ? "miro2obsidian server not detected. Use Download JSON or Copy JSON."
          : "miro2obsidian server not detected. Start it with: miro2obsidian websdk-serve"
      );
      return;
    }
    setHandoffStatus("Sending to miro2obsidian…");
    const result = await handoff.postCapture(session, payload);
    setHandoffStatus(
      result.ok
        ? `Sent to miro2obsidian ✓ (${result.items} items)`
        : `Not sent to miro2obsidian: ${result.error}. Use Download JSON as a fallback.`
    );
  }

  async function exportBoardAndSend() {
    const payload = await exporter.exportBoard();
    setPayload(payload);
    await sendPayload(payload, { automatic: true });
  }

  async function exportSelection() {
    setPayload(await exporter.exportSelection());
  }

  async function createGeneratedProbeItems() {
    setPayload(await exporter.createGeneratedProbeItems());
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
    if (sendButton) {
      sendButton.disabled = true;
    }
    try {
      await action();
      if (window.miro && miro.board && miro.board.notifications) {
        await miro.board.notifications.showInfo("Miro Web SDK export ready");
      }
    } catch (error) {
      output.textContent = String(error && error.stack ? error.stack : error);
    }
  }

  // Opened (usually via the app icon) while the local program waits for this board:
  // export and send without another click.
  async function autoRunIfPending() {
    if (!handoff || !window.miro || !miro.board) {
      return;
    }
    const session = await handoff.getSession();
    const boardId = await handoff.getBoardId();
    if (!handoff.isPending(session, boardId)) {
      return;
    }
    setHandoffStatus("miro2obsidian is waiting for this board. Exporting…");
    const outcome = await handoff.withExportLock(boardId, () => run(exportBoardAndSend));
    if (outcome.busy) {
      setHandoffStatus("The export is already running in the background; this panel will not repeat it.");
    }
  }

  createGeneratedProbeButton.addEventListener("click", () => run(createGeneratedProbeItems));
  exportBoardButton.addEventListener("click", () => run(exportBoardAndSend));
  exportSelectionButton.addEventListener("click", () => run(exportSelection));
  downloadButton.addEventListener("click", downloadJson);
  copyButton.addEventListener("click", copyJson);
  if (sendButton) {
    sendButton.addEventListener("click", () => sendPayload(lastPayload, { automatic: false }));
  }
  autoRunIfPending().catch((error) => {
    setHandoffStatus(`Automatic export check failed: ${error && error.message ? error.message : error}`);
  });
})();
