(function () {
  const output = document.getElementById("output");
  const createGeneratedProbeButton = document.getElementById("create-generated-probe");
  const exportBoardButton = document.getElementById("export-board");
  const exportSelectionButton = document.getElementById("export-selection");
  const downloadButton = document.getElementById("download-json");
  const copyButton = document.getElementById("copy-json");

  let lastPayload = null;

  const ONE_PIXEL_PNG_DATA_URL =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";

  const PROBE_IMAGE_URL = "https://miro.com/blog/wp-content/uploads/2023/10/Frame-12772209-1536x806.png";
  const PROBE_PREVIEW_URL =
    "https://miro.com/blog/wp-content/uploads/2020/10/organize-their-Miro-boards-for-trainings-and-workshops-FB.png";

  const WEBSDK_SHAPE_TYPES = [
    "rectangle",
    "round_rectangle",
    "circle",
    "triangle",
    "rhombus",
    "parallelogram",
    "trapezoid",
    "pentagon",
    "hexagon",
    "octagon",
    "wedge_round_rectangle_callout",
    "star",
    "flow_chart_predefined_process",
    "cloud",
    "cross",
    "can",
    "right_arrow",
    "left_arrow",
    "left_right_arrow",
    "left_brace",
    "right_brace",
  ];

  const STICKY_COLORS = [
    "light_yellow",
    "yellow",
    "orange",
    "red",
    "light_pink",
    "pink",
    "light_blue",
    "violet",
    "blue",
    "dark_blue",
    "cyan",
    "dark_green",
    "light_green",
    "green",
    "white",
    "black",
  ];

  const CONNECTOR_SHAPES = ["straight", "elbowed", "curved"];
  const CONNECTOR_CAPS = [
    "none",
    "stealth",
    "rounded_stealth",
    "arrow",
    "filled_triangle",
    "triangle",
    "filled_diamond",
    "diamond",
    "filled_oval",
    "oval",
    "erd_one",
    "erd_many",
    "erd_one_or_many",
    "erd_only_one",
    "erd_zero_or_many",
    "erd_zero_or_one",
  ];

  const TABLE_DIAGNOSTIC_TYPES = new Set(["table", "table_text", "data_table_format"]);
  const TABLE_DIAGNOSTIC_KNOWN_FIELDS = [
    "content",
    "text",
    "title",
    "plainText",
    "plain_text",
    "description",
    "value",
    "html",
    "data",
    "rows",
    "columns",
    "cells",
    "table",
    "tableData",
    "cell",
    "parent",
    "parentId",
    "x",
    "y",
    "width",
    "height",
  ];

  function gridPosition(index, origin, columns, gapX, gapY) {
    return {
      x: origin.x + (index % columns) * gapX,
      y: origin.y + Math.floor(index / columns) * gapY,
    };
  }

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

  function valuePreview(value) {
    if (typeof value === "function") {
      return undefined;
    }
    let converted;
    try {
      converted = toPlain(value);
    } catch (error) {
      return {
        error: String(error && error.message ? error.message : error),
      };
    }
    if (converted === undefined) {
      return undefined;
    }
    const asJson = JSON.stringify(converted);
    if (asJson && asJson.length > 1600) {
      return {
        preview: asJson.slice(0, 1600),
        truncated: true,
      };
    }
    return converted;
  }

  function readPropertySafely(target, key) {
    try {
      return {
        ok: true,
        value: valuePreview(target[key]),
      };
    } catch (error) {
      return {
        ok: false,
        error: String(error && error.message ? error.message : error),
      };
    }
  }

  function descriptorSummary(target, key, descriptor) {
    const summary = {
      key,
      enumerable: Boolean(descriptor.enumerable),
      configurable: Boolean(descriptor.configurable),
      has_getter: typeof descriptor.get === "function",
      has_setter: typeof descriptor.set === "function",
      value_type: descriptor.value === undefined ? undefined : typeof descriptor.value,
    };
    if ("writable" in descriptor) {
      summary.writable = Boolean(descriptor.writable);
    }
    if (summary.has_getter) {
      summary.getter_read = readPropertySafely(target, key);
    } else if (typeof descriptor.value !== "function") {
      summary.value_preview = valuePreview(descriptor.value);
    }
    return summary;
  }

  function prototypeName(proto) {
    if (!proto) {
      return null;
    }
    if (proto.constructor && proto.constructor.name) {
      return proto.constructor.name;
    }
    return Object.prototype.toString.call(proto);
  }

  function findTextishValues(value, path, out, seen) {
    if (!value || typeof value !== "object") {
      return;
    }
    if (!seen) {
      seen = new WeakSet();
    }
    if (seen.has(value)) {
      return;
    }
    seen.add(value);

    if (Array.isArray(value)) {
      value.forEach((entry, index) => findTextishValues(entry, `${path}[${index}]`, out, seen));
      return;
    }

    for (const key of Object.keys(value)) {
      const nestedPath = path ? `${path}.${key}` : key;
      const nested = value[key];
      if (
        ["content", "text", "title", "plainText", "plain_text", "description", "value", "html"].includes(key) &&
        String(nested || "").trim()
      ) {
        out.push({ path: nestedPath, value: String(nested) });
      }
      findTextishValues(nested, nestedPath, out, seen);
    }
  }

  function deepInspectTableLikeItem(item) {
    const itemType = item && (item.type || item.itemType || item.kind);
    const diagnostic = {
      item_id: item && item.id ? String(item.id) : "",
      item_type: itemType || "unknown",
      enumerable_keys: Object.keys(item || {}),
      own_property_names: [],
      known_field_reads: {},
      prototype_chain: [],
      textish_values: [],
    };

    if (!item || typeof item !== "object") {
      return diagnostic;
    }

    diagnostic.own_property_names = Object.getOwnPropertyNames(item);
    for (const key of TABLE_DIAGNOSTIC_KNOWN_FIELDS) {
      diagnostic.known_field_reads[key] = readPropertySafely(item, key);
    }

    let proto = item;
    let depth = 0;
    while (proto && depth < 6) {
      const names = Object.getOwnPropertyNames(proto).sort();
      diagnostic.prototype_chain.push({
        depth,
        name: prototypeName(proto),
        property_names: names,
        descriptors: names.map((key) => descriptorSummary(item, key, Object.getOwnPropertyDescriptor(proto, key))),
      });
      proto = Object.getPrototypeOf(proto);
      depth += 1;
    }

    const plain = toPlain(item);
    findTextishValues(plain, "", diagnostic.textish_values);
    return diagnostic;
  }

  function buildDiagnostics(items) {
    const tableLike = [];
    for (const item of items) {
      const itemType = item && (item.type || item.itemType || item.kind);
      if (TABLE_DIAGNOSTIC_TYPES.has(itemType)) {
        tableLike.push(deepInspectTableLikeItem(item));
      }
    }
    return {
      table_like_items: tableLike,
    };
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

  function requireExperimentalMethod(name) {
    if (!miro.board.experimental || typeof miro.board.experimental[name] !== "function") {
      throw new Error(`miro.board.experimental.${name} is not available in this Web SDK runtime`);
    }
    return miro.board.experimental[name].bind(miro.board.experimental);
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
      diagnostics: buildDiagnostics(items),
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

    async function attempt(probeType, action) {
      try {
        await action();
        return true;
      } catch (error) {
        failures.push({
          probe_type: probeType,
          error: String(error && error.message ? error.message : error),
        });
        return false;
      }
    }

    const rootX = -2400;
    const rootY = 2600;
    const tag = await create("tag_todo", () =>
      requireBoardMethod("createTag")({
        title: "miro2obsidian-todo",
        color: "yellow",
      })
    );
    const urgentTag = await create("tag_urgent", () =>
      requireBoardMethod("createTag")({
        title: "miro2obsidian-urgent",
        color: "magenta",
      })
    );

    const textProbes = [
      {
        key: "text_plain",
        content: "<p>Web SDK plain text probe</p>",
        width: 320,
        style: { fontSize: 20, textAlign: "left" },
      },
      {
        key: "text_rich",
        content:
          "<p><strong>Rich text</strong><br/><em>italic</em>, <u>underline</u>, <s>strike</s>, <a href='https://miro.com/'>link</a></p>",
        width: 420,
        style: { fontSize: 18, textAlign: "left" },
      },
      {
        key: "text_link_only",
        content: "<p><a href='https://www.youtube.com/watch?v=aqz-KE-bpKQ'>YouTube link text probe</a></p>",
        width: 380,
        style: { fontSize: 18, textAlign: "left" },
      },
      {
        key: "text_rotated",
        content: "<p>Rotated text probe</p>",
        width: 280,
        rotation: 12,
        style: { fontSize: 18, textAlign: "center" },
      },
    ];
    for (const [index, probe] of textProbes.entries()) {
      const position = gridPosition(index, { x: rootX, y: rootY }, 4, 460, 190);
      await create(probe.key, () =>
        requireBoardMethod("createText")({
          content: probe.content,
          x: position.x,
          y: position.y,
          width: probe.width,
          rotation: probe.rotation || 0,
          style: probe.style,
        })
      );
    }

    const frame = await create("frame_16x9", () =>
      requireBoardMethod("createFrame")({
        title: "Web SDK frame 16:9",
        x: rootX + 1760,
        y: rootY + 120,
        width: 760,
        height: 428,
        style: { fillColor: "#ffffff" },
      })
    );
    const frameChild = await create("frame_child_text", () =>
      requireBoardMethod("createText")({
        content: "<p>Child text added to a frame</p>",
        x: rootX + 1540,
        y: rootY + 70,
        width: 300,
      })
    );
    if (frame && frameChild) {
      await attempt("frame_add_child_text", () => frame.add(frameChild));
    }

    const shapeItems = [];
    for (const [index, shapeType] of WEBSDK_SHAPE_TYPES.entries()) {
      const position = gridPosition(index, { x: rootX, y: rootY + 620 }, 7, 280, 180);
      const item = await create(`shape_${shapeType}`, () =>
        requireBoardMethod("createShape")({
          content: `<p>${shapeType}</p>`,
          shape: shapeType,
          x: position.x,
          y: position.y,
          width: 220,
          height: 120,
          rotation: index === 0 ? 8 : 0,
          style: {
            color: "#1a1a1a",
            fillColor: index % 2 === 0 ? "#FBE983" : "#D6EFFF",
            fillOpacity: 0.9,
            borderColor: "#4262ff",
            borderWidth: 2,
            textAlign: "center",
            textAlignVertical: "middle",
          },
        })
      );
      if (item) {
        shapeItems.push(item);
      }
    }

    for (const [index, color] of STICKY_COLORS.entries()) {
      const position = gridPosition(index, { x: rootX, y: rootY + 1280 }, 8, 260, 210);
      await create(`sticky_${color}`, () =>
        requireBoardMethod("createStickyNote")({
          content: `Sticky ${color}`,
          tagIds: tag ? [tag.id] : [],
          shape: index % 2 === 0 ? "square" : "rectangle",
          x: position.x,
          y: position.y,
          width: index % 2 === 0 ? 180 : 240,
          style: {
            fillColor: color,
            textAlign: "center",
            textAlignVertical: "middle",
          },
        })
      );
    }

    const cardTagIds = [tag, urgentTag].filter(Boolean).map((item) => item.id);
    await create("card_full", () =>
      requireBoardMethod("createCard")({
        title: "Web SDK card with status, dates, tags, fields",
        description: "<p>Card description with <strong>HTML</strong> and list:</p><ul><li>one</li><li>two</li></ul>",
        taskStatus: "in-progress",
        startDate: "2026-06-10",
        dueDate: "2026-06-30",
        fields: [
          { value: "High", fillColor: "#FBE983", textColor: "#503000", tooltip: "Priority" },
          { value: "Owner", fillColor: "#bef2f2", textColor: "#0713FF", tooltip: "Role" },
        ],
        tagIds: cardTagIds,
        x: rootX,
        y: rootY + 1840,
        width: 360,
      })
    );
    await create("card_minimal", () =>
      requireBoardMethod("createCard")({
        title: "Minimal Web SDK card",
        x: rootX + 420,
        y: rootY + 1840,
        width: 320,
      })
    );
    await create("app_card_fields", () =>
      requireBoardMethod("createAppCard")({
        title: "Web SDK app card with fields",
        description: "App card preview fields should be exported.",
        status: "connected",
        style: { cardTheme: "#2d9bf0" },
        fields: [
          {
            value: "Owner",
            iconUrl: "https://cdn-icons-png.flaticon.com/512/921/921124.png",
            iconShape: "round",
            fillColor: "#FBE983",
            textColor: "#F83A22",
            tooltip: "Owner field",
          },
          {
            value: "Timeline",
            iconUrl: "https://cdn-icons-png.flaticon.com/512/3094/3094861.png",
            iconShape: "square",
            fillColor: "#F8D878",
            textColor: "#503000",
            tooltip: "Timeline field",
          },
        ],
        x: rootX + 820,
        y: rootY + 1840,
        width: 360,
      })
    );

    const connectorStart = shapeItems[0];
    const connectorEnd = shapeItems[1];
    if (connectorStart && connectorEnd) {
      for (const [index, connectorShape] of CONNECTOR_SHAPES.entries()) {
        await create(`connector_${connectorShape}`, () =>
          requireBoardMethod("createConnector")({
            shape: connectorShape,
            start: { item: connectorStart.id, snapTo: "right" },
            end: { item: connectorEnd.id, snapTo: "left" },
            captions: [
              {
                content: `${connectorShape} connector`,
                position: 0.5,
                textAlignVertical: "bottom",
              },
            ],
            style: {
              startStrokeCap: CONNECTOR_CAPS[index],
              endStrokeCap: CONNECTOR_CAPS[index + 1],
              strokeStyle: index === 1 ? "dashed" : index === 2 ? "dotted" : "normal",
              strokeColor: index === 0 ? "#4262ff" : index === 1 ? "#ff00ff" : "#00aa55",
              strokeWidth: 2 + index,
            },
          })
        );
      }
    }
    for (const [index, cap] of CONNECTOR_CAPS.entries()) {
      const start = shapeItems[(index * 2) % shapeItems.length];
      const end = shapeItems[(index * 2 + 1) % shapeItems.length];
      if (!start || !end) {
        continue;
      }
      await create(`connector_cap_${cap}`, () =>
        requireBoardMethod("createConnector")({
          shape: "curved",
          start: { item: start.id, snapTo: "bottom" },
          end: { item: end.id, snapTo: "top" },
          style: {
            startStrokeCap: cap,
            endStrokeCap: cap,
            strokeColor: "#555555",
            strokeStyle: index % 2 === 0 ? "normal" : "dashed",
            strokeWidth: 1,
          },
        })
      );
    }

    await create("tagged_sticky_note", () =>
      requireBoardMethod("createStickyNote")({
        content: "Sticky note with a Web SDK-created tag",
        tagIds: tag ? [tag.id] : [],
        x: rootX + 1240,
        y: rootY + 1840,
        width: 260,
      })
    );
    await create("embed_modal", () =>
      requireBoardMethod("createEmbed")({
        url: "https://youtu.be/aqz-KE-bpKQ",
        previewUrl: PROBE_PREVIEW_URL,
        mode: "modal",
        width: 640,
        height: 360,
        x: rootX + 1600,
        y: rootY + 1840,
      })
    );
    await create("embed_inline", () =>
      requireBoardMethod("createEmbed")({
        url: "https://miro.com/",
        mode: "inline",
        width: 480,
        height: 270,
        x: rootX + 2260,
        y: rootY + 1840,
      })
    );
    await create("image_url", () =>
      requireBoardMethod("createImage")({
        title: "miro2obsidian image probe",
        url: PROBE_IMAGE_URL,
        alt: "Miro image probe from absolute URL",
        x: rootX,
        y: rootY + 2320,
        width: 420,
      })
    );
    await create("image_data_url", () =>
      requireBoardMethod("createImage")({
        title: "miro2obsidian data URL image probe",
        url: ONE_PIXEL_PNG_DATA_URL,
        alt: "Miro image probe from data URL",
        x: rootX + 520,
        y: rootY + 2320,
        width: 180,
      })
    );
    await create("preview_miro", () =>
      requireBoardMethod("createPreview")({
        url: "https://miro.com/",
        x: rootX + 920,
        y: rootY + 2320,
        width: 400,
      })
    );
    await create("preview_youtube", () =>
      requireBoardMethod("createPreview")({
        url: "https://www.youtube.com/watch?v=aqz-KE-bpKQ",
        x: rootX + 1420,
        y: rootY + 2320,
        width: 400,
      })
    );

    const mindmapRoot = await create("mindmap_node_root", () =>
      requireExperimentalMethod("createMindmapNode")({
        nodeView: {
          type: "shape",
          content: "<p>Mind map root</p>",
          shape: "round_rectangle",
          style: { color: "#1a85ff", fillOpacity: 0.12 },
        },
        x: rootX + 2040,
        y: rootY + 2320,
      })
    );
    const mindmapChildA = await create("mindmap_node_child_a", () =>
      requireExperimentalMethod("createMindmapNode")({
        nodeView: {
          type: "text",
          content: "<p>Mind map child A</p>",
        },
        x: rootX + 1780,
        y: rootY + 2520,
      })
    );
    const mindmapChildB = await create("mindmap_node_child_b", () =>
      requireExperimentalMethod("createMindmapNode")({
        nodeView: {
          type: "text",
          content: "<p>Mind map child B</p>",
        },
        x: rootX + 2300,
        y: rootY + 2520,
      })
    );
    if (mindmapRoot && mindmapChildA) {
      await attempt("mindmap_node_add_child_a", () => mindmapRoot.add(mindmapChildA));
    }
    if (mindmapRoot && mindmapChildB) {
      await attempt("mindmap_node_add_child_b", () => mindmapRoot.add(mindmapChildB));
    }

    const shape = await create("group_shape", () =>
      requireBoardMethod("createShape")({
        content: "Grouped shape",
        x: rootX + 2720,
        y: rootY + 2320,
        width: 220,
        height: 120,
      })
    );
    const card = await create("group_card", () =>
      requireBoardMethod("createCard")({
        title: "Grouped card",
        x: rootX + 3000,
        y: rootY + 2320,
        width: 260,
      })
    );
    const text = await create("group_text", () =>
      requireBoardMethod("createText")({
        content: "<p>Grouped text</p>",
        x: rootX + 3340,
        y: rootY + 2320,
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
      diagnostics: buildDiagnostics(selection),
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
