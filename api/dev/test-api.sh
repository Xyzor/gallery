#!/bin/bash
#
# test-api.sh -- talk to server.js over its unix socket and check the answers.
# Development/test only. Needs curl and node.
#
#     dev/test-api.sh <socket-path>
#
set -uo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
sock="$1"
pass=0 fail=0

check() {  # check <description> <expected> <actual>
  if [[ "$2" == "$3" ]]; then
    pass=$((pass + 1)); echo "PASS  $1"
  else
    fail=$((fail + 1)); echo "FAIL  $1 (expected '$2', got '$3')"
  fi
}
status() { curl -s -o /dev/null -w '%{http_code}' --unix-socket "$sock" --path-as-is "$@"; }
header() {  # header <name> <url>
  curl -s -D - -o /dev/null --unix-socket "$sock" --path-as-is "http://x$2" \
    | tr -d '\r' | awk -v h="$(tr A-Z a-z <<<"$1")" -F': ' 'tolower($1)==h {print $2}'
}

if [[ "$(status http://x/health)" == 000 ]]; then
  echo "cannot connect to $sock (note: unix socket paths are limited to 107 bytes)" >&2
  exit 2
fi

# --- basic endpoints -------------------------------------------------------
check "/health 200"             200 "$(status http://x/health)"
check "/get-files 200"          200 "$(status http://x/get-files)"
check "unknown path 404"        404 "$(status http://x/nope)"
check "POST 405"                405 "$(status -X POST http://x/get-files)"
check "HEAD /get-files 200"     200 "$(status -I http://x/get-files)"
check "HEAD has no body"        0   "$(curl -s -I --unix-socket "$sock" http://x/get-files -o /dev/null -w '%{size_download}')"

shape=$(curl -s --unix-socket "$sock" http://x/get-files | node -e '
  const d = JSON.parse(require("fs").readFileSync(0, "utf8"));
  const ok = Array.isArray(d.files) && Array.isArray(d.groups) && Array.isArray(d.mimes)
          && d.length === d.files.length
          && d.files.every((f) => f.SourceFile && f.FileName && f.Directory && f.MIMEType && f.id
                                && ["image", "video"].includes(f.kind)
                                && (f.date === null || /^\d{4}:\d\d:\d\d \d\d:\d\d:\d\d$/.test(f.date)));
  console.log(ok ? "ok" : "bad");')
check "/get-files shape matches js/api.js" ok "$shape"

order=$(curl -s --unix-socket "$sock" http://x/get-files | node -e '
  const files = JSON.parse(require("fs").readFileSync(0, "utf8")).files;
  // Newest first by `date`; every undated file after all dated ones.
  const ok = files.every((f, i) => i === 0 || (() => {
    const prev = files[i - 1].date, cur = f.date;
    if (prev === null) return cur === null;
    return cur === null || prev >= cur;
  })());
  console.log(ok ? "ok" : "bad");')
check "/get-files sorted newest first, undated last" ok "$order"

# --- every indexed URL is served, with per-segment encoding ---------------
while IFS=$'\t' read -r url mime; do
  path="${url#/api}"
  check "200 $path"           200 "$(status "http://x$path")"
  check "type $path"          "$mime" "$(header Content-Type "$path")"
  check "accel $path"         "/_${path#/}" "$(header X-Accel-Redirect "$path")"
done < <(node -e '
  const types = require(process.argv[1]).MEDIA_TYPES;
  const ext = (u) => require("path").extname(decodeURIComponent(u)).toLowerCase();
  const idx = require(process.argv[2]);
  for (const f of idx.items) for (const u of [f.SourceFile, f.previewImageUrl])
    if (u) console.log(u + "\t" + types.get(ext(u))[1]);
' "$root/media-types.js" "$root/data/gallery-index.json")

# --- things that must never be served -------------------------------------
check "traversal ..%2F 400"     400 "$(status 'http://x/gallery/..%2Fdev%2F.outside%2Fsecret.jpg')"
check "traversal ..%2F deep"    400 "$(status 'http://x/gallery/2024%2F..%2F..%2Fdev%2F.outside%2Fsecret.jpg')"
check "traversal %2e%2e"        404 "$(status 'http://x/gallery/%2e%2e/dev/.outside/secret.jpg')"
check "traversal literal .."    404 "$(status 'http://x/gallery/../dev/.outside/secret.jpg')"
check "NUL byte 400"            400 "$(status 'http://x/gallery/2024/a%00.jpg')"
check "bad percent 400"         400 "$(status 'http://x/gallery/2024/%E0%A4%A.jpg')"
check "dot-file 400"            400 "$(status 'http://x/gallery/2023/holiday/._IMG_0001.jpg')"
check "symlink file 404"        404 "$(status 'http://x/gallery/2024/link.jpg')"
check "symlinked dir 404"       404 "$(status 'http://x/gallery/2024/linkdir/secret.jpg')"
check "txt 404"                 404 "$(status 'http://x/gallery/2024/notes.txt')"
check "missing 404"             404 "$(status 'http://x/gallery/2024/nope.jpg')"
check "directory 404"           404 "$(status 'http://x/gallery/2024/videos.jpg')"

echo "---"
echo "$pass passed, $fail failed"
[[ $fail -eq 0 ]]
