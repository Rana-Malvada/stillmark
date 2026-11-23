#!/usr/bin/env bash
# Builds the face worker image for linux/amd64 and runs its unit tests inside it.
# Requires a Docker engine (for example Colima). No Snowflake access is used.
set -euo pipefail
cd "$(dirname "$0")"
tag="face-worker:test"
docker buildx build --platform linux/amd64 --load -t "$tag" . >/dev/null
sample_dir="$(mktemp -d "${HOME}/.cache/face-test.XXXXXX")"
trap 'rm -rf "$sample_dir"' EXIT
args=()
if [[ -n "${FACE_SAMPLE_IMAGE:-}" ]]; then
  cp "$FACE_SAMPLE_IMAGE" "$sample_dir/sample.jpg"
  args+=(-e FACE_SAMPLE_IMAGE=/samples/sample.jpg)
fi
docker run --rm --platform linux/amd64 --network none --entrypoint python \
  -e MODEL_DIR=/worker/models "${args[@]}" \
  -v "$PWD/test_faces.py:/worker/test_faces.py:ro" \
  -v "$PWD/test_publication.py:/worker/test_publication.py:ro" -v "$sample_dir:/samples:ro" \
  "$tag" -m unittest discover -s /worker -p 'test_*.py' -v
