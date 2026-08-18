/*
  Generate the service worker from the REAL build output.

  Why generated rather than hand-written: Vite content-hashes the JS and CSS
  (`index-DtBJpEAo.js`), so the filenames change on every meaningful build. A
  hardcoded precache list would go stale silently — the worker would cache a
  file that no longer exists, the fetch would fail, and the app would look
  broken offline while working perfectly online. Reading `dist/` after the
  build is the only list that cannot drift.

  The cache name embeds a hash of the file list, so a new build produces a new
  cache and `activate` deletes the old one. Without that the first version
  would be served forever — the classic service-worker trap where users are
  pinned to a stale app and no amount of refreshing helps.
*/
import { readdirSync, statSync, writeFileSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { createHash } from 'node:crypto';

const DIST = 'dist';

const walk = (dir) => readdirSync(dir).flatMap((name) => {
  const p = join(dir, name);
  return statSync(p).isDirectory() ? walk(p) : [p];
});

const files = walk(DIST)
  .map((p) => '/' + relative(DIST, p).split('\\').join('/'))
  // The OFL licence text and the 1024 icon are never requested at runtime:
  // the licence is a legal file that ships alongside the font, and 1024 is
  // only used by install UI, which fetches it over the network at install
  // time. Precaching them would cost ~24KB of a phone's cache budget for
  // bytes the running app never asks for.
  .filter((f) => f !== '/fonts/Oswald-OFL.txt' && f !== '/icons/icon-1024.png' && f !== '/icon.svg')
  .sort();

// Cache-bust on content, not on a version someone must remember to bump.
const hash = createHash('sha256')
  .update(files.map((f) => f + ':' + statSync(join(DIST, f.slice(1))).size).join('|'))
  .digest('hex')
  .slice(0, 8);

const sw = `/*
  GENERATED FILE — do not edit. Produced by scripts/make-sw.mjs at build time.

  Makes the app work with NO NETWORK: the Mac can be asleep, the phone can be
  on cellular or in airplane mode. Everything the app needs at runtime is
  precached on first load. The camera and the audio are entirely local — once
  these files are on the device there is genuinely nothing left to fetch.

  Strategy is CACHE-FIRST for precached assets. This is a fixed set of
  content-hashed build artifacts, so a cache hit can never be stale: if the
  content changed, the filename changed, and the new filename is in a new
  cache. Network-first would spend a round trip on every asset to discover
  what it already knows.
*/
const CACHE = 'impression-${hash}';
const PRECACHE = ${JSON.stringify(files, null, 2)};

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    /*
      Cached one-by-one rather than with \`cache.addAll\`, which is atomic: a
      single 404 rejects the whole batch and NOTHING is cached, leaving the app
      silently online-only. Failing per-file means a missing asset costs that
      one asset instead of the entire offline capability.
    */
    await Promise.all(PRECACHE.map(async (url) => {
      try {
        const res = await fetch(url, { cache: 'reload' });
        if (res.ok) await cache.put(url, res);
      } catch { /* keep going; one missing file must not sink the install */ }
    }));
    // Take over without waiting for every tab to close.
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    // Drop caches from previous builds, or the device accumulates a copy of
    // every version ever installed.
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Only GET is cacheable, and only same-origin: a cross-origin request has
  // nothing to do with this app's offline story.
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  /*
    NAVIGATIONS: serve the cached shell.

    A single-page app has exactly one HTML entry point, so any navigation —
    including a launch from the home-screen icon with no network — resolves to
    the precached index.html. Without this branch an offline launch would fail
    at the very first request and never reach the cached JS at all.
  */
  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      const cached = await caches.match('/index.html');
      if (cached) return cached;
      try { return await fetch(request); }
      catch { return new Response('Offline', { status: 503, headers: { 'Content-Type': 'text/plain' } }); }
    })());
    return;
  }

  event.respondWith((async () => {
    const cached = await caches.match(request);
    if (cached) return cached;
    try {
      const res = await fetch(request);
      /*
        Cache same-origin successes encountered at runtime. \`res.ok\` excludes
        404s and, importantly, opaque responses — caching an opaque response
        stores a body this worker cannot read and cannot validate.
      */
      if (res.ok && res.type === 'basic') {
        const cache = await caches.open(CACHE);
        cache.put(request, res.clone());
      }
      return res;
    } catch {
      // Genuinely offline and not precached. Nothing useful to return.
      return new Response('', { status: 504 });
    }
  })());
});
`;

writeFileSync(join(DIST, 'sw.js'), sw);
console.log(`sw.js written — cache impression-${hash}, ${files.length} files precached:`);
for (const f of files) console.log('  ' + f);
