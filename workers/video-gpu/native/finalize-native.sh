#!/bin/bash
set -euo pipefail
[[ "${NATIVE_BUILD_JOBS:?}" =~ ^([1-9]|1[0-6])$ ]] || exit 1
cd /ffmpeg
./configure $(sed -n '/^[ ]*--/s/^[ ]*//p' /locks/ffmpeg-configure.txt)
make -j"$NATIVE_BUILD_JOBS"
# FATE must use this build, not the donor package already in the compiler image.
make install
make install DESTDIR=/patched
python3 /locks/verify-built-libraries.py | tee /locks/tested-library-closure.json
make fate -j"$NATIVE_BUILD_JOBS" 2>&1 | tee /locks/ffmpeg-tests.log
make fate-cfhd fate-flic SAMPLES=/fate-samples -j"$NATIVE_BUILD_JOBS" 2>&1 | tee /locks/ffmpeg-codec-tests.log
mkdir -p /native-output/usr/lib/jellyfin-ffmpeg/lib /native-output/evidence
cp -a /patched/usr/lib/jellyfin-ffmpeg/bin/{ffmpeg,ffprobe} /native-output/usr/lib/jellyfin-ffmpeg/
cp -a /patched/usr/lib/jellyfin-ffmpeg/lib/{libav*,libsw*}.so* /native-output/usr/lib/jellyfin-ffmpeg/lib/
cp -a /patched/usr/lib/jellyfin-ffmpeg/lib/libxml2.so* /native-output/usr/lib/jellyfin-ffmpeg/lib/
cp -a /patched/usr/lib/jellyfin-ffmpeg/lib/libz.so* /native-output/usr/lib/jellyfin-ffmpeg/lib/
cp ffbuild/config.mak ffbuild/config.log /native-output/evidence/
cp /locks/ffmpeg-configure.txt /native-output/evidence/
./ffmpeg -buildconf > /native-output/evidence/ffmpeg-buildconf.txt 2>&1
find tests/data/fate -name '*.rep' -exec cp {} /native-output/evidence/ \;

cp /locks/{source-patch,zlib,libxml2,ffmpeg,ffmpeg-codec}-tests.log /native-output/evidence/
cp /locks/{vendor-patches,build-capacity,test-registration-tests}.log /native-output/evidence/
cp /locks/tested-zlib-closure.json /native-output/evidence/
cp /locks/tested-library-closure.json /native-output/evidence/
python3 - <<'PYMANIFEST'
import pathlib, hashlib, json, os
root = pathlib.Path('/native-output/usr/lib/jellyfin-ffmpeg')
manifest = {'files': {str(p.relative_to(root)): hashlib.sha256(p.read_bytes()).hexdigest()
                     for p in root.rglob('*') if p.is_file() and not p.is_symlink()},
            'symlinks': {str(p.relative_to(root)): os.readlink(p)
                         for p in root.rglob('*') if p.is_symlink()}}
pathlib.Path('/native-output/evidence/built-artifacts.json').write_text(json.dumps(manifest, indent=2) + '\n')
PYMANIFEST
