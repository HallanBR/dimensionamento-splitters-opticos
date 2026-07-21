"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  calculateRoute,
  calculateQuick,
  buildRecommendations,
} = require("../calculator.js");

const settings = {
  sourcePower: 3,
  fiberLoss: 0.35,
  spliceLoss: 0.1,
  minimumPower: -27,
  safetyMargin: 3,
};

test("calcula as duas saídas de um splitter 10/90", () => {
  const result = calculateQuick(-8, "10/90");
  assert.equal(result.local, -18.7);
  assert.equal(result.pass, -9);
});

test("propaga a saída passante para o ponto seguinte", () => {
  const points = [
    { name: "CTO 01", distance: 1, splices: 2, splitter: "10/90", balanced: "1x8" },
    { name: "CTO 02", distance: 2, splices: 1, splitter: "20/80", balanced: "1x8" },
  ];
  const results = calculateRoute(points, settings);
  assert.equal(results[0].input, 2.45);
  assert.equal(Number(results[0].pass.toFixed(2)), 1.45);
  assert.equal(Number(results[1].input.toFixed(2)), 0.65);
  assert.equal(Number(results[1].local.toFixed(2)), -17.55);
});

test("desconta a margem de segurança na classificação efetiva", () => {
  const results = calculateRoute([
    { name: "CTO", distance: 0, splices: 0, splitter: "05/95", balanced: "1x16" },
  ], settings);
  assert.equal(Number(results[0].margin.toFixed(2)), 2.4);
  assert.equal(Number(results[0].effectiveMargin.toFixed(2)), -0.6);
});

test("gera recomendação para rota abaixo da reserva", () => {
  const points = [{ name: "CTO crítica", distance: 0, splices: 0, splitter: "05/95", balanced: "1x16" }];
  const results = calculateRoute(points, settings);
  const recommendations = buildRecommendations(points, settings, results);
  assert.equal(recommendations[0].level, "required");
  assert.match(recommendations[0].title, /CTO crítica/);
});

test("reconhece folga elevada e sugere avaliar a origem", () => {
  const points = [{ name: "CTO próxima", distance: 0, splices: 0, splitter: "50/50", balanced: "1x2" }];
  const results = calculateRoute(points, settings);
  const recommendations = buildRecommendations(points, settings, results);
  assert.ok(recommendations.some((item) => item.title.includes("potência menor")));
});
