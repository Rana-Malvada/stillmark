"""Worker unit tests: python3 -m unittest discover -s workers/face-cpu -p 'test_*.py'"""

from __future__ import annotations

import io
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import numpy as np
from PIL import Image

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import cluster  # noqa: E402
import faces  # noqa: E402

MODELS = Path(os.environ.get("MODEL_DIR", HERE / "models"))
SAMPLE = os.environ.get("FACE_SAMPLE_IMAGE")


def jpeg(width: int, height: int, orientation: int | None = None) -> bytes:
    image = Image.new("RGB", (width, height), (10, 20, 30))
    image.paste((250, 0, 0), (0, 0, width // 4, height // 4))  # Marks the top-left corner.
    buffer = io.BytesIO()
    exif = Image.Exif()
    if orientation:
        exif[0x0112] = orientation
    exif[0x8827] = 100  # Unrelated tag that must never be copied into crops.
    image.save(buffer, "JPEG", exif=exif.tobytes(), quality=95)
    return buffer.getvalue()


class DecodeTests(unittest.TestCase):
    def test_applies_exif_orientation(self):
        upright = faces.decode(jpeg(400, 200))
        rotated = faces.decode(jpeg(400, 200, orientation=6))
        self.assertEqual(upright.shape[:2], (200, 400))
        self.assertEqual(rotated.shape[:2], (400, 200))
        # Orientation 6 rotates 90 degrees clockwise: the red corner moves top-right.
        self.assertGreater(rotated[5, -5, 2], 200)
        self.assertLess(rotated[5, 5, 2], 50)

    def test_refuses_oversized_images_before_decoding(self):
        with mock.patch.object(faces, "MAX_PIXELS", 1000):
            with self.assertRaisesRegex(ValueError, "pixel limit"):
                faces.decode(jpeg(100, 100))

    def test_rejects_non_images(self):
        with self.assertRaises(Exception):
            faces.decode(b"not an image")


class CropTests(unittest.TestCase):
    def test_crop_is_square_webp_without_metadata(self):
        image = faces.decode(jpeg(800, 600))
        row = np.zeros(15, np.float32)
        row[:4] = [700, 500, 120, 120]  # Near the corner: must clamp, not fail.
        data = faces.crop(image, row)
        with Image.open(io.BytesIO(data)) as out:
            self.assertEqual(out.format, "WEBP")
            self.assertEqual(out.size, (faces.CROP_EDGE, faces.CROP_EDGE))
            self.assertEqual(len(out.getexif()), 0)


class TiledDetectionTests(unittest.TestCase):
    def test_tile_translation_preserves_face_size_and_score(self):
        image = np.zeros((2400, 3200, 3), np.uint8)
        row = np.array(
            [100, 150, 60, 80, 115, 170, 145, 170, 130, 190, 120, 210, 140, 210, 0.95],
            np.float32,
        )
        # No full-image detection; only a tile offset on both axes finds a face.
        target = (faces._tiles(3200)[1], faces._tiles(2400)[1])
        detections = [np.zeros((0, 15), np.float32)]
        for y in faces._tiles(2400):
            for x in faces._tiles(3200):
                detections.append(
                    row[None].copy() if (x, y) == target else np.zeros((0, 15), np.float32)
                )
        with mock.patch.object(faces, "_detect", side_effect=detections):
            found = faces.detect_faces(None, image)
        self.assertEqual(found.shape, (1, 15))
        np.testing.assert_allclose(found[0, :2], row[:2] + target)
        np.testing.assert_allclose(found[0, 2:4], [60, 80])
        np.testing.assert_allclose(
            found[0, 4:14].reshape(5, 2), row[4:14].reshape(5, 2) + target
        )
        self.assertEqual(found[0, 14], row[14])


class QualityTests(unittest.TestCase):
    def landmarks(self, side: float, nose_offset: float, score: float) -> np.ndarray:
        row = np.zeros(15, np.float32)
        row[:4] = [0, 0, side, side]
        row[4:6], row[6:8] = [30, 40], [70, 40]
        row[8:10] = [50 + nose_offset, 60]
        row[14] = score
        return row

    def test_frontal_sharp_large_face_is_a_reference(self):
        sharp = np.random.default_rng(1).integers(0, 255, (112, 112, 3), dtype=np.uint8)
        quality, ok = faces.assess(self.landmarks(150, 0, 0.95), sharp)
        self.assertTrue(ok)
        self.assertGreater(quality, 0.8)

    def test_small_blurry_turned_or_uncertain_faces_are_not_references(self):
        sharp = np.random.default_rng(1).integers(0, 255, (112, 112, 3), dtype=np.uint8)
        blurry = np.full((112, 112, 3), 128, np.uint8)
        for row, image in [
            (self.landmarks(40, 0, 0.95), sharp),
            (self.landmarks(150, 0, 0.95), blurry),
            (self.landmarks(150, 25, 0.95), sharp),
            (self.landmarks(150, 0, 0.7), sharp),
        ]:
            self.assertFalse(faces.assess(row, image)[1])


class SuppressionTests(unittest.TestCase):
    def row(self, x, y, w, h, score):
        r = np.zeros(15, np.float32)
        r[:4], r[14] = [x, y, w, h], score
        return r

    def test_keeps_the_best_box_and_drops_contained_or_overlapping_duplicates(self):
        found = np.array(
            [
                self.row(100, 100, 200, 200, 0.95),  # Full face.
                self.row(150, 150, 80, 80, 0.80),  # Partial detection inside it.
                self.row(110, 105, 195, 200, 0.90),  # Near-identical box.
                self.row(600, 100, 200, 200, 0.85),  # Different person.
            ]
        )
        kept = faces._suppress(found)
        self.assertEqual(sorted(kept[:, 0].tolist()), [100.0, 600.0])
        self.assertAlmostEqual(float(kept[kept[:, 0] == 100][0, 14]), 0.95, places=5)

    def test_keeps_adjacent_faces_in_a_group_photo(self):
        found = np.array([self.row(x, 100, 90, 90, 0.9) for x in (0, 80, 160)])
        self.assertEqual(len(faces._suppress(found)), 3)


class PathTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        (root / "in" / "originals").mkdir(parents=True)
        (root / "out").mkdir()
        os.environ["WORKER_INPUT"] = str(root / "in")
        os.environ["WORKER_OUTPUT"] = str(root / "out")
        sys.modules.pop("worker", None)
        import worker

        self.worker = worker

    def tearDown(self):
        self.tmp.cleanup()
        for name in ("WORKER_INPUT", "WORKER_OUTPUT"):
            os.environ.pop(name, None)

    def test_rejects_paths_outside_the_originals_mount(self):
        for path in ["../secrets/PG_SECRET/password", "/etc/passwd", "", "originals/../../x"]:
            with self.assertRaises(ValueError, msg=path):
                self.worker.source_file(path)
        self.assertTrue(str(self.worker.source_file("originals/a.jpg")).endswith("originals/a.jpg"))

    def test_writes_crops_once_under_the_faces_prefix(self):
        path = self.worker.write_crop(b"webp")
        self.assertTrue(path.startswith("faces/") and path.endswith(".webp"))
        files = sorted(p.name for p in self.worker.OUTPUT.iterdir())
        self.assertEqual(files, [path.removeprefix("faces/")])

    def test_output_check_passes_when_writable_and_fails_fast_when_not(self):
        self.worker.check_output()
        self.assertEqual(list(self.worker.OUTPUT.iterdir()), [])
        self.worker.OUTPUT.chmod(0o500)
        try:
            with self.assertRaises(PermissionError):
                self.worker.check_output()
        finally:
            self.worker.OUTPUT.chmod(0o700)

    def test_settings_are_bounded(self):
        with mock.patch.dict(os.environ, {"MATCH_AUTO": "1.5"}):
            with self.assertRaises(SystemExit):
                self.worker.setting("MATCH_AUTO", "0.6", 0.2, 0.99)


@unittest.skipUnless((MODELS / "face_detection_yunet_2023mar.onnx").exists(), "models are in the image")
class ParallelAnalysisTests(unittest.TestCase):
    """The parallel path must equal the serial path and never fail a whole batch."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        (root / "in").mkdir()
        (root / "out").mkdir()
        os.environ["WORKER_INPUT"] = str(root / "in")
        os.environ["WORKER_OUTPUT"] = str(root / "out")
        import importlib

        import worker

        self.worker = importlib.reload(worker)
        self.paths = (
            str(MODELS / "face_detection_yunet_2023mar.onnx"),
            str(MODELS / "face_recognition_sface_2021dec.onnx"),
        )
        self.models = faces.Models(*self.paths)
        source = Path(SAMPLE).read_bytes() if SAMPLE else jpeg(640, 480)
        for name in ("a.jpg", "b.jpg", "c.jpg"):
            (root / "in" / name).write_bytes(source)
        (root / "in" / "broken.jpg").write_bytes(b"not an image")

    def tearDown(self):
        self.tmp.cleanup()
        for name in ("WORKER_INPUT", "WORKER_OUTPUT", "WORKER_PARALLEL"):
            os.environ.pop(name, None)

    def job(self, parallel: str):
        with mock.patch.dict(os.environ, {"WORKER_PARALLEL": parallel}):
            return self.worker.Job(None, self.models, "00000000-0000-4000-8000-000000000000", self.paths)

    def test_parallel_matches_serial_and_isolates_bad_photos(self):
        paths = ["a.jpg", "broken.jpg", "../escape.jpg", "b.jpg", "c.jpg"]
        serial_job = self.job("1")
        try:
            serial = serial_job.analyze_many(paths)
        finally:
            serial_job.close()
        job = self.job("3")
        try:
            parallel = job.analyze_many(paths)
        finally:
            job.close()
        self.assertIsInstance(parallel[1], Exception)
        self.assertIsInstance(parallel[2], ValueError)  # Outside the originals mount.
        for i in (0, 3, 4):
            self.assertNotIsInstance(parallel[i], Exception)
            self.assertEqual(
                [(f.index, round(f.x, 4), round(f.y, 4)) for f in parallel[i]],
                [(f.index, round(f.x, 4), round(f.y, 4)) for f in serial[i]],
            )
            for a, b in zip(parallel[i], serial[i]):
                self.assertGreater(float(np.dot(a.embedding, b.embedding)), 0.999)

    def test_batch_keeps_every_process_busy_and_is_bounded(self):
        self.assertEqual(self.job("26").batch, 52)
        self.assertEqual(self.job("1").batch, 16)
        with mock.patch.dict(os.environ, {"WORKER_PARALLEL": "65"}):
            with self.assertRaises(SystemExit):
                self.worker.Job(None, self.models, "00000000-0000-4000-8000-000000000000", self.paths)

    def test_a_crashed_process_fails_only_its_batch_and_the_pool_recovers(self):
        job = self.job("2")
        try:
            job.analyze_many(["a.jpg"])
            for process in list(job.pool.processes):
                process.kill()
                process.wait(timeout=5)
            # A dead idle child is replaced before its next request. In-flight
            # hangs are separately covered by test_inference_liveness.
            import time
            time.sleep(.2)
            recovered = job.analyze_many(["a.jpg", "b.jpg"])
            self.assertFalse(any(isinstance(r, Exception) for r in recovered))
        finally:
            job.close()


class ClusterTests(unittest.TestCase):
    def people(self, centers: int, per: int, spread: float, seed: int = 7) -> np.ndarray:
        rng = np.random.default_rng(seed)
        base = rng.normal(size=(centers, 128))
        rows = [c + rng.normal(scale=spread, size=(per, 128)) for c in base]
        return np.vstack(rows).astype(np.float32)

    def test_separates_distinct_people(self):
        vectors = self.people(3, 4, 0.3)
        groups = cluster.cluster(vectors, 0.6)
        self.assertEqual(sorted(map(sorted, groups)), [[0, 1, 2, 3], [4, 5, 6, 7], [8, 9, 10, 11]])

    def test_does_not_chain_through_an_in_between_face(self):
        a, b = np.zeros(128, np.float32), np.zeros(128, np.float32)
        a[0], b[1] = 1, 1
        bridge = (a + b) / np.sqrt(2)
        vectors = np.vstack([a, a * 0.99 + 0.01, bridge, b * 0.99 + 0.01, b])
        groups = cluster.cluster(vectors, 0.75)
        self.assertTrue(all(not ({0, 1} & set(g) and {3, 4} & set(g)) for g in groups))

    def test_leaves_singletons_unassigned_and_bounds_work(self):
        self.assertEqual(cluster.cluster(self.people(4, 1, 0.1), 0.6), [])
        with mock.patch.object(cluster, "MAX_FACES", 3):
            with self.assertRaises(ValueError):
                cluster.cluster(self.people(1, 4, 0.1), 0.6)

    def test_cohesion_scores_each_member(self):
        vectors = self.people(1, 3, 0.05)
        scores = cluster.cohesion(vectors, [0, 1, 2])
        self.assertEqual(len(scores), 3)
        self.assertTrue(all(0.9 < s <= 1 for s in scores))


class MergeTests(unittest.TestCase):
    """One person photographed in two 'eras' (a drift in appearance) plus a stranger."""

    def setUp(self):
        rng = np.random.default_rng(3)
        self.base = rng.normal(size=128)
        drift = rng.normal(size=128) * 0.9
        stranger = rng.normal(size=128)
        noise = lambda c, n: (c + rng.normal(scale=0.35, size=(n, 128))).astype(np.float32)
        self.early = noise(self.base, 6)
        self.late = noise(self.base + drift, 5)
        self.mixed = np.vstack([noise(self.base, 2), noise(self.base + drift, 2)])
        self.stranger = noise(stranger, 6)

    def test_closest_link_separates_a_drifted_same_person_from_a_stranger(self):
        bridge = cluster.closest_link(self.early, self.mixed)
        stranger = cluster.closest_link(self.early, self.stranger)
        self.assertGreater(bridge, stranger + 0.2)

    def test_merges_same_person_groups_and_keeps_the_stranger_apart(self):
        merged = cluster.merge_groups([self.early, self.late, self.mixed, self.stranger], 0.48)
        self.assertEqual(merged, [[0, 1, 2]])

    def test_merges_nothing_when_threshold_is_unreachable(self):
        self.assertEqual(cluster.merge_groups([self.early, self.stranger], 0.99), [])

    def test_bounds_work(self):
        with mock.patch.object(cluster, "MAX_FACES", 5):
            with self.assertRaises(ValueError):
                cluster.merge_groups([self.early, self.late], 0.48)


@unittest.skipUnless(
    (MODELS / "face_detection_yunet_2023mar.onnx").exists() and SAMPLE, "models or sample missing"
)
class ModelTests(unittest.TestCase):
    def test_detects_and_embeds_a_face_consistently_under_rotation(self):
        models = faces.Models(
            str(MODELS / "face_detection_yunet_2023mar.onnx"),
            str(MODELS / "face_recognition_sface_2021dec.onnx"),
        )
        data = Path(SAMPLE).read_bytes()
        found = faces.analyze(models, data)
        self.assertGreaterEqual(len(found), 1)
        first = found[0]
        self.assertEqual(len(first.embedding), 128)
        self.assertAlmostEqual(float(np.linalg.norm(first.embedding)), 1.0, places=3)
        self.assertTrue(0 <= first.x < 1 and 0 < first.w <= 1)
        with Image.open(io.BytesIO(data)) as image:
            buffer = io.BytesIO()
            exif = Image.Exif()
            exif[0x0112] = 8
            image.rotate(-90, expand=True).save(buffer, "JPEG", exif=exif.tobytes(), quality=95)
        rotated = faces.analyze(models, buffer.getvalue())
        self.assertGreaterEqual(len(rotated), 1)
        similarity = float(np.dot(first.embedding, rotated[0].embedding))
        self.assertGreater(similarity, 0.8)


if __name__ == "__main__":
    unittest.main()
