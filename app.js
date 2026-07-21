"use strict";

const { DEFAULT_SPLITTERS: splitters, DEFAULT_BALANCED_LOSSES: balancedLosses } = OpticalCalculator;
let points = [
  { name: "CTO 01", distance: 1.2, splices: 4, splitter: "10/90", balanced: "1x8" },
  { name: "CTO 02", distance: 0.8, splices: 2, splitter: "20/80", balanced: "1x8" },
];

const byId = (id) => document.getElementById(id);
const numberValue = (id) => Number(byId(id).value) || 0;
const formatDbm = (value) => `${value.toFixed(2)} dBm`;
const splitterOptions = () => splitters.map((item) => `<option value="${item.ratio}">${item.ratio} · cód. ${item.code}</option>`).join("");
const balancedOptions = () => Object.keys(balancedLosses).map((item) => `<option>${item}</option>`).join("");

function getSettings() {
  return {
    sourcePower: numberValue("source-power"),
    fiberLoss: numberValue("fiber-loss"),
    spliceLoss: numberValue("splice-loss"),
    minimumPower: numberValue("minimum-power"),
    safetyMargin: numberValue("safety-margin"),
  };
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
  calculate();
}

function syncPoints(event) {
  const row = event.target.closest(".route-row");
  if (!row || !event.target.dataset.field) return;
  const index = Number(row.dataset.index);
  const field = event.target.dataset.field;
  points[index][field] = ["distance", "splices"].includes(field) ? Math.max(0, Number(event.target.value) || 0) : event.target.value;
  calculate();
}

function calculate() {
  const settings = getSettings();
  const results = OpticalCalculator.calculateRoute(points, settings);
  renderResults(results, settings);
  renderRecommendations(OpticalCalculator.buildRecommendations(points, settings, results));
  renderMaterials();
}

function renderResults(results, settings) {
  byId("results-body").innerHTML = results.length ? results.map((result) => {
    const status = result.effectiveMargin < 0 ? ["Crítico", "critical"] : result.effectiveMargin < 2 ? ["Atenção", "warning"] : ["Aprovado", "good"];
    return `<tr><td><strong>${escapeHtml(result.name)}</strong></td><td>${formatDbm(result.input)}</td><td>${result.splitterData.ratio}</td><td>${formatDbm(result.local)}</td><td>${formatDbm(result.pass)}</td><td>${result.margin.toFixed(2)} dB</td><td><span class="badge ${status[1]}">${status[0]}</span></td></tr>`;
  }).join("") : '<tr><td colspan="7" class="empty-state">Adicione um ponto para iniciar o dimensionamento.</td></tr>';

  if (!results.length) {
    byId("critical-point").textContent = "—";
    byId("critical-value").textContent = "Adicione um ponto";
    byId("minimum-margin").textContent = "—";
    byId("route-status").textContent = "Não calculada";
    byId("route-status-copy").textContent = "Preencha a estrutura";
    return;
  }

  const critical = results.reduce((lowest, item) => item.margin < lowest.margin ? item : lowest);
  const hasCritical = results.some((item) => item.effectiveMargin < 0);
  const hasWarning = results.some((item) => item.effectiveMargin >= 0 && item.effectiveMargin < 2);
  byId("critical-point").textContent = critical.name;
  byId("critical-value").textContent = formatDbm(critical.local);
  byId("minimum-margin").textContent = `${critical.margin.toFixed(2)} dB`;
  byId("route-status").textContent = hasCritical ? "Revisão necessária" : hasWarning ? "Dentro do limite" : "Rota saudável";
  byId("route-status-copy").textContent = hasCritical ? `Há ponto abaixo dos ${settings.safetyMargin.toFixed(1)} dB de reserva` : hasWarning ? "Existe ponto próximo da reserva" : "Todos os pontos têm reserva";
}

function renderRecommendations(recommendations) {
  byId("recommendations-list").innerHTML = recommendations.length
    ? recommendations.map((item) => `<article class="recommendation ${item.level}"><div><strong>${escapeHtml(item.title)}</strong><p>${escapeHtml(item.body)}</p></div></article>`).join("")
    : '<p class="empty-state">Adicione pontos à rota para receber sugestões.</p>';
}

function renderMaterials() {
  const counts = points.reduce((map, point) => {
    map[point.splitter] = (map[point.splitter] || 0) + 1;
    map[point.balanced] = (map[point.balanced] || 0) + (point.balanced === "Sem splitter" ? 0 : 1);
    return map;
  }, {});
  byId("materials-list").innerHTML = Object.entries(counts).filter(([, quantity]) => quantity > 0).map(([name, quantity]) => {
    const splitter = splitters.find((item) => item.ratio === name);
    const suffix = splitter ? ` · cód. ${splitter.code}` : " · balanceado";
    return `<span class="material-chip">${quantity}× Splitter ${name}${suffix}</span>`;
  }).join("");
}

function updateQuick() {
  const result = OpticalCalculator.calculateQuick(numberValue("quick-power"), byId("quick-splitter").value);
  byId("quick-local").textContent = formatDbm(result.local);
  byId("quick-pass").textContent = formatDbm(result.pass);
}

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]);
}

byId("quick-splitter").innerHTML = splitterOptions();
byId("quick-splitter").value = "10/90";
byId("add-point").addEventListener("click", () => {
  points.push({ name: `CTO ${String(points.length + 1).padStart(2, "0")}`, distance: 0, splices: 0, splitter: "10/90", balanced: "1x8" });
  renderPoints();
});
byId("route-list").addEventListener("input", syncPoints);
byId("route-list").addEventListener("change", syncPoints);
byId("route-list").addEventListener("click", (event) => {
  const button = event.target.closest(".remove-point");
  if (!button) return;
  points.splice(Number(button.closest(".route-row").dataset.index), 1);
  renderPoints();
});
["source-power", "fiber-loss", "splice-loss", "minimum-power", "safety-margin"].forEach((id) => byId(id).addEventListener("input", calculate));
["quick-power", "quick-splitter"].forEach((id) => byId(id).addEventListener("input", updateQuick));
byId("new-project").addEventListener("click", () => {
  points = [];
  byId("project-name").value = "Nova rota óptica";
  renderPoints();
  window.scrollTo({ top: 0, behavior: "smooth" });
});

renderPoints();
updateQuick();
