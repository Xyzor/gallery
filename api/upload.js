'use strict';
//
// upload.js -- POST /upload: one multipart `file` plus a `group`, a sub-path of gallery/
// that may exist fully, partly or not at all.
//
// A batch upload arrives as 100+ requests at once. At most MAX_ACTIVE_UPLOADS are read
// at a time; the rest wait unread (nginx has already buffered their bodies), and only
// beyond MAX_QUEUED_UPLOADS does the API answer 503.
//
const fs   = require('node:fs');
const fsp  = require('node:fs/promises');
const path = require('node:path');
const { BAD_SEGMENT, MEDIA_TYPES, matchesSignature } = require('./media-types');
const { getBoundary, receiveMultipart, MultipartError } = require('./multipart');

const GALLERY_DIR        = 'gallery';
const PREVIEW_DIR        = '_preview_';     // create_previews.sh owns these folders
const MAX_UPLOAD_BYTES   = 2 * 1024 ** 3;   // keep in line with nginx client_max_body_size
const MIN_FREE_BYTES     = 1024 ** 3;       // refuse uploads that would leave less than this
const MAX_ACTIVE_UPLOADS = 8;
const MAX_QUEUED_UPLOADS = 500;
const MAX_GROUP_DEPTH    = 8;
const MAX_FIELD_BYTES    = 4 * 1024;
const MAX_NAME_BYTES     = 255;             // what ext4 and most filesystems allow
// Inside gallery/, because link() only works within one mount: with ProtectSystem=strict each
// ReadWritePaths= entry is its own mount, and a link from data/ into gallery/ fails with
// EXDEV. A dot-folder is never indexed, served or accepted as an upload group.
const TMP_DIR            = path.join(GALLERY_DIR, '.upload-tmp');

// Sent with answers given before the body was read, so Node does not drain a 2 GB body
// just to keep the connection alive.
const CLOSE = { Connection: 'close' };
const reply = (status, error, headers) => ({ status, payload: { error }, headers });

/**
 * @param {{appRoot: string, onStored: () => void}} options
 * @returns {{handle: (req: import('http').IncomingMessage) => Promise<{status: number, payload: object, headers?: object} | null>}}
 *   handle() resolves to null when the client went away and there is nobody to answer.
 */
function createUploader({ appRoot, onStored }) {
  const galleryAbs = path.join(appRoot, GALLERY_DIR);
  const tmpDir = path.join(appRoot, TMP_DIR);

  // Whatever is left in tmpDir is from uploads interrupted by a crash or restart.
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.mkdirSync(tmpDir, { recursive: true, mode: 0o700 });

  let active = 0;
  const queue = [];
  const dirLocks = new Map();   // folder -> tail of the chain of uploads storing into it

  /** Resolves when a slot is free; null when the queue is full. */
  function acquire() {
    if (active < MAX_ACTIVE_UPLOADS) {
      active += 1;
      return Promise.resolve();
    }
    if (queue.length >= MAX_QUEUED_UPLOADS) return null;
    return new Promise((resolve) => queue.push(resolve));
  }

  function release() {
    const next = queue.shift();
    if (next) next();          // the slot passes straight to the next request
    else active -= 1;
  }

  async function handle(req) {
    const boundary = getBoundary(req.headers['content-type']);
    if (!boundary) return reply(415, 'expected_multipart', CLOSE);

    const declaredBytes = Number(req.headers['content-length']) || 0;
    if (declaredBytes > MAX_UPLOAD_BYTES) return reply(413, 'file_too_large', CLOSE);

    const slot = acquire();
    if (!slot) return reply(503, 'busy', { ...CLOSE, 'Retry-After': '5' });
    await slot;
    try {
      const disk = await fsp.statfs(galleryAbs);
      if (disk.bavail * disk.bsize < declaredBytes + MIN_FREE_BYTES) {
        return reply(507, 'insufficient_storage', CLOSE);
      }
      return await receiveAndStore(req, boundary);
    } catch (error) {
      // Only a closed connection means the client went away; any other error still gets an
      // answer (and, through server.js, a log line), otherwise nginx reports a bare 502.
      if (req.socket?.destroyed) {
        console.warn(`upload: client went away (${error.code ?? error.message})`);
        return null;
      }
      if (error.code === 'ENOSPC') return reply(507, 'insufficient_storage', CLOSE);
      throw error;
    } finally {
      release();
    }
  }

  async function receiveAndStore(req, boundary) {
    let parsed;
    try {
      parsed = await receiveMultipart(req, {
        boundary, tmpDir, maxFileBytes: MAX_UPLOAD_BYTES, maxFieldBytes: MAX_FIELD_BYTES, maxParts: 2,
      });
    } catch (error) {
      if (error instanceof MultipartError) return reply(error.status, error.reason, CLOSE);
      throw error;
    }

    const { fields, files } = parsed;
    try {
      const group = fields.find((field) => field.name === 'group');
      const file = files.find((entry) => entry.name === 'file');
      if (!group || !file || fields.length + files.length !== 2) return reply(400, 'expected_file_and_group');

      const segments = parseGroup(group.value);
      if (!segments) return reply(400, 'bad_group');

      const fileName = cleanFileName(file.filename);
      if (!fileName) return reply(400, 'bad_name');
      const ext = path.extname(fileName).toLowerCase();
      if (!MEDIA_TYPES.has(ext)) return reply(415, 'unsupported_type');
      if (!matchesSignature(file.head, ext)) return reply(415, 'content_does_not_match_type');

      const dir = await ensureGroupDir(segments);
      if (!dir) return reply(400, 'bad_group');

      const conflict = await withDirLock(dir, () => storeUnlessTaken(file.path, dir, fileName));
      if (conflict) return reply(409, conflict);

      onStored();
      return { status: 201, payload: { status: 'stored', path: [GALLERY_DIR, ...segments, fileName].join('/') } };
    } finally {
      // Never let a failed cleanup replace the answer (or the error) of the upload itself.
      await Promise.all(files.map((entry) => fsp.rm(entry.path, { force: true }).catch(() => {})));
    }
  }

  /**
   * Creates the missing folders one level at a time. EEXIST from a concurrent request
   * creating the same folder is fine; a symlink or a file in the way is not, so a link
   * planted in gallery/ cannot redirect uploads elsewhere.
   */
  async function ensureGroupDir(segments) {
    let dir = galleryAbs;
    for (const segment of segments) {
      dir = path.join(dir, segment);
      try {
        // 750 like deploy.sh sets; group and setgid are inherited from gallery/.
        await fsp.mkdir(dir, { mode: 0o750 });
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
      }
      if (!(await fsp.lstat(dir)).isDirectory()) return null;
    }
    return dir;
  }

  /**
   * Runs fn once every earlier upload into the same folder is done, so checking the
   * folder and linking the new file into it happen as one step.
   */
  async function withDirLock(dir, fn) {
    const previous = dirLocks.get(dir) ?? Promise.resolve();
    let unlock;
    const tail = previous.then(() => new Promise((resolve) => { unlock = resolve; }));
    dirLocks.set(dir, tail);
    await previous;
    try {
      return await fn();
    } finally {
      unlock();
      if (dirLocks.get(dir) === tail) dirLocks.delete(dir);
    }
  }

  /**
   * Links the temp file into dir as fileName; returns the 409 reason instead when that
   * is not allowed. Two originals in one folder must not share a basename, because
   * the preview of a video or GIF is "<basename>.jpg" and the two would collide.
   */
  async function storeUnlessTaken(tmpPath, dir, fileName) {
    const stem = stemOf(fileName);
    const clash = (await fsp.readdir(dir)).find((name) =>
      !name.startsWith('.') && MEDIA_TYPES.has(path.extname(name).toLowerCase()) && stemOf(name) === stem);
    if (clash === fileName) return 'already_exists';
    if (clash) return 'same_basename_exists';

    // link() never replaces an existing file, which also covers files that appear
    // in the folder through something other than this API.
    try {
      await fsp.link(tmpPath, path.join(dir, fileName));
    } catch (error) {
      if (error.code === 'EEXIST') return 'already_exists';
      throw error;
    }
    return null;
  }

  return { handle };
}

const stemOf = (name) => name.replace(/\.[^.]*$/, '');

/** The same rule server.js applies when serving, plus a filesystem length limit. */
function isGoodName(name) {
  return name !== '' && name === name.trim() && !name.includes('/') && !BAD_SEGMENT.test(name)
    && Buffer.byteLength(name) <= MAX_NAME_BYTES;
}

/** "2026/folder2" -> ["2026", "folder2"]; null if any folder name is unacceptable. */
function parseGroup(value) {
  const segments = value.normalize('NFC').trim().replace(/^\/+|\/+$/g, '').split('/');
  if (segments.length > MAX_GROUP_DEPTH) return null;
  return segments.every((segment) => isGoodName(segment) && segment !== PREVIEW_DIR) ? segments : null;
}

/** Browsers send a bare name, old ones a full path. macOS sends decomposed accents, hence NFC. */
function cleanFileName(raw) {
  if (typeof raw !== 'string') return null;
  const name = raw.split(/[\\/]/).pop().normalize('NFC').trim();
  return isGoodName(name) ? name : null;
}

module.exports = { createUploader };
