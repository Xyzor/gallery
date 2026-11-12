#!/usr/bin/env node
'use strict';
//
// build-index.js -- scan gallery/, read media metadata, write data/gallery-index.json
//
// Run manually from the app root after adding or removing media:
//     sudo node build-index.js && sudo systemctl restart fgallery-api
//
// After uploads through POST /upload the API runs it itself (reindex.js) and
// reloads the index without a restart.
//
// Dependencies: Node standard library only, plus the `exiftool` binary
// (Debian package: libimage-exiftool-perl).
//
const { spawn } = require('node:child_process');
const fsp  = require('node:fs/promises');
const fs   = require('node:fs');
const os   = require('node:os');
const path = require('node:path');
const { MEDIA_TYPES } = require('./media-types');

// --- Configuration -------------------------------------------------------
const APP_ROOT    = __dirname;                       // e.g. /srv/app/gallery-api
const GALLERY_DIR = 'gallery';                       // fixed, arbitrary depth below
const PREVIEW_DIR = '_preview_';                     // never appears in a filename
// In data/, the one folder besides gallery/ that the API may write to, so the
// API can republish the index after uploads.
const OUT_FILE    = path.join(APP_ROOT, 'data', 'gallery-index.json');
const URL_PREFIX  = '/api/';                         // what the browser requests

// Only these are indexed. Anything else in gallery/ -- a stray .txt, a .DS_Store,
// an editor backup -- is ignored rather than served, which is both a correctness
// and a privacy property: it cannot end up in the gallery by accident.
// The list lives in media-types.js so server.js serves exactly the same set.
const MEDIA_EXT = new Map([...MEDIA_TYPES].map(([ext, [kind]]) => [ext, kind]));

// A preview has the original's filename. When it is not in the original's
// format (videos, GIF) create_previews.sh writes "<stem>.jpg" instead;
// two originals in one folder never share a stem.
const PREVIEW_STILL_EXT = '.jpg';

// --- 1. Collect originals and previews in a single walk ------------------
//
// One pass builds both lists. When we meet a _preview_ directory we read its
// contents and do NOT descend further, so previews are never mistaken for
// originals and deeply nested preview trees cost nothing.
//
async function scan(absDir, relDir, originals, previews) {
  let entries;
  try {
    entries = await fsp.readdir(absDir, { withFileTypes: true });
  } catch (err) {
    console.warn(`  skip ${relDir}: ${err.code}`);
    return;
  }

  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    // Dot-files (.DS_Store, macOS "._IMG.jpg" AppleDouble files, temp files of
    // create_previews.sh) are never media, and server.js refuses to serve them.
    if (e.name.startsWith('.')) continue;
    const rel = relDir ? `${relDir}/${e.name}` : e.name;
    const abs = path.join(absDir, e.name);

    // isDirectory()/isFile() on a Dirent do NOT follow symlinks, so a symlink
    // pointing outside the gallery is neither descended into nor indexed.
    if (e.isDirectory()) {
      if (e.name === PREVIEW_DIR) {
        let previewEntries;
        try {
          previewEntries = await fsp.readdir(abs, { withFileTypes: true });
        } catch (err) {
          console.warn(`  skip ${rel}: ${err.code}`);
          continue;
        }
        for (const p of previewEntries) {
          if (p.isFile() && !p.name.startsWith('.')) previews.add(`${rel}/${p.name}`);
        }
      } else {
        await scan(abs, rel, originals, previews);
      }
    } else if (e.isFile() && MEDIA_EXT.has(path.extname(e.name).toLowerCase())) {
      originals.push(rel);
    }
  }
}

// --- 2. Read metadata for every original in one exiftool run -------------
//
// Arguments go in a temp file passed with -@, one per line. This sidesteps
// ARG_MAX entirely (no xargs, no split output) and means no shell is involved,
// so filenames are never re-parsed by anything.
//
async function readMetadata(absPaths) {
  if (absPaths.length === 0) return [];

  const argFile = path.join(
    await fsp.mkdtemp(path.join(os.tmpdir(), 'gallery-index-')), 'args');
  await fsp.writeFile(argFile, absPaths.join('\n') + '\n', 'utf8');

  const args = [
    '-j',                       // JSON output
    '-n',                       // raw values: bytes not "1.2 MB", seconds not "0:05",
                                // and dates as "2024:05:03 14:22:10" for parsing
    '-q', '-q',                 // suppress the "N image files read" chatter
    '-charset', 'filename=UTF8',
    '-api', 'QuickTimeUTC=1',   // MP4/MOV store creation time in UTC; convert it to
                                // local time so videos sort correctly against photos
    '-api', 'largefilesupport=1',
    '-FileName', '-Directory', '-FileSize', '-MIMEType',
    '-ImageWidth', '-ImageHeight', '-Duration', '-Orientation',
    '-DateTimeOriginal', '-CreateDate', '-EXIF:ModifyDate',
    '-OffsetTimeOriginal', '-OffsetTimeDigitized',
    '-@', argFile,
  ];

  const out = [], err = [];
  const code = await new Promise((resolve, reject) => {
    // spawn(), not exec(): the arguments are passed as an array straight to
    // execve, and stdout is streamed rather than capped by maxBuffer.
    const child = spawn('exiftool', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (c) => out.push(c));
    child.stderr.on('data', (c) => err.push(c));
    child.on('error', reject);
    child.on('close', resolve);
  }).finally(() => fsp.rm(path.dirname(argFile), { recursive: true, force: true }));

  const warnings = Buffer.concat(err).toString('utf8').trim();
  if (warnings) console.warn(warnings);

  // exiftool exits 1 when some files produced warnings but still emits valid
  // JSON for the rest, so a non-zero code is reported, not treated as fatal.
  if (code !== 0) console.warn(`  exiftool exited ${code} (partial results)`);

  const stdout = Buffer.concat(out).toString('utf8').trim();
  // No output at all for a non-empty list means exiftool itself failed; writing
  // an empty index would silently empty the gallery.
  if (!stdout) throw new Error(`exiftool exited ${code} without any output`);
  return JSON.parse(stdout);
}

// --- Helpers -------------------------------------------------------------

// Encode each path segment separately: encodeURIComponent would otherwise
// escape the "/" separators too.
const toUrl = (rel) => URL_PREFIX + rel.split('/').map(encodeURIComponent).join('/');

// "YYYY:MM:DD HH:MM:SS" prefix of an exiftool date, or null when the tag is
// missing or zeroed out ("0000:00:00 00:00:00" is common on cameras without a
// clock). String() because exiftool may emit a bare number for a garbage value.
function exifDate(value) {
  if (value === null || value === undefined) return null;
  const s = String(value).slice(0, 19);
  return /^\d{4}:\d\d:\d\d \d\d:\d\d:\d\d$/.test(s) && !s.startsWith('0000') ? s : null;
}

// A date in a filename such as IMG_20240503_142210, PXL_20240503_142210123,
// IMG-20240503-WA0001 (date only), Screenshot_20240503-142210 or
// "2024-05-03 14.22.10". The date must not be glued to other digits, so camera
// counters (IMG_1234, P1020345) never match.
const FILENAME_DATE =
  /(?<!\d)((?:19|20)\d\d)[-_.]?(\d\d)[-_.]?(\d\d)(?:[ T_-](\d\d)[-_.:]?(\d\d)[-_.:]?(\d\d)\d{0,3})?(?!\d)/g;

// "YYYY:MM:DD HH:MM:SS" from the filename, or null. Only real dates between
// 1990 and today count; a missing or impossible time becomes 00:00:00.
function filenameDate(fileName) {
  const stem = fileName.replace(/\.[^.]*$/, '');
  const now = new Date();
  for (const [, y, mo, d, h, mi, s] of stem.matchAll(FILENAME_DATE)) {
    const year = Number(y), month = Number(mo), day = Number(d);
    if (year < 1990 || month < 1 || month > 12 || day < 1) continue;
    if (day > new Date(year, month, 0).getDate()) continue;      // e.g. 31 February
    if (new Date(year, month - 1, day) > now) continue;          // not in the future
    const time = h !== undefined && Number(h) < 24 && Number(mi) < 60 && Number(s) < 60
      ? `${h}:${mi}:${s}` : '00:00:00';
    return `${y}:${mo}:${d} ${time}`;
  }
  return null;
}

// The one date to sort, show and filter by, and where it came from, best
// source first. The file's modification time is deliberately not used: on the
// server it is the upload time, which would put old photos above new ones.
// Files without any of these get null and are sorted last.
function pickDate(t, fileName) {
  const candidates = [
    ['DateTimeOriginal', () => exifDate(t.DateTimeOriginal)],   // photo taken
    ['CreateDate',       () => exifDate(t.CreateDate)],         // digitized / recording start
    ['filename',         () => filenameDate(fileName)],
    ['ModifyDate',       () => exifDate(t.ModifyDate)],         // camera or editor; last resort
  ];
  for (const [source, get] of candidates) {
    const date = get();
    if (date) return [date, source];
  }
  return [null, 'none'];
}

function findPreview(rel, previews) {
  const dir  = path.posix.dirname(rel);
  const base = path.posix.basename(rel);
  const stem = base.replace(/\.[^.]*$/, '');
  for (const cand of [base, stem + PREVIEW_STILL_EXT]) {
    const key = `${dir}/${PREVIEW_DIR}/${cand}`;
    if (previews.has(key)) return key;
  }
  return null;
}

// --- Main ----------------------------------------------------------------
async function main() {
  const galleryAbs = path.join(APP_ROOT, GALLERY_DIR);
  await fsp.access(galleryAbs);   // fail loudly and early if gallery/ is missing

  console.log(`scanning ${galleryAbs} ...`);
  const originals = [], previews = new Set();
  await scan(galleryAbs, GALLERY_DIR, originals, previews);
  console.log(`  ${originals.length} media file(s), ${previews.size} preview(s)`);

  // exiftool is given absolute paths: a relative name beginning with "-" would
  // be read as an option, and absolute paths make the result independent of
  // the directory the script happens to be run from.
  const absByRel = new Map(originals.map((r) => [path.join(APP_ROOT, r), r]));
  const tags = await readMetadata([...absByRel.keys()]);
  console.log(`  metadata for ${tags.length} file(s)`);

  const items = [];
  const dateSources = new Map();
  for (const t of tags) {
    const rel = absByRel.get(t.SourceFile) ?? absByRel.get(path.resolve(t.SourceFile));
    if (!rel) { console.warn(`  unmatched SourceFile: ${t.SourceFile}`); continue; }

    // The extension says image/video but the content does not (a corrupt or
    // misnamed file): leave it out rather than serve something broken.
    const kind = MEDIA_EXT.get(path.extname(rel).toLowerCase());
    if (!String(t.MIMEType ?? '').startsWith(`${kind}/`)) {
      console.warn(`  skip ${rel}: content is ${t.MIMEType ?? 'unknown'}, not ${kind}`);
      continue;
    }

    const preview = findPreview(rel, previews);
    const [date, dateSource] = pickDate(t, path.posix.basename(rel));
    dateSources.set(dateSource, (dateSources.get(dateSource) ?? 0) + 1);

    items.push({
      SourceFile:	toUrl(rel),
      previewImageUrl:	preview ? toUrl(preview) : null,
      FileName:		path.posix.basename(rel),
      Directory:	path.posix.dirname(rel),
      MIMEType:		t.MIMEType ?? null,
      FileSize:		t.FileSize ?? null,     // bytes, because of -n
      DateTimeOriginal:	t.DateTimeOriginal ?? null,
      OffsetTimeOriginal: t.OffsetTimeOriginal ?? null,
      CreateDate:	t.CreateDate ?? null,
      OffsetTimeDigitized: t.OffsetTimeDigitized ?? null,

      relPath:		rel,                            // on-disk path, NOT url-encoded
      kind,
      width:		t.ImageWidth  ?? null,
      height:		t.ImageHeight ?? null,
      duration:		t.Duration    ?? null,          // seconds, videos only
      orientation:	t.Orientation ?? null,

      date,                                           // "YYYY:MM:DD HH:MM:SS" or null, see pickDate()
    });
  }

  items.sort((a, b) => {
    if (a.date !== b.date) {
      if (a.date === null) return 1;
      if (b.date === null) return -1;
      return b.date.localeCompare(a.date);
    }
    return b.FileName.localeCompare(a.FileName);
  });
  items.forEach((it, i) => { it.id = i + 1; });   // stable 1-based ids after sorting

  const index = {
    generatedAt: new Date().toISOString(),
    galleryRoot: GALLERY_DIR,
    urlPrefix:   URL_PREFIX,
    count:       items.length,
    missingPreview: items.filter((i) => !i.previewImageUrl).map((i) => i.relPath),
    directories: [...new Set(items.map((i) => i.Directory))].sort(),
    mimeTypes:   [...new Set(items.map((i) => i.MIMEType).filter(Boolean))].sort(),
    items,
  };

  // Atomic publish: write a temp file in the same directory, then rename over
  // the target. rename() within one filesystem is atomic, so a running server
  // can never read a half-written index -- it sees the old file or the new one.
  const tmp = `${OUT_FILE}.tmp-${process.pid}`;
  await fsp.mkdir(path.dirname(OUT_FILE), { recursive: true });
  await fsp.writeFile(tmp, JSON.stringify(index, null, 2) + '\n', { mode: 0o640 });
  await fsp.rename(tmp, OUT_FILE);

  console.log(`wrote ${OUT_FILE}`);
  console.log(`  ${index.count} item(s), ${index.directories.length} director(ies), ` +
              `${index.mimeTypes.length} MIME type(s)`);
  const n = (source) => dateSources.get(source) ?? 0;
  console.log(`  dates: ${n('DateTimeOriginal')} DateTimeOriginal, ${n('CreateDate')} CreateDate, ` +
              `${n('filename')} filename, ${n('ModifyDate')} ModifyDate, ${n('none')} none (sorted last)`);
  if (index.missingPreview.length) {
    console.log(`  ${index.missingPreview.length} file(s) without a preview:`);
    for (const p of index.missingPreview.slice(0, 10)) console.log(`    ${p}`);
    if (index.missingPreview.length > 10) console.log('    ...');
    console.log('  run create_previews.sh, then rebuild the index');
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
