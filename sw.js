const ENCODING = "auto";
const MAX_PARTS = 30;
const GTA_MOUNT = "/games/gta4";
// The WASM/hub use root-absolute paths; the files live under the mount.
const GTA_ALIASES = ["/iso/", "/app0/"];
// Worker.js handles these directly, so the SW must pass them through.
const GTA_PASSTHROUGH = ["/host/", "/upload/"];
// Only these GTA files are split. Probing a manifest for every shader/font
// would add a wasted 404 round trip per asset (the game loads 1000+ wgsl).
const GTA_SPLIT_SUFFIXES = [".wasm", ".iso", ".data", ".bin"];
// Cache-busting bucket: rotate every hour so stale cached responses
// (browser HTTP cache + any Cache API entries) are abandoned and refetched.
const CACHE_BUCKET_MS = 60 * 60 * 1000;
function cacheBucket() { return Math.floor(Date.now() / CACHE_BUCKET_MS); }

const gtaManifests = new Map();

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
  if (url.pathname.includes(".part")) return; // part files are fetched by handleGta
  // The game page keeps a clean address (`/game.html?g=<id>`). Cache-busting
  // navigations to it would leak `_v` into the visible URL, so leave it alone.
  if (url.pathname === "/game.html") {
    event.respondWith(handle(req, url));
    return;
  }
  if (GTA_PASSTHROUGH.some((p) => url.pathname.startsWith(p))) return;
  if (isGta(url)) {
    event.respondWith(handleGta(req, url));
    return;
  }
  // Eaglercraft 26.3 (Horizon) shares memory across threads: it needs
  // COEP "require-corp" instead of the site's usual "credentialless".
  // Bust the browser HTTP cache by versioning the URL with the current hour bucket.
  // New bucket => new URL => cache miss => fresh fetch, while old entries go stale.
  const busted = new URL(url.href);
  busted.searchParams.set("_v", String(cacheBucket()));
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
  // cannot copy a navigation request's mode. We intentionally cache-bust with
  // `_v` anyway, so an only-if-cached probe would always miss; drop the cache
  // mode so the Request constructor doesn't throw.
  if (init.cache === "only-if-cached") delete init.cache;
  return init;
}

function isGta(url) {
  const p = url.pathname;
  return p === GTA_MOUNT || p.startsWith(GTA_MOUNT + "/") || GTA_ALIASES.some((a) => p.startsWith(a));
}

// /iso/gta4.iso -> /games/gta4/iso/gta4.iso (where split.js wrote the parts)
function gtaInternalUrl(url) {
  const u = new URL(url.href);
  u.search = "";
  for (const alias of GTA_ALIASES) {
    if (u.pathname.startsWith(alias)) {
      u.pathname = GTA_MOUNT + alias + u.pathname.slice(alias.length);
      break;
    }
  }
  return u;
}

function withCOI(res, url) {
  if (!res || res.status === 0) return res;
  const gamePath = !!url && (url.pathname === "/games/eagler/26.3" ||
    url.pathname.startsWith("/games/eagler/26.3/") || isGta(url));
  const coep = gamePath ? "require-corp" : "credentialless";
  const headers = new Headers(res.headers);
  headers.set("Cross-Origin-Opener-Policy", "same-origin");
  headers.set("Cross-Origin-Embedder-Policy", coep);
  if (gamePath) headers.set("Cross-Origin-Resource-Policy", "same-origin");
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
  for (let i = 1; i <= MAX_PARTS; i++) {
    const partUrl = `${url.origin}${url.pathname}.part${String(i).padStart(3, "0")}?_v=${cacheBucket()}`;
    const head = await fetch(partUrl, { method: "HEAD" });
    if (!head.ok) break;
    if ((head.headers.get("content-type") || "").includes("text/html")) break;
    const len = Number(head.headers.get("content-length")) || 0;
    if (len) total += len;
    else known = false;
    urls.push(partUrl);
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

  const found = await findParts(url);
  if (!found) return withCOI(direct, url);

  let enc = null;
  if (isUnity) enc = ENCODING === "auto" ? await sniffUrl(found.urls[0]) : ENCODING;

  if (req.method === "HEAD") return withCOI(build(url, null, found.total, enc), url);
  return withCOI(build(url, streamParts(found.urls), found.total, enc), url);
}

// ---------- GTA IV: split-asset reassembly with real byte-range support ----------

async function gtaManifest(internalUrl) {
  const key = internalUrl.pathname;
  if (gtaManifests.has(key)) return gtaManifests.get(key);
  const res = await fetch(new URL(`${key}.manifest.json`, internalUrl.origin));
  if (!res.ok) return null;
  const manifest = await res.json();
  gtaManifests.set(key, manifest);
  return manifest;
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

function gtaPartUrl(internalUrl, index) {
  return new URL(`${internalUrl.pathname}.part${String(index + 1).padStart(3, "0")}`, internalUrl.origin).href;
}

// Streams [start, end] out of the split parts. Cloudflare static assets
// ignore Range headers, so fetch a part once and discard the leading bytes
// instead of buffering a whole 24 MB part for every 4 MB read the game makes.
function gtaRangeStream(internalUrl, manifest, start, end) {
  let partIndex = Math.floor(start / manifest.chunkSize);
  let offset = start - partIndex * manifest.chunkSize;
  let remaining = end - start + 1;
  let need = 0;
  let skipping = 0;
  let reader = null;

  return new ReadableStream({
    async pull(controller) {
      try {
        while (remaining > 0) {
          if (!reader) {
            if (partIndex >= manifest.partCount) {
              controller.close();
              return;
            }
            need = Math.min(remaining, manifest.sizes[partIndex] - offset);
            if (need <= 0) {
              partIndex += 1;
              offset = 0;
              continue;
            }
            const res = await fetch(gtaPartUrl(internalUrl, partIndex));
            if (!res.ok || !res.body) throw new Error(`Part ${partIndex + 1} failed: ${res.status}`);
            reader = res.body.getReader();
            skipping = offset;
          }

          let { done, value } = await reader.read();
          if (done) {
            await reader.cancel().catch(() => {});
            reader = null;
            if (need > 0) throw new Error(`Part ${partIndex + 1} ended early`);
            partIndex += 1;
            offset = 0;
            continue;
          }
          if (skipping > 0) {
            const drop = Math.min(skipping, value.byteLength);
            skipping -= drop;
            if (value.byteLength <= drop) continue;
            value = value.slice(drop);
          }
          if (value.byteLength <= need) {
            controller.enqueue(value);
            remaining -= value.byteLength;
            need -= value.byteLength;
          } else {
            controller.enqueue(value.slice(0, need));
            remaining -= need;
            need = 0;
          }
          if (need === 0) {
            await reader.cancel().catch(() => {});
            reader = null;
            partIndex += 1;
            offset = 0;
          }
          return;
        }
        controller.close();
      } catch (error) {
        controller.error(error);
      }
    },
    cancel() {
      return reader ? reader.cancel() : undefined;
    },
  });
}

async function handleGta(req, url) {
  if (url.pathname === GTA_MOUNT) {
    const redirect = new Response(null, { status: 302, headers: { Location: `${GTA_MOUNT}/` } });
    return withCOI(redirect, url);
  }

  const internal = gtaInternalUrl(url);
  const manifest = GTA_SPLIT_SUFFIXES.some((s) => internal.pathname.endsWith(s))
    ? await gtaManifest(internal)
    : null;

  if (!manifest) {
    // Ordinary site files (index.html, js, hub art, tu8, aes_key, ...).
    // No cache-busting: let the browser's HTTP cache and ETags do their job.
    return withCOI(await fetch(new Request(internal.href, copyInit(req))), url);
  }

  const rangeHeader = req.headers.get("Range");
  const range = rangeHeader ? parseRange(rangeHeader, manifest.total) : "full";
  if (range === null) {
    const headers = new Headers({ "Content-Range": `bytes */${manifest.total}` });
    return withCOI(new Response(null, { status: 416, headers }), url);
  }

  const headers = new Headers();
  headers.set("Content-Type", internal.pathname.endsWith(".wasm") ? "application/wasm" : "application/octet-stream");
  headers.set("Accept-Ranges", "bytes");
  headers.set("Cache-Control", "no-cache");
  headers.set("X-Uncompressed-Length", String(manifest.total));
  if (range === "full") {
    headers.set("Content-Length", String(manifest.total));
  } else {
    headers.set("Content-Range", `bytes ${range.start}-${range.end}/${manifest.total}`);
    headers.set("Content-Length", String(range.end - range.start + 1));
  }

  if (req.method === "HEAD") {
    return withCOI(new Response(null, { status: range === "full" ? 200 : 206, headers }), url);
  }

  const slice = range === "full"
    ? { start: 0, end: manifest.total - 1 }
    : range;
  return withCOI(
    new Response(gtaRangeStream(internal, manifest, slice.start, slice.end), {
      status: range === "full" ? 200 : 206,
      headers,
    }),
    url
  );
}
