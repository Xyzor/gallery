#!/bin/bash
#
# deploy.sh -- deploy the gallery frontend from this checkout to the web root.
#
#     sudo ./deploy.sh <target-dir>
#     sudo ./deploy.sh /srv/www/gallery-web
#
# Copies the entries in COPY into <target-dir> and sets permissions. A listed
# folder is replaced as a whole, so files removed from the repository (a
# renamed js module, for example) do not linger on the server.
#
# Permissions: everything under <target-dir>, and the folder itself, is
# root:root, folders 755, files 644; nginx reads them as "other". EXECUTABLES
# are root:root 700.
#
# Deploy the backend first: this frontend needs the `date` and `kind` fields
# of the backend's index.
#
set -euo pipefail
umask 022

# --- Lists -----------------------------------------------------------------
# Files or folders copied from this checkout into <target-dir>.
# dev/, README.md and package*.json are development-only and not deployed.
COPY=(index.html css js)
# Entries right under <target-dir> that only root may read and run.
EXECUTABLES=()

# --- Helpers ---------------------------------------------------------------
die() { echo "deploy: $*" >&2; exit 1; }
step() { currentStep="$1"; echo "==> $1"; }

currentStep="checks"
onError() {
  if [[ $currentStep == checks ]]; then
    echo "deploy: FAILED during checks -- nothing was changed" >&2
  else
    echo "deploy: FAILED during: $currentStep" >&2
  fi
}
trap onError ERR

# --- 1. Checks: nothing is changed until all of these pass -----------------
[[ $# -eq 1 ]] || die "usage: sudo $(basename "$0") <target-dir>"
targetArg="$1"

[[ $EUID -eq 0 ]] || die "must run as root"

srcDir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
[[ -d "$targetArg" ]] || die "target folder does not exist: $targetArg"
target="$(realpath -e -- "$targetArg")"
[[ "$target" != "$srcDir" ]] || die "target is this checkout itself: $target"

for item in "${COPY[@]}"; do
  [[ -e "$srcDir/$item" ]] || die "missing in $srcDir: $item"
done
for item in "${EXECUTABLES[@]}"; do
  [[ " ${COPY[*]} " == *" $item "* ]] || die "EXECUTABLES entry not in COPY: $item"
done

echo "deploying $srcDir -> $target"

# --- 2. Copy -----------------------------------------------------------------
step "copy"
for item in "${COPY[@]}"; do
  if [[ -d "$srcDir/$item" ]]; then
    # Copy next to the old folder first, then swap, so the old folder is only
    # replaced once the new one is complete.
    rm -rf -- "$target/.$item.new" "$target/.$item.old"
    cp -R -- "$srcDir/$item" "$target/.$item.new"
    if [[ -e "$target/$item" ]]; then mv -- "$target/$item" "$target/.$item.old"; fi
    mv -- "$target/.$item.new" "$target/$item"
    rm -rf -- "$target/.$item.old"
  else
    cp -- "$srcDir/$item" "$target/"
  fi
done

# --- 3. Permissions ----------------------------------------------------------
step "set permissions"
# chown -R and find -type d/-type f do not follow symlinks, so nothing outside
# the target is touched.
chown -R root:root "$target"
find "$target" -type d -exec chmod 755 {} +
find "$target" -type f -exec chmod 644 {} +
for item in "${EXECUTABLES[@]}"; do
  chown root:root "$target/$item"
  chmod 700 "$target/$item"
done

trap - ERR
echo "deploy: done"
