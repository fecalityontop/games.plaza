function isolation(extra, coep, cache) {
  const headers = new Headers(extra || undefined);
  headers.set("Cross-Origin-Opener-Policy", "same-origin");
  headers.set("Cross-Origin-Embedder-Policy", coep);
  if (coep === "require-corp") headers.set("Cross-Origin-Resource-Policy", "same-origin");
  if (cache) headers.set("Cache-Control", cache);
  return headers;
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
    const noCache = path === "/sw.js" || path.endsWith("/sw.js");

    // Eaglercraft 26.3 (Horizon) shares memory across threads and needs the
    // stricter policy even before the service worker takes control.
    const eagler = path === "/games/eagler/26.3" || path.startsWith("/games/eagler/26.3/");
    const coep = eagler ? "require-corp" : "credentialless";

    // Clean URL for the settings window.
    if (path === "/settings" || path === "/settings/") {
      const internal = new URL("/settings.html", url);
      return asset(request, env, new Request(internal.href, {
        method: request.method,
        headers: request.headers,
      }), coep, noCache);
    }

    return asset(request, env, request, coep, noCache,
      runTextNeedsCrlf(path) ? toCrlf : null);
  },
};
