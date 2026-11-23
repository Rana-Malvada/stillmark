"""Publication failure tests without model, NumPy, or database dependencies.

Only inference imports are stubbed. Tests execute the real Job.publish and crop
writer against a database double that can lose a committed response.
"""

import importlib.util
import json
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch


def load_worker():
    cluster = types.ModuleType("cluster")
    cluster.MAX_FACES = 100
    cluster.ClusteringInterrupted = type('ClusteringInterrupted',(Exception,),{})
    for name in ("cluster", "cohesion", "merge_groups"):
        setattr(cluster, name, None)
    faces = types.ModuleType("faces")
    faces.MODEL_VERSION = "test-model"
    for name in ("Face", "Models", "analyze"):
        setattr(faces, name, None)
    merge = types.ModuleType("bounded_merge")
    merge.merge_unnamed = lambda *args: 0
    merge.has_pending = lambda *args: False
    merge.clear_sessions = lambda: None
    spec = importlib.util.spec_from_file_location(
        "publication_test_worker", Path(__file__).with_name("worker.py")
    )
    module = importlib.util.module_from_spec(spec)
    with patch.dict(
        sys.modules,
        {
            "numpy": types.ModuleType("numpy"),
            "psycopg": types.ModuleType("psycopg"),
            "cluster": cluster,
            "faces": faces,
            "bounded_merge": merge,
        },
    ):
        spec.loader.exec_module(module)
    return module


class Database:
    def __init__(self, output, failure=None):
        self.output, self.failure = output, failure
        self.reserved, self.published = set(), []
        self.calls = []

    def execute(self, sql, args):
        self.calls.append(sql)
        if "reserve_crops" in sql:
            if self.failure == "reservation":
                raise ConnectionError("reservation unavailable")
            self.reserved.update(args[2])
            if self.failure == "reservation_lost_ack":
                raise ConnectionError("reservation committed but response was lost")
            return self
        if "face_worker.publish" not in sql:
            raise AssertionError(sql)
        payload = json.loads(args[-1])
        for item in payload:
            if item["crop_path"] not in self.reserved:
                raise AssertionError("crop was written without durable cleanup")
            if not (self.output / item["crop_path"].removeprefix("faces/")).exists():
                raise AssertionError("publication preceded crop write")
        if self.failure in ("before_execution", "stale_claim"):
            raise ConnectionError(self.failure)
        self.published = payload
        if self.failure == "lost_ack":
            raise ConnectionError("commit succeeded but response was lost")
        return self

    def fetchone(self):
        return (len(self.published),)


class PublicationTests(unittest.TestCase):
    def setUp(self):
        self.worker = load_worker()
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.output = Path(self.temp.name)
        self.worker.OUTPUT = self.output
        self.face = types.SimpleNamespace(
            crop_webp=b"webp",
            index=0,
            x=0.1,
            y=0.1,
            w=0.2,
            h=0.2,
            score=0.9,
            quality=0.9,
            quality_ok=True,
            embedding=[1, 0, 0],
        )

    def publish(self, db, found=None):
        job = object.__new__(self.worker.Job)
        job.db = db
        return job.publish(1, "originals/a.jpg", "claim", [self.face] if found is None else found)

    def test_reservation_failure_writes_no_crops(self):
        for failure in ("reservation", "reservation_lost_ack"):
            with self.subTest(failure=failure):
                db = Database(self.output, failure)
                with self.assertRaises(ConnectionError):
                    self.publish(db)
                self.assertEqual(list(self.output.iterdir()), [])
                self.assertFalse(db.published)

    def test_lost_commit_acknowledgment_preserves_published_crops(self):
        db = Database(self.output, "lost_ack")
        with self.assertRaises(ConnectionError):
            self.publish(db)
        self.assertEqual(len(db.published), 1)
        path = db.published[0]["crop_path"]
        self.assertIn(path, db.reserved)
        self.assertEqual((self.output / path.removeprefix("faces/")).read_bytes(), b"webp")

    def test_failed_or_stale_publication_keeps_durable_orphan_cleanup(self):
        for failure in ("before_execution", "stale_claim"):
            with self.subTest(failure=failure):
                db = Database(self.output, failure)
                with self.assertRaises(ConnectionError):
                    self.publish(db)
                self.assertEqual(len(db.reserved), 1)
                self.assertFalse(db.published)
                path = next(iter(db.reserved))
                self.assertTrue((self.output / path.removeprefix("faces/")).exists())

    def test_success_reserves_before_writing_and_publishes_once(self):
        db = Database(self.output)
        original_write = self.worker.write_crop

        def write(data, *args):
            self.assertEqual(len(db.reserved), 1)
            return original_write(data, *args)

        with patch.object(self.worker, "write_crop", write):
            self.assertEqual(self.publish(db), 1)
        self.assertEqual(len(db.calls), 2)
        self.assertEqual(len(db.published), 1)

    def test_empty_result_still_publishes_without_creating_files(self):
        db = Database(self.output)
        self.assertEqual(self.publish(db, []), 0)
        self.assertEqual(list(self.output.iterdir()), [])

    def test_write_failure_keeps_all_paths_reserved_without_publication(self):
        db = Database(self.output)
        original_write = self.worker.write_crop
        calls = 0

        def write(data, *args):
            nonlocal calls
            calls += 1
            if calls == 2:
                raise OSError("storage write failed")
            return original_write(data, *args)

        with patch.object(self.worker, "write_crop", write):
            with self.assertRaises(OSError):
                self.publish(db, [self.face, self.face])
        self.assertEqual(len(db.reserved), 2)
        self.assertEqual(len(list(self.output.iterdir())), 1)
        self.assertFalse(db.published)

    def test_retry_uses_new_paths_and_preserves_the_first_cleanup_intent(self):
        db = Database(self.output, "before_execution")
        with self.assertRaises(ConnectionError):
            self.publish(db)
        abandoned = set(db.reserved)
        db.failure = None
        self.assertEqual(self.publish(db), 1)
        self.assertEqual(len(db.reserved), 2)
        self.assertNotIn(db.published[0]["crop_path"], abandoned)


if __name__ == "__main__":
    unittest.main()
