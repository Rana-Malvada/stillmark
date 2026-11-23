ARG UPLOAD_WORKER_IMAGE
FROM ${UPLOAD_WORKER_IMAGE}
ARG UPLOAD_WORKER_IMAGE
RUN case "$UPLOAD_WORKER_IMAGE" in *@sha256:*) ;; *) echo 'UPLOAD_WORKER_IMAGE must use a registry digest' >&2; exit 1 ;; esac
COPY --chown=node:node run.cjs /app/benchmark.cjs
CMD ["node", "/app/benchmark.cjs"]
