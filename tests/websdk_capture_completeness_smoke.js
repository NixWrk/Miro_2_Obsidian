const fs = require("fs");
const vm = require("vm");

const exporterPath = process.argv[2];
if (!exporterPath) {
  throw new Error("exporter path is required");
}
const exporterSource = fs.readFileSync(exporterPath, "utf8");

async function runScenario({ items, selection = [], boardInfo, includeGetInfo = true }) {
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
