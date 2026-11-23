"""Build and verify a video worker from committed, minimal source; never push or deploy."""

import argparse
import json
import pathlib
import re
import subprocess
import tarfile
import tempfile
from image_security import scan_image

# Explicit build boundary: a new internal import must be deliberately included.
# Never copy the web server, credentials, host dependencies or prebuilt bundles.
SOURCE_FILES = (
    "workers/video-gpu/Dockerfile",
    "workers/video-gpu/build.mjs",
    "workers/video-gpu/verify-build.mjs",
    "workers/video-gpu/package.json",
    "workers/video-gpu/package-lock.json",
    "workers/video-gpu/postgres-root.crt",
    "workers/video-gpu/postgres.mjs",
    "workers/video-gpu/worker.ts",
    "workers/video-gpu/plan.ts",
    "workers/video-gpu/recovery.ts",
    "lib/worker-cycle-recovery.ts",
    "lib/video-audio.ts",
    "lib/video-fragments.ts",
    "lib/video-playback-queue.ts",
    "workers/video-gpu/native/applicability.json",
    "workers/video-gpu/native/artifact-integrity.cjs",
    "workers/video-gpu/native/build-inputs.json",
    "workers/video-gpu/native/build-parallelism.py",
    "workers/video-gpu/native/verify-built-libraries.py",
    "workers/video-gpu/native/build-native.sh",
    "workers/video-gpu/native/build-tools.lock",
    "workers/video-gpu/native/cfhd-official.patch",
    "workers/video-gpu/native/compiler-packages.txt",
    "workers/video-gpu/native/components.cdx.json",
    "workers/video-gpu/native/fate-samples.json",
    "workers/video-gpu/native/fetch-inputs.py",
    "workers/video-gpu/native/ffmpeg-configure.txt",
    "workers/video-gpu/native/finalize-native.sh",
    "workers/video-gpu/native/flic-official.patch",
    "workers/video-gpu/native/native-cache.py",
    "workers/video-gpu/native/native-inventory.cjs",
    "workers/video-gpu/native/pinned-fetch.py",
    "workers/video-gpu/native/runtime-closure.cjs",
    "workers/video-gpu/native/source-lock.json",
    "workers/video-gpu/native/vendor-dependencies.sh",
    "workers/video-gpu/native/vendor-dependency-lock.json",
    "workers/video-gpu/native/zlib-official.patch",
    "workers/video-gpu/native/swscale-test-config.patch",
)


def run(args, **kwargs):
    return subprocess.run(args, check=True, text=True, capture_output=True, **kwargs).stdout.strip()


def prepare_context(root, commit, destination):
    resolved = run(["git", "rev-parse", "--verify", f"{commit}^{{commit}}"], cwd=root)
    if not re.fullmatch(r"[a-f0-9]{40}", resolved):
        raise ValueError("Expected exact Git commit")
    destination.mkdir(parents=True, exist_ok=False)
    with tempfile.TemporaryDirectory() as temp:
        archive = pathlib.Path(temp) / "source.tar"
        run(
            [
                "git",
                "archive",
                "--format=tar",
                "--output",
                str(archive),
                resolved,
                "--",
                *SOURCE_FILES,
            ],
            cwd=root,
        )
        with tarfile.open(archive) as bundle:
            for member in bundle.getmembers():
                if not member.isdir() and (not member.isfile() or member.name not in SOURCE_FILES):
                    raise ValueError("Unexpected worker build input")
            bundle.extractall(destination, filter="data")
    for name in SOURCE_FILES:
        if not (destination / name).is_file():
            raise ValueError(f"Missing committed worker build input: {name}")
    return resolved


def build_image(root, commit, image):
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._/:@-]*", image):
        raise ValueError("Invalid image reference")
    with tempfile.TemporaryDirectory(prefix="stillmark-video-source-") as temp:
        context = pathlib.Path(temp) / "source"
        resolved = prepare_context(root, commit, context)
        subprocess.run(
            [
                "docker",
                "buildx",
                "build",
                "--platform",
                "linux/amd64",
                "--load",
                "--build-arg",
                f"SOURCE_COMMIT={resolved}",
                "-f",
                str(context / "workers/video-gpu/Dockerfile"),
                "-t",
                image,
                str(context),
            ],
            check=True,
        )
        # Verify immutable local image ID so a tag cannot change between inspect and test.
        inspection = json.loads(run(["docker", "image", "inspect", image]))[0]
        if inspection["Config"]["Labels"].get("org.opencontainers.image.revision") != resolved:
            raise ValueError("Worker image revision label mismatch")
        verified = json.loads(
            run(
                [
                    "docker",
                    "run",
                    "--rm",
                    "--platform",
                    "linux/amd64",
                    "--network",
                    "none",
                    "--read-only",
                    "--entrypoint",
                    "/usr/local/bin/node",
                    inspection["Id"],
                    "/worker/verify-build.mjs",
                    resolved,
                ]
            )
        )
        scan_image(
            inspection["Id"],
            root / ".release" / "video-security" / inspection["Id"].split(":")[1],
            require_native=True,
            review_scope="video-gpu",
        )
        return {"image": image, "imageId": inspection["Id"], **verified}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--commit", required=True, help="Committed source revision to build")
    parser.add_argument("--image", required=True, help="New version tag; no push is performed")
    args = parser.parse_args()
    root = pathlib.Path(__file__).resolve().parents[2]
    print(json.dumps(build_image(root, args.commit, args.image), indent=2))


if __name__ == "__main__":
    main()
