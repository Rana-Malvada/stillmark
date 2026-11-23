import glob
import tempfile
import time
import unittest

import numpy as np

from cluster import cluster, ClusteringInterrupted


def reference(embeddings, threshold):
    # Original average-link algorithm, retained only as a small correctness oracle.
    n = len(embeddings)
    unit = embeddings / np.linalg.norm(embeddings, axis=1, keepdims=True)
    links = (unit @ unit.T).astype(np.float64)
    np.fill_diagonal(links, -np.inf)
    groups = {i: [i] for i in range(n)}
    active = np.ones(n, bool)
    while len(groups) > 1:
        sizes = np.array([len(groups[i]) if active[i] else 1 for i in range(n)])
        scores = links / np.outer(sizes, sizes)
        scores[~active, :] = -np.inf
        scores[:, ~active] = -np.inf
        a, b = np.unravel_index(np.argmax(scores), scores.shape)
        if not np.isfinite(scores[a, b]) or scores[a, b] < threshold:
            break
        a, b = sorted((a, b))
        groups[a] += groups.pop(b)
        links[a, :] += links[b, :]
        links[:, a] += links[:, b]
        links[a, a] = -np.inf
        active[b] = False
        links[b, :] = -np.inf
        links[:, b] = -np.inf
    return sorted((sorted(g) for g in groups.values() if len(g) > 1), key=lambda g: (-len(g), g[0]))


class ClusterDeadlineTests(unittest.TestCase):
    def test_preserves_average_linkage_and_tie_order(self):
        rng = np.random.default_rng(37)
        for n in [2, 8, 67, 135]:
            embeddings = rng.normal(size=(n, 12)).astype("f")
            for threshold in [0.25, 0.6, 0.9]:
                self.assertEqual(cluster(embeddings, threshold), reference(embeddings, threshold))
        identical = np.tile([1.0, 0.0], (70, 1)).astype("f")
        self.assertEqual(cluster(identical, 0.8), reference(identical, 0.8))

    def test_stop_interrupts_between_blocks_and_removes_scratch(self):
        calls = [0]

        def heartbeat():
            calls[0] += 1
            return calls[0] < 4

        before = set(glob.glob(tempfile.gettempdir() + "/face-cluster-*"))
        with self.assertRaises(ClusteringInterrupted):
            cluster(np.ones((5000, 8), "f"), 0.8, heartbeat=heartbeat)
        self.assertEqual(calls[0], 4)
        self.assertEqual(set(glob.glob(tempfile.gettempdir() + "/face-cluster-*")), before)

    def test_deadline_interrupts_without_returning_partial_groups(self):
        with self.assertRaises(ClusteringInterrupted):
            cluster(np.ones((100, 8), "f"), 0.8, deadline=time.monotonic() - 1)
        with self.assertRaises(ValueError):
            cluster(np.ones((5001, 8), "f"), 0.8)


if __name__ == "__main__":
    unittest.main()
