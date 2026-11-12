// Development/test-only mock backend. Not part of the gallery itself.
//
//   node dev/mock-server.mjs            → http://localhost:8080
//   PORT=3000 FILE_COUNT=50 node dev/mock-server.mjs
//
// Serves the gallery with the production CSP, fakes /api/get-files and the media URLs
// (SVG pictures, dev/sample.webm for videos), and counts every media request.
// GET /__stats returns those counts, which is how the "never re-download" rule can be checked.
// Tests import startMockServer() and read the counts directly.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

export const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; "
  + "media-src 'self'; font-src 'self'; connect-src 'self'; object-src 'none'; "
  + "frame-ancestors 'none'; base-uri 'self'; form-action 'self'";

const STATIC_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
};
const PRIVATE_DIRS = ['/dev/', '/tests/', '/node_modules/'];

// '' is a file directly in gallery/ (Directory "gallery"); 'deep/a/b' checks nested labels;
// '2024/nyár' checks accents (e.g. the accent-insensitive folder search).
const FOLDERS = ['2019/holiday', '2020/family', '2020/hiking', '2021/city', '2022/garden', '2023/misc', 'deep/a/b', '2024/nyár', ''];
// [extension, MIMEType, kind] -- the same set as api_fgallery's media-types.js.
const TYPES = [
  ['.jpg', 'image/jpeg', 'image'], ['.png', 'image/png', 'image'], ['.webp', 'image/webp', 'image'],
  ['.gif', 'image/gif', 'image'], ['.mp4', 'video/mp4', 'video'], ['.mov', 'video/quicktime', 'video'],
  ['.webm', 'video/webm', 'video'], ['.m4v', 'video/x-m4v', 'video'],
];
const IMAGE_TYPES = TYPES.filter((type) => type[2] === 'image');
const VIDEO_TYPES = TYPES.filter((type) => type[2] === 'video');
// exiftool -n style Duration values (seconds, may have decimals).
const SAMPLE_DURATIONS = [3.04, 12.345, 59.6, 75.5, 3000, 3725.2];

/**
 * @param {object} [options]
 * @param {number} [options.port=0]              0 picks a free port
 * @param {number} [options.fileCount=500]
 * @param {number} [options.apiStatus=200]       anything else makes /api/get-files fail
 * @param {number} [options.originalDelayMs=250] delay for full-size pictures (shows the spinner)
 * @param {boolean} [options.duplicateIds=false] give every file id 1, like the spec's sample data
 * @param {number} [options.uploadDelayMs=400]   delay before an upload is answered (shows the statuses)
 * @param {(group: string, filename: string) => [number, string] | null} [options.rejectUpload]
 *        answer an upload with [status, error code] instead, e.g. [409, 'same_basename_exists']
 */
export function startMockServer({
  port = 0,
  fileCount = 500,
  apiStatus = 200,
  originalDelayMs = 250,
  duplicateIds = false,
  uploadDelayMs = 400,
  rejectUpload = () => null,
} = {}) {
  const gallery = buildGallery(fileCount, { duplicateIds });
  const requestCounts = new Map();
  // Like the real API, nothing is ever overwritten: "gallery/<group>/<name>" already taken.
  const stored = new Set(gallery.files.map((file) => file.relPath));
  const uploads = [];

  const server = createServer(async (request, response) => {
    const { pathname } = new URL(request.url, 'http://localhost');
    response.setHeader('Content-Security-Policy', CSP);
    // Deliberately no caching headers: the page itself must avoid re-downloads.
    response.setHeader('Cache-Control', 'no-store');

    try {
      if (pathname === '/api/get-files') {
        if (apiStatus !== 200) return response.writeHead(apiStatus).end('Mock failure');
        return sendJson(response, gallery);
      }
      if (pathname === '/__stats') return sendJson(response, Object.fromEntries(requestCounts));
      if (pathname === '/api/upload') {
        return await receiveUpload(request, response, { stored, uploads, uploadDelayMs, rejectUpload });
      }
      if (pathname.startsWith('/api/gallery/')) {
        requestCounts.set(pathname, (requestCounts.get(pathname) ?? 0) + 1);
        return await sendMedia(response, pathname, gallery, originalDelayMs);
      }
      return await sendStatic(response, pathname === '/' ? '/index.html' : pathname);
    } catch {
      if (!response.headersSent) response.writeHead(404);
      response.end('Not found');
    }
  });

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      const url = `http://127.0.0.1:${server.address().port}`;
      resolve({
        url,
        gallery,
        requestCounts,
        uploads,   // { group, filename, bytes, status } for every POST /api/upload
        resetStats: () => requestCounts.clear(),
        close: () => new Promise((done) => {
          server.closeAllConnections();
          server.close(done);
        }),
      });
    });
  });
}

/**
 * Same shape as api_fgallery's gallery-index.json items, including its awkward cases:
 * names with spaces/accents, files without a date, and files whose preview has not been
 * created yet (previewImageUrl null).
 */
export function buildGallery(count, { duplicateIds = false } = {}) {
  const files = Array.from({ length: count }, (_, index) => {
    const folder = FOLDERS[index % FOLDERS.length];
    const isVideo = index % 11 === 5;
    const [ext, mime, kind] = isVideo
      ? VIDEO_TYPES[index % VIDEO_TYPES.length]
      : IMAGE_TYPES[index % 13 === 4 ? 1 + (index % (IMAGE_TYPES.length - 1)) : 0];
    const stem = index % 17 === 3 ? `Fénykép ${index} (1)` : `${isVideo ? 'clip' : 'photo'}_${index}`;
    const name = stem + ext;
    const relDir = folder ? `gallery/${folder}` : 'gallery';
    const year = /^\d{4}/.test(folder) ? folder.slice(0, 4) : '2024';
    const month = String((index % 12) + 1).padStart(2, '0');
    const day = String((index % 28) + 1).padStart(2, '0');
    const exifDate = `${year}:${month}:${day} 12:${String(index % 60).padStart(2, '0')}:00`;
    const landscape = index % 3 !== 0;
    // Videos and GIFs get a still "<basename>.jpg" preview; other images keep their name.
    const previewName = kind === 'video' || ext === '.gif' ? `${stem}.jpg` : name;

    const hasExif = index % 7 !== 6;
    const noDate = index % 97 === 96;

    return {
      SourceFile: toUrl(`${relDir}/${name}`),
      previewImageUrl: index % 37 === 36 ? null : toUrl(`${relDir}/_preview_/${previewName}`),
      FileName: name,
      Directory: relDir,
      MIMEType: mime,
      FileSize: 1_000_000 + index * 7919,
      DateTimeOriginal: hasExif && !isVideo ? exifDate : null,
      OffsetTimeOriginal: hasExif && !isVideo ? '+02:00' : null,
      CreateDate: !hasExif ? null : index % 50 === 49 ? '0000:00:00 00:00:00' : exifDate,
      OffsetTimeDigitized: hasExif && !isVideo ? '+02:00' : null,
      relPath: `${relDir}/${name}`,
      kind,
      width: landscape ? 4032 : 2268,
      height: landscape ? 2268 : 4032,
      duration: isVideo ? SAMPLE_DURATIONS[index % SAMPLE_DURATIONS.length] : null,
      orientation: 1,
      date: noDate ? null : exifDate,
    };
  });

  // The backend sorts newest first by `date`, undated files last.
  files.sort((a, b) => (a.date === b.date ? b.FileName.localeCompare(a.FileName)
    : a.date === null ? 1 : b.date === null ? -1 : b.date.localeCompare(a.date)));
  files.forEach((file, index) => { file.id = duplicateIds ? 1 : index + 1; });

  return {
    files,
    groups: [...new Set(files.map((file) => file.Directory))].sort(),
    mimes: [...new Set(files.map((file) => file.MIMEType))].sort(),
    length: files.length,
  };
}

function toUrl(relPath) {
  return `/api/${relPath.split('/').map(encodeURIComponent).join('/')}`;
}

async function sendMedia(response, pathname, gallery, originalDelayMs) {
  const index = gallery.files.findIndex((entry) => entry.SourceFile === pathname || entry.previewImageUrl === pathname);
  if (index === -1) throw new Error('unknown media');
  const file = gallery.files[index];

  if (pathname === file.SourceFile && file.kind === 'video') {
    const video = await readFile(join(ROOT, 'dev', 'sample.webm'));
    response.writeHead(200, { 'Content-Type': 'video/webm', 'Content-Length': video.length });
    return response.end(video);
  }

  const isPreview = pathname === file.previewImageUrl;
  const svg = pictureSvg(file, index, isPreview);
  // Real JPEGs in production; SVG keeps the mock dependency-free.
  setTimeout(() => {
    response.writeHead(200, { 'Content-Type': 'image/svg+xml' });
    response.end(svg);
  }, isPreview ? 0 : originalDelayMs);
}

function pictureSvg(file, index, isPreview) {
  const scale = isPreview ? 0.08 : 0.5;
  const width = Math.round(file.width * scale);
  const height = Math.round(file.height * scale);
  const hue = (index * 47) % 360;
  const step = Math.round(width / 8);
  const lines = [];
  for (let x = step; x < width; x += step) lines.push(`<line x1="${x}" y1="0" x2="${x}" y2="${height}"/>`);
  for (let y = step; y < height; y += step) lines.push(`<line x1="0" y1="${y}" x2="${width}" y2="${y}"/>`);

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
<rect width="100%" height="100%" fill="hsl(${hue} 55% 45%)"/>
<g stroke="rgba(255,255,255,.35)" stroke-width="${Math.max(1, width / 400)}">${lines.join('')}</g>
<text x="50%" y="50%" fill="#fff" font-family="sans-serif" font-size="${Math.round(width / 9)}"
  text-anchor="middle" dominant-baseline="middle">#${index + 1}</text>
</svg>`;
}

async function sendStatic(response, pathname) {
  const safePath = normalize(pathname).replace(/^(\.\.[/\\])+/, '');
  const type = STATIC_TYPES[extname(safePath)];
  if (!type || PRIVATE_DIRS.some((dir) => safePath.startsWith(dir))) throw new Error('not served');
  const body = await readFile(join(ROOT, safePath));
  response.writeHead(200, { 'Content-Type': type });
  response.end(body);
}

function sendJson(response, value, status = 200) {
  response.writeHead(status, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(value));
}

/**
 * POST /api/upload with the real API's answers (201 stored, 409 already_exists, 400, 405).
 * The multipart body is only searched for the `group` field and the file's name, which is
 * enough for a test backend; the real parser lives in api_fgallery's multipart.js.
 */
async function receiveUpload(request, response, { stored, uploads, uploadDelayMs, rejectUpload }) {
  if (request.method !== 'POST') return sendJson(response, { error: 'method_not_allowed' }, 405);
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const body = Buffer.concat(chunks);
  const text = body.toString('utf8');
  const group = /name="group"\r\n\r\n([^\r]*)\r\n/.exec(text)?.[1];
  const filename = /name="file"; filename="([^"]*)"/.exec(text)?.[1];

  await new Promise((resolve) => setTimeout(resolve, uploadDelayMs));
  const relPath = `gallery/${group}/${filename}`;
  const [status, error] = !group || !filename ? [400, 'expected_file_and_group']
    : rejectUpload(group, filename) ?? (stored.has(relPath) ? [409, 'already_exists'] : [201, null]);
  uploads.push({ group, filename, bytes: body.length, status });

  if (status !== 201) return sendJson(response, { error }, status);
  stored.add(relPath);
  return sendJson(response, { status: 'stored', path: relPath }, 201);
}

// Run standalone: node dev/mock-server.mjs
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const server = await startMockServer({
    port: Number(process.env.PORT ?? 8080),
    fileCount: Number(process.env.FILE_COUNT ?? 500),
  });
  console.log(`Gallery mock running on ${server.url.replace('127.0.0.1', 'localhost')}`);
}
