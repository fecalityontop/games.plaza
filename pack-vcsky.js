// Pack the 31k individual vcsky asset files into ~22 MiB parts plus a
// path -> byte-range manifest. The service worker serves each original URL
// straight out of the pack, so Cloudflare only sees ~30 assets instead of
// 31k (free-plan limit is 20,000 files / 25 MiB per file). English only.
//
//   node pack-vcsky.js            # gzip files where it actually shrinks them
//   node pack-vcsky.js --raw      # skip compression entirely
//
// Recombines pre-split .partNNN radio stations back into one logical file.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { once } = require('events');
const { createWriteStream } = fs;

const MB = 1024 * 1024;
const CHUNK = 22 * MB; // below the 25 MiB per-asset limit
const RAW = process.argv.includes('--raw');
const ROOT = path.join(__dirname, 'games/gta/vc/vcsky');
const PACKS = path.join(ROOT, 'packs');
const SOURCES = [
  { lang: 'en', dir: path.join(ROOT, 'fetched'), prefix: '/vcsky/fetched/' },
];

const pad = (n) => String(n).padStart(3, '0');

function listFiles(dir, prefix) {
  const files = [];
  const partGroups = new Map();
  (function walk(d, rel) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })
      .sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      const full = path.join(d, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { walk(full, r); continue; }
      const part = /\.part(\d+)$/.exec(e.name);
      if (part) {
        const base = full.slice(0, -part[0].length);
        if (!partGroups.has(base)) partGroups.set(base, []);
        partGroups.get(base).push({ n: Number(part[1]), path: full });
        continue;
      }
      const parts = [];
      for (let i = 1; ; i++) {
        const p = `${full}.part${pad(i)}`;
        if (!fs.existsSync(p)) break;
        parts.push(p);
      }
      files.push({ url: prefix + r, sources: parts.length ? parts : [full] });
    }
  })(dir, '');

  // Most split radio files have no unsplit base file at all, so group the
  // .partNNN siblings into one logical entry here as well.
  for (const [base, parts] of partGroups) {
    const rel = path.relative(dir, base).replace(/\\/g, '/');
    const url = prefix + rel;
    if (files.some((f) => f.url === url)) continue;
    parts.sort((a, b) => a.n - b.n);
    files.push({ url, sources: parts.map((p) => p.path) });
  }
  return files;
}

function readLogical(sources) {
  if (sources.length === 1) return fs.readFileSync(sources[0]);
  return Buffer.concat(sources.map((p) => fs.readFileSync(p)));
}

async function pack(lang, files) {
  const outDir = path.join(PACKS, lang);
  fs.mkdirSync(outDir, { recursive: true });
  // Clean previous run so stale parts can't linger if this run is smaller.
  for (const f of fs.readdirSync(outDir)) fs.unlinkSync(path.join(outDir, f));

  let partNo = 0;
  let partPath = path.join(outDir, `part${pad(partNo + 1)}.bin`);
  let partStream = createWriteStream(partPath);
  await once(partStream, 'open');
  let partBytes = 0;
  let total = 0;
  const entries = Object.create(null);
  let brCount = 0;

  async function nextPart() {
    await new Promise((resolve, reject) => {
      partStream.once('error', reject);
      partStream.end(resolve);
    });
    partNo++;
    partPath = path.join(outDir, `part${pad(partNo + 1)}.bin`);
    partStream = createWriteStream(partPath);
    await once(partStream, 'open');
    partBytes = 0;
  }

  async function append(buf) {
    let pos = 0;
    while (pos < buf.length) {
      const take = Math.min(CHUNK - partBytes, buf.length - pos);
      if (!partStream.write(buf.subarray(pos, pos + take))) await once(partStream, 'drain');
      partBytes += take;
      pos += take;
      if (partBytes === CHUNK) await nextPart();
    }
  }

  for (let i = 0; i < files.length; i++) {
    const { url, sources } = files[i];
    const data = readLogical(sources);
    let stored = data;
    let encName = '';
    if (!RAW) {
      // gzip is natively supported by DecompressionStream in the SW. Audio is
      // already compressed, so only model/texture files tend to shrink.
      const gz = zlib.gzipSync(data, { level: 6 });
      if (gz.length < data.length * 0.95) { stored = gz; encName = 'gzip'; brCount++; }
    }

    const start = total;
    await append(stored);
    entries[url] = [start, stored.length, data.length, encName];
    total += stored.length;
    if ((i + 1) % 2000 === 0 || i + 1 === files.length) {
      console.log(`[${lang}] ${i + 1}/${files.length}, ${(total / MB).toFixed(0)} MB`);
    }
  }

  await new Promise((resolve, reject) => {
    partStream.once('error', reject);
    partStream.end(resolve);
  });

  const manifest = { chunkSize: CHUNK, partCount: partNo + 1, total, entries };
  fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest));
  console.log(`[${lang}] ${manifest.partCount} parts, ${(total / MB).toFixed(0)} MB stored, ${brCount} compressed`);
}

(async () => {
  fs.mkdirSync(PACKS, { recursive: true });
  for (const s of SOURCES) {
    if (!fs.existsSync(s.dir)) { console.warn(`skip missing ${s.dir}`); continue; }
    await pack(s.lang, listFiles(s.dir, s.prefix));
  }
})().catch((e) => { console.error(e); process.exitCode = 1; });
