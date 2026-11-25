const fs = require('fs');
const path = require('path');
const { createReadStream, createWriteStream } = fs;
const { pipeline } = require('stream/promises');
const { stat, writeFile, access } = fs.promises;

const MB = 1024 * 1024;

function pad(n) { return String(n).padStart(3, '0'); }

// Streams a file into fixed-size parts so large assets work without loading
// them all into memory. Every part is < the 25 MiB asset limit.
async function splitFile(filePath, numParts, { manifest = false } = {}) {
  try {
    await access(filePath);
  } catch {
    console.error(`File not found: ${filePath}`);
    process.exit(1);
  }

  const size = (await stat(filePath)).size;
  const chunkSize = Math.ceil(size / numParts);

  // Track the remaining bytes explicitly: ceil() can make numParts*chunkSize
  // slightly larger than the file, so the final part must be shortened.
  const sizes = [];
  let remaining = size;
  for (let i = 0; i < numParts; i++) {
    const n = Math.min(chunkSize, remaining);
    sizes.push(n);
    remaining -= n;
  }

  let start = 0;
  for (let i = 0; i < numParts; i++) {
    const end = start + sizes[i] - 1;
    const partName = `${filePath}.part${pad(i + 1)}`;
    await pipeline(
      createReadStream(filePath, { start, end, highWaterMark: 4 * MB }),
      createWriteStream(partName)
    );
    start += sizes[i];
    if ((i + 1) % 25 === 0 || i + 1 === numParts) {
      console.log(` - part ${i + 1}/${numParts} (${(sizes[i] / MB).toFixed(2)} MB)`);
    }
  }

  if (manifest) {
    const manifestName = `${filePath}.manifest.json`;
    await writeFile(manifestName, JSON.stringify({
      file: path.basename(filePath),
      total: size,
      partCount: numParts,
      chunkSize,
      sizes,
    }));
    console.log(` manifest: ${manifestName}`);
  }

  console.log(`✅ Split "${path.basename(filePath)}" into ${numParts} parts (~${(chunkSize / MB).toFixed(2)} MB each)`);
}

async function main() {
  const targetFile = process.argv[2];
  if (!targetFile) {
    console.error('Usage: node split.js <file> <numParts> [--manifest]');
    console.error('   or: node split.js <file> --chunk 24   (24 MiB parts + manifest)');
    process.exit(1);
  }

  if (process.argv[3] === '--chunk') {
    const mb = Number(process.argv[4]);
    if (!Number.isFinite(mb) || mb <= 0) {
      console.error('Chunk size must be a positive number of MiB, e.g. --chunk 24');
      process.exit(1);
    }
    const size = (await stat(targetFile)).size;
    await splitFile(targetFile, Math.max(1, Math.ceil(size / (mb * MB))), { manifest: true });
    return;
  }

  const numParts = parseInt(process.argv[3], 10) || 2;
  await splitFile(targetFile, numParts, { manifest: process.argv.includes('--manifest') });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
