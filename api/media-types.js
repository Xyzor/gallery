'use strict';
//
// media-types.js -- the one list of media types, shared by build-index.js,
// server.js and upload.js so a file that gets indexed can always be served, a
// file that can be uploaded can always be indexed, and vice versa.
//
// extension -> [kind, Content-Type]
//
const MEDIA_TYPES = new Map([
  ['.jpg',  ['image', 'image/jpeg']], ['.jpeg', ['image', 'image/jpeg']],
  ['.png',  ['image', 'image/png']],  ['.webp', ['image', 'image/webp']],
  ['.gif',  ['image', 'image/gif']],
  ['.mp4',  ['video', 'video/mp4']],  ['.mov',  ['video', 'video/quicktime']],
  ['.webm', ['video', 'video/webm']], ['.m4v',  ['video', 'video/x-m4v']],
]);

// A path segment may contain anything a camera or a person puts in a filename
// (spaces, brackets, accents) -- but no control characters or backslashes, it
// must not be a dot-file and must not be "." or "..". Containment is enforced
// separately, this only rejects names that are never legitimate.
const BAD_SEGMENT = /[\x00-\x1f\x7f\\]|^\./;

// The first bytes each type starts with, so an upload's content can be checked
// against its extension before it is stored. MP4/MOV/M4V start with a box:
// 4 size bytes, then its type.
const ISO_BOX_TYPES = new Set(['ftyp', 'moov', 'mdat', 'wide', 'free', 'skip']);
const startsWith = (head, ...bytes) => bytes.every((b, i) => head[i] === b);
const ascii = (head, from, to) => head.subarray(from, to).toString('latin1');
const SIGNATURES = new Map([
  ['.jpg',  (h) => startsWith(h, 0xff, 0xd8, 0xff)],
  ['.jpeg', (h) => startsWith(h, 0xff, 0xd8, 0xff)],
  ['.png',  (h) => startsWith(h, 0x89, 0x50, 0x4e, 0x47)],
  ['.gif',  (h) => ascii(h, 0, 4) === 'GIF8'],
  ['.webp', (h) => ascii(h, 0, 4) === 'RIFF' && ascii(h, 8, 12) === 'WEBP'],
  ['.webm', (h) => startsWith(h, 0x1a, 0x45, 0xdf, 0xa3)],
  ['.mp4',  (h) => ISO_BOX_TYPES.has(ascii(h, 4, 8))],
  ['.mov',  (h) => ISO_BOX_TYPES.has(ascii(h, 4, 8))],
  ['.m4v',  (h) => ISO_BOX_TYPES.has(ascii(h, 4, 8))],
]);

/** True when the first bytes of a file look like what its extension claims. */
function matchesSignature(head, ext) {
  const check = SIGNATURES.get(ext);
  return Boolean(check && head.length >= 12 && check(head));
}

module.exports = { MEDIA_TYPES, BAD_SEGMENT, matchesSignature };
