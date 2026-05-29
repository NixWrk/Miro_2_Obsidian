(function () {
  const fileInput = document.getElementById("canvas-file");
  const viewport = document.getElementById("viewport");
  const stage = document.getElementById("stage");
  const nodesLayer = document.getElementById("nodes");
  const edgesLayer = document.getElementById("edges");
  const nodeCount = document.getElementById("node-count");
  const edgeCount = document.getElementById("edge-count");
  const bboxValue = document.getElementById("bbox-value");
  const messages = document.getElementById("messages");

  function asNumber(value, fallback) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  function nodeRect(node) {
    const x = asNumber(node.x, 0);
    const y = asNumber(node.y, 0);
    const width = Math.max(1, asNumber(node.width, 1));
    const height = Math.max(1, asNumber(node.height, 1));
    return { x, y, width, height, cx: x + width / 2, cy: y + height / 2 };
  }

  function computeBBox(nodes) {
    if (!nodes.length) {
      return { x: 0, y: 0, width: 1, height: 1 };
    }
    const rects = nodes.map(nodeRect);
    const minX = Math.min(...rects.map((r) => r.x));
    const minY = Math.min(...rects.map((r) => r.y));
    const maxX = Math.max(...rects.map((r) => r.x + r.width));
    const maxY = Math.max(...rects.map((r) => r.y + r.height));
    return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
  }

  function clear() {
    nodesLayer.replaceChildren();
    edgesLayer.replaceChildren();
  }

  function setMessage(text, isError) {
    messages.textContent = text;
    messages.style.color = isError ? "#ffb4ab" : "";
    document.body.dataset.renderStatus = isError ? "error" : "ready";
    document.body.dataset.renderMessage = text;
  }

  function renderNode(node, offset) {
    const rect = nodeRect(node);
    const el = document.createElement("div");
    const type = String(node.type || "unknown");
    el.className = `node ${type}`;
    el.style.left = `${rect.x + offset.x}px`;
    el.style.top = `${rect.y + offset.y}px`;
    el.style.width = `${rect.width}px`;
    el.style.height = `${rect.height}px`;
    el.dataset.nodeId = String(node.id || "");

    if (type === "text") {
      el.innerHTML = node.text || "";
    } else if (type === "link") {
      const label = document.createElement("span");
      label.className = "node-label";
      label.textContent = node.url || "(empty link)";
      el.appendChild(label);
    } else if (type === "file") {
      const label = document.createElement("span");
      label.className = "node-label";
      label.textContent = node.file || "(empty file)";
      el.appendChild(label);
    } else if (type === "group") {
      const label = document.createElement("span");
      label.className = "node-label";
      label.textContent = node.label || node.id || "group";
      el.appendChild(label);
    } else {
      const label = document.createElement("span");
      label.className = "node-label";
      label.textContent = `${type}: ${node.id || ""}`;
      el.appendChild(label);
    }

    nodesLayer.appendChild(el);
  }

  function renderEdges(edges, nodeMap, offset) {
    for (const edge of edges) {
      const from = nodeMap.get(String(edge.fromNode));
      const to = nodeMap.get(String(edge.toNode));
      if (!from || !to) {
        continue;
      }
      const fromRect = nodeRect(from);
      const toRect = nodeRect(to);
      const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
      line.classList.add("edge");
      line.setAttribute("x1", String(fromRect.cx + offset.x));
      line.setAttribute("y1", String(fromRect.cy + offset.y));
      line.setAttribute("x2", String(toRect.cx + offset.x));
      line.setAttribute("y2", String(toRect.cy + offset.y));
      edgesLayer.appendChild(line);
    }
  }

  function renderCanvas(canvas) {
    clear();
    const nodes = Array.isArray(canvas.nodes) ? canvas.nodes : [];
    const edges = Array.isArray(canvas.edges) ? canvas.edges : [];
    const bbox = computeBBox(nodes);
    const padding = 80;
    const offset = { x: padding - bbox.x, y: padding - bbox.y };
    const stageWidth = Math.max(viewport.clientWidth, bbox.width + padding * 2);
    const stageHeight = Math.max(viewport.clientHeight, bbox.height + padding * 2);
    const nodeMap = new Map(nodes.map((node) => [String(node.id), node]));

    stage.style.width = `${stageWidth}px`;
    stage.style.height = `${stageHeight}px`;
    edgesLayer.setAttribute("width", String(stageWidth));
    edgesLayer.setAttribute("height", String(stageHeight));
    edgesLayer.setAttribute("viewBox", `0 0 ${stageWidth} ${stageHeight}`);

    for (const node of nodes.filter((node) => node.type === "group")) {
      renderNode(node, offset);
    }
    for (const node of nodes.filter((node) => node.type !== "group")) {
      renderNode(node, offset);
    }
    renderEdges(edges, nodeMap, offset);

    nodeCount.textContent = String(nodes.length);
    edgeCount.textContent = String(edges.length);
    document.body.dataset.nodeCount = String(nodes.length);
    document.body.dataset.edgeCount = String(edges.length);
    bboxValue.textContent = `${Math.round(bbox.width)} x ${Math.round(bbox.height)}`;
    setMessage("Rendered successfully.", false);
  }

  async function readCanvasFile(file) {
    const text = await file.text();
    return JSON.parse(text);
  }

  fileInput.addEventListener("change", async () => {
    const file = fileInput.files && fileInput.files[0];
    if (!file) {
      return;
    }
    try {
      const canvas = await readCanvasFile(file);
      renderCanvas(canvas);
    } catch (error) {
      clear();
      setMessage(error instanceof Error ? error.message : String(error), true);
    }
  });

  async function loadCanvasFromUrl(url) {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to load canvas: ${response.status} ${response.statusText}`);
    }
    return response.json();
  }

  async function bootFromQueryParam() {
    const params = new URLSearchParams(window.location.search);
    const canvasUrl = params.get("canvas");
    if (!canvasUrl) {
      return;
    }

    try {
      setMessage(`Loading ${canvasUrl}`, false);
      const canvas = await loadCanvasFromUrl(canvasUrl);
      renderCanvas(canvas);
    } catch (error) {
      clear();
      setMessage(error instanceof Error ? error.message : String(error), true);
    }
  }

  bootFromQueryParam();
})();
