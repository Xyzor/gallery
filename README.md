# gallery

A self-hosted, mobile-first media gallery for photos and videos.

| Folder | What | Read |
|---|---|---|
| [`api/`](api) | The backend: a small Node.js API (no dependencies) behind nginx. It indexes the media in a `gallery/` folder with exiftool, makes previews with ImageMagick and ffmpeg, serves the files through nginx, and accepts uploads. | [`api/README.md`](api/README.md) |
| [`www/`](www) | The frontend: plain HTML, CSS and JavaScript with no build step. A grid with infinite scrolling, filters, a zoomable viewer and an upload overlay. | [`www/README.md`](www/README.md) |

Each README covers setup, local testing and deployment for its part. When deploying, deploy the API first: the frontend relies on its index fields and its upload endpoint.
