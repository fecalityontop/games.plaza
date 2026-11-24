const HOST_PREFIX = "/host/file/install/";
const GTA_MOUNT = "/games/gta4";

// GTA IV needs cross-origin isolation for SharedArrayBuffer/WebAssembly threads.
// The site at large uses `credentialless` so third-party game assets keep
// working; GTA's own pages (and its /iso + /app0 aliases) get `require-corp`.
function isGtaPath(path) {
  return path === GTA_MOUNT || path.startsWith(GTA_MOUNT + "/") ||
         path.startsWith("/iso/") || path.startsWith("/app0/");
}

function isolation(extra, coep, cache) {
  const headers = new Headers(extra || undefined);
  headers.set("Cross-Origin-Opener-Policy", "same-origin");
  headers.set("Cross-Origin-Embedder-Policy", coep);
  if (coep === "require-corp") headers.set("Cross-Origin-Resource-Policy", "same-origin");
  if (cache) headers.set("Cache-Control", cache);
  return headers;
}

function text(body, coep) {
  return new Response(body, {
    status: 200,
    headers: isolation({ "Content-Type": "text/plain; charset=utf-8" }, coep),
  });
}

// Cloudflare Pages serves these text files with LF-only line endings, but
// Run 3's level parser splits path metadata on CRLF. Without this it passes a
// whole level section to JSON.parse and throws. Restore CRLF on the way out.
function runTextNeedsCrlf(path) {
  return path.startsWith("/games/run/text/") && path.endsWith(".txt");
}
function toCrlf(text) {
  return text.replace(/\r\n/g, "\n").replace(/\n/g, "\r\n");
}

// Single place that adds the isolation headers to every static-asset response,
// including the .partNNN files the service worker streams back together.
async function asset(request, env, target, coep, noCache, transformText) {
  const response = await env.ASSETS.fetch(target);
  let body = response.body;
  let headers = response.headers;
  if (transformText && response.ok && response.body) {
    body = transformText(await response.text());
    headers = new Headers(headers);
    // These describe the original asset bytes, not the normalized body.
    headers.delete("Content-Length");
    headers.delete("Content-Encoding");
    headers.delete("ETag");
  }
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: isolation(headers, coep, noCache ? "no-cache, no-store, must-revalidate" : null),
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const coep = isGtaPath(path) ? "require-corp" : "credentialless";
    const noCache = path === "/sw.js" || path.endsWith("/sw.js");

    // GTA IV hub endpoints. The big files are static assets split into
    // .partNNN files; the service worker reassembles them. No Python needed.
    if (path === "/host/info") return text("install\t/host/file/install/\n", "require-corp");
    if (path === "/host/free") return text("1099511627776\n", "require-corp");
    if (path === "/host/list/install") return text("", "require-corp");
    if (path.startsWith(HOST_PREFIX)) {
      const internal = new URL(GTA_MOUNT + "/host/install/" + path.slice(HOST_PREFIX.length), url);
      return asset(request, env, new Request(internal.href, {
        method: request.method,
        headers: request.headers,
      }), "require-corp", false);
    }
    if (path.startsWith("/upload/") && request.method === "POST") {
      // No storage on this site; acknowledge so the hub continues.
      return new Response(null, {
        status: 204,
        headers: isolation(null, "require-corp"),
      });
    }

    // The game asks for /iso/... and /app0/... at the site root. The SW maps
    // these to the mount; do the same here so direct loads work too.
    if (path.startsWith("/iso/") || path.startsWith("/app0/")) {
      const internal = new URL(GTA_MOUNT + path, url);
      return asset(request, env, new Request(internal.href, {
        method: request.method,
        headers: request.headers,
      }), "require-corp", false);
    }

    // Clean URL for the settings window.
    if (path === "/settings" || path === "/settings/") {
      const internal = new URL("/settings.html", url);
      return asset(request, env, new Request(internal.href, {
        method: request.method,
        headers: request.headers,
      }), coep, noCache);
    }

    // Eaglercraft 26.3 (Horizon) shares memory across threads and needs the
    // stricter policy even before the service worker takes control.
    const eagler = path === "/games/eagler/26.3" || path.startsWith("/games/eagler/26.3/");
    return asset(request, env, request, eagler ? "require-corp" : coep, noCache,
      runTextNeedsCrlf(path) ? toCrlf : null);
  },
};
