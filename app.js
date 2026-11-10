"use strict";

const PYODIDE_VERSION = "314.0.2";
const PYODIDE_INDEX_URL = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`;
const SCENARIO_VERSION = 1;
const COMPACT_VERSION = 2;
const SCENARIO_HASH_KEY = "cenario";
const COMPACT_HASH_KEY = "r";
const MAX_SHARED_POINTS = 100;
const UNDO_TIMEOUT = 7000;
const SETTING_FIELDS = {
  sourcePower: "source-power",
  fiberLoss: "fiber-loss",
  spliceLoss: "splice-loss",
  minimumPower: "minimum-power",
  safetyMargin: "safety-margin",
};

let splitters = [];
let balancedLosses = {};
let defaultSettings = {
  sourcePower: 3,
  fiberLoss: 0.35,
  spliceLoss: 0.10,
  minimumPower: -27,
  safetyMargin: 3,
};
let points = [];
let requestTimer = null;
let analysisRequest = null;
let quickRequest = null;
let pythonReadyPromise = null;
let pythonCallQueue = Promise.resolve();
let lastAnalysis = null;
let pendingUndo = null;
let undoTimer = null;
let pendingOptimization = null;
let installPrompt = null;

const byId = (id) => document.getElementById(id);
const numberValue = (id) => Number(byId(id).value) || 0;
const formatDbm = (value) => value === null || value === undefined ? "—" : `${Number(value).toFixed(2)} dBm`;
const formatDb = (value) => `${value >= 0 ? "+" : ""}${Number(value).toFixed(2)} dB`;

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

      const sourceRequest = fetch(new URL("optical.py", document.baseURI));
      const runtime = await loadPyodide({ indexURL: PYODIDE_INDEX_URL });
      const sourceResponse = await sourceRequest;
      if (!sourceResponse.ok) {
        throw new Error("O arquivo do motor óptico não foi encontrado.");
      }
      runtime.FS.writeFile("optical.py", await sourceResponse.text());
      await runtime.runPythonAsync(`
import json
from optical import OpticalInputError, analyze_route, calculate_quick, catalog, optimize_splitters

def _handle_browser_request(raw_request):
    try:
        request = json.loads(raw_request)
        action = request.get("action")
        payload = request.get("payload") or {}
        if action == "catalog":
            result = catalog()
        elif action == "calculate":
            result = analyze_route(payload.get("points", []), payload.get("settings", {}))
        elif action == "optimize":
            result = optimize_splitters(payload.get("points", []), payload.get("settings", {}))
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
    "/api/optimize": "optimize",
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

function setSettings(settings) {
  Object.entries(SETTING_FIELDS).forEach(([key, id]) => {
    byId(id).value = String(settings[key]);
  });
}

function bytesToBase64Url(bytes) {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function base64UrlToBytes(value) {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw new Error("O conteúdo compartilhado não é válido.");
  const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

async function transformBytes(bytes, stream) {
  const piped = new Blob([bytes]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(piped).arrayBuffer());
}

function scenarioPayload() {
  return {
    version: SCENARIO_VERSION,
    name: byId("project-name").value.trim(),
    settings: getSettings(),
    points: points.map(({ name, distance, splices, splitter, balanced, measured }) => ({
      name,
      distance,
      splices,
      splitter,
      balanced,
      measured: measured ?? null,
    })),
  };
}

// Formato compacto: lista posicional em vez de objetos com chaves repetidas
function compactScenario(scenario) {
  return [
    COMPACT_VERSION,
    scenario.name,
    Object.keys(SETTING_FIELDS).map((key) => scenario.settings[key]),
    scenario.points.map((point) => [
      point.name,
      point.distance,
      point.splices,
      point.splitter,
      point.balanced,
      point.measured,
    ]),
  ];
}

function expandScenario(compact) {
  if (!Array.isArray(compact) || compact[0] !== COMPACT_VERSION || !Array.isArray(compact[2]) || !Array.isArray(compact[3])) {
    throw new Error("Esta versão do cenário compartilhado não é compatível.");
  }
  const settingKeys = Object.keys(SETTING_FIELDS);
  return {
    version: SCENARIO_VERSION,
    name: compact[1],
    settings: Object.fromEntries(settingKeys.map((key, index) => [key, compact[2][index]])),
    points: compact[3].map((point) => {
      if (!Array.isArray(point)) return point;
      const [name, distance, splices, splitter, balanced, measured] = point;
      return { name, distance, splices, splitter, balanced, measured };
    }),
  };
}

async function buildShareLink() {
  const url = new URL(window.location.href);
  const scenario = scenarioPayload();
  if (typeof CompressionStream === "function") {
    const json = JSON.stringify(compactScenario(scenario));
    const compressed = await transformBytes(new TextEncoder().encode(json), new CompressionStream("deflate-raw"));
    url.hash = `${COMPACT_HASH_KEY}=${bytesToBase64Url(compressed)}`;
  } else {
    url.hash = `${SCENARIO_HASH_KEY}=${bytesToBase64Url(new TextEncoder().encode(JSON.stringify(scenario)))}`;
  }
  return url.toString();
}

function sharedNumber(value, label, { integer = false, nonNegative = false } = {}) {
  if (typeof value !== "number" || !Number.isFinite(value) || (integer && !Number.isInteger(value)) || (nonNegative && value < 0)) {
    throw new Error(`O valor compartilhado de ${label} é inválido.`);
  }
  return value;
}

function normalizeSharedScenario(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("O cenário compartilhado não é válido.");
  if (raw.version !== SCENARIO_VERSION) throw new Error("Esta versão do cenário compartilhado não é compatível.");
  if (!Array.isArray(raw.points) || raw.points.length > MAX_SHARED_POINTS) {
    throw new Error(`O cenário compartilhado deve ter no máximo ${MAX_SHARED_POINTS} pontos.`);
  }

  const knownSplitters = new Set(splitters.map((item) => item.ratio));
  const knownBalanced = new Set(Object.keys(balancedLosses));
  const normalizedPoints = raw.points.map((point, index) => {
    if (!point || typeof point !== "object" || Array.isArray(point)) {
      throw new Error(`O ponto ${index + 1} do cenário compartilhado é inválido.`);
    }
    const splitter = typeof point.splitter === "string" ? point.splitter : "";
    const balanced = typeof point.balanced === "string" ? point.balanced : "Sem splitter";
    if (splitter && !knownSplitters.has(splitter)) throw new Error(`O splitter do ponto ${index + 1} não é reconhecido.`);
    if (!splitter && index < raw.points.length - 1) throw new Error("Somente o último ponto pode ficar sem splitter desbalanceado.");
    if (!knownBalanced.has(balanced)) throw new Error(`O splitter local do ponto ${index + 1} não é reconhecido.`);

    const name = typeof point.name === "string" ? point.name.trim() : "";
    if (name.length > 100) throw new Error(`O nome do ponto ${index + 1} é muito longo.`);
    const measured = point.measured === undefined || point.measured === null
      ? null
      : sharedNumber(point.measured, `sinal real do melhor cliente do ponto ${index + 1}`);
    return {
      name: name || `CTO ${String(index + 1).padStart(2, "0")}`,
      distance: sharedNumber(point.distance, `distância do ponto ${index + 1}`, { nonNegative: true }),
      splices: sharedNumber(point.splices, `fusões do ponto ${index + 1}`, { integer: true, nonNegative: true }),
      splitter,
      balanced,
      measured,
    };
  });

  const rawSettings = raw.settings && typeof raw.settings === "object" ? raw.settings : {};
  const settings = {
    sourcePower: sharedNumber(rawSettings.sourcePower, "potência de origem"),
    fiberLoss: sharedNumber(rawSettings.fiberLoss, "perda da fibra", { nonNegative: true }),
    spliceLoss: sharedNumber(rawSettings.spliceLoss, "perda por fusão", { nonNegative: true }),
    minimumPower: sharedNumber(rawSettings.minimumPower, "limite mínimo"),
    safetyMargin: sharedNumber(rawSettings.safetyMargin, "margem de segurança", { nonNegative: true }),
  };
  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  if (name.length > 120) throw new Error("O nome do cenário compartilhado é muito longo.");
  return { name, settings, points: normalizedPoints };
}

async function loadSharedScenario() {
  const params = new URLSearchParams(window.location.hash.slice(1));
  const compact = params.get(COMPACT_HASH_KEY);
  const legacy = params.get(SCENARIO_HASH_KEY);
  if (!compact && !legacy) return false;
  let raw;
  try {
    if (compact) {
      const bytes = await transformBytes(base64UrlToBytes(compact), new DecompressionStream("deflate-raw"));
      raw = expandScenario(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
    } else {
      raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(base64UrlToBytes(legacy)));
    }
  } catch (error) {
    if (error instanceof Error && /^(O conteúdo|Esta versão)/u.test(error.message)) throw error;
    throw new Error("Não foi possível ler o cenário deste link.");
  }
  const scenario = normalizeSharedScenario(raw);
  byId("project-name").value = scenario.name;
  setSettings(scenario.settings);
  points = scenario.points;
  return true;
}

async function copyShareLink() {
  const input = byId("share-link");
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(input.value);
    } else {
      input.focus();
      input.select();
      if (!document.execCommand("copy")) throw new Error("Cópia não suportada.");
    }
    byId("copy-status").textContent = "Link copiado para a área de transferência.";
    byId("copy-share-link").textContent = "Link copiado";
  } catch (error) {
    input.focus();
    input.select();
    byId("copy-status").textContent = "Selecione o link acima e copie manualmente.";
  }
}

function splitterOptions(includeEmpty = false) {
  const emptyOption = includeEmpty ? '<option value="">Nenhum</option>' : "";
  return emptyOption + splitters
    .map((item) => `<option value="${item.ratio}">${item.ratio}</option>`)
    .join("");
}

function balancedOptions() {
  return Object.keys(balancedLosses).map((item) => `<option>${item}</option>`).join("");
}

function newPoint(name) {
  return { name, distance: 0, splices: 0, splitter: "10/90", balanced: "1x8", measured: null };
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
      const label = escapeHtml(point.name || `caixa ${index + 1}`);
      return `
        <div class="flow-step" data-index="${index}">
          <div class="flow-connector">
            <span class="flow-line" aria-hidden="true"></span>
            <span class="segment-fields">
              <input class="segment-input" data-field="distance" type="number" min="0" step="0.01" value="${point.distance}" aria-label="Distância até ${label} (km)">
              <span>km</span>
              <input class="segment-input splices-input" data-field="splices" type="number" min="0" step="1" value="${point.splices}" aria-label="Fusões até ${label}">
              <span>fusões</span>
            </span>
            <button class="insert-point" type="button" data-action="insert" title="Inserir uma caixa antes de ${label}">+ Inserir caixa</button>
          </div>
          <article class="network-node${point.splitter ? "" : " terminal-node"}" data-index="${index}">
            <div class="node-row">
              <span class="node-index" aria-hidden="true">${index + 1}</span>
              <div class="node-title">
                <input class="name-input" data-field="name" value="${escapeHtml(point.name)}" placeholder="Nome da caixa" aria-label="Nome da caixa ${index + 1}">
                <span class="inversion-flag" data-output="attenuation" hidden>Atenuação antes?</span>
                <span class="inversion-flag" data-output="inversion" hidden>Saídas invertidas?</span>
              </div>
              <label class="splitter-core">
                <span data-output="splitter-label">${point.splitter ? "Desbalanceado" : "Final da rota"}</span>
                <select class="splitter-select" data-field="splitter" aria-label="Desbalanceado da caixa ${index + 1}">${splitterOptions(index === points.length - 1)}</select>
              </label>
              <div class="node-results">
                <div class="branch-card local-branch">
                  <label class="branch-label">Clientes
                    <select class="mini-select" data-field="balanced" aria-label="Splitter de clientes da caixa ${index + 1}">${balancedOptions()}</select>
                  </label>
                  <strong data-output="local">Calculando...</strong>
                  <span class="status-chip" data-output="status">—</span>
                </div>
                <div class="branch-card pass-branch" title="Sinal que segue para o próximo ponto">
                  <small>Continuidade</small>
                  <strong data-output="pass">${point.splitter ? "Calculando..." : "—"}</strong>
                </div>
                <div class="branch-card measured-branch">
                  <small title="Sinal do cliente com maior potência nesta caixa (o que tem menos atenuação própria), consultado no sistema. Informe quando estiver diferente do projetado">Melhor cliente (real)</small>
                  <span class="measured-field">
                    <input data-field="measured" type="number" step="0.01" value="${point.measured ?? ""}" placeholder="—" aria-label="Sinal real do melhor cliente da caixa ${index + 1} (dBm)">
                    <small>dBm</small>
                  </span>
                  <span class="delta-chip" data-output="delta" hidden></span>
                </div>
              </div>
              <button class="remove-node" type="button" data-action="remove" title="Excluir ${label}" aria-label="Excluir ${label}">×</button>
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

function focusPointName(index) {
  const input = document.querySelector(`.network-node[data-index="${index}"] [data-field="name"]`);
  if (!input) return;
  input.scrollIntoView({ behavior: "smooth", block: "center" });
  input.focus({ preventScroll: true });
  input.select();
}

function syncPoint(event) {
  const step = event.target.closest(".flow-step");
  const field = event.target.dataset.field;
  if (!step || !field) return;
  const index = Number(step.dataset.index);
  let newValue = event.target.value;
  if (["distance", "splices"].includes(field)) newValue = Math.max(0, Number(newValue) || 0);
  if (field === "measured") newValue = newValue === "" || !Number.isFinite(Number(newValue)) ? null : Number(newValue);
  if (field === "splitter" && !newValue && index < points.length - 1) {
    event.target.value = points[index].splitter;
    showError("Somente a última caixa da rota pode ficar sem splitter desbalanceado.");
    return;
  }
  if (points[index][field] === newValue) return;
  points[index][field] = newValue;

  if (field === "splitter") {
    renderPoints();
    return;
  }
  scheduleAnalysis();
}

function removePoint(index) {
  const [removed] = points.splice(index, 1);
  renderPoints();
  pendingUndo = { point: removed, index };
  byId("toast-text").textContent = `${removed.name || "Caixa"} excluída.`;
  byId("toast").hidden = false;
  window.clearTimeout(undoTimer);
  undoTimer = window.setTimeout(clearUndo, UNDO_TIMEOUT);
}

function clearUndo() {
  pendingUndo = null;
  window.clearTimeout(undoTimer);
  byId("toast").hidden = true;
}

function undoRemove() {
  if (!pendingUndo) return;
  const { point, index } = pendingUndo;
  points.splice(Math.min(index, points.length), 0, point);
  clearUndo();
  renderPoints();
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
  lastAnalysis = analysis;
  patchRouteOutputs(analysis.results);
  renderSummary(analysis.summary, analysis.results, analysis.diagnosis);
  renderChart(analysis.results, analysis.settings);
  renderRecommendations(analysis.recommendations);
  renderMaterials(analysis.materials);
}

function deltaState(delta) {
  const size = Math.abs(delta);
  return size < 1.5 ? "good" : size < 3 ? "warning" : "critical";
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
    node.querySelector('[data-output="splitter-label"]').textContent = terminal ? "Final da rota" : "Desbalanceado";
    node.querySelector('[data-output="local"]').textContent = formatDbm(result.local);
    node.querySelector('[data-output="pass"]').textContent = formatDbm(result.pass);
    node.querySelector(".pass-branch").classList.toggle("is-empty", terminal);
    const status = node.querySelector('[data-output="status"]');
    status.textContent = state[0];
    status.className = `status-chip ${state[1]}`;

    const delta = node.querySelector('[data-output="delta"]');
    delta.hidden = result.measuredDelta === null;
    if (result.measuredDelta !== null) {
      delta.textContent = `Δ ${formatDb(result.measuredDelta)}`;
      delta.className = `delta-chip ${deltaState(result.measuredDelta)}`;
      delta.title = `Melhor cliente real ${formatDbm(result.measured)} · projetado ${formatDbm(result.local)}`;
    }
    const attenuation = node.querySelector('[data-output="attenuation"]');
    const suspectedAttenuation = result.suspectedAttenuation ?? null;
    attenuation.hidden = suspectedAttenuation === null;
    if (suspectedAttenuation !== null) attenuation.textContent = `Atenuação antes? ~${suspectedAttenuation.toFixed(1)} dB`;
    node.querySelector('[data-output="inversion"]').hidden = !result.suspectedInversion;
    node.classList.toggle("is-suspect", Boolean(result.suspectedInversion) || suspectedAttenuation !== null);
  });
}

function renderSummary(summary, results, diagnosis) {
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
  const fieldDivergence = diagnosis?.divergent?.length > 0;
  container.dataset.state = minimumEffective < 0 || fieldDivergence ? "critical" : minimumEffective < 2 ? "warning" : "good";
  byId("route-status").textContent = summary.status;
  byId("route-status-copy").textContent = summary.statusCopy;
  byId("critical-point").textContent = summary.criticalPoint || "—";
  byId("critical-value").textContent = summary.criticalValue === null ? "—" : formatDbm(summary.criticalValue);
  byId("minimum-margin").textContent = summary.minimumMargin === null
    ? "—"
    : `${Number(summary.minimumMargin).toFixed(2)} dB`;
  byId("total-clients").textContent = String(summary.totalClients || 0);
}

function niceTicks(minimum, maximum) {
  const span = maximum - minimum;
  const step = span > 30 ? 10 : span > 12 ? 5 : 2;
  const ticks = [];
  for (let value = Math.ceil(minimum / step) * step; value <= maximum; value += step) ticks.push(value);
  return ticks;
}

function renderChart(results, settings) {
  const card = byId("chart-card");
  const container = byId("power-chart");
  card.hidden = !results.length;
  if (!results.length) return;

  const width = Math.max(260, Math.round(container.clientWidth || 300));
  const height = 196;
  const pad = { top: 12, right: 12, bottom: 24, left: 38 };
  const limit = settings.minimumPower;
  const reserve = limit + settings.safetyMargin;
  const values = results.flatMap((item) => [item.local, item.measured]).filter((value) => value !== null);
  const low = Math.floor(Math.min(...values, limit) - 2);
  const high = Math.ceil(Math.max(...values, reserve) + 2);
  const innerWidth = width - pad.left - pad.right;
  const innerHeight = height - pad.top - pad.bottom;
  const x = (index) => pad.left + (results.length === 1 ? innerWidth / 2 : (index / (results.length - 1)) * innerWidth);
  const y = (value) => pad.top + ((high - value) / (high - low)) * innerHeight;

  const grid = niceTicks(low, high).map((tick) => `
    <line class="chart-grid" x1="${pad.left}" x2="${width - pad.right}" y1="${y(tick)}" y2="${y(tick)}"></line>
    <text class="chart-axis" x="${pad.left - 6}" y="${y(tick) + 3}" text-anchor="end">${tick}</text>`).join("");
  const xLabels = results.map((item, index) => `
    <text class="chart-axis" x="${x(index)}" y="${height - 7}" text-anchor="middle">${index + 1}</text>`).join("");
  const estimatedPath = results.map((item, index) => `${index ? "L" : "M"}${x(index)},${y(item.local)}`).join(" ");
  const estimatedDots = results.map((item, index) => `<circle class="chart-dot estimated" cx="${x(index)}" cy="${y(item.local)}" r="4"></circle>`).join("");
  const measuredDots = results.map((item, index) => item.measured === null ? "" : `
    <line class="chart-delta" x1="${x(index)}" x2="${x(index)}" y1="${y(item.local)}" y2="${y(item.measured)}"></line>
    <rect class="chart-dot measured" x="${x(index) - 4.5}" y="${y(item.measured) - 4.5}" width="9" height="9" transform="rotate(45 ${x(index)} ${y(item.measured)})"></rect>`).join("");
  const columnWidth = results.length === 1 ? innerWidth : innerWidth / (results.length - 1);
  const hits = results.map((item, index) => `
    <rect class="chart-hit" data-index="${index}" x="${x(index) - columnWidth / 2}" y="${pad.top}" width="${columnWidth}" height="${innerHeight}"></rect>`).join("");

  container.innerHTML = `
    <svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="Potência projetada e sinal real do melhor cliente de cada caixa">
      ${grid}
      <line class="chart-limit" x1="${pad.left}" x2="${width - pad.right}" y1="${y(limit)}" y2="${y(limit)}"></line>
      <text class="chart-ref-label limit" x="${width - pad.right}" y="${y(limit) + 11}" text-anchor="end">Limite ${limit}</text>
      <line class="chart-reserve" x1="${pad.left}" x2="${width - pad.right}" y1="${y(reserve)}" y2="${y(reserve)}"></line>
      <text class="chart-ref-label" x="${width - pad.right}" y="${y(reserve) - 4}" text-anchor="end">Reserva ${reserve}</text>
      <line class="chart-crosshair" id="chart-crosshair" y1="${pad.top}" y2="${pad.top + innerHeight}" hidden></line>
      <path class="chart-line" d="${estimatedPath}"></path>
      ${estimatedDots}
      ${measuredDots}
      ${xLabels}
      ${hits}
    </svg>
    <div class="chart-tooltip" id="chart-tooltip" hidden></div>`;
  byId("chart-legend-measured").hidden = !results.some((item) => item.measured !== null);

  const tooltip = byId("chart-tooltip");
  const crosshair = byId("chart-crosshair");
  container.querySelectorAll(".chart-hit").forEach((hit) => {
    hit.addEventListener("mouseenter", () => {
      const index = Number(hit.dataset.index);
      const item = results[index];
      const measured = item.measured === null
        ? ""
        : `<span><i class="key measured"></i>Melhor cliente real <b>${formatDbm(item.measured)}</b></span><span class="muted">Diferença ${formatDb(item.measuredDelta)}</span>`;
      tooltip.innerHTML = `<strong>${index + 1}. ${escapeHtml(item.name)}</strong><span><i class="key estimated"></i>Projetado <b>${formatDbm(item.local)}</b></span>${measured}`;
      tooltip.hidden = false;
      const left = Math.min(Math.max(x(index) - tooltip.offsetWidth / 2, 0), width - tooltip.offsetWidth);
      tooltip.style.left = `${left}px`;
      crosshair.setAttribute("x1", x(index));
      crosshair.setAttribute("x2", x(index));
      crosshair.hidden = false;
    });
    hit.addEventListener("mouseleave", () => {
      tooltip.hidden = true;
      crosshair.hidden = true;
    });
  });
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

async function openOptimizer() {
  const dialog = byId("optimize-dialog");
  const body = byId("optimize-body");
  const apply = byId("apply-optimization");
  pendingOptimization = null;
  apply.hidden = true;
  body.innerHTML = '<p class="details-empty">Comparando combinações...</p>';
  dialog.showModal();
  try {
    const result = await api("/api/optimize", { settings: getSettings(), points });
    const healthy = result.currentMinimum !== undefined && result.currentMinimum >= 2;
    const note = healthy
      ? '<p class="optimize-note">A rota atual já atende com folga. Trocar é opcional.</p>'
      : "";
    if (!result.changed) {
      body.innerHTML = `<p class="optimize-message">${escapeHtml(result.message)}</p>${note}`;
      return;
    }
    pendingOptimization = result;
    const changed = new Set(result.changes.map((item) => item.index));
    const rows = result.points.map((item, index) => {
      const before = points[index].splitter || "—";
      const after = result.splitters[index] || "—";
      return `
        <tr class="${changed.has(index) ? "is-changed" : ""}">
          <td>${index + 1}. ${escapeHtml(item.name)}</td>
          <td>${before}</td>
          <td>${after}</td>
          <td>${formatDbm(item.before)}</td>
          <td>${formatDbm(item.after)}</td>
        </tr>`;
    }).join("");
    body.innerHTML = `
      <p class="optimize-message">${escapeHtml(result.message)}</p>
      <div class="optimize-scores">
        <span><small>Menor reserva hoje</small><strong>${formatDb(result.currentMinimum)}</strong></span>
        <span><small>Com a sugestão</small><strong>${formatDb(result.proposedMinimum)}</strong></span>
      </div>
      ${note}
      <div class="optimize-table-wrap">
        <table class="optimize-table">
          <thead><tr><th>Caixa</th><th>Atual</th><th>Sugerido</th><th>Clientes hoje</th><th>Depois</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
    apply.hidden = false;
  } catch (error) {
    body.innerHTML = `<p class="optimize-message">${escapeHtml(error.message)}</p>`;
  }
}

function applyOptimization() {
  if (!pendingOptimization) return;
  pendingOptimization.splitters.forEach((ratio, index) => {
    if (points[index]) points[index].splitter = ratio;
  });
  pendingOptimization = null;
  byId("optimize-dialog").close();
  renderPoints();
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

function applyTheme(theme) {
  const dark = theme === "dark";
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  byId("theme-toggle").setAttribute("aria-pressed", String(dark));
  byId("theme-icon").textContent = dark ? "☀" : "☾";
  byId("theme-label").textContent = dark ? "Modo claro" : "Modo noturno";
}

function setupTheme() {
  applyTheme(document.documentElement.dataset.theme);
  byId("theme-toggle").addEventListener("click", () => {
    const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    applyTheme(next);
    try {
      localStorage.setItem("tema", next);
    } catch (error) {
      // Sem armazenamento disponível, o tema vale só para esta visita
    }
    if (lastAnalysis) renderChart(lastAnalysis.results, lastAnalysis.settings);
  });
}

// Cache offline e instalação como aplicativo
function setupInstall() {
  const secure = window.location.protocol === "https:" || ["localhost", "127.0.0.1"].includes(window.location.hostname);
  if ("serviceWorker" in navigator && secure) {
    navigator.serviceWorker.register("sw.js").catch(() => undefined);
  }
  const button = byId("install-app");
  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    installPrompt = event;
    button.hidden = false;
  });
  window.addEventListener("appinstalled", () => {
    installPrompt = null;
    button.hidden = true;
  });
  button.addEventListener("click", async () => {
    if (!installPrompt) return;
    installPrompt.prompt();
    await installPrompt.userChoice;
    installPrompt = null;
    button.hidden = true;
  });
}

function registerEvents() {
  byId("add-point").addEventListener("click", () => {
    if (points.length && !points[points.length - 1].splitter) {
      showError("A rota termina na última caixa. Para adicionar outro ponto, selecione nela um splitter desbalanceado.");
      return;
    }
    clearUndo();
    points.push(newPoint(`CTO ${String(points.length + 1).padStart(2, "0")}`));
    renderPoints();
    window.setTimeout(() => focusPointName(points.length - 1), 0);
  });

  byId("route-list").addEventListener("input", syncPoint);
  byId("route-list").addEventListener("change", syncPoint);
  byId("route-list").addEventListener("click", (event) => {
    const actionTarget = event.target.closest("[data-action]");
    if (!actionTarget) return;
    const index = Number(actionTarget.closest(".flow-step").dataset.index);
    if (actionTarget.dataset.action === "insert") {
      clearUndo();
      points.splice(index, 0, newPoint("Nova CTO"));
      renderPoints();
      window.setTimeout(() => focusPointName(index), 0);
    }
    if (actionTarget.dataset.action === "remove") removePoint(index);
  });
  byId("toast-undo").addEventListener("click", undoRemove);

  ["source-power", "fiber-loss", "splice-loss", "minimum-power", "safety-margin"]
    .forEach((id) => byId(id).addEventListener("input", () => scheduleAnalysis()));
  ["quick-power", "quick-splitter"]
    .forEach((id) => byId(id).addEventListener("input", updateQuick));

  byId("open-settings").addEventListener("click", () => byId("settings-dialog").showModal());
  byId("open-optimizer").addEventListener("click", openOptimizer);
  byId("apply-optimization").addEventListener("click", applyOptimization);
  byId("open-quick").addEventListener("click", () => {
    byId("quick-dialog").showModal();
    updateQuick();
  });
  byId("open-analysis").addEventListener("click", () => {
    const details = byId("analysis-details");
    details.open = true;
    details.scrollIntoView({ behavior: "smooth", block: "start" });
  });
  byId("share-project").addEventListener("click", async () => {
    byId("share-link").value = "Gerando link...";
    byId("copy-status").textContent = "";
    byId("copy-share-link").textContent = "Copiar link";
    byId("share-dialog").showModal();
    byId("share-link").value = await buildShareLink();
  });
  byId("copy-share-link").addEventListener("click", copyShareLink);

  byId("new-project").addEventListener("click", () => {
    points = [];
    clearUndo();
    byId("project-name").value = "";
    setSettings(defaultSettings);
    byId("analysis-details").open = false;
    window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
    renderPoints();
    window.scrollTo({ top: 0, behavior: "smooth" });
  });

  let resizeTimer = null;
  window.addEventListener("resize", () => {
    window.clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(() => {
      if (lastAnalysis) renderChart(lastAnalysis.results, lastAnalysis.settings);
    }, 150);
  });
}

async function start() {
  setupTheme();
  setupInstall();
  try {
    const data = await api("/api/catalog");
    splitters = data.splitters;
    balancedLosses = data.balancedLosses;
    defaultSettings = data.defaults;
    byId("quick-splitter").innerHTML = splitterOptions();
    byId("quick-splitter").value = "10/90";
    let sharedScenarioError = null;
    try {
      await loadSharedScenario();
    } catch (error) {
      sharedScenarioError = error;
    }
    registerEvents();
    renderPoints();
    await updateQuick();
    if (sharedScenarioError) showError(sharedScenarioError.message);
  } catch (error) {
    showError(`Não foi possível iniciar a aplicação: ${error.message}`);
  }
}

start();
