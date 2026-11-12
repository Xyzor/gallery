# gallery: API

The backend of the [gallery](../README.md), using only the Node.js standard library. It indexes the photos and videos in a `gallery/` folder with exiftool, makes previews with ImageMagick and ffmpeg, and serves both to the frontend in [`../www`](../www). nginx delivers the actual file bytes via `X-Accel-Redirect`. It also accepts uploads, many at once, and rebuilds previews and the index after them.

**Contents:**
- [Files](#files)
- [API reference](#api-reference)
- [Deploying and updating the gallery](#deploying-and-updating-the-gallery)
- [Uploading](#uploading)
- [Local testing](#local-testing)
- [Server setup](#server-setup)
  - [Development machine](#development-machine)
  - [Production server (Debian)](#production-server-debian)

## Files

| File | Purpose |
|---|---|
| `create_previews.sh` | Creates 400px-high thumbnails in a `_preview_/` folder next to each original |
| `build-index.js` | Scans `gallery/`, reads metadata with exiftool, writes `data/gallery-index.json` |
| `server.js` | Serves `/health`, `/get-files` and `/gallery/*` on a unix socket; nginx sends the actual file bytes via X-Accel-Redirect. Accepts uploads on `POST /upload` |
| `upload.js`, `multipart.js` | The upload endpoint and its streaming multipart parser (see [Uploading](#uploading)) |
| `reindex.js` | After uploads, runs `create_previews.sh` and `build-index.js` once and reloads the index |
| `media-types.js` | The list of supported extensions and the filename rule, shared by the index builder, the server and uploads |
| `deploy.sh` | Deploys this checkout to the server folder (see below) |
| `dev/` | Test tools only: dummy-gallery generator, nginx test config, API test script |

## API reference

The API listens on a unix socket. nginx exposes it under `/api/` and strips that prefix, so `GET /api/get-files` reaches the API as `GET /get-files`. Errors are JSON `{"error": "<code>"}`.

| Request | Answer |
|---|---|
| `GET /health` | `200 {"status":"ok"}` |
| `GET /get-files` | `200` with the whole index: `{ files, length, groups, mimes }`. `files` is sorted newest first by `date`, with undated files last. Each file has `SourceFile` and `previewImageUrl` (URLs, or `null` for a missing preview), `FileName`, `Directory`, `MIMEType`, `kind` (`image` or `video`), `FileSize`, `date`, `width`, `height`, `duration`, `orientation`, the raw EXIF dates and an `id`. `groups` lists the folders, e.g. `gallery/2023/holiday`. |
| `GET /gallery/<path>` | `200` with an empty body and `X-Accel-Redirect: /_gallery/<path>`; nginx then sends the file. `400` for a name that's never valid (a dot-file, `..`, control characters, an encoded `/`); `404` for unsupported types, missing files, symlinks, and symlinked folders that lead outside `gallery/`. |
| `POST /upload` | Stores one file; see [Uploading](#uploading). |

## Deploying and updating the gallery

On the server, from `api/` in a checkout of this repository:

```sh
sudo ./deploy.sh fgallery-api /srv/app/gallery-api fgallery-api
#                <service>    <target folder>      <api user>
```

Run it after a code change **and** after adding or removing media in `gallery/` by hand. Media uploaded through `POST /upload` needs no deployment. It:

1. **Checks everything first** and stops without changing anything if a check fails. It checks:
   - that it runs as root, with all three arguments;
   - that the target folder and its `gallery/` exist;
   - that the service, user and group exist;
   - that the service can write to `gallery/` and `data/`: if its unit has `ProtectSystem=strict`, both must be covered by `ReadWritePaths=`, and the script prints the line to add;
   - that every listed file is present;
   - that `node`, `exiftool`, `ffmpeg`, ImageMagick and `curl` are installed.
2. **Copies** the files listed in `COPY` (at the top of the script) into the target.
3. **Creates missing previews** (`create_previews.sh`). A file that can't get a preview is listed as a warning and the deployment continues.
4. **Rebuilds the index** (`build-index.js`). The deployment stops here if this fails.
5. **Sets permissions.** Nothing is world-readable. nginx reads the gallery through its membership in the API user's group.
   - The code is `root:<api user>`, folders `750` and files `640`: the service can read it but not change it.
   - The scripts in `EXECUTABLES` are `root:<api user> 750`: the service runs them after uploads but can't edit them.
   - The folders in `WRITABLE` (`gallery/` and `data/`) belong to `<api user>`, because uploads add media there and the index in `data/` is rebuilt afterwards. Gallery folders are setgid (`2750`), so folders created by uploads keep the group and nginx can read them.
6. **Restarts the service** and waits up to 10 s for `/health` on the socket. Set `SOCKET_PATH` if the unit uses a different socket path. If the health check fails, it prints the last journal lines.

The old service keeps running until step 6, so a failure in steps 2–4 never takes the site down. The new files may already be copied, though, so fix the problem and run the deployment again.

A preview has the same filename as its original. Videos and GIF get a still `<basename>.jpg` instead, so two originals in one folder must not share a basename (`clip.mp4` next to `clip.mov`). Dot-files, and files whose content doesn't match their extension, are not indexed.

Every file needs a preview. If one is missing, `build-index.js` lists it and the grid shows a placeholder tile. There is deliberately no fallback to the full-size original.

## Uploading

`POST /api/upload` as `multipart/form-data` (a browser `FormData`) with two parts:

- `file`: the media file. Its name comes from the part's filename.
- `group`: the folder below `gallery/`, e.g. `2026/folder2`. Missing folders are created; up to 8 levels.

```sh
curl -F group=2026/folder2 -F file=@IMG_1.jpg https://<host>/api/upload
```

Answers (JSON):

| Status | Meaning |
|---|---|
| `201` | Stored: `{"status":"stored","path":"gallery/2026/folder2/IMG_1.jpg"}` |
| `400` | Bad multipart, missing or extra parts, bad group or filename |
| `409` | `already_exists`, or `same_basename_exists` (another original with that basename is already in the folder, see above) |
| `413` | Larger than 2 GiB |
| `415` | Not a supported type, or the content doesn't match the extension |
| `503` | More than 500 uploads waiting; retry after `Retry-After` seconds |
| `507` | The disk would have less than 1 GiB free |

Names follow the same rule as serving: anything except control characters, backslashes and a leading dot, and no folder may be called `_preview_`. Nothing is ever overwritten.

A batch of 100+ files arrives as 100+ requests at once: 8 are processed at a time and the rest wait. Once no upload has arrived for 10 s (at most 60 s into a continuous stream), the API runs `create_previews.sh` and `build-index.js` once and reloads the index, so new files appear in `/get-files` without a restart.

Temporary files stay inside the two folders the service may write to, so it needs no writable `/tmp`. Each upload is written to `gallery/.upload-tmp/` and then hard-linked into place. It has to be inside `gallery/`, because with `ProtectSystem=strict` each `ReadWritePaths=` entry is a separate mount and a link between mounts fails. The rebuild after uploads uses `data/tmp/`.

There is no authentication: anyone who can reach `/api/upload` can add files. nginx needs a larger body limit on this location:

```nginx
location = /api/upload {
    proxy_pass http://unix:/run/fgallery-api/api.sock:/upload;
    client_max_body_size 2g;
    client_body_timeout  300s;
    proxy_read_timeout   300s;
}
```

## Local testing

```sh
dev/make-dummy-gallery.sh --force        # generated media in gallery/ (gitignored)
./create_previews.sh "$PWD/gallery"
node build-index.js
dev/start-test-env.sh "$XDG_RUNTIME_DIR/fgallery-test"   # server.js + user-level nginx on :8088
dev/test-api.sh "$XDG_RUNTIME_DIR/fgallery-test/api.sock"
kill $(cat "$XDG_RUNTIME_DIR"/fgallery-test/*.pid)        # stop
```

`server.js` reads its socket path from `SOCKET_PATH` (default `/run/fgallery-api/api.sock`). Unix socket paths are limited to 107 bytes, so keep the run directory short.

## Server setup

What's installed or configured outside this repository.

### Development machine

Local testing needs these tools:

| Tool | Used for |
|---|---|
| `node` | the server, the index builder, the frontend's mock server |
| `exiftool` | `build-index.js` |
| `ffmpeg`, ImageMagick | previews and the dummy gallery |
| `nginx` | the end-to-end test of the X-Accel-Redirect handoff |

On Arch Linux, for example: `sudo pacman -S nodejs perl-image-exiftool ffmpeg imagemagick nginx`.

The test nginx runs as the normal user, using `dev/start-test-env.sh` and a config rendered into the run directory. The system nginx service is **not** enabled, and `/etc/nginx` is not modified; only `/etc/nginx/mime.types` is read.

### Production server (Debian)

First-time setup, before the first `deploy.sh`:

```sh
sudo apt install --no-install-recommends nodejs libimage-exiftool-perl ffmpeg imagemagick nginx curl
sudo useradd --system --no-create-home --shell /usr/sbin/nologin fgallery-api
sudo usermod -aG fgallery-api www-data          # nginx reads the gallery through this group
sudo mkdir -p /srv/app/gallery-api/gallery   # media goes into gallery/ (by hand or POST /upload)
```

and a unit `/etc/systemd/system/fgallery-api.service`:

```ini
[Unit]
Description=fgallery API
After=network.target

[Service]
User=fgallery-api
Group=fgallery-api
RuntimeDirectory=fgallery-api
ExecStart=/usr/bin/node /srv/app/gallery-api/server.js
Restart=on-failure
# Only with ProtectSystem=strict: the folders uploads write to (deploy.sh checks this).
#ReadWritePaths=/srv/app/gallery-api/gallery /srv/app/gallery-api/data

[Install]
WantedBy=multi-user.target
```

Then run `sudo systemctl daemon-reload && sudo systemctl enable fgallery-api`, followed by the first `deploy.sh`, which also starts the service.

Summary of what lives outside this project:

- Packages: `nodejs`, `libimage-exiftool-perl`, `ffmpeg`, `imagemagick`, `nginx`, `curl`.
- A systemd service `fgallery-api` that runs `node server.js` as user `fgallery-api`, with `RuntimeDirectory=fgallery-api` so that `/run/fgallery-api/` exists.
- `www-data` is a member of the `fgallery-api` group; the socket has mode `0660`.
- nginx locations (see `dev/nginx.test.conf.template` for a working example):
  - `location /api/ { proxy_pass http://unix:/run/fgallery-api/api.sock:/; }`. The `/api` prefix must be stripped.
  - `location /_gallery/ { internal; alias /srv/app/gallery-api/gallery/; }`
  - `location = /api/upload { ... client_max_body_size 2g; }`, see [Uploading](#uploading).
