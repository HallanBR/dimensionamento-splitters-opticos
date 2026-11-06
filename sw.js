"use strict";

// Arquivos do app: sempre busca a versão nova na rede e usa o cache só sem conexão.
// Motor Python (Pyodide): versão fixa, então fica no cache e abre quase na hora.
const APP_CACHE = "optica-app-v1";
const PYODIDE_CACHE = "optica-pyodide-v314.0.2";
const APP_SHELL = [
  "./",
  "index.html",
  "styles.css",
  "app.js",
  "optical.py",
  "manifest.webmanifest",
  "icons/icon-192.png",
  "icons/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(APP_CACHE).then((cache) => cache.addAll(APP_SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((key) => ![APP_CACHE, PYODIDE_CACHE].includes(key)).map((key) => caches.delete(key)),
      ))
      .then(() => self.clients.claim()),
  );
});

async function networkFirst(request) {
  const cache = await caches.open(APP_CACHE);
  try {
    const response = await fetch(request);
    if (response.ok) cache.put(request, response.clone());
    return response;
  } catch (error) {
    const cached = await cache.match(request, { ignoreSearch: true });
    if (cached) return cached;
    if (request.mode === "navigate") return cache.match("index.html");
    throw error;
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(PYODIDE_CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) cache.put(request, response.clone());
  return response;
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin === self.location.origin) {
    if (!url.pathname.startsWith("/api/")) event.respondWith(networkFirst(request));
  } else if (url.hostname === "cdn.jsdelivr.net" && url.pathname.startsWith("/pyodide/")) {
    event.respondWith(cacheFirst(request));
  }
});
