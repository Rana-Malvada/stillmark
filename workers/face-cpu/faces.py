"""Face detection, quality assessment, alignment and embedding for one image.

Pure functions over decoded pixels; no database or storage access. Originals are
read-only inputs and are never modified.
"""

from __future__ import annotations

import io
from dataclasses import dataclass

import cv2
import numpy as np
from PIL import Image, ImageOps
from pillow_heif import register_heif_opener

register_heif_opener()

MODEL_VERSION = "yunet2023mar-sface2021dec"
WORKING_EDGE = 1600  # Long edge for the first detection pass.
SMALL_FACE_PX = 48  # Faces smaller than this at working size trigger a tiled pass.
TILE = 1280
TILE_OVERLAP = 192
MAX_PIXELS = 120_000_000  # Refuse decompression bombs before decoding.
MIN_FACE_PX = 24  # Minimum face side, in original pixels, to keep at all.
GOOD_FACE_PX = 64  # Minimum side to be eligible as a matching reference.
MIN_SHARPNESS = 40.0  # Laplacian variance on the aligned crop.
MIN_REFERENCE_SCORE = 0.85
MAX_YAW = 0.35  # Normalized nose offset from the eye midline.
CROP_EDGE = 160
CROP_MARGIN = 0.35


@dataclass(frozen=True)
class Face:
    index: int
    x: float
    y: float
    w: float
    h: float
    score: float
    quality: float
    quality_ok: bool
    embedding: list[float]
    crop_webp: bytes


class Models:
    """Loads the two ONNX models once per worker process."""

    def __init__(self, detector_path: str, recognizer_path: str):
        self.detector = cv2.FaceDetectorYN.create(detector_path, "", (320, 320), 0.75, 0.3, 5000)
        self.recognizer = cv2.FaceRecognizerSF.create(recognizer_path, "")


def decode(data: bytes) -> np.ndarray:
    """Decodes JPEG/PNG/HEIC/TIFF bytes to upright BGR, applying EXIF orientation."""
    with Image.open(io.BytesIO(data)) as probe:
        if probe.width * probe.height > MAX_PIXELS:
            raise ValueError("image exceeds pixel limit")
    with Image.open(io.BytesIO(data)) as image:
        image = ImageOps.exif_transpose(image)
        rgb = np.asarray(image.convert("RGB"))
    return cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR)


def _detect(models: Models, image: np.ndarray) -> np.ndarray:
    h, w = image.shape[:2]
    models.detector.setInputSize((w, h))
    _, found = models.detector.detect(image)
    return np.zeros((0, 15), np.float32) if found is None else found


def _scaled(image: np.ndarray, edge: int) -> tuple[np.ndarray, float]:
    h, w = image.shape[:2]
    scale = min(1.0, edge / max(h, w))
    if scale == 1.0:
        return image, 1.0
    return (
        cv2.resize(image, (round(w * scale), round(h * scale)), interpolation=cv2.INTER_AREA),
        scale,
    )


def _tiles(length: int) -> list[int]:
    if length <= TILE:
        return [0]
    step = TILE - TILE_OVERLAP
    starts = list(range(0, length - TILE, step))
    return starts + [length - TILE]


def _overlaps(a: np.ndarray, b: np.ndarray) -> bool:
    """True for near-duplicates: high IoU, or one box mostly inside the other."""
    ax2, ay2, bx2, by2 = a[0] + a[2], a[1] + a[3], b[0] + b[2], b[1] + b[3]
    iw = max(0.0, min(ax2, bx2) - max(a[0], b[0]))
    ih = max(0.0, min(ay2, by2) - max(a[1], b[1]))
    inter = iw * ih
    smaller = min(a[2] * a[3], b[2] * b[3])
    union = a[2] * a[3] + b[2] * b[3] - inter
    return union > 0 and (inter / union >= 0.4 or (smaller > 0 and inter / smaller > 0.5))


def _suppress(found: np.ndarray) -> np.ndarray:
    keep: list[np.ndarray] = []
    for row in found[np.argsort(-found[:, 14], kind="stable")]:
        if not any(_overlaps(row, k) for k in keep):
            keep.append(row)
    return np.array(keep, np.float32).reshape(-1, 15)


def detect_faces(models: Models, image: np.ndarray) -> np.ndarray:
    """Returns YuNet rows (box, five landmarks, score) in original pixel coordinates."""
    working, scale = _scaled(image, WORKING_EDGE)
    found = _detect(models, working)
    if len(found):
        found = found.copy()
        found[:, :14] /= scale
    small = len(found) == 0 or bool(
        np.any(np.minimum(found[:, 2], found[:, 3]) * scale < SMALL_FACE_PX)
    )
    if small and scale < 1.0:
        h, w = image.shape[:2]
        extra = []
        for y0 in _tiles(h):
            for x0 in _tiles(w):
                tile = np.ascontiguousarray(image[y0 : y0 + TILE, x0 : x0 + TILE])
                rows = _detect(models, tile)
                if len(rows):
                    rows = rows.copy()
                    # YuNet stores x, y, width, height, then five x/y landmarks.
                    # Translate positions only: dimensions are not coordinates.
                    rows[:, 0] += x0
                    rows[:, 1] += y0
                    rows[:, 4:14:2] += x0
                    rows[:, 5:14:2] += y0
                    extra.append(rows)
        if extra:
            found = np.vstack([found, *extra])
    found = _suppress(found)
    return found[np.minimum(found[:, 2], found[:, 3]) >= MIN_FACE_PX]


def yaw(row: np.ndarray) -> float:
    """Approximate head turn from landmarks: nose offset from the eye midline."""
    right_eye, left_eye, nose = row[4:6], row[6:8], row[8:10]
    eye_distance = float(np.linalg.norm(left_eye - right_eye))
    if eye_distance <= 0:
        return 1.0
    return abs(float(nose[0] - (right_eye[0] + left_eye[0]) / 2)) / eye_distance


def assess(row: np.ndarray, aligned: np.ndarray) -> tuple[float, bool]:
    """Scores 0..1 and decides whether the face may serve as a matching reference."""
    side = float(min(row[2], row[3]))
    score = float(row[14])
    sharpness = float(cv2.Laplacian(cv2.cvtColor(aligned, cv2.COLOR_BGR2GRAY), cv2.CV_64F).var())
    turn = yaw(row)
    quality = (
        0.35 * min(1.0, side / (2 * GOOD_FACE_PX))
        + 0.25 * min(1.0, sharpness / (3 * MIN_SHARPNESS))
        + 0.2 * max(0.0, 1.0 - turn / (2 * MAX_YAW))
        + 0.2 * score
    )
    ok = (
        side >= GOOD_FACE_PX
        and sharpness >= MIN_SHARPNESS
        and turn <= MAX_YAW
        and score >= MIN_REFERENCE_SCORE
    )
    return round(quality, 4), ok


def crop(image: np.ndarray, row: np.ndarray) -> bytes:
    """Square WebP thumbnail around the face with margin; metadata is not copied."""
    h, w = image.shape[:2]
    x, y, bw, bh = (float(v) for v in row[:4])
    side = max(bw, bh) * (1 + 2 * CROP_MARGIN)
    cx, cy = x + bw / 2, y + bh / 2
    x0, y0 = int(max(0, cx - side / 2)), int(max(0, cy - side / 2))
    x1, y1 = int(min(w, cx + side / 2)), int(min(h, cy + side / 2))
    region = cv2.resize(image[y0:y1, x0:x1], (CROP_EDGE, CROP_EDGE), interpolation=cv2.INTER_AREA)
    ok, encoded = cv2.imencode(".webp", region, [cv2.IMWRITE_WEBP_QUALITY, 82])
    if not ok:
        raise ValueError("crop encoding failed")
    return encoded.tobytes()


def analyze(models: Models, data: bytes) -> list[Face]:
    image = decode(data)
    h, w = image.shape[:2]
    faces: list[Face] = []
    rows = detect_faces(models, image)
    for index, row in enumerate(rows[np.lexsort((rows[:, 1], rows[:, 0]))]):
        aligned = models.recognizer.alignCrop(image, row)
        embedding = models.recognizer.feature(aligned).reshape(-1)
        norm = float(np.linalg.norm(embedding))
        if not np.isfinite(norm) or norm == 0:
            continue
        quality, ok = assess(row, aligned)
        x, y = max(0.0, float(row[0])), max(0.0, float(row[1]))
        bw = min(float(row[2]), w - x)
        bh = min(float(row[3]), h - y)
        if bw <= 0 or bh <= 0:
            continue
        faces.append(
            Face(
                index=index,
                x=round(x / w, 6),
                y=round(y / h, 6),
                w=round(bw / w, 6),
                h=round(bh / h, 6),
                score=round(float(row[14]), 4),
                quality=quality,
                quality_ok=ok,
                embedding=[round(float(v), 6) for v in embedding / norm],
                crop_webp=crop(image, row),
            )
        )
    return faces
