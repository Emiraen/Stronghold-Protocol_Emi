import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const root = fileURLToPath(new URL('../../', import.meta.url));
export const resourceTestChrome = process.env.CHROME_PATH || [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/chromium', '/usr/bin/google-chrome',
].find(existsSync);

/** Isolated Chrome profile and an ephemeral static-only server; never starts the game server. */
export async function resourceBrowserHarness() {
  const server = createServer(async (req, res) => {
    const path = String(req.url).split('?')[0];
    if (path === '/') { res.end('<!doctype html><title>Resource cache IO regression</title>'); return; }
    if (!/^\/(?:public\/js|shared)\/[\w/.-]+\.js$/.test(path) || path.includes('..')) {
      res.writeHead(404).end(); return;
    }
    try { res.setHeader('Content-Type', 'text/javascript'); res.end(await readFile(resolve(root, `.${path}`))); }
    catch { res.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  let browser;
  try { browser = await puppeteer.launch({ executablePath: resourceTestChrome, headless: true, args: ['--no-sandbox', '--disable-gpu'] }); }
  catch (error) { await new Promise(resolve => server.close(resolve)); throw error; }
  return {
    async run(config, scenario) {
      const page = await browser.newPage(), externalRequests = [];
      await page.setRequestInterception(true);
      page.on('request', request => {
        if (new URL(request.url()).origin === origin) request.continue();
        else { externalRequests.push(request.url()); request.abort(); }
      });
      try {
        await page.goto(origin);
        await page.evaluate(async config => {
          const io = { gets: [], scans: 0 }, requests = [];
          let db;
          const open = () => new Promise((resolve, reject) => {
            const request = indexedDB.open('stronghold-resource-cache', 1);
            request.onupgradeneeded = () => request.result.createObjectStore('resources', { keyPath: 'url' });
            request.onerror = () => reject(request.error);
            request.onsuccess = () => { db = request.result; resolve(db); };
          });
          const mutate = async action => {
            if (!db) await open();
            return new Promise((resolve, reject) => {
              const tx = db.transaction('resources', 'readwrite');
              action(tx.objectStore('resources'));
              tx.oncomplete = resolve;
              tx.onerror = tx.onabort = () => reject(tx.error);
            });
          };
          const fixture = { config, io, requests, manifestRequests: [],
            put(item, body, extra = {}) {
              return mutate(store => store.put({ url: new URL(item.url, location).href, version: item.version,
                bytes: item.bytes, type: item.type, complete: true, blob: new Blob([body], { type: item.type }), ...extra }));
            },
            remove(item) { return mutate(store => store.delete(new URL(item.url, location).href)); },
            resetIo() { io.gets.length = 0; io.scans = 0; requests.length = 0; },
          };
          const get = IDBObjectStore.prototype.get, getAll = IDBObjectStore.prototype.getAll;
          IDBObjectStore.prototype.get = function(key) {
            if (this.name === 'resources') {
              const entry = { mode: this.transaction.mode, key: String(key), sequence: io.gets.length + 1 };
              io.gets.push(entry);
              if (entry.mode === 'readonly') this.transaction.addEventListener('complete', () => {
                // A later task observes all promise continuations of this read as well.
                setTimeout(() => fixture.onReadComplete?.(entry), 0);
              }, { once: true });
            }
            return get.call(this, key);
          };
          IDBObjectStore.prototype.getAll = function(...args) {
            if (this.name === 'resources') {
              io.scans++;
              if (fixture.pauseScanAt === io.scans) {
                // Complete the real read transaction, then let an unrelated write finish before
                // delivering its completion to check(). This exercises scanChanges reconciliation.
                let handler;
                Object.defineProperty(this.transaction, 'oncomplete', { configurable: true,
                  get: () => handler, set: value => { handler = value; } });
                this.transaction.addEventListener('complete', event => {
                  Promise.resolve().then(() => fixture.duringScan()).then(() => handler?.(event), error => {
                    fixture.scanWriteError = String(error);
                    handler?.(event);
                  });
                }, { once: true });
              }
            }
            return getAll.apply(this, args);
          };
          globalThis.fetch = async (input, options = {}) => {
            const url = new URL(input, location);
            if (url.pathname.startsWith('/data/resource-preload.')) {
              fixture.manifestRequests.push(url.pathname);
              if (fixture.onManifestFetch) {
                const response = await fixture.onManifestFetch(url, options);
                if (response) return response;
              }
              return Response.json(config.manifest);
            }
            const request = { path: url.pathname, range: new Headers(options.headers).get('Range') };
            requests.push(request);
            if (fixture.onFetch) {
              const response = await fixture.onFetch(url, options);
              if (response) return response;
            }
            if (url.pathname.endsWith('.sprpack')) return new Response('', { status: 404 });
            const body = config.bodies[url.pathname];
            if (body === undefined) throw new Error(`Unexpected mocked resource: ${url.pathname}`);
            return new Response(body, { headers: { 'Content-Type': 'application/octet-stream' } });
          };
          if (config.disableIndexedDB) Object.defineProperty(globalThis, 'indexedDB', { value: undefined, configurable: true });
          const module = await import('/public/js/resourceCache.js');
          Object.assign(fixture, module);
          fixture.inspect = async item => {
            if (!db) await open();
            return new Promise((resolve, reject) => {
              const tx = db.transaction('resources', 'readonly'), request = get.call(tx.objectStore('resources'), new URL(item.url, location).href);
              tx.oncomplete = () => resolve(request.result);
              tx.onerror = () => reject(tx.error);
            });
          };
          globalThis.resourceFixture = fixture;
        }, config);
        const result = await page.evaluate(scenario);
        if (externalRequests.length) throw new Error(`Unexpected external network request: ${externalRequests.join(', ')}`);
        return result;
      } finally { await page.close(); }
    },
    async close() { await browser.close(); await new Promise(resolve => server.close(resolve)); },
  };
}
