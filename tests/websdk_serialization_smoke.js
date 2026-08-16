const fs = require("fs");
const vm = require("vm");

const exporterPath = process.argv[2];
if (!exporterPath) {
  throw new Error("exporter path is required");
}

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

const item = {
  id: "item-1",
  type: "shape",
  nan: Number.NaN,
  infinity: Number.POSITIVE_INFINITY,
  bigint: 42n,
  missing: undefined,
};
item.self = item;
Object.defineProperty(item, "__proto__", {
  enumerable: true,
  value: { preserved: true },
});

global.miro = {
  board: {
    get: async () => [item],
    getSelection: async () => [],
    getInfo: async () => ({ id: "board-1" }),
    notifications: { showInfo: async () => {} },
  },
};
global.window = { miro: global.miro };

vm.runInThisContext(fs.readFileSync(exporterPath, "utf8"), { filename: exporterPath });

(async () => {
  const exportBoard = listeners["export-board:click"];
  if (typeof exportBoard !== "function") {
    throw new Error("export-board click handler was not registered");
  }
  await exportBoard();
  const payload = JSON.parse(element("output").textContent);
  if (payload.completeness.capture_complete !== false) {
    throw new Error("lossy serialization was incorrectly declared complete");
  }
  const issues = payload.completeness.serialization.issues;
  const kinds = new Set(issues.map((issue) => issue.kind));
  for (const expected of ["non_finite_number", "bigint", "undefined", "circular_reference"]) {
    if (!kinds.has(expected)) {
      throw new Error(`missing serialization issue: ${expected}`);
    }
  }
  const errors = payload.completeness.serialization.errors;
  if (errors.length !== 1 || errors[0].kind !== "circular_reference") {
    throw new Error("JSON-preserving markers were incorrectly classified as errors");
  }
  if (
    payload.completeness.items.serialization_errors.length !== 1 ||
    !payload.completeness.items.serialization_errors[0].endsWith(":circular_reference")
  ) {
    throw new Error("item serialization errors do not isolate the lossy marker");
  }
  if (!payload.items[0].nan.__miro_export_serialization__) {
    throw new Error("non-finite value was not preserved as an explicit marker");
  }
  if (!payload.items[0].self.__miro_export_serialization__) {
    throw new Error("circular reference was not preserved as an explicit marker");
  }
  if (
    !Object.prototype.hasOwnProperty.call(payload.items[0], "__proto__") ||
    payload.items[0].__proto__.preserved !== true
  ) {
    throw new Error("enumerable __proto__ field was lost during serialization");
  }

  const safeItem = {
    id: "item-2",
    type: "shape",
    nan: Number.NaN,
    infinity: Number.POSITIVE_INFINITY,
    bigint: 42n,
    missing: undefined,
  };
  miro.board.get = async () => [safeItem];
  await exportBoard();
  const safePayload = JSON.parse(element("output").textContent);
  if (safePayload.completeness.capture_complete !== true) {
    throw new Error("marker-preserving serialization was incorrectly declared incomplete");
  }
  if (safePayload.completeness.items.serialization_errors.length !== 0) {
    throw new Error("marker-preserving serialization produced item errors");
  }
  if (safePayload.provenance.serialization.issue_count !== 4) {
    throw new Error("marker annotations were not retained in provenance");
  }
})().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
