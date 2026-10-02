// Headless handoff smoke test: mocked `miro` and `fetch`, no network.
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const exporterPath = process.argv[2];
if (!exporterPath) {
  throw new Error("exporter path is required");
}
const dir = path.dirname(exporterPath);
const sources = ["exporter-core.js", "handoff.js"].map((name) => ({
  file: path.join(dir, name),
  code: fs.readFileSync(path.join(dir, name), "utf8"),
}));
const panelSource = fs.readFileSync(exporterPath, "utf8");

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function setup({ pending = ["board-1"], server = true, postStatus = 200, postBody, delay = null } = {}) {
  const calls = { session: 0, posts: [], notifications: [] };
  const listeners = {};
  const elements = new Map();
  function element(id) {
    if (!elements.has(id)) {
      elements.set(id, {
        disabled: false,
        textContent: "",
        addEventListener(event, callback) {
          listeners[`${id}:${event}`] = callback;
        },
      });
    }
    return elements.get(id);
  }
  global.document = { getElementById: element, createElement: () => ({ click() {} }) };
  global.navigator = { clipboard: { writeText: async () => {} } };
  global.fetch = async (url, options = {}) => {
    if (!server) {
      throw new TypeError("connection refused");
    }
    if (url === "/api/session") {
      calls.session += 1;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          app: "miro2obsidian-websdk",
          protocol: 1,
          token: "tok-123",
          pending,
          accepting: true,
        }),
      };
    }
    if (url === "/api/captures") {
      calls.posts.push({
        method: options.method,
        headers: options.headers,
        body: JSON.parse(options.body),
      });
      const body = postBody || {
        status: "accepted",
        board_id: "board-1",
        path: "x",
        items: JSON.parse(options.body).items.length,
      };
      return { ok: postStatus === 200, status: postStatus, json: async () => body };
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  global.miro = {
    board: {
      getInfo: async () => ({ id: "board-1" }),
      get: async () => {
        if (delay) {
          await delay;
        }
        return [{ id: "item-1", type: "shape" }];
      },
      getSelection: async () => [],
      notifications: { showInfo: async (message) => calls.notifications.push(message) },
    },
  };
  global.window = { miro: global.miro };
  for (const source of sources) {
    vm.runInThisContext(source.code, { filename: source.file });
  }
  return { calls, listeners, element };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

(async () => {
  // 1. Pending board: export headlessly and POST with the token.
  let env = setup();
  let result = await window.Miro2ObsidianHandoff.runPendingExport();
  assert(result.state === "sent" && result.items === 1, `expected sent, got ${JSON.stringify(result)}`);
  assert(env.calls.posts.length === 1, "expected exactly one POST");
  const post = env.calls.posts[0];
  assert(post.method === "POST", "capture must be POSTed");
  assert(post.headers["X-Miro2Obsidian-Token"] === "tok-123", "token header missing");
  assert(post.headers["Content-Type"] === "application/json", "content type missing");
  assert(post.body.export_scope === "board", "payload must be a whole-board export");
  assert(post.body.capture_profile === "maximum_board_v1", "payload profile changed");
  assert(post.body.board.id === "board-1", "payload board id changed");
  assert(env.calls.notifications.some((m) => m.includes("exporting board")), "start notification missing");
  assert(env.calls.notifications.some((m) => m.includes("sent")), "sent notification missing");

  // 2. Not pending: nothing is exported.
  env = setup({ pending: ["other-board"] });
  result = await window.Miro2ObsidianHandoff.runPendingExport();
  assert(result.state === "not-pending" && env.calls.posts.length === 0, "unexpected export");

  // 3. Server not reachable: do nothing special.
  env = setup({ server: false });
  result = await window.Miro2ObsidianHandoff.runPendingExport();
  assert(result.state === "no-server" && env.calls.notifications.length === 0, "unexpected reaction");

  // 4. Concurrent runs: only one export is performed.
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  env = setup({ delay: gate });
  const first = window.Miro2ObsidianHandoff.runPendingExport();
  await tick();
  const second = await window.Miro2ObsidianHandoff.runPendingExport();
  assert(second.state === "busy", `second run should be busy, got ${second.state}`);
  release();
  assert((await first).state === "sent", "first run should complete");
  assert(env.calls.posts.length === 1, "concurrent runs posted twice");

  // 5. Server rejection is reported, not thrown.
  env = setup({ postStatus: 400, postBody: { status: "rejected", error: "stale export" } });
  result = await window.Miro2ObsidianHandoff.runPendingExport();
  assert(result.state === "error" && result.error === "stale export", "rejection not reported");

  // 6. Panel: auto-run when pending, then manual flows.
  env = setup();
  vm.runInThisContext(panelSource, { filename: exporterPath });
  await tick();
  await tick();
  assert(env.calls.posts.length === 1, "panel did not auto-send a pending board");
  assert(
    env.element("handoff-status").textContent === "Sent to miro2obsidian ✓ (1 items)",
    `unexpected panel status: ${env.element("handoff-status").textContent}`
  );
  assert(JSON.parse(env.element("output").textContent).export_scope === "board", "panel output lost");

  // 7. Panel without a server keeps the download/copy behaviour.
  env = setup({ pending: [], server: false });
  vm.runInThisContext(panelSource, { filename: exporterPath });
  await env.listeners["export-board:click"]();
  assert(env.calls.posts.length === 0, "panel posted without a server");
  assert(env.element("handoff-status").textContent.includes("not detected"), "missing fallback hint");
  assert(env.element("download-json").disabled === false, "download must stay available");

  // 8. Panel with a server but nothing pending: a manual export is sent automatically,
  //    and the explicit button re-sends.
  env = setup({ pending: [] });
  vm.runInThisContext(panelSource, { filename: exporterPath });
  await tick();
  assert(env.calls.posts.length === 0, "panel exported without a request");
  await env.listeners["export-board:click"]();
  assert(env.calls.posts.length === 1, "manual export was not sent");
  assert(env.element("send-to-app").disabled === false, "send button should be enabled");
  await env.listeners["send-to-app:click"]();
  assert(env.calls.posts.length === 2, "explicit send button did nothing");

  // 9. Selection export is never sent.
  env = setup({ pending: [] });
  vm.runInThisContext(panelSource, { filename: exporterPath });
  await env.listeners["export-selection:click"]();
  assert(env.calls.posts.length === 0, "selection export must not be sent");
  assert(env.element("send-to-app").disabled === true, "send button must stay disabled for selections");
})().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
