FROM docker.io/library/python:3.12-slim-trixie@sha256:5e2bdb1b0d542d5039cffb8181c65930093949194a65c365dfb1b0fe13a4fa5b AS models
# Model weights are fetched at build time and verified; never downloaded at runtime.
COPY models.lock /models.lock
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates && \
    mkdir /models && cd /models && \
    while read -r sum name url; do \
      curl -fsSL --retry 3 -o "$name" "$url" && echo "$sum  $name" | sha256sum -c -; \
    done < /models.lock

FROM docker.io/library/python:3.12-slim-trixie@sha256:5e2bdb1b0d542d5039cffb8181c65930093949194a65c365dfb1b0fe13a4fa5b
# Fixed IDs: stage volumes in the job spec are mounted for uid/gid 10001.
RUN apt-get update && apt-get upgrade -y && rm -rf /var/lib/apt/lists/*
RUN groupadd --system --gid 10001 worker && \
    useradd --system --uid 10001 --gid 10001 --home-dir /worker worker
WORKDIR /worker
COPY requirements-linux-amd64.lock ./
RUN pip install --no-cache-dir --require-hashes --only-binary=:all: -r requirements-linux-amd64.lock
COPY --from=models /models ./models
COPY faces.py cluster.py worker.py inference_pool.py bounded_merge.py LICENSES.md postgres-root.crt ./
USER worker
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 OMP_NUM_THREADS=2
ENTRYPOINT ["python", "/worker/worker.py"]
