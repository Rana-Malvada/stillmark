import itertools
import tempfile
import time
import unittest
from unittest.mock import patch

import numpy as np

import bounded_merge as merging
from cluster import ClosestLinkScan, closest_link


class Rows:
    def __init__(self, rows):
        self.rows = rows

    def fetchone(self):
        return self.rows[0]

    def fetchall(self):
        return self.rows


class Database:
    def __init__(self, groups, threshold=0.8):
        self.groups = groups.copy()
        self.generation = 1
        self.threshold = threshold
        self.left = self.right = None
        self.best = None
        self.complete = False
        self.merges = []
        self.checkpoints = []
        self.max_page = 0
        self._pairs = list(itertools.combinations(sorted(groups), 2))
        self._positions = {p: i for i, p in enumerate(self._pairs)}
        self.mutated = False

    def execute(self, sql, args):
        if "merge_state" in sql:
            return Rows([(self.generation, self.left, self.right, self.complete)])
        if "merge_next_pair" in sql:
            cursor = (args[2], args[3])
            offset = self._positions[cursor] + 1 if cursor[0] is not None else 0
            return Rows(
                [
                    (a, b, len(self.groups[a]), len(self.groups[b]))
                    for a, b in self._pairs[offset : offset + 64]
                ]
            )
        if "merge_face_page" in sql:
            group, after, limit = self.groups[args[2]], args[3], args[4]
            rows = [(i + 1, row) for i, row in enumerate(group[after : after + limit], start=after)]
            self.max_page = max(self.max_page, len(rows))
            return Rows(rows)
        if "merge_checkpoint" in sql:
            _, _, generation, a, b, score = args
            if generation != self.generation:
                return Rows([(False,)])
            self.left, self.right = a, b
            self.checkpoints.append((a, b, score))
            if score >= self.threshold and (self.best is None or score >= self.best[0]):
                self.best = (score, a, b)
            return Rows([(True,)])
        if "merge_finish_pass" in sql:
            if args[2] != self.generation:
                return Rows([(-1,)])
            if self.best is None:
                self.complete = True
                return Rows([(0,)])
            _, a, b = self.best
            self.merges.append((a, b))
            self.groups[a] = np.concatenate((self.groups[a], self.groups.pop(b)))
            self.generation += 1
            self.left = self.right = self.best = None
            self._pairs = list(itertools.combinations(sorted(self.groups), 2))
            self._positions = {p: i for i, p in enumerate(self._pairs)}
            return Rows([(1,)])
        raise AssertionError(sql)


class BoundedMergeTests(unittest.TestCase):
    def tearDown(self):
        merging.clear_sessions()

    def test_block_score_is_exact_for_unequal_groups_and_small_k(self):
        rng = np.random.default_rng(73)
        for n, m in [(1, 2), (7, 11), (257, 522)]:
            a, b = rng.normal(size=(n, 12)).astype("f"), rng.normal(size=(m, 12)).astype("f")
            expected = closest_link(a, b)
            a /= np.linalg.norm(a, axis=1, keepdims=True)
            b /= np.linalg.norm(b, axis=1, keepdims=True)
            with tempfile.TemporaryDirectory() as root:
                scan = ClosestLinkScan(a, b, root, block_size=31)
                while not scan.step():
                    pass
                self.assertAlmostEqual(scan.score, expected, places=6)
                self.assertLessEqual(scan.top_a.shape[1], 3)
                scan.close()

    def test_more_than_5000_faces_including_all_faces(self):
        # A small tail changes the expected score: dropping after 5000 is invalid.
        a = np.tile([1.0, 0.0], (5001, 1)).astype("f")
        a[-2501:] = [0.0, 1.0]
        b = np.tile([1.0, 0.0], (1, 1)).astype("f")
        db = Database({"a": a, "b": b}, threshold=0.8)
        merging.merge_unnamed(db, "owner", "model", 0.8, time.monotonic() + 20)
        self.assertTrue(db.complete)
        self.assertEqual(db.merges, [])
        self.assertAlmostEqual(db.checkpoints[0][2], closest_link(a, b), places=6)
        self.assertLessEqual(db.max_page, 512)

    def test_time_slices_keep_incomplete_pair_and_restart_keeps_completed_pairs(self):
        rng = np.random.default_rng(9)
        db = Database(
            {str(i): rng.normal(size=(270, 8)).astype("f") for i in range(3)}, threshold=2
        )
        for _ in range(1000):
            remaining = [5]

            def heartbeat():
                remaining[0] -= 1
                return remaining[0] > 0

            merging.merge_unnamed(db, "owner", "model", 2, time.monotonic() + 5, heartbeat)
            if db.checkpoints:
                merging.clear_sessions()  # simulate worker restart
                break
        completed = len(db.checkpoints)
        self.assertEqual(completed, 1)
        merging.merge_unnamed(db, "owner", "model", 2, time.monotonic() + 20)
        self.assertTrue(db.complete)
        self.assertEqual(len(db.checkpoints), 3)
        # A finished pass only reads its small state, never downloads a face again.
        with patch.object(db, "execute", wraps=db.execute) as execute:
            merging.merge_unnamed(db, "owner", "model", 2, time.monotonic() + 1)
            self.assertEqual(execute.call_count, 1)

    def test_highest_score_pair_wins_not_first_eligible_pair(self):
        # a/b are above threshold, b/c are stronger. Global pass must choose b/c.
        groups = {
            "a": np.array([[1.0, 0.0]], "f"),
            "b": np.array([[0.9, 0.43589]], "f"),
            "c": np.array([[0.85, 0.52678]], "f"),
        }
        db = Database(groups)
        merging.merge_unnamed(db, "owner", "model", 0.8, time.monotonic() + 10)
        self.assertEqual(db.merges[0], ("b", "c"))

    def test_generation_change_discards_scores_before_merge(self):
        db = Database({"a": np.array([[1.0, 0.0]], "f"), "b": np.array([[1.0, 0.0]], "f")})
        original = db.execute
        changed = [False]

        def execute(sql, args):
            if "merge_checkpoint" in sql and not changed[0]:
                changed[0] = True
                db.generation += 1
                db.groups["b"][:] = [0.0, 1.0]
            return original(sql, args)

        db.execute = execute
        merging.merge_unnamed(db, "owner", "model", 0.8, time.monotonic() + 10)
        self.assertEqual(db.merges, [])
        self.assertTrue(db.complete)

    def test_more_than_501_groups_reaches_last_pair_without_absorb_limit(self):
        db = Database({i: np.array([[1.0, 0.0]], "f") for i in range(503)})

        class CheapPair:
            def __init__(self, a, b, *counts):
                self.ids = (a, b)
                # The only match is beyond the old 500 group boundary.
                self.score = 1 if (a, b) == (501, 502) and not db.merges else 0
                self.scan = self

            def step(self, *_):
                return True

            def close(self):
                pass

        with patch.object(merging, "_Pair", CheapPair):
            merging.merge_unnamed(db, "owner", "model", 0.8, time.monotonic() + 20)
        self.assertTrue(db.complete)
        self.assertEqual(db.merges, [(501, 502)])
        self.assertEqual(len(db.groups), 502)
        self.assertGreater(len(db.checkpoints), 125000)


if __name__ == "__main__":
    unittest.main()
