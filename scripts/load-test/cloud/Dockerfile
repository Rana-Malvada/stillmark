FROM node:22-bookworm-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee
WORKDIR /runner
COPY cloud/package.json cloud/package-lock.json ./cloud/
RUN npm ci --prefix cloud --omit=dev --ignore-scripts --no-audit --no-fund
COPY harness.mjs transport-trace.mjs mixed.mjs http-failure.mjs ./
COPY cloud/server.mjs cloud/transport.mjs ./cloud/
COPY fixtures /fixtures
USER node
CMD ["node", "cloud/server.mjs"]
