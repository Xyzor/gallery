const http = require('http');
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const { BAD_SEGMENT, MEDIA_TYPES } = require('./media-types');
const { createUploader } = require('./upload');
const { createReindexer } = require('./reindex');

// Overridable so the server can be run locally / in tests without /run access.
const SOCKET_PATH = process.env.SOCKET_PATH ?? '/run/fgallery-api/api.sock';
// The nginx config expect an uri starting with /_gallery/
const ACCEL_REDIRECT_PREFIX = '/_';
const PREVIEW_SCRIPT = process.env.FGALLERY_PREVIEW_SCRIPT ?? path.join(__dirname, 'create_previews.sh');

const GALLERY_ABS = path.join(__dirname, 'gallery');
// realpath of the gallery root, resolved once at startup; used to make sure a
// symlinked directory inside the gallery cannot lead outside of it.
let galleryReal;
try {
  galleryReal = fs.realpathSync(GALLERY_ABS);
} catch (err) {
  console.error(`cannot resolve ${GALLERY_ABS}`);
  throw err;
}

const INDEX_FILE = path.join(__dirname, 'data', 'gallery-index.json');

// Previews made by create_previews.sh after an upload inherit this: like
// deploy.sh, nothing the service creates is world-readable.
process.umask(0o027);

// The /get-files body, serialised once per index rather than once per request.
let filesResponse;

function loadIndex() {
  const galleryIndex = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'));
  const files = galleryIndex.items;
  filesResponse = Buffer.from(JSON.stringify({
    files, length: files.length, groups: galleryIndex.directories, mimes: galleryIndex.mimeTypes,
  }));
  return files.length;
}

try {
  loadIndex();
} catch (err) {
  console.error(`cannot read ${INDEX_FILE} -- run "node build-index.js" first`);
  throw err;
}

// Encode each path segment separately so the "/" separators survive and nginx
// can match the internal /_gallery/ location.
const encodePath = (rel) => rel.split('/').map(encodeURIComponent).join('/');

const isInside = (root, p) => p.startsWith(root + path.sep);

const sendJsonBuffer = (res, code, buf, headers = {}) => {
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': buf.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  res.end(buf);
}

const sendJson = (res, code, payload, headers) => sendJsonBuffer(res, code, Buffer.from(JSON.stringify(payload)), headers);

const reindexer = createReindexer({
  appRoot: __dirname,
  previewScript: PREVIEW_SCRIPT,
  onIndexed: () => {
    // A broken new index must not take the running gallery down: keep serving the old one.
    try { console.log(`[reindex] index reloaded, ${loadIndex()} item(s)`); }
    catch (err) { console.error('[reindex] cannot reload the index, keeping the old one:', err); }
  },
});

const uploader = createUploader({ appRoot: __dirname, onStored: reindexer.schedule });

const server = http.createServer(async (req, res) => {
  try {
    // Parse against a dummy origin purely to get normalised path + query.
    const parsedUrl = new URL(req.url, 'http://api.invalid');
    const urlPathname = parsedUrl.pathname;

    if (urlPathname === '/upload') {
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'method_not_allowed' }, { Allow: 'POST' });
      const result = await uploader.handle(req);
      if (!result) return res.destroy();   // the client is gone
      return sendJson(res, result.status, result.payload, result.headers);
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return sendJson(res, 405, { error: 'method_not_allowed' });
    }

    if (urlPathname === '/health') return sendJson(res, 200, { status: 'ok' });

    if (urlPathname === '/get-files') return sendJsonBuffer(res, 200, filesResponse);

    if (urlPathname.startsWith('/gallery/')) {
      // URL() resolves literal "..", but an encoded "%2F" survives until it is
      // decoded here, so every decoded segment is checked again.
      let segments;
      try { segments = urlPathname.substring(1).split('/').map(decodeURIComponent); }
      catch { return sendJson(res, 400, { error: 'bad_name' }); }

      if (segments.some((s) => s === '' || s.includes('/') || BAD_SEGMENT.test(s))) {
        return sendJson(res, 400, { error: 'bad_name' });
      }
      const uri = segments.join('/');

      const extension = MEDIA_TYPES.get(path.extname(uri).toLowerCase());
      if (!extension) return sendJson(res, 404, { error: 'not_found' });

      const filePath = path.resolve(__dirname, uri);
      if (!isInside(GALLERY_ABS, filePath)) return sendJson(res, 400, { error: 'bad_name' });

      // lstat, not stat: this does NOT follow symlinks, so a symlink
      // planted in the media directory cannot be used to read /etc/shadow.
      let fileStat;
      try { fileStat = await fsp.lstat(filePath); }
      catch { return sendJson(res, 404, { error: 'not_found' }); }
      if (!fileStat.isFile()) return sendJson(res, 404, { error: 'not_found' });

      // lstat only checks the last component; a symlinked *directory* on the
      // way would still be followed, so compare the fully resolved path too.
      let realPath;
      try { realPath = await fsp.realpath(filePath); }
      catch { return sendJson(res, 404, { error: 'not_found' }); }
      if (!isInside(galleryReal, realPath)) return sendJson(res, 404, { error: 'not_found' });

      // Hand the request back to nginx. The body is empty; nginx discards
      // this response and serves the file from the internal location.
      res.writeHead(200, {
        'X-Accel-Redirect': ACCEL_REDIRECT_PREFIX + encodePath(uri),
        'Content-Type': extension[1],
        'Cache-Control': 'private, max-age=300',
      });
      return res.end();
    }

    return sendJson(res, 404, { error: 'not_found' });
  } catch (error) {
    console.error('request failed:', error);

    if (!res.headersSent) return sendJson(res, 500, { error: 'internal_error' });
    res.destroy();
  }
});

// Match nginx's upstream keepalive so neither side closes mid-request.
server.keepAliveTimeout = 65_000;
server.headersTimeout   = 66_000;
// Uploads can take long; nginx's own client timeouts bound them instead.
server.requestTimeout   = 0;

// A socket left behind by a crashed process would make listen() fail with
// EADDRINUSE.
try {
  fs.unlinkSync(SOCKET_PATH);
} catch (err) {
  if (err.code !== 'ENOENT') throw err;
}

server.listen(SOCKET_PATH, () => {
  // srw-rw----  fgallery-api:fgallery-api -- owner and group only. www-data is in
  // the fgallery-api group; nobody else on the system can reach the API.
  fs.chmodSync(SOCKET_PATH, 0o660);
  console.log(`fgallery-api listening on ${SOCKET_PATH}, gallery=${GALLERY_ABS}`);
});
