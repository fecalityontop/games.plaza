const fs = require('fs');
const path = require('path');
const { createReadStream, createWriteStream, existsSync } = fs;
const { pipeline } = require('stream/promises');

function pad(n) { return String(n).padStart(3, '0'); }

async function combineFiles(partPath) {
  const match = partPath.match(/^(.*)\.part\d+$/);
  if (!match) {
    console.error("Invalid part filename format. Expected something like filename.ext.part001");
    process.exit(1);
  }

  const originalFilePath = match[1];
  const baseName = path.basename(originalFilePath);
  const manifestPath = `${originalFilePath}.manifest.json`;
  const manifest = existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')) : null;
  const partCount = manifest ? manifest.partCount : null;

  console.log(`Looking for parts belonging to: ${baseName}...`);

  // Collect the part names first so a missing part can't leave a truncated
  // output file behind.
  const parts = [];
  for (let i = 1; partCount === null || i <= partCount; i++) {
    const part = `${originalFilePath}.part${pad(i)}`;
    if (!existsSync(part)) break;
    parts.push(part);
  }

  if (!parts.length) {
    console.error(`❌ No parts found for ${baseName}`);
    process.exit(1);
  }
  if (partCount !== null && parts.length !== partCount) {
    console.error(`❌ Expected ${partCount} parts, found ${parts.length}`);
    process.exit(1);
  }

  // Stream each part into the output: the GTA IV disc is ~7.8 GB, so reading
  // it all into a Buffer would exhaust memory.
  const output = createWriteStream(originalFilePath);
  for (const part of parts) {
    console.log(` - Found: ${path.basename(part)}`);
    await pipeline(createReadStream(part), output, { end: false });
  }
  await new Promise((resolve, reject) => {
    output.once('finish', resolve);
    output.once('error', reject);
    output.end();
  });

  const size = fs.statSync(originalFilePath).size;
  console.log(`\nSuccessfully combined ${parts.length} parts into: "${originalFilePath}" (${(size / 1024 / 1024).toFixed(2)} MB)`);
}

const targetPart = process.argv[2];
if (!targetPart) {
  console.error("Please specify a part file. Example: node combine.js john.mp3.part001");
  process.exit(1);
}

combineFiles(targetPart).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
