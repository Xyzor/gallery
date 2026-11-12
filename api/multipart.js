'use strict';
//
// multipart.js -- streaming multipart/form-data parser (RFC 7578), standard library only.
//
// File parts are written to temp files as they arrive, so memory use per request
// stays at about one network chunk no matter how large the upload is. Text fields
// are collected in memory, capped by maxFieldBytes.
//
const crypto = require('node:crypto');
const fsp    = require('node:fs/promises');
const path   = require('node:path');

const CRLF        = Buffer.from('\r\n');
const DASH_DASH   = Buffer.from('--');
const HEADERS_END = Buffer.from('\r\n\r\n');
const MAX_HEADER_BYTES = 8 * 1024;
const HEAD_BYTES  = 16;   // kept from every file so the caller can check its signature

/** A problem with the request itself; `status` and `reason` go straight into the response. */
class MultipartError extends Error {
  constructor(status, reason) {
    super(reason);
    this.status = status;
    this.reason = reason;
  }
}

const bad = (reason) => new MultipartError(400, reason);

/** The boundary from a Content-Type header, or null if it is not multipart/form-data. */
function getBoundary(contentType = '') {
  const [type, ...params] = contentType.split(';');
  if (type.trim().toLowerCase() !== 'multipart/form-data') return null;

  for (const param of params) {
    const eq = param.indexOf('=');
    if (eq === -1 || param.slice(0, eq).trim().toLowerCase() !== 'boundary') continue;
    let value = param.slice(eq + 1).trim();
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    // RFC 2046: 1-70 characters from a fixed set, not ending in a space.
    return /^[0-9A-Za-z'()+_,\-./:=? ]{0,69}[0-9A-Za-z'()+_,\-./:=?]$/.test(value) ? value : null;
  }
  return null;
}

/**
 * Reads a multipart body to the end.
 *
 * @param {AsyncIterable<Buffer>} source  usually the http.IncomingMessage
 * @param {{boundary: string, tmpDir: string, maxFileBytes: number, maxFieldBytes: number, maxParts: number}} options
 * @returns {Promise<{fields: {name: string, value: string}[],
 *                    files: {name: string, filename: string, path: string, size: number, head: Buffer}[]}>}
 *
 * The caller owns the returned temp files and must delete them. On any error every
 * temp file written so far is deleted before the error is rethrown.
 */
async function receiveMultipart(source, { boundary, tmpDir, maxFileBytes, maxFieldBytes, maxParts }) {
  // Every delimiter is CRLF + "--" + boundary. Starting the buffer with a CRLF lets the
  // first one, which may sit at the very start of the body, be found the same way.
  const delimiter = Buffer.concat([CRLF, DASH_DASH, Buffer.from(boundary, 'latin1')]);
  const keep = delimiter.length - 1;   // a delimiter may be split across two chunks

  const fields = [];
  const files = [];
  let buf = CRLF;
  let state = 'preamble';   // preamble -> afterDelimiter -> headers -> body -> afterDelimiter ... -> done
  let partCount = 0;
  let part = null;          // { kind: 'field', name, chunks, size } | { kind: 'file', ..., handle }

  async function writeBody(data) {
    if (data.length === 0) return;
    part.size += data.length;
    if (part.kind === 'field') {
      if (part.size > maxFieldBytes) throw new MultipartError(413, 'field_too_large');
      part.chunks.push(data);
      return;
    }
    if (part.size > maxFileBytes) throw new MultipartError(413, 'file_too_large');
    if (part.head.length < HEAD_BYTES) {
      part.head = Buffer.concat([part.head, data.subarray(0, HEAD_BYTES - part.head.length)]);
    }
    await part.handle.write(data);
  }

  async function startPart(headerText) {
    if (++partCount > maxParts) throw bad('too_many_parts');
    const { name, filename } = parseDisposition(parseHeaders(headerText).get('content-disposition'));

    if (filename === undefined) {
      part = { kind: 'field', name, chunks: [], size: 0 };
      return;
    }
    const tmpPath = path.join(tmpDir, `${crypto.randomUUID()}.part`);
    // Registered before opening, so cleanup also covers a half-created file.
    const file = { name, filename, path: tmpPath, size: 0, head: Buffer.alloc(0) };
    files.push(file);
    // 640: never world-readable; a stored upload keeps this mode (see deploy.sh).
    part = Object.assign(file, { kind: 'file', handle: await fsp.open(tmpPath, 'wx', 0o640) });
  }

  async function endPart() {
    if (part.kind === 'field') {
      fields.push({ name: part.name, value: Buffer.concat(part.chunks).toString('utf8') });
    } else {
      const handle = part.handle;
      delete part.handle;
      delete part.kind;
      await handle.close();
    }
    part = null;
  }

  /** Consumes as much of `buf` as it can; returns false when it needs more data. */
  async function step() {
    switch (state) {
      case 'preamble': {
        const at = buf.indexOf(delimiter);
        if (at === -1) {
          buf = buf.subarray(Math.max(0, buf.length - keep));
          return false;
        }
        buf = buf.subarray(at + delimiter.length);
        state = 'afterDelimiter';
        return true;
      }
      case 'afterDelimiter': {
        if (buf.length < 2) return false;
        if (buf[0] === 0x2d && buf[1] === 0x2d) {   // "--": closing delimiter, the rest is epilogue
          state = 'done';
          return false;
        }
        if (buf[0] !== 0x0d || buf[1] !== 0x0a) throw bad('bad_multipart');
        state = 'headers';   // the CRLF stays: an empty header block is then just CRLF CRLF
        return true;
      }
      case 'headers': {
        const at = buf.indexOf(HEADERS_END);
        if (at === -1) {
          if (buf.length > MAX_HEADER_BYTES) throw bad('headers_too_large');
          return false;
        }
        await startPart(buf.subarray(2, at).toString('utf8'));
        buf = buf.subarray(at + HEADERS_END.length);
        state = 'body';
        return true;
      }
      case 'body': {
        const at = buf.indexOf(delimiter);
        if (at === -1) {
          const safe = Math.max(0, buf.length - keep);
          await writeBody(buf.subarray(0, safe));
          buf = buf.subarray(safe);
          return false;
        }
        await writeBody(buf.subarray(0, at));
        await endPart();
        buf = buf.subarray(at + delimiter.length);
        state = 'afterDelimiter';
        return true;
      }
      default:   // 'done': ignore the epilogue
        buf = Buffer.alloc(0);
        return false;
    }
  }

  // After the first error the rest of the body is still read, and dropped: leaving the
  // for-await loop early destroys the request and its socket, so the caller could not send
  // any answer and nginx would report a 502. Draining stops at the size limit.
  const drainLimit = maxFileBytes + maxParts * (maxFieldBytes + MAX_HEADER_BYTES) + 64 * 1024;
  let failure = null;
  let received = 0;
  try {
    for await (const chunk of source) {
      received += chunk.length;
      if (failure) {
        if (received > drainLimit) break;
        continue;
      }
      try {
        // Only the small unconsumed tail is copied; body data is written straight from the chunk.
        buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
        while (await step());
      } catch (error) {
        failure = error;
      }
    }
  } catch (error) {
    failure ??= error;   // reading the request itself failed: the client went away
  }
  if (!failure && state !== 'done') failure = bad('truncated_multipart');
  if (!failure) return { fields, files };

  // Cleanup errors are ignored: the error to report is the one that stopped the upload.
  await part?.handle?.close().catch(() => {});
  await Promise.all(files.map((file) => fsp.rm(file.path, { force: true }).catch(() => {})));
  throw failure;
}

function parseHeaders(text) {
  const headers = new Map();
  if (text === '') return headers;
  for (const line of text.split('\r\n')) {
    const colon = line.indexOf(':');
    if (colon <= 0) throw bad('bad_part_headers');
    headers.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim());
  }
  return headers;
}

/** `form-data; name="file"; filename="a.jpg"` -> { name, filename } (filename undefined for text fields). */
function parseDisposition(value) {
  if (!value || !/^form-data\s*(;|$)/i.test(value)) throw bad('bad_part_headers');

  const params = new Map();
  const PARAM = /;\s*([A-Za-z0-9_*-]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^;\s]*))/g;
  for (const [, key, quoted, token] of value.matchAll(PARAM)) {
    params.set(key.toLowerCase(), quoted !== undefined ? quoted.replace(/\\(.)/g, '$1') : token);
  }

  const name = params.get('name');
  if (!name) throw bad('bad_part_headers');

  let filename = params.get('filename');
  // RFC 5987 form, e.g. filename*=UTF-8''%C3%A1.jpg, wins when present.
  const extended = /^utf-8''(.*)$/i.exec(params.get('filename*') ?? '');
  if (extended) {
    try { filename = decodeURIComponent(extended[1]); } catch { throw bad('bad_part_headers'); }
  }
  return { name, filename };
}

module.exports = { getBoundary, receiveMultipart, MultipartError };
