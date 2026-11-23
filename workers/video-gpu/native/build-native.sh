#!/bin/bash
set -euo pipefail
export PATH=/opt/build-tools/bin:$PATH
export TARGET_DIR=/usr/lib/jellyfin-ffmpeg PKG_CONFIG_PATH=/usr/lib/jellyfin-ffmpeg/lib/pkgconfig
export LD_LIBRARY_PATH=/usr/lib/jellyfin-ffmpeg/lib:/usr/lib/jellyfin-ffmpeg/lib/mfx:/usr/lib/jellyfin-ffmpeg/lib/xorg
export LDFLAGS="-Wl,--disable-new-dtags -Wl,-rpath=/usr/lib/jellyfin-ffmpeg/lib -L/usr/lib/jellyfin-ffmpeg/lib -lm"
export CFLAGS="-I/usr/lib/jellyfin-ffmpeg/include" CPPFLAGS="-I/usr/lib/jellyfin-ffmpeg/include" CXXFLAGS="-I/usr/lib/jellyfin-ffmpeg/include"
NATIVE_BUILD_JOBS=$(python3 /locks/build-parallelism.py /locks/build-inputs.json)
export NATIVE_BUILD_JOBS
printf "Native compile jobs: %s\n" "$NATIVE_BUILD_JOBS" | tee /locks/build-capacity.log
python3 /locks/fetch-inputs.py
mkdir /ffmpeg
tar -xf /tmp/source.tar.gz -C /ffmpeg --strip-components=1
python3 /locks/fetch-inputs.py --vendor-patches /ffmpeg 2>&1 | tee /locks/vendor-patches.log
python3 /locks/fetch-inputs.py --test-config /ffmpeg 2>&1 | tee /locks/test-registration-tests.log
# Validate all backports before the expensive dependency build.
mkdir /tmp/patch-preflight
cd /tmp/patch-preflight
python3 /locks/pinned-fetch.py git clone -b v1.3.2 --depth=1 https://github.com/madler/zlib.git
python3 /locks/fetch-inputs.py --preflight /ffmpeg /tmp/patch-preflight/zlib 2>&1 | tee /locks/source-patch-tests.log
bash /locks/vendor-dependencies.sh > /locks/dependencies-build.log 2>&1 || { tail -80 /locks/dependencies-build.log; exit 1; }
cd /ffmpeg/zlib
git apply /locks/zlib-official.patch
make -j"$NATIVE_BUILD_JOBS"
make install
make install DESTDIR=/patched
python3 /locks/verify-built-libraries.py --zlib | tee /locks/tested-zlib-closure.json
make test 2>&1 | tee /locks/zlib-tests.log
cd /ffmpeg/libxml2
make check -j"$NATIVE_BUILD_JOBS" 2>&1 | tee /locks/libxml2-tests.log
make install DESTDIR=/patched
cd /ffmpeg
bash /locks/finalize-native.sh
