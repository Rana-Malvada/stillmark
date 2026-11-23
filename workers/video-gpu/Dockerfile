# syntax=docker/dockerfile:1.7
FROM docker.io/library/node:22-trixie-slim@sha256:68c76cfad89921b927eae28ba21407475e29d0ce450afcdbe70c1532db042b64 AS app-build
ARG SOURCE_COMMIT
WORKDIR /source/workers/video-gpu
COPY workers/video-gpu/package.json workers/video-gpu/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY workers/video-gpu/ ./
COPY lib/ /source/lib/
RUN SOURCE_COMMIT="$SOURCE_COMMIT" node build.mjs && npm prune --omit=dev --no-audit --no-fund
FROM docker.io/library/node:22-trixie-slim@sha256:68c76cfad89921b927eae28ba21407475e29d0ce450afcdbe70c1532db042b64 AS node
FROM ubuntu:24.04@sha256:9c7f200c07e3d4a03e7249d2c16bf66a51120fb876aa2242cf31451412543289 AS runtime-base
ADD --checksum=sha256:22e3bbb6ca67f4d7badb16ae4a3c677940b97cb76eb273af7d70f6cb2b9b62bf https://github.com/jellyfin/jellyfin-ffmpeg/releases/download/v8.1.3-2/jellyfin-ffmpeg8_8.1.3-2-noble_amd64.deb /tmp/jellyfin-ffmpeg.deb
RUN apt-get update && apt-get upgrade -y && apt-get install -y --no-install-recommends /tmp/jellyfin-ffmpeg.deb ca-certificates && rm -rf /var/lib/apt/lists/* /tmp/jellyfin-ffmpeg.deb
COPY --from=node /usr/local/bin/node /usr/local/bin/node
FROM runtime-base AS compiler
ENV DEBIAN_FRONTEND=noninteractive
COPY workers/video-gpu/Dockerfile /native-recipe/Dockerfile
COPY workers/video-gpu/native/verify-built-libraries.py workers/video-gpu/native/build-parallelism.py workers/video-gpu/native/build-inputs.json workers/video-gpu/native/build-native.sh workers/video-gpu/native/build-tools.lock workers/video-gpu/native/cfhd-official.patch workers/video-gpu/native/compiler-packages.txt workers/video-gpu/native/fate-samples.json workers/video-gpu/native/fetch-inputs.py workers/video-gpu/native/ffmpeg-configure.txt workers/video-gpu/native/finalize-native.sh workers/video-gpu/native/flic-official.patch workers/video-gpu/native/native-cache.py workers/video-gpu/native/pinned-fetch.py workers/video-gpu/native/vendor-dependencies.sh workers/video-gpu/native/vendor-dependency-lock.json workers/video-gpu/native/zlib-official.patch workers/video-gpu/native/swscale-test-config.patch /native-inputs/
RUN apt-get update && apt-get install -y --no-install-recommends $(cat /native-inputs/compiler-packages.txt) && rm -rf /var/lib/apt/lists/*
RUN python3 -m venv /opt/build-tools && /opt/build-tools/bin/pip install --require-hashes -r /native-inputs/build-tools.lock
ENV PATH=/opt/build-tools/bin:$PATH
RUN cp -a /native-inputs /locks
# A cache miss is a complete build from immutable public source and reviewed patches.
# Cache restoration binds all inputs, package/compiler versions and every file hash.
RUN --mount=type=cache,id=stillmark-video-native-v1,target=/native-cache,sharing=locked     python3 /native-inputs/native-cache.py restore; status=$?;     if [ "$status" = 3 ]; then bash /locks/build-native.sh && python3 /native-inputs/native-cache.py store;     elif [ "$status" != 0 ]; then exit "$status"; fi
FROM scratch AS native-cache-export
COPY --from=compiler /native-cache-export/ /
FROM runtime-base
# Replace donor codec/XML/zlib files completely; COPY alone retains older SONAME files.
RUN find /usr/lib/jellyfin-ffmpeg/lib -maxdepth 1 \( -name 'libav*.so*' -o -name 'libsw*.so*' -o -name 'libxml2.so*' -o -name 'libz.so*' \) -delete && rm -f /usr/lib/jellyfin-ffmpeg/ffmpeg /usr/lib/jellyfin-ffmpeg/ffprobe
COPY --from=compiler /native-output/usr/ /usr/
COPY --from=compiler /native-output/evidence/ /worker/native-security/build-evidence/
WORKDIR /worker
ARG SOURCE_COMMIT
LABEL org.opencontainers.image.revision=$SOURCE_COMMIT
LABEL org.stillmark.native-security="reviewed-source-v1"
COPY --from=app-build /source/workers/video-gpu/dist/worker.mjs ./worker.mjs
COPY --from=app-build /source/workers/video-gpu/dist/build-info.json ./build-info.json
COPY --from=app-build /source/workers/video-gpu/node_modules ./node_modules
COPY workers/video-gpu/postgres-root.crt ./postgres-root.crt
COPY workers/video-gpu/verify-build.mjs ./verify-build.mjs
COPY workers/video-gpu/native/artifact-integrity.cjs workers/video-gpu/native/runtime-closure.cjs workers/video-gpu/native/native-inventory.cjs ./
COPY workers/video-gpu/native/components.cdx.json workers/video-gpu/native/source-lock.json workers/video-gpu/native/applicability.json ./native-security/
RUN ldconfig && node runtime-closure.cjs && node native-inventory.cjs && node verify-build.mjs "$SOURCE_COMMIT"
ENV NODE_ENV=production
USER 65532:65532
ENTRYPOINT ["/usr/local/bin/node", "/worker/worker.mjs"]
