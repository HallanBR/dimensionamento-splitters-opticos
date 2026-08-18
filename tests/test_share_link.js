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
  DOMException,
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

vm.runInContext(`
  splitters = [{ ratio: "10/90" }, { ratio: "20/80" }];
  balancedLosses = { "Sem splitter": 0, "1x8": 10.5, "1x16": 13.8 };
  points = [
    { name: "CTO São José", distance: 1.25, splices: 2, splitter: "10/90", balanced: "1x8" },
    { name: "CTO final", distance: 0.8, splices: 1, splitter: "", balanced: "1x16" },
  ];
`, context);

element("project-name").value = "Expansão óptica – Centro";
element("source-power").value = "4.5";
element("fiber-loss").value = "0.35";
element("splice-loss").value = "0.1";
element("minimum-power").value = "-27";
element("safety-margin").value = "3";

const link = vm.runInContext("buildShareLink()", context);
assert.match(link, /^https:\/\/example\.test\/planner\/#cenario=/u);

element("project-name").value = "";
element("source-power").value = "0";
vm.runInContext("points = []", context);
sandbox.window.location = new URL(link);

assert.equal(vm.runInContext("loadSharedScenario()", context), true);
assert.equal(element("project-name").value, "Expansão óptica – Centro");
assert.equal(element("source-power").value, "4.5");
assert.deepEqual(
  JSON.parse(vm.runInContext("JSON.stringify(points)", context)),
  [
    { name: "CTO São José", distance: 1.25, splices: 2, splitter: "10/90", balanced: "1x8" },
    { name: "CTO final", distance: 0.8, splices: 1, splitter: "", balanced: "1x16" },
  ],
);

assert.throws(
  () => vm.runInContext(`normalizeSharedScenario({
    version: 1,
    name: "Inválido",
    settings: { sourcePower: 3, fiberLoss: 0.35, spliceLoss: 0.1, minimumPower: -27, safetyMargin: 3 },
    points: [{ name: "CTO", distance: 1, splices: 1, splitter: "99/01", balanced: "1x8" }],
  })`, context),
  /não é reconhecido/u,
);

console.log("Compartilhamento por link: OK");
