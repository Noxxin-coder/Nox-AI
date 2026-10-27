const { copyFile, mkdir } = require('node:fs/promises');
const { join } = require('node:path');

async function main() {
  const source = join(__dirname, '..', 'src', 'web', 'index.html');
  const destinationDirectory = join(__dirname, '..', 'dist', 'src', 'web');
  await mkdir(destinationDirectory, { recursive: true });
  await copyFile(source, join(destinationDirectory, 'index.html'));
}

main().catch((error) => {
  console.error(`Could not package Nox AI web UI: ${error.message}`);
  process.exitCode = 1;
});
