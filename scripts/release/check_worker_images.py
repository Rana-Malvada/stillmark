"""Required real worker-image tests and vulnerability scans. No credentials/deployment.

Builds current source, checks actual installed libraries/models, scans immutable
image IDs, and retains private evidence. It never relies on host Python imports.
"""

import datetime
import json
import os
import pathlib
import subprocess
import sys
import uuid
from common import ROOT
from image_security import scan_image
from check_database import source_snapshot

WORKERS = ("face-cpu", "search-cpu", "upload-cpu", "video-gpu")
SUITES = {
    "face-cpu": (
        "test_faces.py",
        "test_repair.py",
        "test_inference_liveness.py",
        "test_bounded_merge.py",
        "test_cluster_deadline.py",
        "test_publication.py",
        "test_warm_idle.py",
    ),
    "search-cpu": (
        "test_worker.py",
        "test_search_inference_liveness.py",
        "test_rerank_publication.py",
        "test_capacity.py",
        "test_travel_summaries.py",
        "test_warm_idle.py",
    ),
}


def test_cpu_limit():
    # Docker can expose fewer CPUs than the host (including two-core CI runners).
    # This is a behavior gate, not a throughput benchmark; keep every suite.
    available = int(
        subprocess.check_output(["docker", "info", "--format", "{{.NCPU}}"], text=True).strip()
    )
    if available < 1:
        raise ValueError("Docker must expose at least one CPU for worker tests")
    return str(min(4, available))


def test_image(worker, image_id):
    # Mount only tests and the repair utility; implementations and models come
    # from the exact production image. No database or network access is possible.
    base = [
        "docker",
        "run",
        "--rm",
        "--platform",
        "linux/amd64",
        "--network",
        "none",
        "--read-only",
        "--tmpfs",
        "/tmp:rw,size=1073741824",
        "--cpus",
        test_cpu_limit(),
        "--memory",
        "6g",
    ]
    if worker in SUITES:
        mounts = []
        for name in SUITES[worker]:
            mounts += ["-v", f"{ROOT}/workers/{worker}/{name}:/worker/{name}:ro"]
        if worker == "face-cpu":
            mounts += [
                "-v",
                f"{ROOT}/workers/face-cpu/repair.py:/worker/repair.py:ro",
                "-e",
                "MODEL_DIR=/worker/models",
                "-v",
                f"{ROOT}/tests/fixtures/media/astronaut.png:/tmp/face-sample.png:ro",
                "-e",
                "FACE_SAMPLE_IMAGE=/tmp/face-sample.png",
            ]
        for name in SUITES[worker]:
            subprocess.run(
                [
                    *base,
                    *mounts,
                    "--entrypoint",
                    "python",
                    image_id,
                    "-m",
                    "unittest",
                    "discover",
                    "-s",
                    "/worker",
                    "-p",
                    name,
                    "-v",
                ],
                check=True,
                timeout=900,
            )
    elif worker == "upload-cpu":
        subprocess.run(
            [
                *base,
                "-v",
                f"{ROOT}/workers/upload-cpu/test_decode_heif.py:/app/workers/upload-cpu/test_decode_heif.py:ro",
                "--entrypoint",
                "/opt/heif/bin/python",
                image_id,
                "-m",
                "unittest",
                "discover",
                "-s",
                "/app/workers/upload-cpu",
                "-p",
                "test_decode_heif.py",
                "-v",
            ],
            check=True,
            timeout=180,
        )
        subprocess.run(
            [
                *base,
                "--entrypoint",
                "/opt/heif/bin/python",
                image_id,
                "-m",
                "unittest",
                "discover",
                "-s",
                "/opt/stillmark/shared",
                "-p",
                "test_image_decode.py",
                "-v",
            ],
            check=True,
            timeout=180,
        )
    else:
        # The runtime contains its immutable bundle verifier, ffmpeg and ffprobe.
        subprocess.run(
            [
                *base,
                "--entrypoint",
                "/usr/local/bin/node",
                image_id,
                "/worker/verify-build.mjs",
                subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip(),
            ],
            check=True,
            timeout=60,
        )
        subprocess.run(
            [*base, "--entrypoint", "/usr/lib/jellyfin-ffmpeg/ffmpeg", image_id, "-version"],
            check=True,
            timeout=30,
        )
        # Exercise the shipped codecs/libraries, including an audio-bearing HLS
        # output. A version string alone does not prove the runtime can transcode.
        subprocess.run(
            [
                *base,
                "--entrypoint",
                "/bin/sh",
                image_id,
                "-ec",
                "/usr/lib/jellyfin-ffmpeg/ffmpeg -hide_banner -loglevel error "
                "-f lavfi -i testsrc2=size=128x96:rate=10 "
                "-f lavfi -i sine=frequency=440:sample_rate=44100 -t 2 "
                "-c:v libx264 -preset ultrafast -pix_fmt yuv420p -c:a aac "
                "-f hls -hls_time 1 /tmp/playback.m3u8 && "
                "/usr/lib/jellyfin-ffmpeg/ffprobe -v error -show_streams "
                "-of json /tmp/playback.m3u8 > /tmp/probe.json && "
                "node -e \"const p=require('/tmp/probe.json'); "
                "if(!p.streams.some(s=>s.codec_name==='h264'&&s.width===128) || "
                "!p.streams.some(s=>s.codec_name==='aac')) process.exit(1)\"",
            ],
            check=True,
            timeout=60,
        )


def main():
    selected = sys.argv[1:] or WORKERS
    if any(w not in WORKERS for w in selected):
        raise ValueError("Unknown worker")
    run_id = str(uuid.uuid4())
    output = ROOT / ".release" / "worker-images" / run_id
    output.mkdir(parents=True)
    commit = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip()
    source = source_snapshot(ROOT)
    record = {
        **source,
        "startedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "images": [],
        "status": "running",
    }
    try:
        for worker in selected:
            image_source = source_snapshot(ROOT)
            tag = f"stillmark-{worker}:gate-{run_id}"
            context = ROOT / "workers" / worker if worker == "face-cpu" else ROOT
            subprocess.run(
                [
                    "docker",
                    "buildx",
                    "build",
                    "--platform",
                    "linux/amd64",
                    "--load",
                    "--build-arg",
                    f"SOURCE_COMMIT={commit}",
                    "-f",
                    str(ROOT / "workers" / worker / "Dockerfile"),
                    "-t",
                    tag,
                    str(context),
                ],
                check=True,
                timeout=10800,
            )
            image_id = json.loads(
                subprocess.check_output(["docker", "image", "inspect", tag], text=True)
            )[0]["Id"]
            entry = {
                "worker": worker,
                "imageId": image_id,
                "sourceSha256": image_source["sourceSha256"],
                "status": "testing",
            }
            record["images"].append(entry)
            test_image(worker, image_id)
            if worker == "search-cpu":
                subprocess.run(
                    ["node", "scripts/verification/search-ocr-recovery.mjs"],
                    cwd=ROOT,
                    env={**os.environ, "SEARCH_RECOVERY_TEST_IMAGE": image_id},
                    check=True,
                    timeout=240,
                )
            entry["tests"] = "passed"
            scan_image(image_id, output / worker, require_native=worker == "video-gpu", review_scope=worker)
            if source_snapshot(ROOT) != image_source:
                raise RuntimeError(
                    f"Source changed while {worker} was built/tested; rerun against stable source"
                )
            entry["status"] = "passed-with-reported-upstream-findings"
        if source_snapshot(ROOT) != source:
            raise RuntimeError(
                "Source changed while worker images were checked; rerun against stable source"
            )
        record["status"] = "passed"
    except BaseException:
        record["status"] = "failed"
        raise
    finally:
        (output / "result.json").write_text(json.dumps(record, indent=2) + "\n")
        print(f"Worker-image evidence: {output}")


if __name__ == "__main__":
    main()
