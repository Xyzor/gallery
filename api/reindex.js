'use strict';
//
// reindex.js -- after uploads, rebuild previews and the index once the burst is over.
//
// Each run scans the whole gallery (create_previews.sh skips existing previews, build-index
// runs exiftool over everything), so it is run once per burst, not once per file.
//
const { spawn } = require('node:child_process');
const fs        = require('node:fs');
const path      = require('node:path');
const readline  = require('node:readline');

const GALLERY_DIR = 'gallery';
// Temp files of the rebuild (exiftool's argument file in build-index.js, ImageMagick's pixel
// cache) go here instead of /tmp, which is read-only with ProtectSystem=strict.
const TMP_DIR     = path.join('data', 'tmp');
const QUIET_MS    = 10_000;   // run once no upload has arrived for this long
const MAX_WAIT_MS = 60_000;   // ... but no later than this after the first one of a burst

/**
 * @param {{appRoot: string, previewScript: string, onIndexed: () => void}} options
 * @returns {{schedule: () => void}}
 */
function createReindexer({ appRoot, previewScript, onIndexed }) {
  const tmpDir = path.join(appRoot, TMP_DIR);
  fs.rmSync(tmpDir, { recursive: true, force: true });   // leftovers of an interrupted run
  fs.mkdirSync(tmpDir, { recursive: true, mode: 0o700 });
  const env = { ...process.env, TMPDIR: tmpDir, MAGICK_TEMPORARY_PATH: tmpDir };

  let timer = null;
  let burstStartedAt = 0;
  let running = false;
  let pending = false;   // uploads arrived during a run: run once more afterwards

  function schedule() {
    if (running) {
      pending = true;
      return;
    }
    const now = Date.now();
    if (!timer) burstStartedAt = now;
    clearTimeout(timer);
    const delay = Math.min(QUIET_MS, Math.max(0, burstStartedAt + MAX_WAIT_MS - now));
    timer = setTimeout(run, delay);
  }

  async function run() {
    timer = null;
    running = true;
    try {
      // A failed preview leaves only that file without one, so indexing still goes ahead.
      await runStep('previews', 'bash', [previewScript, path.join(appRoot, GALLERY_DIR)])
        .catch((error) => console.error(`[reindex] ${error.message}`));
      await runStep('index', process.execPath, [path.join(appRoot, 'build-index.js')]);
      onIndexed();
    } catch (error) {
      console.error(`[reindex] ${error.message} -- the next upload retries`);
    } finally {
      running = false;
      if (pending) {
        pending = false;
        schedule();
      }
    }
  }

  function runStep(label, command, args) {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, { cwd: appRoot, env, stdio: ['ignore', 'pipe', 'pipe'] });
      readline.createInterface({ input: child.stdout }).on('line', (line) => console.log(`[reindex:${label}] ${line}`));
      readline.createInterface({ input: child.stderr }).on('line', (line) => console.error(`[reindex:${label}] ${line}`));
      child.on('error', reject);
      child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${label} exited with ${code}`))));
    });
  }

  return { schedule };
}

module.exports = { createReindexer };
