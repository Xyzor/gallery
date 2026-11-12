#!/bin/bash
#
# deploy.sh -- deploy the gallery API from this checkout to the server folder.
#
#     sudo ./deploy.sh <service> <target-dir> <api-user>
#     sudo ./deploy.sh fgallery-api /srv/app/gallery-api fgallery-api
#
# Copies the files in COPY into <target-dir>, creates missing previews,
# rebuilds the index, sets permissions and restarts <service>. The old service
# keeps running until the very end, so a failed step never takes the site down.
#
# Permissions (deny by default): everything under <target-dir> is
# root:<api-user>, folders 750, files 640, so the service can read the code
# but not change it and other local users see nothing. EXECUTABLES are
# root:<api-user> 750: the service runs them after uploads but cannot edit them.
# WRITABLE (gallery/ and data/) belong to <api-user>, because uploads add media
# and the index is rebuilt afterwards; gallery folders are setgid so nginx,
# a member of the <api-user> group, can read every new upload too.
#
set -euo pipefail
umask 027                      # nothing created here is ever world-readable

# --- Lists -----------------------------------------------------------------
# Files (or folders) copied from this checkout into <target-dir>.
COPY=(server.js media-types.js build-index.js create_previews.sh multipart.js upload.js reindex.js)
# Entries right under <target-dir> that root and the service may read and run.
EXECUTABLES=(create_previews.sh build-index.js)
# Folders right under <target-dir> that the service may write to.
WRITABLE=(gallery data)

SOCKET_PATH="${SOCKET_PATH:-/run/fgallery-api/api.sock}"
HEALTH_TIMEOUT_S=10

# --- Helpers ---------------------------------------------------------------
die() { echo "deploy: $*" >&2; exit 1; }
step() { currentStep="$1"; echo "==> $1"; }

currentStep="checks"
onError() {
  if [[ $currentStep == checks ]]; then
    echo "deploy: FAILED during checks -- nothing was changed" >&2
  else
    echo "deploy: FAILED during: $currentStep -- ${service:-the service} was NOT restarted, the old version is still running" >&2
  fi
}
trap onError ERR

# --- 1. Checks: nothing is changed until all of these pass -----------------
[[ $# -eq 3 ]] || die "usage: sudo $(basename "$0") <service> <target-dir> <api-user>"
service="$1" targetArg="$2" apiUser="$3"

[[ $EUID -eq 0 ]] || die "must run as root"

srcDir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
[[ -d "$targetArg" ]] || die "target folder does not exist: $targetArg"
target="$(realpath -e -- "$targetArg")"
[[ "$target" != "$srcDir" ]] || die "target is this checkout itself: $target"
[[ -d "$target/gallery" ]] || die "no gallery/ folder in $target"

systemctl cat -- "$service" >/dev/null 2>&1 || die "unknown systemd service: $service"

# With ProtectSystem=strict the service sees the whole file system read-only except its
# ReadWritePaths=, so every WRITABLE folder must be covered by one (the folder or a parent).
# Missing one only shows at runtime, e.g. as a misleading ENOENT from mkdir in data/.
if [[ "$(systemctl show -p ProtectSystem --value -- "$service")" == strict ]]; then
  rwPaths=()
  for entry in $(systemctl show -p ReadWritePaths --value -- "$service"); do
    entry="${entry#-}"; entry="${entry#+}"   # "-": ignore if missing, "+": relative to RootDirectory=
    rwPaths+=("$(realpath -m -- "$entry")")
  done
  notWritable=()
  for item in "${WRITABLE[@]}"; do
    covered=no
    for rw in "${rwPaths[@]}"; do
      if [[ "$target/$item" == "$rw" || "$target/$item" == "$rw"/* ]]; then covered=yes; break; fi
    done
    [[ $covered == yes ]] || notWritable+=("$target/$item")
  done
  if (( ${#notWritable[@]} )); then
    neededPaths=("${WRITABLE[@]/#/$target/}")
    die "$service has ProtectSystem=strict but cannot write to: ${notWritable[*]}
  add to the [Service] section of its unit:
    ReadWritePaths=${neededPaths[*]}
  then run: systemctl daemon-reload"
  fi
fi

getent passwd "$apiUser" >/dev/null || die "unknown user: $apiUser"
getent group "$apiUser" >/dev/null || die "unknown group: $apiUser"

for item in "${COPY[@]}"; do
  [[ -e "$srcDir/$item" ]] || die "missing in $srcDir: $item"
done
for item in "${EXECUTABLES[@]}"; do
  [[ " ${COPY[*]} " == *" $item "* ]] || die "EXECUTABLES entry not in COPY: $item"
done

for tool in node exiftool ffmpeg curl; do
  command -v "$tool" >/dev/null || die "required tool not installed: $tool"
done
command -v magick >/dev/null || command -v convert >/dev/null \
  || die "required tool not installed: imagemagick"

echo "deploying $srcDir -> $target (service $service, user $apiUser)"

# --- 2. Copy -----------------------------------------------------------------
step "copy"
for item in "${COPY[@]}"; do
  cp -R -- "$srcDir/$item" "$target/"
done
mkdir -p -- "$target/data"

# --- 3. Previews -------------------------------------------------------------
# Exits non-zero only on a real error; a single file that cannot get a preview
# is reported as a warning.
step "create previews"
bash "$target/create_previews.sh" "$target/gallery"

# --- 4. Index ----------------------------------------------------------------
# Written atomically to data/; the server reads it at startup and after the
# rebuild that follows uploads.
step "build index"
node "$target/build-index.js"

# --- 5. Permissions ----------------------------------------------------------
step "set permissions"
# chown -R and find -type d/-type f do not follow symlinks, so nothing outside
# the target is touched.
chown -R "root:$apiUser" "$target"
find "$target" -type d -exec chmod 750 {} +
find "$target" -type f -exec chmod 640 {} +
for item in "${EXECUTABLES[@]}"; do
  chmod 750 "$target/$item"
done
for item in "${WRITABLE[@]}"; do
  chown -R "$apiUser:$apiUser" "$target/$item"
done
# setgid: folders created by uploads inherit the group, so nginx can read them.
find "$target/gallery" -type d -exec chmod 2750 {} +

# --- 6. Restart --------------------------------------------------------------
step "restart $service"
systemctl restart -- "$service"
trap - ERR
# The index used to live in the target root; the new server reads data/.
rm -f -- "$target/gallery-index.json"

# --- 7. Health check ---------------------------------------------------------
step "health check"
for ((i = 0; i < HEALTH_TIMEOUT_S * 2; i++)); do
  if curl -sf --max-time 2 --unix-socket "$SOCKET_PATH" http://localhost/health >/dev/null; then
    echo "deploy: done, $service is healthy"
    exit 0
  fi
  sleep 0.5
done

echo "deploy: $service did not answer on $SOCKET_PATH within ${HEALTH_TIMEOUT_S}s" >&2
journalctl -u "$service" -n 30 --no-pager >&2 || true
exit 1
