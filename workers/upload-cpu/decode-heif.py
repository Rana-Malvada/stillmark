"""Decode the primary HEIF image for web renditions; never rewrite the original."""
import json
import resource
import sys

from PIL import Image
from image_decode import decode_image


def decode(source, destination):
    image, dimensions = decode_image(source, required_format="HEIF")
    try:
        image.save(destination, "PNG")
    finally:
        image.close()
    return dimensions


if __name__ == "__main__":
    # Per-invocation limits belong to this subprocess, not long-lived ML workers.
    resource.setrlimit(resource.RLIMIT_CPU, (55, 55))
    resource.setrlimit(resource.RLIMIT_FSIZE, (64 * 1024 * 1024, 64 * 1024 * 1024))
    if sys.platform == "linux":
        resource.setrlimit(resource.RLIMIT_AS, (2 * 1024**3, 2 * 1024**3))
    try:
        result = decode(sys.argv[1], sys.argv[2])
    except (ValueError, OSError, SyntaxError, EOFError, Image.DecompressionBombWarning, Image.DecompressionBombError):
        print("Invalid or unsupported HEIF image", file=sys.stderr)
        sys.exit(2)
    print(json.dumps(result))
