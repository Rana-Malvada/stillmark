# Build from the repository root. The adjacent allowlist excludes credentials and local artifacts.
FROM node:22-trixie-slim@sha256:68c76cfad89921b927eae28ba21407475e29d0ce450afcdbe70c1532db042b64 AS build
WORKDIR /src
ENV NEXT_TELEMETRY_DISABLED=1 ONNXRUNTIME_NODE_INSTALL=skip
COPY package.json package-lock.json ./
COPY scripts/snowflake-deadline ./scripts/snowflake-deadline
RUN npm ci --include=dev
COPY . .
RUN npm run build && node scripts/copy-video-tools.cjs

FROM node:22-trixie-slim@sha256:68c76cfad89921b927eae28ba21407475e29d0ce450afcdbe70c1532db042b64
WORKDIR /app
# Runtime executes the bundled server directly; package-manager tooling belongs only in the build stage.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /opt/yarn-* \
    && rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg
RUN apt-get update && apt-get upgrade -y && apt-get install -y --no-install-recommends python3 python3-venv \
    && rm -rf /var/lib/apt/lists/*
COPY workers/upload-cpu/requirements-linux-amd64.lock /tmp/heif-requirements.txt
RUN python3 -m venv /opt/heif \
    && /opt/heif/bin/pip install --no-cache-dir --require-hashes --only-binary=:all: -r /tmp/heif-requirements.txt
ENV PYTHONPATH=/opt/stillmark/shared
COPY workers/shared/ /opt/stillmark/shared/
COPY --chown=node:node workers/upload-cpu/decode-heif.py ./workers/upload-cpu/decode-heif.py
COPY workers/upload-cpu/test_decode_heif.py ./workers/upload-cpu/test_decode_heif.py
RUN /opt/heif/bin/python -m unittest discover -s /opt/stillmark/shared -p test_image_decode.py
RUN /opt/heif/bin/python -m unittest discover -s workers/upload-cpu -p test_decode_heif.py \
    && rm workers/upload-cpu/test_decode_heif.py
ENV NODE_ENV=production HOSTNAME=0.0.0.0 PORT=3000 \
    UPLOAD_SERVICE_ONLY=true BACKGROUND_JOBS_ENABLED=false \
    UPLOAD_COMPLETIONS_PER_INSTANCE=1 MALLOC_ARENA_MAX=2
COPY --from=build --chown=node:node /src/.next/standalone ./
COPY --from=build --chown=node:node /src/certs ./certs
USER node
EXPOSE 3000
CMD ["node", "server.js"]
