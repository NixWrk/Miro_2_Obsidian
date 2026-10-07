const fs = require("fs");
const vm = require("vm");

const exporterPath = process.argv[2];
if (!exporterPath) {
  throw new Error("exporter path is required");
}
const exporterSource = fs.readFileSync(exporterPath, "utf8");

async function runScenario({ items, selection = [], boardInfo, includeGetInfo = true, boardMethods = {} }) {
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

  global.document = {
    getElementById: element,
    createElement() {
      return { click() {} };
    },
  };
  global.navigator = { clipboard: { writeText: async () => {} } };
  const board = {
    get: async () => items,
    getSelection: async () => selection,
    notifications: { showInfo: async () => {} },
    ...boardMethods,
  };
  if (includeGetInfo) {
    board.getInfo = async () => boardInfo;
  }
  global.miro = { board };
  global.window = { miro: global.miro };

  vm.runInThisContext(exporterSource, { filename: exporterPath });
  await listeners["export-board:click"]();
  return JSON.parse(element("output").textContent);
}

function requireIncludes(values, expected) {
  if (!values.includes(expected)) {
    throw new Error(`missing expected error: ${expected}`);
  }
}

(async () => {
  const validItem = { id: "item-1", type: "shape" };
  const calls = [];
  const enriched = await runScenario({
    items: [validItem, { id: "frame-1", type: "frame" }],
    boardInfo: { id: "board-1" },
    boardMethods: {
      experimental: { get: async ({ type }) => {
        calls.push(type);
        return type === "shape"
          ? [{ id: "item-1", type: "shape", content: "richer", style: { fillColor: "#123456" } }]
          : [{ id: "mind-1", type: "mindmap_node", nodeView: { content: "mind map" } }];
      } },
      getLayerIndex: async item => { calls.push(`layer:${item.id}`); return item.id === "item-1" ? 0 : 2; },
      getMetadata: async item => { calls.push(`metadata:${item.id}`); return { synthetic: false, empty: [] }; },
      getAppData: async () => ({ synthetic: "app-only" }),
    },
  });
  if (!enriched.completeness.capture_complete || enriched.items.length !== 3) throw new Error("enriched union incomplete");
  const shape = enriched.items.find(item => item.id === "item-1");
  if (shape.layerIndex !== 0 || shape.content !== "richer" || shape.appMetadata.synthetic !== false) throw new Error("enrichment values lost");
  if (!calls.includes("shape") || !calls.includes("mindmap_node") || calls.includes("layer:frame-1") || calls.includes("metadata:frame-1")) throw new Error("incorrect enrichment call inventory");
  const evidence = enriched.provenance.read_enrichment;
  const stableVariant = evidence.variants.find((v) => v.item_id === validItem.id && v.method === "miro.board.get");
  const experimentalVariant = evidence.variants.find((v) => v.item_id === validItem.id && v.method === "miro.board.experimental.get:shape");
  if (evidence.variants.length !== 3 || stableVariant.item.content !== undefined || experimentalVariant.item.content !== "richer") throw new Error("original SDK variants lost");
  if (evidence.app_data.synthetic !== "app-only" || evidence.app_metadata_scope !== "exporting_app_only") throw new Error("board app data provenance lost");
  const failedRead = await runScenario({
    items: [validItem], boardInfo: { id: "board-1" },
    boardMethods: { experimental: { get: async () => { throw new Error("synthetic read failed"); } } },
  });
  if (failedRead.completeness.capture_complete || failedRead.provenance.read_enrichment.complete) throw new Error("failed read claimed complete");
  const badLayer = await runScenario({
    items: [validItem], boardInfo: { id: "board-1" }, boardMethods: { getLayerIndex: async () => -1 },
  });
  if (badLayer.completeness.capture_complete) throw new Error("invalid layer claimed complete");
  const complete = await runScenario({
    items: [validItem],
    selection: [validItem],
    boardInfo: { id: "board-1" },
  });
  if (complete.completeness.capture_complete !== true) {
    throw new Error("valid capture was incorrectly declared incomplete");
  }
  if (complete.completeness.capture_errors.length !== 0) {
    throw new Error("valid capture contains structural errors");
  }

  const missingBoard = await runScenario({
    items: [validItem],
    includeGetInfo: false,
  });
  if (missingBoard.completeness.capture_complete !== false) {
    throw new Error("capture without board identity was incorrectly declared complete");
  }
  requireIncludes(missingBoard.completeness.capture_errors, "board_not_object");
  if (missingBoard.provenance.board.identity_complete !== false) {
    throw new Error("missing board identity was not recorded in provenance");
  }

  const invalidItems = await runScenario({
    items: [
      { id: "duplicate", type: "shape" },
      { id: "duplicate", type: "shape" },
      { type: "shape" },
      { id: "missing-type" },
      null,
    ],
    selection: [
      { id: "selection-duplicate", type: "shape" },
      { id: "selection-duplicate", type: "shape" },
    ],
    boardInfo: { id: "board-1" },
  });
  if (invalidItems.completeness.capture_complete !== false) {
    throw new Error("structurally invalid items were incorrectly declared complete");
  }
  const errors = invalidItems.completeness.capture_errors;
  for (const expected of [
    "item_1_duplicate_id:duplicate",
    "item_2_missing_id",
    "item_3_missing_type",
    "item_4_not_object",
    "selection_item_1_duplicate_id:selection-duplicate",
  ]) {
    requireIncludes(errors, expected);
  }
})().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
