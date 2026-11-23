# Pass an immutable image digest (repository@sha256:...) from a verified build.
# Build the bundle with build.mjs, then use dist/scale-benchmark as the context.
ARG WORKER_IMAGE
FROM ${WORKER_IMAGE}
ARG WORKER_IMAGE
RUN case "$WORKER_IMAGE" in *@sha256:*) ;; *) echo 'WORKER_IMAGE must use a registry digest' >&2; exit 1 ;; esac
COPY --chown=node:node run.cjs /app/scale-benchmark.cjs
CMD ["node", "/app/scale-benchmark.cjs"]
