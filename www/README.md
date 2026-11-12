# gallery: web frontend

A mobile-first media gallery written in plain HTML, CSS and JavaScript, with no build step. It loads the file list once from `/api/get-files`, which is served by the [API in `../api`](../api). Filtering and paging then happen in the browser.

| Path | Purpose |
|---|---|
| `index.html`, `css/`, `js/` | The gallery itself; this is what gets deployed |
| `dev/mock-server.mjs` | Test-only mock backend that serves the page plus fake data |
| `dev/sample.webm` | The clip the mock server returns for every video |
| `deploy.sh` | Deploys this checkout to the web root (see [Deploy](#deploy)) |

There are two ways to run it locally: against the **mock server** (fast, no setup) or against the **real backend** (the full stack, including nginx).

## 1. Against the mock server

Needs Node.js only, with no `npm install`.

```sh
npm start                                   # same as: node dev/mock-server.mjs
# → http://localhost:8080
PORT=3000 FILE_COUNT=50 node dev/mock-server.mjs
```

The mock server:

- serves the page with the **production Content-Security-Policy**, so CSP violations show up in the browser console;
- generates `FILE_COUNT` files (default 500) with the same fields as the backend's `gallery-index.json`. They include every edge case the frontend has to handle:
  - all eight MIME types (`kind` is `image` or `video`)
  - a few files with no `date`
  - `previewImageUrl: null`, which should show a placeholder tile
  - names with spaces and accents, nested folders (`deep/a/b`), and files directly in `gallery/`
- returns SVGs for pictures (previews immediately, originals after 250 ms, so the loading spinner shows) and `dev/sample.webm` for every video;
- counts media requests. `GET /__stats` shows how many times each URL was fetched; every count should stay at 1 (the page never downloads a file twice);
- accepts `POST /api/upload` like the real API: `201` after 400 ms, or `409 already_exists` when the folder already has that name. Uploaded files are only recorded, not added to the gallery;
- doesn't serve `/dev/`, `/tests/` or `/node_modules/`.

After changing the backend's output, update `buildGallery()` in `dev/mock-server.mjs` to match it.

## 2. Against the real backend (nginx + server.js)

This runs the real API from `../api` on a generated test gallery, behind a user-level nginx set up like production: `/api/` proxied to the unix socket, and files served through X-Accel-Redirect.

What's needed and how to install it is listed in [`../api/README.md`](../api/README.md): `node`, `ffmpeg`, `imagemagick`, `exiftool`, `nginx`.

```sh
cd ../api
dev/make-dummy-gallery.sh --force            # generated media in gallery/
./create_previews.sh "$PWD/gallery"
node build-index.js
dev/start-test-env.sh "$XDG_RUNTIME_DIR/fgallery-test"
# → http://127.0.0.1:8088/  (serves this folder, www/)

kill $(cat "$XDG_RUNTIME_DIR"/fgallery-test/*.pid)    # stop
```

- **Frontend edits:** reload the page. nginx serves the files straight from this folder.
- **Gallery or backend changes:** rerun `node build-index.js`, then stop and start the environment, because `server.js` reads the index only at startup.
- **Logs:** nginx and server logs are in `$XDG_RUNTIME_DIR/fgallery-test/`.
- **Another location:** set `WWW_DIR=/path/to/www` before running `start-test-env.sh` to serve a different frontend checkout.

The dummy gallery has 22 files: photos, PNG, WebP and GIF images, MP4/MOV/WebM/M4V videos, a rotated photo, a filename with accents, a nested folder and a top-level file. 8 of the files have no date.

## What to check

Use a phone-sized window (browser dev tools, about 390 px wide), and keep the console and network tabs open.

- [ ] Every tile loads. Videos show a ▶ badge with their length.
- [ ] A file without a preview shows its filename as a placeholder, and nothing requests `/null`. To test this on the real backend, move one file out of a `_preview_/` folder, rebuild the index and restart.
- [ ] The list is newest first. Files with no date come last.
- [ ] Filter → **Types** shows exactly two options, "Images" and "Videos".
- [ ] Filter → **Folders**: labels look like `2023 - holiday` and `deep - a - b - c`, and files directly in `gallery/` show as "Gallery (top level)".
- [ ] Filter → **Folders** search: typing narrows the list by label or path (`2023/hol`), ignoring case and accents (`nyar` finds "nyár"); nothing matching shows "No folders match.". A checked folder stays checked, and is applied, while the search hides it. The line under the list always shows how many folders are selected, hidden ones included. Enter in the search doesn't apply the filter; reopening the filter and Clear show the full list again.
- [ ] Filter → **Date**: a range leaves out files with no date. On the dummy gallery, 2024-04-01 to 2024-04-07 gives "4 of 22".
- [ ] Filter → **Date** → "Without a date": on its own it shows only the files without a date ("8 of 22" on the dummy gallery); together with a range it adds them to the range ("12 of 22" for 2024-04-01 to 2024-04-07). Clear unchecks it.
- [ ] The viewer shows the date, size and position. Arrow keys and swipes move between files; pinch, double-tap, the mouse wheel and the +/− buttons zoom pictures; videos play and can be seeked.
- [ ] Closing the viewer scrolls the grid back to the file that was open.
- [ ] Every tile has an **i** in its top-right corner: shown on hover or keyboard focus, and always on touch screens. Tapping it opens "Details" (not the viewer) with 10 rows: file name, folder, type, size, dimensions, orientation, duration, date, taken and created. Missing values show as "—".
- [ ] The viewer has the same **i** under the date, size and counter, showing the file currently open. Escape closes the details first and leaves the viewer open.
- [ ] **Upload** (next to Filter) opens the upload sheet. Its Upload button stays disabled, with a hint saying why, until a folder is entered, at least one file is added and no row is marked.
- [ ] **Folder** suggests every existing folder except the top level, written as `2019/holiday` (no `gallery/`). Picking one, typing a new path (`2026/trip`) and picking one and then editing it (`2019/holiday/beach`) all work. A new path shows "New folder." or "New folder inside 2019/holiday.". Invalid paths (`a//b`, `.hidden`, `../x`, `a/_preview_`, `gallery/2019`, more than 8 levels) show the reason under the field and keep Upload disabled. Uploading into a new path creates it, and it then appears in the suggestions.
- [ ] A file whose name exists anywhere in the gallery shows "Already in the gallery"; picking the same name twice shows "Selected twice" on both rows; two files with the same basename (`clip.mp4` and `clip.webm`) show "Name clashes with another selected file", because the API refuses the second one; other types show "Unsupported type". Removing those rows with × enables Upload.
- [ ] On Android, **Add files** opens the Files picker (not the Photo Picker), and a photo keeps its real name (`PXL_20261109_142210123.jpg`, not `1000012345.jpg`). Desktop and iOS show only media files in the file dialog.
- [ ] Upload sends one request per file. Each row goes Waiting → Uploading n % → Uploaded (or "Failed: …" with the API's reason). Adding an uploaded file again shows "Already in the gallery". A note under the file list says that indexing takes roughly 2 minutes; new files appear in the grid after that and a page reload.
- [ ] No console errors (especially CSP) and no 4xx/5xx responses.
- [ ] Mock server only: `/__stats` shows no URL with a count above 1 after scrolling, filtering and paging back and forth.

## Deploy

On the server, from `www/` in a checkout of this repository:

```sh
sudo ./deploy.sh /srv/www/gallery-web     # <target folder>, must already exist
```

**Deploy the API (`../api`) first.** This frontend needs the `date` and `kind` fields of its index and its upload endpoint.

The script:

1. **Checks first:** it must run as root, the target folder must exist and must not be this checkout, and every listed entry must be present. If a check fails, nothing is changed.
2. **Copies** the entries in `COPY` at the top of the script (`index.html`, `css`, `js`). Each folder is copied in full next to the old one and then swapped in, so files deleted from the repository disappear from the server too. `dev/`, this README and the package files are not deployed.
3. **Sets permissions:** the target and everything in it become `root:root`, with folders `755` and files `644`, so nginx reads them as "other". Entries listed in `EXECUTABLES` (none at the moment) would get `root:root 700`.

There's no service to restart: nginx serves the new files immediately. Visitors with the page open get the new version on their next reload.
