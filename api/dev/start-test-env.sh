#!/bin/bash
#
# start-test-env.sh -- run server.js and a user-level nginx for local testing.
# Development/test only; nothing system-wide is touched.
#
#     dev/start-test-env.sh <run-dir>     # e.g. a scratch directory
#
# Then open http://127.0.0.1:8088/ . Stop with: kill $(cat <run-dir>/*.pid)
#
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
www="${WWW_DIR:-$(cd "$root/../www" && pwd)}"   # the frontend next to api/ in this repo
run="$(mkdir -p "$1" && cd "$1" && pwd)"
sock="$run/api.sock"
mime=/etc/nginx/mime.types

sed -e "s|@RUN@|$run|g" -e "s|@SOCK@|$sock|g" -e "s|@WWW@|$www|g" \
    -e "s|@REPO@|$root|g" -e "s|@MIME@|$mime|g" \
    "$root/dev/nginx.test.conf.template" > "$run/nginx.conf"

SOCKET_PATH="$sock" node "$root/server.js" > "$run/server.log" 2>&1 &
echo $! > "$run/server.pid"

for _ in $(seq 50); do [[ -S "$sock" ]] && break; sleep 0.1; done
[[ -S "$sock" ]] || { echo "server.js did not start, see $run/server.log" >&2; exit 1; }

nginx -p "$run" -c "$run/nginx.conf" -e "$run/error.log" > "$run/nginx.out" 2>&1 &
sleep 0.5
kill -0 "$(cat "$run/nginx.pid" 2>/dev/null)" 2>/dev/null \
  || { echo "nginx did not start, see $run/nginx.out / error.log" >&2; exit 1; }

echo "server.js: $sock   nginx: http://127.0.0.1:8088/   logs: $run"
