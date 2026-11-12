#!/bin/bash
#
# make-dummy-gallery.sh -- (re)create gallery/ with generated test media.
# Development/test only. Needs ffmpeg, ImageMagick and exiftool.
#
#     dev/make-dummy-gallery.sh            # refuses if gallery/ exists
#     dev/make-dummy-gallery.sh --force    # wipe and recreate
#
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
g="$root/gallery"

if [[ -e "$g" ]]; then
  if [[ "${1:-}" != "--force" ]]; then
    echo "$g exists; pass --force to wipe and recreate it" >&2
    exit 1
  fi
  rm -rf "$g"
fi

img() {  # img <out> <label> <WxH> <color>
  convert -size "$3" "xc:$4" -gravity center -pointsize 60 -fill white \
    -annotate 0 "$2" "$1"
}
vid() {  # vid <out> <seconds> [extra ffmpeg args...]
  local out="$1" secs="$2"; shift 2
  ffmpeg -nostdin -loglevel error -y -f lavfi -i "testsrc=size=640x360:rate=25:duration=$secs" \
    -f lavfi -i "sine=frequency=440:duration=$secs" -shortest "$@" "$out"
}
# ImageMagick 7 warns on "convert".
if command -v magick >/dev/null; then convert() { magick "$@"; }; fi
exif() { exiftool -q -overwrite_original "$@"; }

mkdir -p "$g/2023/holiday" "$g/2024/screens" "$g/2024/videos" "$g/2024/nodate" "$g/deep/a/b/c"

# --- 2023/holiday: camera-like JPEGs with full dates ----------------------
img "$g/2023/holiday/IMG_0001.jpg" "IMG_0001" 1600x1200 steelblue
exif -DateTimeOriginal='2023:07:14 10:00:00' -CreateDate='2023:07:14 10:00:00' \
  "$g/2023/holiday/IMG_0001.jpg"

img "$g/2023/holiday/IMG_0002.jpg" "IMG_0002" 1600x1200 seagreen
exif -DateTimeOriginal='2023:07:15 18:30:00' -CreateDate='2023:07:15 18:30:00' \
  -OffsetTimeOriginal='+02:00' "$g/2023/holiday/IMG_0002.jpg"

# Stored landscape, displayed portrait (phone held upright).
img "$g/2023/holiday/IMG_0003_rotated.jpg" "ROTATED" 1600x1200 darkorange
exif -DateTimeOriginal='2023:07:16 09:00:00' -CreateDate='2023:07:16 09:00:00' \
  -Orientation#=6 "$g/2023/holiday/IMG_0003_rotated.jpg"

# Name with space, parentheses and accents (rejected by the old server).
img "$g/2023/holiday/Árvíztűrő tükör (1).jpg" "UNICODE" 1600x1200 purple
exif -DateTimeOriginal='2023:07:17 12:00:00' -CreateDate='2023:07:17 12:00:00' \
  "$g/2023/holiday/Árvíztűrő tükör (1).jpg"

# --- 2024/screens: formats without camera dates ---------------------------
img "$g/2024/screens/screenshot.png" "PNG" 1280x720 slategray
touch -d '2024-02-01 08:00:00' "$g/2024/screens/screenshot.png"
img "$g/2024/screens/picture.webp" "WEBP" 1200x800 teal
exif -DateTimeOriginal='2024:02:02 08:00:00' "$g/2024/screens/picture.webp" || true
convert -delay 50 -size 400x300 xc:red xc:green xc:blue -loop 0 "$g/2024/screens/anim.gif"
touch -d '2024-02-03 08:00:00' "$g/2024/screens/anim.gif"

# --- 2024/videos: containers with creation_time (UTC) ---------------------
vid "$g/2024/videos/clip_mp4.mp4"  3 -c:v libx264 -pix_fmt yuv420p -c:a aac \
  -metadata creation_time='2024-03-01T10:00:00Z'
vid "$g/2024/videos/clip_mov.mov"  2 -c:v libx264 -pix_fmt yuv420p -c:a aac \
  -metadata creation_time='2024-03-02T10:00:00Z'
vid "$g/2024/videos/clip_webm.webm" 2 -c:v libvpx-vp9 -b:v 300k -c:a libopus
touch -d '2024-03-03 10:00:00' "$g/2024/videos/clip_webm.webm"
vid "$g/2024/videos/clip_m4v.m4v"  2 -c:v libx264 -pix_fmt yuv420p -c:a aac \
  -metadata creation_time='2024-03-04T10:00:00Z'

# --- 2024/nodate: media WITHOUT a CreateDate ------------------------------
# build-index.js tries DateTimeOriginal, CreateDate, a date in the filename,
# then EXIF ModifyDate. The file time is never used: the touch -d below only
# makes sure it is really ignored.
img "$g/2024/nodate/dto_only.jpg" "DTO ONLY" 1200x900 olive
exif -all= "$g/2024/nodate/dto_only.jpg"
exif -DateTimeOriginal='2024:04:02 08:00:00' "$g/2024/nodate/dto_only.jpg"

img "$g/2024/nodate/IMG_20240406_101500.jpg" "NAME+TIME" 1200x900 cadetblue
exif -all= "$g/2024/nodate/IMG_20240406_101500.jpg"

img "$g/2024/nodate/IMG-20240407-WA0001.jpg" "WHATSAPP" 1200x900 seagreen
exif -all= "$g/2024/nodate/IMG-20240407-WA0001.jpg"

img "$g/2024/nodate/modify_only.jpg" "MODIFY ONLY" 1200x900 rosybrown
exif -all= "$g/2024/nodate/modify_only.jpg"
exif -ModifyDate='2024:04:03 08:00:00' "$g/2024/nodate/modify_only.jpg"

# Impossible date in the name (month 13): must end up undated.
img "$g/2024/nodate/IMG_20241345_000000.jpg" "BAD NAME" 1200x900 slateblue
exif -all= "$g/2024/nodate/IMG_20241345_000000.jpg"

# No usable date at all: these must be sorted last.
img "$g/2024/nodate/stripped.jpg" "STRIPPED" 1200x900 sienna
exif -all= "$g/2024/nodate/stripped.jpg"
touch -d '2024-04-01 08:00:00' "$g/2024/nodate/stripped.jpg"

img "$g/2024/nodate/zero_date.jpg" "ZERO DATE" 1200x900 maroon
exif -all= "$g/2024/nodate/zero_date.jpg"
exif -CreateDate='0000:00:00 00:00:00' "$g/2024/nodate/zero_date.jpg"
touch -d '2024-04-03 08:00:00' "$g/2024/nodate/zero_date.jpg"

vid "$g/2024/nodate/no_meta.mp4" 2 -c:v libx264 -pix_fmt yuv420p -c:a aac \
  -map_metadata -1 -fflags +bitexact
touch -d '2024-04-04 08:00:00' "$g/2024/nodate/no_meta.mp4"

img "$g/2024/nodate/mtime_only.png" "MTIME" 1200x900 navy
touch -d '2024-04-05 08:00:00' "$g/2024/nodate/mtime_only.png"

# --- deep nesting ----------------------------------------------------------
img "$g/deep/a/b/c/nested.jpg" "NESTED" 800x600 darkcyan
exif -DateTimeOriginal='2022:01:01 00:00:00' -CreateDate='2022:01:01 00:00:00' \
  "$g/deep/a/b/c/nested.jpg"

# --- directly in gallery/ (Directory is just "gallery") --------------------
img "$g/top_level.jpg" "TOP LEVEL" 800x600 darkgoldenrod
exif -DateTimeOriginal='2021:06:01 12:00:00' "$g/top_level.jpg"

# --- traps: none of these may be indexed or served -------------------------
echo "not media" > "$g/2024/notes.txt"
printf '\0\0\0\1Bud1' > "$g/2024/.DS_Store"
printf 'AppleDouble junk' > "$g/2023/holiday/._IMG_0001.jpg"
ln -s /etc/hostname "$g/2024/link.jpg"
outside="$root/dev/.outside"                    # a real image outside gallery/
mkdir -p "$outside"
img "$outside/secret.jpg" "SECRET" 400x300 black
ln -s "$outside" "$g/2024/linkdir"
printf 'corrupt' > "$g/2024/broken.jpg"          # preview creation must fail cleanly

echo "created $(find "$g" -type f | wc -l) files under $g"
