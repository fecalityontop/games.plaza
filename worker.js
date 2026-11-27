function isolation(extra, coep, cache) {
  const headers = new Headers(extra || undefined);
  headers.set("Cross-Origin-Opener-Policy", "same-origin");
  headers.set("Cross-Origin-Embedder-Policy", coep);
  if (coep === "require-corp") headers.set("Cross-Origin-Resource-Policy", "same-origin");
  if (cache) headers.set("Cache-Control", cache);
  return headers;
}

// The site's service worker used to be registered by hand in each page that
// needed it. Keep one copy here and inject it into every HTML document.
const AUTO_SW_SCRIPT = `<script data-gp-sw-auto>
(async function () {
  // game.html embeds each game in a same-origin iframe. Both documents get
  // this script, so only the top-level one is allowed to register; otherwise
  // a single game.html visit would try to register twice.
  if (window.top !== window.self) return;

  var FLAG = "root-coi-reloaded";
  var MIGRATE = "gp-migrated-to-sw-v2";
  function readFlag() { try { return sessionStorage.getItem(FLAG); } catch (e) { return null; } }
  function writeFlag() { try { sessionStorage.setItem(FLAG, "1"); return true; } catch (e) { return false; } }
  function clearFlag() { try { sessionStorage.removeItem(FLAG); } catch (e) {} }

  if (!("serviceWorker" in navigator)) return;
  if (navigator.serviceWorker.controller) { clearFlag(); return; }

  // One-time cleanup of registrations and caches left by older builds.
  try {
    if (!localStorage.getItem(MIGRATE)) {
      var regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map(function (r) { return r.unregister(); }));
      if (window.caches) {
        var keys = await caches.keys();
        await Promise.all(keys.map(function (k) { return caches.delete(k); }));
      }
      localStorage.setItem(MIGRATE, "1");
    }
  } catch (e) {}

  if (readFlag() === "1") return;

  navigator.serviceWorker.register("/sw.js", { updateViaCache: "none" }).then(function (reg) {
    var reload = function () {
      if (window.leaving) return;
      if (!writeFlag()) return;
      window.location.replace(window.location.href);
    };
    if (reg.active && !navigator.serviceWorker.controller) { reload(); return; }
    navigator.serviceWorker.addEventListener("controllerchange", reload, { once: true });
    var w = reg.installing || reg.waiting;
    if (w && w.state === "installed") w.postMessage({ type: "skip-waiting" });
    if (w) w.addEventListener("statechange", function () {
      if (w.state === "installed") w.postMessage({ type: "skip-waiting" });
    });
  }).catch(function (e) { console.warn("sw register failed", e); });
})();
</script>`;

// Splice the script in as raw bytes so pages with a non-UTF-8 charset are not
// mangled by decoding and re-encoding the whole document.
const enc = new TextEncoder();
const AUTO_SW_BYTES = enc.encode(AUTO_SW_SCRIPT);
const AUTO_SW_MARKER = enc.encode("data-gp-sw-auto");
const TAG_CLOSE_HEAD = enc.encode("</head");
const TAG_OPEN_HEAD = enc.encode("<head");
const TAG_OPEN_BODY = enc.encode("<body");
const TAG_CLOSE_BODY = enc.encode("</body");
const TAG_OPEN_HTML = enc.encode("<html");

function findAscii(haystack, needle, start) {
  outer: for (var i = start || 0; i <= haystack.length - needle.length; i++) {
    for (var j = 0; j < needle.length; j++) {
      var b = haystack[i + j];
      if (b >= 65 && b <= 90) b += 32; // lower-case for case-insensitive tags
      if (b !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

function afterTag(bytes, at) {
  var gt = bytes.indexOf(0x3e, at); // ">"
  return gt === -1 ? bytes.length : gt + 1;
}

function injectAutoSw(buffer) {
  var bytes = new Uint8Array(buffer);
  if (findAscii(bytes, AUTO_SW_MARKER, 0) !== -1) return bytes;

  // Prefer the end of <head>; fall back to the earliest usable tag.
  var at = findAscii(bytes, TAG_CLOSE_HEAD, 0);
  if (at === -1) {
    at = findAscii(bytes, TAG_OPEN_HEAD, 0);
    at = at === -1 ? -1 : afterTag(bytes, at);
  }
  if (at === -1) {
    at = findAscii(bytes, TAG_OPEN_BODY, 0);
    at = at === -1 ? -1 : afterTag(bytes, at);
  }
  if (at === -1) at = findAscii(bytes, TAG_CLOSE_BODY, 0);
  if (at === -1) {
    at = findAscii(bytes, TAG_OPEN_HTML, 0);
    at = at === -1 ? 0 : afterTag(bytes, at);
  }

  var out = new Uint8Array(bytes.length + AUTO_SW_BYTES.length);
  out.set(bytes.subarray(0, at), 0);
  out.set(AUTO_SW_BYTES, at);
  out.set(bytes.subarray(at), at + AUTO_SW_BYTES.length);
  return out;
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
  } else if (
    request.method === "GET" && response.ok && response.body &&
    (headers.get("Content-Type") || "").toLowerCase().includes("text/html")
  ) {
    body = injectAutoSw(await response.arrayBuffer());
    headers = new Headers(headers);
    headers.delete("Content-Length");
    headers.delete("Content-Encoding");
    headers.delete("ETag");
    // The registration code lives in worker.js; don't let browsers keep an
    // HTML document cached with an older copy of it.
    headers.set("Cache-Control", "no-cache");
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
