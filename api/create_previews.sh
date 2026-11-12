#!/bin/bash

## Requires: sudo apt install --no-install-recommends ffmpeg imagemagick

dirGallery="${1%/}"

if [[ "$dirGallery" != /* || ! -d "$dirGallery" ]]; then
  echo "Usage: $(basename "$0") /srv/app/fgallery/gallery" >&2
  exit 1
fi

dirPreview="_preview_"
previewHeight=400
counter=0
failed=()

# ImageMagick 7 calls it "magick" and warns on "convert"; Debian's IM6 has
# only "convert".
if command -v magick >/dev/null; then imConvert=magick; else imConvert=convert; fi

# -auto-orient first so the height is measured the way the photo is displayed,
# then -strip so no EXIF (GPS!) ends up in the thumbnail. The "[0]" picks the
# first frame of an animated GIF. The explicit "jpeg:" output format is needed
# because the temp file has no image extension.
createImagePreview() {
  local format="$3"
  "$imConvert" "$1[0]" -auto-orient -strip -resize "x$previewHeight" "$format:$2"
}

# "thumbnail" picks a representative frame (skips black/fade-in frames).
# -nostdin keeps ffmpeg from consuming the file list of the while loop.
createVideoPreview() {
  ffmpeg -nostdin -loglevel error -i "$1" \
    -vf "thumbnail,scale=-2:$previewHeight" -frames:v 1 -q:v 3 -f image2 -c:v mjpeg "$2"
}

while IFS= read -r -d '' file; do
  dirFile=$(dirname "$file")
  filename=$(basename "$file")
  mkdir -p "$dirFile/$dirPreview"

  case "${filename,,}" in
    *.jpg|*.jpeg)
      output="$dirFile/$dirPreview/$filename"
      createPreview=createImagePreview
      format=jpeg
      ;;
    *.png)
      output="$dirFile/$dirPreview/$filename"
      createPreview=createImagePreview
      format=png
      ;;
    *.webp)
      output="$dirFile/$dirPreview/$filename"
      createPreview=createImagePreview
      format=webp
      ;;
    *.gif)
      # A still JPEG: a GIF preview would be animated.
      output="$dirFile/$dirPreview/${filename%.*}.jpg"
      createPreview=createImagePreview
      format=jpeg
      ;;
    *)
      output="$dirFile/$dirPreview/${filename%.*}.jpg"
      createPreview=createVideoPreview
      format=
      ;;
  esac

  ((counter++))
  # -s, not -f: an empty file left over from an earlier failure is redone.
  if [ ! -s "$output" ]; then
    echo "($counter). creating: $output"
    # Write to a temp file and rename on success, so an interrupted or failed
    # conversion never leaves a half-written preview that is skipped forever.
    tmp="$dirFile/$dirPreview/.tmp.$$.${filename}"
    if "$createPreview" "$file" "$tmp" "$format" && [ -s "$tmp" ]; then
      mv -f "$tmp" "$output"
    else
      echo "($counter). FAILED: $file" >&2
      rm -f "$tmp"
      failed+=("$file")
    fi
  fi
# Process substitution, not a pipe, so "failed" survives the loop; NUL-separated
# so any filename works. The list must stay in sync with media-types.js.
# "._*" are macOS AppleDouble files, not images.
done < <(find "$dirGallery" -type f -not -path "*/$dirPreview/*" -not -name '._*' \( \
    -iname '*.jpg' -o -iname '*.jpeg' -o -iname '*.png' -o -iname '*.webp' \
    -o -iname '*.gif' \
    -o -iname '*.mp4' -o -iname '*.mov' -o -iname '*.m4v' -o -iname '*.webm' \
  \) -print0)

# A file without a preview is a warning, not an error: it shows as a
# placeholder tile, and build-index.js skips files that are not media at all.
if (( ${#failed[@]} )); then
  echo "WARNING: ${#failed[@]} preview(s) could not be created:" >&2
  printf '  %s\n' "${failed[@]}" >&2
fi
