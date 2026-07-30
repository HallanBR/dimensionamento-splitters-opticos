"use strict";

const PYODIDE_VERSION = "314.0.2";
const PYODIDE_INDEX_URL = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`;

let splitters = [];
let balancedLosses = {};
let points = [];
let editingIndex = null;
let requestTimer = null;
let analysisRequest = null;
let quickRequest = null;
let pythonReadyPromise = null;
let pythonCallQueue = Promise.resolve();

const byId = (id) => document.getElementById(id);
const numberValue = (id) => Number(byId(id).value) || 0;
const formatDbm = (value) => value === null || value === undefined ? "—" : `${Number(value).toFixed(2)} dBm`;
const splitterLabel = (ratio) => ratio || "Sem desbalanceado";

function setRuntimeStatus(state, title, copy) {
  const status = byId("runtime-status");
  if (!status) return;
  status.dataset.state = state;
  byId("runtime-title").textContent = title;
  byId("runtime-copy").textContent = copy;
}

async function ensurePython() {
  if (!pythonReadyPromise) {
    pythonReadyPromise = (async () => {
      setRuntimeStatus("loading", "Iniciando Python", "Carregando o motor óptico...");
      if (typeof loadPyodide !== "function") {
        throw new Error("O motor Python não pôde ser carregado. Confira sua conexão com a internet.");
      }

      const runtime = await loadPyodide({ indexURL: PYODIDE_INDEX_URL });
      const sourceResponse = await fetch(new URL("optical.py", document.baseURI));
      if (!sourceResponse.ok) {
        throw new Error("O arquivo do motor óptico não foi encontrado.");
      }
      runtime.FS.writeFile("optical.py", await sourceResponse.text());
      await runtime.runPythonAsync(`
import json
from optical import OpticalInputError, analyze_route, calculate_quick, catalog

def _handle_browser_request(raw_request):
    try:
        request = json.loads(raw_request)
        action = request.get("action")
        payload = request.get("payload") or {}
        if action == "catalog":
            result = catalog()
        elif action == "calculate":
            result = analyze_route(payload.get("points", []), payload.get("settings", {}))
        elif action == "quick":
            result = calculate_quick(payload.get("inputPower"), str(payload.get("splitter", "")))
        else:
            raise OpticalInputError("Operação não reconhecida.")
        response = {"ok": True, "data": result}
    except (OpticalInputError, TypeError, ValueError) as exc:
        response = {"ok": False, "error": str(exc)}
    return json.dumps(response, ensure_ascii=False)
`);
      setRuntimeStatus("ready", "Python ativo", "Cálculos executados no navegador");
      return runtime;
    })().catch((error) => {
      setRuntimeStatus("error", "Falha ao iniciar", "Atualize a página para tentar novamente");
      throw error;
    });
  }
  return pythonReadyPromise;
}

async function callPython(action, payload = {}) {
  const execute = async () => {
    const runtime = await ensurePython();
    runtime.globals.set("_browser_request_json", JSON.stringify({ action, payload }));
    try {
      const serialized = runtime.runPython("_handle_browser_request(_browser_request_json)");
      const response = JSON.parse(serialized);
      if (!response.ok) throw new Error(response.error || "Não foi possível concluir a operação.");
      return response.data;
    } finally {
      runtime.globals.delete("_browser_request_json");
    }
  };
  const queued = pythonCallQueue.then(execute, execute);
  pythonCallQueue = queued.catch(() => undefined);
  return queued;
}

async function api(path, payload, signal) {
  if (signal?.aborted) throw new DOMException("Operação cancelada.", "AbortError");
  const action = {
    "/api/catalog": "catalog",
    "/api/calculate": "calculate",
    "/api/quick": "quick",
  }[path];
  if (!action) throw new Error("Operação não reconhecida.");
  const data = await callPython(action, payload);
  if (signal?.aborted) throw new DOMException("Operação cancelada.", "AbortError");
  return data;
}

function getSettings() {
  return {
    sourcePower: numberValue("source-power"),
    fiberLoss: numberValue("fiber-loss"),
    spliceLoss: numberValue("splice-loss"),
    minimumPower: numberValue("minimum-power"),
    safetyMargin: numberValue("safety-margin"),
  };
}

function splitterOptions(includeEmpty = false) {
  const emptyOption = includeEmpty ? '<option value="">Sem desbalanceado</option>' : "";
  return emptyOption + splitters
    .map((item) => `<option value="${item.ratio}">${item.ratio}</option>`)
    .join("");
}

function balancedOptions() {
  return Object.keys(balancedLosses).map((item) => `<option>${item}</option>`).join("");
}

function segmentLabel(point) {
  const distance = Number(point.distance) || 0;
  const splices = Number(point.splices) || 0;
  return `${distance.toLocaleString("pt-BR", { maximumFractionDigits: 2 })} km · ${splices} ${splices === 1 ? "fusão" : "fusões"}`;
}

function renderPoints() {
  const list = byId("route-list");
  if (!points.length) {
    list.innerHTML = `
      <div class="empty-route">
        <strong>A rota começa aqui.</strong>
        Adicione a primeira caixa conectada ao DIO.
      </div>`;
  } else {
    list.innerHTML = points.map((point, index) => {
      const isEditing = editingIndex === index;
      return `
        <div class="flow-step">
          <div class="flow-connector" aria-label="Trecho anterior a ${escapeHtml(point.name)}">
            <span class="flow-line"></span>
            <button class="segment-chip" type="button" data-action="edit" data-index="${index}" data-segment-index="${index}">
              ${segmentLabel(point)}
            </button>
            <span class="flow-arrow" aria-hidden="true">↓</span>
          </div>
          <article class="network-node${point.splitter ? "" : " terminal-node"}" data-index="${index}">
            <header class="node-heading">
              <div>
                <span>Ponto ${index + 1}</span>
                <strong data-node-name>${escapeHtml(point.name)}</strong>
              </div>
              <div class="node-actions">
                <button class="edit-node" type="button" data-action="edit">${isEditing ? "Ocultar" : "Editar"}</button>
                <button class="remove-node" type="button" data-action="remove">Excluir</button>
              </div>
            </header>

            <div class="node-diagram">
              <div class="splitter-core">
                <span data-output="splitter-label">${point.splitter ? "Splitter desbalanceado" : "Final da rota"}</span>
                <strong data-output="ratio">${splitterLabel(point.splitter)}</strong>
              </div>
              <div class="node-results${point.splitter ? "" : " terminal-results"}">
                <div class="branch-card local-branch">
                  <small data-output="local-label">Clientes · ${escapeHtml(point.balanced)}</small>
                  <strong data-output="local">Calculando...</strong>
                  <span class="status-chip" data-output="status">—</span>
                </div>
                <div class="branch-card pass-branch" ${point.splitter ? "" : "hidden"}>
                  <small>Continuidade da rota</small>
                  <strong data-output="pass">Calculando...</strong>
                  <span>Sinal que segue para o próximo ponto</span>
                </div>
              </div>
            </div>

            <div class="node-editor" ${isEditing ? "" : "hidden"}>
              <div class="editor-grid">
                <label><span>Nome da caixa</span><input data-field="name" value="${escapeHtml(point.name)}" aria-label="Nome do ponto ${index + 1}"></label>
                <label><span>Distância (km)</span><input data-field="distance" type="number" min="0" step="0.01" value="${point.distance}" aria-label="Distância do ponto ${index + 1}"></label>
                <label><span>Fusões</span><input data-field="splices" type="number" min="0" step="1" value="${point.splices}" aria-label="Fusões do ponto ${index + 1}"></label>
                <label><span>Desbalanceado</span><select data-field="splitter" aria-label="Splitter do ponto ${index + 1}">${splitterOptions(index === points.length - 1)}</select></label>
                <label><span>Atendimento local</span><select data-field="balanced" aria-label="Splitter local do ponto ${index + 1}">${balancedOptions()}</select></label>
              </div>
              <div class="editor-actions">
                <button class="done-node" type="button" data-action="done">Concluir edição</button>
              </div>
            </div>
          </article>
        </div>`;
    }).join("");

    document.querySelectorAll(".network-node").forEach((node, index) => {
      node.querySelector('[data-field="splitter"]').value = points[index].splitter;
      node.querySelector('[data-field="balanced"]').value = points[index].balanced;
    });
  }

  const terminalRoute = points.length > 0 && !points[points.length - 1].splitter;
  const addButton = byId("add-point");
  addButton.disabled = terminalRoute;
  addButton.title = terminalRoute ? "Escolha um desbalanceado na última caixa para continuar a rota." : "";
  byId("add-point-label").textContent = terminalRoute
    ? "Rota encerrada nesta caixa"
    : points.length
    ? "Adicionar próximo ponto"
    : "Adicionar primeiro ponto";
  scheduleAnalysis(0);
}

function syncPoint(event) {
  const node = event.target.closest(".network-node");
  if (!node || !event.target.dataset.field) return;
  const index = Number(node.dataset.index);
  const field = event.target.dataset.field;
  const newValue = ["distance", "splices"].includes(field)
    ? Math.max(0, Number(event.target.value) || 0)
    : event.target.value;
  if (field === "splitter" && !newValue && index < points.length - 1) {
    event.target.value = points[index].splitter;
    showError("Somente a última caixa da rota pode ficar sem splitter desbalanceado.");
    return;
  }
  points[index][field] = newValue;

  if (field === "splitter") {
    renderPoints();
    return;
  }

  const point = points[index];
  node.querySelector("[data-node-name]").textContent = point.name || `Ponto ${index + 1}`;
  node.querySelector('[data-output="ratio"]').textContent = splitterLabel(point.splitter);
  node.querySelector('[data-output="local-label"]').textContent = `Clientes · ${point.balanced}`;
  const segment = document.querySelector(`[data-segment-index="${index}"]`);
  if (segment) segment.textContent = segmentLabel(point);
  scheduleAnalysis();
}

function scheduleAnalysis(delay = 180) {
  window.clearTimeout(requestTimer);
  requestTimer = window.setTimeout(requestAnalysis, delay);
}

async function requestAnalysis() {
  if (analysisRequest) analysisRequest.abort();
  analysisRequest = new AbortController();
  try {
    const analysis = await api(
      "/api/calculate",
      { settings: getSettings(), points },
      analysisRequest.signal,
    );
    renderAnalysis(analysis);
    hideError();
  } catch (error) {
    if (error.name !== "AbortError") showError(error.message);
  }
}

function renderAnalysis(analysis) {
  patchRouteOutputs(analysis.results);
  renderSummary(analysis.summary, analysis.results);
  renderRecommendations(analysis.recommendations);
  renderMaterials(analysis.materials);
}

function patchRouteOutputs(results) {
  results.forEach((result, index) => {
    const node = document.querySelector(`.network-node[data-index="${index}"]`);
    if (!node) return;
    const state = result.effectiveMargin < 0
      ? ["Crítico", "critical"]
      : result.effectiveMargin < 2
      ? ["Atenção", "warning"]
      : ["Aprovado", "good"];
    node.dataset.state = state[1];
    const terminal = !result.splitter;
    node.classList.toggle("terminal-node", terminal);
    node.querySelector("[data-node-name]").textContent = result.name;
    node.querySelector('[data-output="splitter-label"]').textContent = terminal ? "Final da rota" : "Splitter desbalanceado";
    node.querySelector('[data-output="ratio"]').textContent = splitterLabel(result.splitter);
    node.querySelector('[data-output="local-label"]').textContent = `Clientes · ${result.balanced}`;
    node.querySelector('[data-output="local"]').textContent = formatDbm(result.local);
    const resultGrid = node.querySelector(".node-results");
    const passBranch = node.querySelector(".pass-branch");
    resultGrid.classList.toggle("terminal-results", terminal);
    passBranch.hidden = terminal;
    node.querySelector('[data-output="pass"]').textContent = formatDbm(result.pass);
    const status = node.querySelector('[data-output="status"]');
    status.textContent = state[0];
    status.className = `status-chip ${state[1]}`;
    const segment = document.querySelector(`[data-segment-index="${index}"]`);
    if (segment) segment.textContent = segmentLabel(result);
  });
}

function renderSummary(summary, results) {
  const container = byId("route-summary");
  if (!results.length) {
    container.dataset.state = "empty";
    byId("route-status").textContent = "Aguardando pontos";
    byId("route-status-copy").textContent = "Adicione a primeira caixa para calcular.";
    byId("critical-point").textContent = "—";
    byId("critical-value").textContent = "—";
    byId("minimum-margin").textContent = "—";
    byId("total-clients").textContent = "0";
    return;
  }

  const minimumEffective = Math.min(...results.map((item) => item.effectiveMargin));
  container.dataset.state = minimumEffective < 0 ? "critical" : minimumEffective < 2 ? "warning" : "good";
  byId("route-status").textContent = summary.status;
  byId("route-status-copy").textContent = summary.statusCopy;
  byId("critical-point").textContent = summary.criticalPoint || "—";
  byId("critical-value").textContent = summary.criticalValue === null ? "—" : formatDbm(summary.criticalValue);
  byId("minimum-margin").textContent = summary.minimumMargin === null
    ? "—"
    : `${Number(summary.minimumMargin).toFixed(2)} dB`;
  byId("total-clients").textContent = String(summary.totalClients || 0);
}

function renderRecommendations(recommendations) {
  const primary = byId("primary-recommendation");
  if (!recommendations.length) {
    primary.hidden = true;
    byId("recommendations-count").textContent = "0 sugestões";
    byId("recommendations-list").innerHTML = '<p class="details-empty">Adicione pontos à rota para receber sugestões.</p>';
    return;
  }

  const first = recommendations[0];
  primary.hidden = false;
  primary.dataset.level = first.level;
  byId("primary-recommendation-title").textContent = first.title;
  byId("primary-recommendation-body").textContent = first.body;
  byId("recommendations-count").textContent = `${recommendations.length} ${recommendations.length === 1 ? "sugestão" : "sugestões"}`;
  byId("recommendations-list").innerHTML = recommendations
    .map((item) => `<article class="recommendation ${item.level}"><strong>${escapeHtml(item.title)}</strong><p>${escapeHtml(item.body)}</p></article>`)
    .join("");
}

function renderMaterials(materials) {
  const total = materials.reduce((sum, item) => sum + Number(item.quantity || 0), 0);
  byId("materials-count").textContent = `${total} ${total === 1 ? "item" : "itens"}`;
  byId("materials-list").innerHTML = materials.length
    ? materials.map((item) => {
      const suffix = item.code ? ` · cód. ${item.code}` : "";
      return `<span class="material-chip">${item.quantity}× Splitter ${escapeHtml(item.name)}${suffix}</span>`;
    }).join("")
    : '<p class="details-empty">Os materiais aparecerão conforme você adicionar pontos.</p>';
}

async function updateQuick() {
  if (quickRequest) quickRequest.abort();
  quickRequest = new AbortController();
  try {
    const result = await api("/api/quick", {
      inputPower: numberValue("quick-power"),
      splitter: byId("quick-splitter").value,
    }, quickRequest.signal);
    byId("quick-local").textContent = formatDbm(result.local);
    byId("quick-pass").textContent = formatDbm(result.pass);
    hideError();
  } catch (error) {
    if (error.name !== "AbortError") showError(error.message);
  }
}

function showError(message) {
  const banner = byId("app-error");
  banner.textContent = message;
  banner.hidden = false;
}

function hideError() {
  byId("app-error").hidden = true;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "'": "&#39;",
    '"': "&quot;",
  })[character]);
}

function registerEvents() {
  byId("add-point").addEventListener("click", () => {
    if (points.length && !points[points.length - 1].splitter) {
      showError("A rota termina na última caixa. Para adicionar outro ponto, selecione nela um splitter desbalanceado.");
      return;
    }
    points.push({
      name: `CTO ${String(points.length + 1).padStart(2, "0")}`,
      distance: 0,
      splices: 0,
      splitter: "10/90",
      balanced: "1x8",
    });
    editingIndex = points.length - 1;
    renderPoints();
    window.setTimeout(() => document.querySelector(`.network-node[data-index="${editingIndex}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" }), 0);
  });

  byId("route-list").addEventListener("input", syncPoint);
  byId("route-list").addEventListener("change", syncPoint);
  byId("route-list").addEventListener("click", (event) => {
    const actionTarget = event.target.closest("[data-action]");
    if (!actionTarget) return;
    const node = actionTarget.closest(".network-node");
    const index = node ? Number(node.dataset.index) : Number(actionTarget.dataset.index);
    const action = actionTarget.dataset.action;

    if (action === "edit") {
      editingIndex = editingIndex === index ? null : index;
      renderPoints();
    }
    if (action === "done") {
      editingIndex = null;
      renderPoints();
    }
    if (action === "remove") {
      points.splice(index, 1);
      editingIndex = null;
      renderPoints();
    }
  });

  ["source-power", "fiber-loss", "splice-loss", "minimum-power", "safety-margin"]
    .forEach((id) => byId(id).addEventListener("input", () => scheduleAnalysis()));
  ["quick-power", "quick-splitter"]
    .forEach((id) => byId(id).addEventListener("input", updateQuick));

  byId("open-settings").addEventListener("click", () => byId("settings-dialog").showModal());
  byId("open-quick").addEventListener("click", () => {
    byId("quick-dialog").showModal();
    updateQuick();
  });
  byId("open-analysis").addEventListener("click", () => {
    const details = byId("analysis-details");
    details.open = true;
    details.scrollIntoView({ behavior: "smooth", block: "start" });
  });

  byId("new-project").addEventListener("click", () => {
    points = [];
    editingIndex = null;
    byId("project-name").value = "Nova rota óptica";
    byId("source-power").value = "3";
    byId("analysis-details").open = false;
    renderPoints();
    window.scrollTo({ top: 0, behavior: "smooth" });
  });
}

async function start() {
  try {
    const data = await api("/api/catalog");
    splitters = data.splitters;
    balancedLosses = data.balancedLosses;
    byId("quick-splitter").innerHTML = splitterOptions();
    byId("quick-splitter").value = "10/90";
    registerEvents();
    renderPoints();
    await updateQuick();
  } catch (error) {
    showError(`Não foi possível iniciar a aplicação: ${error.message}`);
  }
}

start();
