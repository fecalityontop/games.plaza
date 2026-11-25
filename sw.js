const ENCODING = "auto";
// Instead of deploying 31k individual vcsky files (over Cloudflare's
// 20k-asset limit) they live in offset-addressed packs too. The manifest
// maps each original URL to a byte range in one of the split pack parts.
const VCSKY_MOUNT = "/games/gta/vc/vcsky";
const VCSKY_PACK_BASE = VCSKY_MOUNT + "/packs/";
// Never append `_v` to these navigation URLs. Cloudflare redirects the
// explicit index.html paths to their clean equivalents, so cover both forms.
const NO_CACHE_BUST = new Set([
  "/",
  "/index.html",
  "/game", // Cloudflare redirects /game.html here, preserving the query
  "/game/",
  "/game.html",
  "/game/index.html",
  "/settings",
  "/settings/",
  "/settings.html",
  "/settings/index.html",
]);
// Cache-busting bucket: rotate every hour so stale cached responses
// (browser HTTP cache + any Cache API entries) are abandoned and refetched.
const CACHE_BUCKET_MS = 60 * 60 * 1000;
// Bump when deployed files change so clients refetch even in the same hour bucket.
const CACHE_EPOCH = "20261125d";
function cacheBucket() { return Math.floor(Date.now() / CACHE_BUCKET_MS); }
function cacheVersion() { return CACHE_EPOCH + "-" + cacheBucket(); }

const vcskyManifests = new Map();

// Pack parts are ~22 MiB each. Keep a small LRU so touching many assets in
// the same part doesn't re-download it for every single file, and dedupe
// concurrent requests for a part that isn't cached yet.
const VCSKY_PART_CACHE_LIMIT = 4;
const vcskyPartBuffers = new Map();
const vcskyPartPending = new Map();

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil((async () => {
  // Drop any previously stored caches so old versions can't linger.
  try {
    const keys = await caches.keys();
    await Promise.all(keys.map((k) => caches.delete(k)));
  } catch (e) {}
  await self.clients.claim();
})()));

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (req.method !== "GET" && req.method !== "HEAD") return;
  if (url.pathname.includes(".part")) return; // part files are fetched by the handlers
  if (NO_CACHE_BUST.has(url.pathname)) {
    event.respondWith(handle(req, url));
    return;
  }
  if (isVcskyFetched(url)) {
    event.respondWith(handleVcsky(req, url));
    return;
  }
  // Bust the browser HTTP cache by versioning the URL with the current hour bucket.
  // New bucket => new URL => cache miss => fresh fetch, while old entries go stale.
  const busted = new URL(url.href);
  busted.searchParams.set("_v", cacheVersion());
  // `req` may be a navigation request, whose `mode` is "navigate". The
  // Request constructor rejects "navigate" in RequestInit, so copy only
  // the safe, transferable fields and let the mode default.
  const bustedReq = new Request(busted.href, copyInit(req));
  event.respondWith(handle(bustedReq, busted));
});

function copyInit(req) {
  const init = {};
  for (const k of ['method', 'headers', 'credentials', 'cache', 'redirect',
                   'referrer', 'referrerPolicy', 'integrity', 'keepalive', 'signal']) {
    if (req[k] !== undefined) init[k] = req[k];
  }
  // `only-if-cached` is only valid with mode "same-origin", and RequestInit
  // cannot copy a navigation request's mode. Versioned navigations would
  // always miss that cache mode anyway, so drop it to avoid a constructor error.
  if (init.cache === "only-if-cached") delete init.cache;
  return init;
}

function isVcskyFetched(url) {
  const p = url.pathname;
  return ["/vcsky/fetched/", VCSKY_MOUNT + "/fetched/"]
    .some((prefix) => p.startsWith(prefix));
}

// game.js rewrites the CDN URLs to /games/gta/vc/vcsky/...; the manifest was
// generated with the original /vcsky/... keys, so normalize before lookup.
function vcskyManifestKey(pathname) {
  return pathname.startsWith(VCSKY_MOUNT + "/")
    ? "/vcsky/" + pathname.slice(VCSKY_MOUNT.length + 1)
    : pathname;
}

function withCOI(res, url) {
  if (!res || res.status === 0) return res;
  // Eaglercraft 26.3 (Horizon) shares memory across threads and needs the
  // stricter policy; the rest of the site uses "credentialless".
  const strict = !!url && (url.pathname === "/games/eagler/26.3" ||
    url.pathname.startsWith("/games/eagler/26.3/"));
  const coep = strict ? "require-corp" : "credentialless";
  const headers = new Headers(res.headers);
  headers.set("Cross-Origin-Opener-Policy", "same-origin");
  headers.set("Cross-Origin-Embedder-Policy", coep);
  if (strict) headers.set("Cross-Origin-Resource-Policy", "same-origin");
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

function typeFor(path) {
  if (path.endsWith(".js.unityweb")) return "application/javascript";
  return "application/octet-stream";
}

function isGzip(head) {
  return !!head && head[0] === 0x1f && head[1] === 0x8b;
}

async function peek(stream) {
  const [a, b] = stream.tee();
  const reader = a.getReader();
  const { value } = await reader.read();
  reader.cancel().catch(() => {});
  return { head: value, body: b };
}

async function sniffUrl(url) {
  const res = await fetch(url);
  if (!res.ok || !res.body) return null;
  const reader = res.body.getReader();
  const { value } = await reader.read();
  reader.cancel().catch(() => {});
  return isGzip(value) ? "gzip" : null;
}

function decode(stream, enc) {
  if (!stream) return null;
  if (enc === "gzip") return stream.pipeThrough(new DecompressionStream("gzip"));
  if (enc === "br") return stream.pipeThrough(new DecompressionStream("brotli"));
  return stream;
}

function build(url, body, length, enc) {
  const h = new Headers();
  h.set("Content-Type", typeFor(url.pathname));
  h.set("Cache-Control", "public, max-age=3600");
  if (length && !enc) h.set("Content-Length", String(length));
  return new Response(decode(body, enc), { status: 200, headers: h });
}

async function findParts(url) {
  const urls = [];
  let total = 0;
  let known = true;
  let i = 1;
  // No part-count cap: keep probing until a part is missing. The HTML check
  // stops a SPA fallback from turning this into an endless loop.
  while (true) {
    const partUrl = `${url.origin}${url.pathname}.part${String(i).padStart(3, "0")}?_v=${cacheVersion()}`;
    const head = await fetch(partUrl, { method: "HEAD" });
    if (!head.ok) break;
    if ((head.headers.get("content-type") || "").includes("text/html")) break;
    const len = Number(head.headers.get("content-length")) || 0;
    if (len) total += len;
    else known = false;
    urls.push(partUrl);
    i++;
  }
  return urls.length ? { urls, total: known ? total : 0 } : null;
}

function streamParts(urls) {
  let i = 0;
  let reader = null;
  return new ReadableStream({
    async pull(controller) {
      while (true) {
        if (!reader) {
          if (i >= urls.length) return controller.close();
          const res = await fetch(urls[i++]);
          if (!res.ok || !res.body) return controller.error(new Error(`Part ${i} failed: ${res.status}`));
          reader = res.body.getReader();
        }
        const { done, value } = await reader.read();
        if (done) {
          reader = null;
          continue;
        }
        controller.enqueue(value);
        return;
      }
    },
    cancel() {
      return reader ? reader.cancel() : undefined;
    },
  });
}

async function handle(req, url) {
  let direct;
  try {
    direct = await fetch(req);
  } catch (e) {
    return fetch(req);
  }
  const isUnity = url.pathname.endsWith(".unityweb");

  if (direct.status !== 404) {
    if (direct.status === 200 && isUnity && req.method === "GET" && direct.body) {
      let enc = ENCODING === "auto" ? null : ENCODING;
      let body = direct.body;
      if (ENCODING === "auto") {
        const p = await peek(body);
        enc = isGzip(p.head) ? "gzip" : null;
        body = p.body;
      }
      return withCOI(build(url, body, Number(direct.headers.get("content-length")) || 0, enc), url);
    }
    return withCOI(direct, url);
  }

  // Any missing file may be a split asset; check for .partNNN siblings.
  const found = await findParts(url);
  if (!found) return withCOI(direct, url);

  let enc = null;
  if (isUnity) enc = ENCODING === "auto" ? await sniffUrl(found.urls[0]) : ENCODING;

  if (req.method === "HEAD") return withCOI(build(url, null, found.total, enc), url);
  return withCOI(build(url, streamParts(found.urls), found.total, enc), url);
}

// ---------- GTA VC: vcsky/fetched packed into range-addressable parts ----------

function vcskyPartUrl(index) {
  return new URL(`${VCSKY_PACK_BASE}en/part${String(index + 1).padStart(3, "0")}.bin`, self.location.href).href;
}

// Fetch a pack part once per SW lifetime (with a bounded LRU), and share the
// same in-flight promise when many assets in one part are requested at once.
// No `no-store`: static assets support ETags, so later SW restarts can
// revalidate instead of pulling 22 MiB again.
function vcskyPart(index) {
  const hit = vcskyPartBuffers.get(index);
  if (hit) {
    vcskyPartBuffers.delete(index);
    vcskyPartBuffers.set(index, hit); // refresh LRU order
    return Promise.resolve(hit);
  }

  const pending = vcskyPartPending.get(index);
  if (pending) return pending;

  const promise = (async () => {
    const u = new URL(vcskyPartUrl(index));
    u.searchParams.set("_v", cacheVersion());
    const res = await fetch(u);
    if (!res.ok) throw new Error(`Pack part ${index + 1} failed: ${res.status}`);
    const buf = await res.arrayBuffer();
    vcskyPartBuffers.set(index, buf);
    while (vcskyPartBuffers.size > VCSKY_PART_CACHE_LIMIT) {
      vcskyPartBuffers.delete(vcskyPartBuffers.keys().next().value);
    }
    return buf;
  })();

  vcskyPartPending.set(index, promise);
  const done = () => {
    if (vcskyPartPending.get(index) === promise) vcskyPartPending.delete(index);
  };
  promise.then(done, done);
  return promise;
}

// An entry is [packOffset, storedLength, rawLength, encoding]. The pack is
// split into CHUNK-sized files, so an entry can straddle two parts. Static
// assets ignore Range headers; slice the cached part buffer(s) instead.
async function vcskyStoredBytes(manifest, entry) {
  const [offset, storedLength] = entry;
  const first = Math.floor(offset / manifest.chunkSize);
  const last = Math.floor((offset + storedLength - 1) / manifest.chunkSize);
  const indices = [];
  for (let i = first; i <= last; i++) indices.push(i);
  const buffers = await Promise.all(indices.map(vcskyPart));
  const chunks = [];
  for (let n = 0; n < indices.length; n++) {
    const i = indices[n];
    const part = new Uint8Array(buffers[n]);
    const from = i === first ? offset - i * manifest.chunkSize : 0;
    const to = i === last ? offset + storedLength - i * manifest.chunkSize : part.byteLength;
    chunks.push(part.subarray(from, to));
  }
  if (chunks.length === 1) return chunks[0];
  const out = new Uint8Array(storedLength);
  let pos = 0;
  for (const c of chunks) { out.set(c, pos); pos += c.byteLength; }
  return out;
}

async function gunzip(data) {
  const ds = new DecompressionStream("gzip");
  return new Response(new Blob([data]).stream().pipeThrough(ds)).arrayBuffer();
}

async function handleVcsky(req, url) {
  try {
    return await handleVcskyInner(req, url);
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    console.error(`[vcsky] ${url.pathname}: ${message}`);
    return withCOI(new Response(`vcsky asset unavailable: ${message}`, {
      status: 502,
      headers: { "Content-Type": "text/plain", "Cache-Control": "no-store" },
    }), url);
  }
}

async function handleVcskyInner(req, url) {
  const key = vcskyManifestKey(url.pathname);
  const manifest = await vcskyManifest();
  if (!manifest) return withCOI(new Response(null, { status: 404 }), url);
  const entry = manifest.entries[key];
  if (!entry) return withCOI(new Response(null, { status: 404 }), url);

  const [, , rawLength, encoding] = entry;
  const total = encoding ? rawLength : entry[1];
  const headers = new Headers({
    "Content-Type": contentTypeFor(url.pathname),
    "Accept-Ranges": "bytes",
    "Cache-Control": "no-cache",
  });
  const range = parseRange(req.headers.get("Range"), total);
  if (range === null) {
    headers.set("Content-Range", `bytes */${total}`);
    return withCOI(new Response(null, { status: 416, headers }), url);
  }
  headers.set("Content-Length", range === "full" ? String(total) : String(range.end - range.start + 1));
  if (range !== "full") headers.set("Content-Range", `bytes ${range.start}-${range.end}/${total}`);
  if (req.method === "HEAD") {
    return withCOI(new Response(null, { status: range === "full" ? 200 : 206, headers }), url);
  }

  const start = range === "full" ? 0 : range.start;
  const end = range === "full" ? total - 1 : range.end;
  const stored = await vcskyStoredBytes(manifest, entry);
  const raw = encoding === "gzip" ? await gunzip(stored) : stored;
  return withCOI(new Response(raw.slice(start, end + 1), {
    status: range === "full" ? 200 : 206,
    headers,
  }), url);
}

function contentTypeFor(path) {
  if (path.endsWith(".mp3")) return "audio/mpeg";
  if (path.endsWith(".wav")) return "audio/wav";
  if (path.endsWith(".adf")) return "application/octet-stream";
  if (path.endsWith(".dff")) return "model/3ds";
  if (path.endsWith(".txd")) return "image/vnd.valve.source.texture";
  return "application/octet-stream";
}

async function vcskyManifest() {
  const p = VCSKY_PACK_BASE + "en/manifest.json";
  if (vcskyManifests.has(p)) return vcskyManifests.get(p);
  try {
    const u = new URL(p, self.location.href);
    u.searchParams.set("_v", cacheVersion());
    const res = await fetch(u);
    if (!res.ok) return null;
    const manifest = await res.json();
    vcskyManifests.set(p, manifest);
    return manifest;
  } catch { return null; }
}

function parseRange(header, total) {
  const m = /^bytes=(\d*)-(\d*)$/.exec((header || "").trim());
  if (!m || (!m[1] && !m[2])) return "full";
  let start;
  let end;
  if (m[1]) {
    start = Number(m[1]);
    end = m[2] ? Number(m[2]) : total - 1;
  } else {
    start = Math.max(0, total - Number(m[2]));
    end = total - 1;
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return "full";
  end = Math.min(end, total - 1);
  if (start > end || start >= total) return null;
  return { start, end };
}
