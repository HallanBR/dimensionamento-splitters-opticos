"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs
  .readFileSync(path.join(__dirname, "..", "app.js"), "utf8")
  .replace(/\r?\nstart\(\);\s*$/u, "");

const elements = new Map();
const element = (id) => {
  if (!elements.has(id)) elements.set(id, { value: "", textContent: "" });
  return elements.get(id);
};

const sandbox = {
  AbortController,
  Blob,
  CompressionStream,
  DecompressionStream,
  DOMException,
  Response,
  TextDecoder,
  TextEncoder,
  URL,
  URLSearchParams,
  atob,
  btoa,
  document: {
    getElementById: element,
  },
  navigator: {},
  window: {
    location: new URL("https://example.test/planner/"),
  },
};
const context = vm.createContext(sandbox);
vm.runInContext(source, context);

const route = [
  { name: "CTO São José", distance: 1.25, splices: 2, splitter: "10/90", balanced: "1x8", measured: -19.4 },
  { name: "CTO final", distance: 0.8, splices: 1, splitter: "", balanced: "1x16", measured: null },
];

function fillScenario() {
  vm.runInContext(`
    splitters = [{ ratio: "10/90" }, { ratio: "20/80" }];
    balancedLosses = { "Sem splitter": 0, "1x8": 10.5, "1x16": 13.8 };
    points = ${JSON.stringify(route)};
  `, context);
  element("project-name").value = "Expansão óptica – Centro";
  element("source-power").value = "4.5";
  element("fiber-loss").value = "0.35";
  element("splice-loss").value = "0.1";
  element("minimum-power").value = "-27";
  element("safety-margin").value = "3";
}

function clearScenario() {
  element("project-name").value = "";
  element("source-power").value = "0";
  vm.runInContext("points = []", context);
}

function assertRestored() {
  assert.equal(element("project-name").value, "Expansão óptica – Centro");
  assert.equal(element("source-power").value, "4.5");
  assert.deepEqual(JSON.parse(vm.runInContext("JSON.stringify(points)", context)), route);
}

async function main() {
  fillScenario();
  const link = await vm.runInContext("buildShareLink()", context);
  assert.match(link, /^https:\/\/example\.test\/planner\/#r=/u);

  // Link legado (formato JSON sem compressão) continua abrindo
  const legacyJson = vm.runInContext("JSON.stringify(scenarioPayload())", context);
  const legacyLink = `https://example.test/planner/#cenario=${Buffer.from(legacyJson).toString("base64url")}`;
  assert.ok(link.length < legacyLink.length, "o link comprimido deve ser menor que o legado");

  clearScenario();
  sandbox.window.location = new URL(link);
  assert.equal(await vm.runInContext("loadSharedScenario()", context), true);
  assertRestored();

  clearScenario();
  sandbox.window.location = new URL(legacyLink);
  assert.equal(await vm.runInContext("loadSharedScenario()", context), true);
  assertRestored();

  assert.throws(
    () => vm.runInContext(`normalizeSharedScenario({
      version: 1,
      name: "Inválido",
      settings: { sourcePower: 3, fiberLoss: 0.35, spliceLoss: 0.1, minimumPower: -27, safetyMargin: 3 },
      points: [{ name: "CTO", distance: 1, splices: 1, splitter: "99/01", balanced: "1x8" }],
    })`, context),
    /não é reconhecido/u,
  );

  sandbox.window.location = new URL("https://example.test/planner/#r=AAAA");
  await assert.rejects(vm.runInContext("loadSharedScenario()", context), /Não foi possível ler/u);

  console.log(`Compartilhamento por link: OK (link ${link.length} × legado ${legacyLink.length} caracteres)`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
