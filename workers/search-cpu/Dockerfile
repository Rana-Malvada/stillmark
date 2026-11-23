# Build from repository root with -f workers/search-cpu/Dockerfile.
FROM ubuntu:24.04@sha256:9c7f200c07e3d4a03e7249d2c16bf66a51120fb876aa2242cf31451412543289
# Noble supplies maintained libxml2/OCR dependencies and Python 3.12. Preserve
# the existing hashed Python wheels and model versions in an isolated venv.
RUN apt-get update && apt-get upgrade -y && apt-get install -y --no-install-recommends python3 python3-venv tesseract-ocr tesseract-ocr-eng ca-certificates && rm -rf /var/lib/apt/lists/*
RUN python3 -m venv /opt/python
ENV PATH=/opt/python/bin:$PATH
WORKDIR /worker
COPY workers/search-cpu/requirements-linux-amd64.lock /build/search-cpu/requirements.lock
COPY workers/shared/ /build/shared/
ENV PYTHONPATH=/build/shared
RUN pip install --no-cache-dir --require-hashes --only-binary=:all: -r /build/search-cpu/requirements.lock
RUN python -m unittest discover -s /build/shared -p test_image_decode.py
COPY workers/search-cpu/models.json workers/search-cpu/download.py ./
RUN python download.py && chmod -R a+rX /models
COPY workers/search-cpu/worker.py workers/search-cpu/inference_pool.py workers/search-cpu/capacity.py workers/search-cpu/travel_summaries.py workers/search-cpu/postgres-root.crt ./
RUN groupadd --system --gid 10001 worker && useradd --system --uid 10001 --gid 10001 --home-dir /worker worker
USER worker
ENV HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 TOKENIZERS_PARALLELISM=false PYTHONUNBUFFERED=1 OMP_NUM_THREADS=4
ENTRYPOINT ["python","/worker/worker.py"]
