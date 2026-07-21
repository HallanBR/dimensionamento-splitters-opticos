"use strict";

const PYODIDE_VERSION = "314.0.2";
const PYODIDE_INDEX_URL = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`;

let splitters = [];
let balancedLosses = {};
let points = [
  { name: "CTO 01", distance: 1.2, splices: 4, splitter: "10/90", balanced: "1x8" },
  { name: "CTO 02", distance: 0.8, splices: 2, splitter: "20/80", balanced: "1x8" },
];
let requestTimer = null;
let analysisRequest = null;
let quickRequest = null;
let pythonReadyPromise = null;
let pythonCallQueue = Promise.resolve();

const byId = (id) => document.getElementById(id);
const numberValue = (id) => Number(byId(id).value) || 0;
const formatDbm = (value) => `${Number(value).toFixed(2)} dBm`;

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

function splitterOptions() {
  return splitters.map((item) => `<option value="${item.ratio}">${item.ratio} · cód. ${item.code}</option>`).join("");
}

function balancedOptions() {
  return Object.keys(balancedLosses).map((item) => `<option>${item}</option>`).join("");
}

function renderPoints() {
  byId("route-list").innerHTML = points.map((point, index) => `
    <div class="route-row" data-index="${index}">
      <label>Nome<input data-field="name" value="${escapeHtml(point.name)}" aria-label="Nome do ponto ${index + 1}"></label>
      <label>Distância (km)<input data-field="distance" type="number" min="0" step="0.01" value="${point.distance}" aria-label="Distância do ponto ${index + 1}"></label>
      <label>Quantidade<input data-field="splices" type="number" min="0" step="1" value="${point.splices}" aria-label="Fusões do ponto ${index + 1}"></label>
      <label>Divisão<select data-field="splitter" aria-label="Splitter do ponto ${index + 1}">${splitterOptions()}</select></label>
      <label>Splitter cliente<select data-field="balanced" aria-label="Splitter local do ponto ${index + 1}">${balancedOptions()}</select></label>
      <button class="remove-point" type="button" aria-label="Remover ${escapeHtml(point.name)}">×</button>
    </div>`).join("");

  document.querySelectorAll(".route-row").forEach((row, index) => {
    row.querySelector('[data-field="splitter"]').value = points[index].splitter;
    row.querySelector('[data-field="balanced"]').value = points[index].balanced;
  });
  scheduleAnalysis(0);
}

function syncPoint(event) {
  const row = event.target.closest(".route-row");
  if (!row || !event.target.dataset.field) return;
  const index = Number(row.dataset.index);
  const field = event.target.dataset.field;
  points[index][field] = ["distance", "splices"].includes(field)
    ? Math.max(0, Number(event.target.value) || 0)
    : event.target.value;
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
  renderResults(analysis.results);
  renderSummary(analysis.summary);
  renderRecommendations(analysis.recommendations);
  renderMaterials(analysis.materials);
}

function renderResults(results) {
  byId("results-body").innerHTML = results.length ? results.map((result) => {
    const status = result.effectiveMargin < 0
      ? ["Crítico", "critical"]
      : result.effectiveMargin < 2
      ? ["Atenção", "warning"]
      : ["Aprovado", "good"];
    return `<tr>
      <td><strong>${escapeHtml(result.name)}</strong></td>
      <td>${formatDbm(result.input)}</td>
      <td>${result.splitterData.ratio}</td>
      <td>${formatDbm(result.local)}</td>
      <td>${formatDbm(result.pass)}</td>
      <td>${Number(result.margin).toFixed(2)} dB</td>
      <td><span class="badge ${status[1]}">${status[0]}</span></td>
    </tr>`;
  }).join("") : '<tr><td colspan="7" class="empty-state">Adicione um ponto para iniciar o dimensionamento.</td></tr>';
}

function renderSummary(summary) {
  byId("critical-point").textContent = summary.criticalPoint || "—";
  byId("critical-value").textContent = summary.criticalValue === null ? "Adicione um ponto" : formatDbm(summary.criticalValue);
  byId("minimum-margin").textContent = summary.minimumMargin === null ? "—" : `${Number(summary.minimumMargin).toFixed(2)} dB`;
  byId("route-status").textContent = summary.status;
  byId("route-status-copy").textContent = summary.statusCopy;
}

function renderRecommendations(recommendations) {
  byId("recommendations-list").innerHTML = recommendations.length
    ? recommendations.map((item) => `<article class="recommendation ${item.level}"><div><strong>${escapeHtml(item.title)}</strong><p>${escapeHtml(item.body)}</p></div></article>`).join("")
    : '<p class="empty-state">Adicione pontos à rota para receber sugestões.</p>';
}

function renderMaterials(materials) {
  byId("materials-list").innerHTML = materials.map((item) => {
    const suffix = item.code ? ` · cód. ${item.code}` : " · balanceado";
    return `<span class="material-chip">${item.quantity}× Splitter ${escapeHtml(item.name)}${suffix}</span>`;
  }).join("");
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
    points.push({
      name: `CTO ${String(points.length + 1).padStart(2, "0")}`,
      distance: 0,
      splices: 0,
      splitter: "10/90",
      balanced: "1x8",
    });
    renderPoints();
  });
  byId("route-list").addEventListener("input", syncPoint);
  byId("route-list").addEventListener("change", syncPoint);
  byId("route-list").addEventListener("click", (event) => {
    const button = event.target.closest(".remove-point");
    if (!button) return;
    points.splice(Number(button.closest(".route-row").dataset.index), 1);
    renderPoints();
  });
  ["source-power", "fiber-loss", "splice-loss", "minimum-power", "safety-margin"]
    .forEach((id) => byId(id).addEventListener("input", () => scheduleAnalysis()));
  ["quick-power", "quick-splitter"]
    .forEach((id) => byId(id).addEventListener("input", updateQuick));
  byId("new-project").addEventListener("click", () => {
    points = [];
    byId("project-name").value = "Nova rota óptica";
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
