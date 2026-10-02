/*
 * Miro2Obsidian handoff client: sends a finished Web SDK capture to the local
 * miro2obsidian server (same origin, loopback) and answers "does the local
 * program want a capture of this board right now?".
 *
 * Everything here fails soft: when /api/session is not reachable (server not
 * running, different host) the helpers report "no server" and the exporter
 * keeps its download/copy behaviour.
 */
(function () {
  const APP_NAME = "miro2obsidian-websdk";
  const PROTOCOL = 1;
  const TOKEN_HEADER = "X-Miro2Obsidian-Token";
  const root = typeof window !== "undefined" ? window : globalThis;
  const memoryLocks = new Set();

  async function getSession() {
    if (typeof fetch !== "function") {
      return null;
    }
    try {
      const response = await fetch("/api/session", {
        cache: "no-store",
        credentials: "same-origin",
      });
      if (!response.ok) {
        return null;
      }
      const data = await response.json();
      if (
        !data ||
        data.app !== APP_NAME ||
        data.protocol !== PROTOCOL ||
        typeof data.token !== "string" ||
        !data.token
      ) {
        return null;
      }
      return {
        token: data.token,
        pending: Array.isArray(data.pending) ? data.pending.map(String) : [],
        accepting: data.accepting !== false,
      };
    } catch (error) {
      return null;
    }
  }

  async function postCapture(session, payload) {
    try {
      const response = await fetch("/api/captures", {
        method: "POST",
        cache: "no-store",
        credentials: "same-origin",
        headers: {
          "Content-Type": "application/json",
          [TOKEN_HEADER]: session.token,
        },
        body: JSON.stringify(payload),
      });
      let data = null;
      try {
        data = await response.json();
      } catch (error) {
        data = null;
      }
      if (response.ok && data && data.status === "accepted") {
        return { ok: true, items: data.items, path: data.path, boardId: data.board_id };
      }
      return {
        ok: false,
        status: response.status,
        error: (data && data.error) || `HTTP ${response.status}`,
      };
    } catch (error) {
      return { ok: false, status: 0, error: String(error && error.message ? error.message : error) };
    }
  }

  async function getBoardId() {
    if (!root.miro || !root.miro.board || typeof root.miro.board.getInfo !== "function") {
      return "";
    }
    try {
      const info = await root.miro.board.getInfo();
      return info && info.id ? String(info.id) : "";
    } catch (error) {
      return "";
    }
  }

  function isPending(session, boardId) {
    return Boolean(session && boardId && session.pending.includes(boardId));
  }

  async function notify(message) {
    try {
      const board = root.miro && root.miro.board;
      if (board && board.notifications && typeof board.notifications.showInfo === "function") {
        await board.notifications.showInfo(message);
      }
    } catch (error) {
      // Notifications are optional.
    }
  }

  // At most one automatic export per board at a time, across the hidden app
  // frame and the panel (Web Locks are shared by same-origin frames).
  async function withExportLock(boardId, work) {
    const name = `miro2obsidian-export:${boardId}`;
    const locks = typeof navigator !== "undefined" ? navigator.locks : null;
    if (locks && typeof locks.request === "function") {
      return locks.request(name, { ifAvailable: true }, async (lock) => {
        if (!lock) {
          return { busy: true };
        }
        return { busy: false, value: await work() };
      });
    }
    if (memoryLocks.has(name)) {
      return { busy: true };
    }
    memoryLocks.add(name);
    try {
      return { busy: false, value: await work() };
    } finally {
      memoryLocks.delete(name);
    }
  }

  // Headless flow: if the local program asked for this board, export it and send it.
  async function runPendingExport() {
    const exporter = root.Miro2ObsidianExporter;
    if (!exporter) {
      return { state: "error", error: "exporter core is not loaded" };
    }
    const session = await getSession();
    if (!session || !session.accepting) {
      return { state: "no-server" };
    }
    const boardId = await getBoardId();
    if (!isPending(session, boardId)) {
      return { state: "not-pending", boardId };
    }
    const outcome = await withExportLock(boardId, async () => {
      await notify("miro2obsidian: exporting board…");
      let result;
      try {
        const payload = await exporter.exportBoard();
        result = await postCapture(session, payload);
      } catch (error) {
        result = { ok: false, error: String(error && error.message ? error.message : error) };
      }
      await notify(
        result.ok
          ? `miro2obsidian: board sent (${result.items} items)`
          : `miro2obsidian: export failed (${result.error})`
      );
      return result;
    });
    if (outcome.busy) {
      return { state: "busy", boardId };
    }
    const result = outcome.value;
    return result.ok
      ? { state: "sent", boardId, items: result.items }
      : { state: "error", boardId, error: result.error };
  }

  root.Miro2ObsidianHandoff = {
    getSession,
    postCapture,
    getBoardId,
    isPending,
    withExportLock,
    runPendingExport,
    notify,
  };
})();
