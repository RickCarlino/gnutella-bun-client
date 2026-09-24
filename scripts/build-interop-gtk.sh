#!/usr/bin/env bash
set -euo pipefail
SOURCE_REPO="${1:?usage: build-interop-gtk.sh SOURCE_GIT_REPO OUTPUT_DIRECTORY}"
OUTPUT_ROOT="${2:?usage: build-interop-gtk.sh SOURCE_GIT_REPO OUTPUT_DIRECTORY}"
REVISION=3ce50bf0dd25e88e0d470eda61a0283a23ed49c6
for program in git tar make cc pkg-config rg sha256sum; do
  command -v "$program" >/dev/null || { echo "missing prerequisite: $program" >&2; exit 1; }
done
pkg-config --exists gtk+-2.0 gnutls
mkdir -p "$OUTPUT_ROOT"
BUILD_ROOT="$(mktemp -d "$OUTPUT_ROOT/gtk-build-XXXXXX")"
git -C "$SOURCE_REPO" archive "$REVISION" | tar -x -C "$BUILD_ROOT"
cd "$BUILD_ROOT"
CFLAGS=-std=gnu17 ./build.sh --gtk2 --disable-dbus --disable-nls --configure-only > configure.log 2>&1
make -j "${GTK_BUILD_JOBS:-4}" > build.log 2>&1
./src/gtk-gnutella --compile-info > compile-info.txt
rg -q '^gnutls=enabled$' compile-info.txt
sha256sum src/gtk-gnutella > binary.sha256
printf '%s\n' "$REVISION" > source-revision.txt
pkg-config --modversion gtk+-2.0 gnutls > dependency-versions.txt
cc --version > compiler-version.txt
printf 'GTK build and provenance: %s\n' "$BUILD_ROOT"
