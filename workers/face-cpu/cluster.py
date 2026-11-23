"""Conservative grouping of unassigned faces into unnamed people.

Average-linkage agglomerative clustering on cosine similarity. Two clusters merge
only while their mean pairwise similarity stays at or above the threshold, which
avoids the chaining that single-linkage causes between look-alike strangers.
"""

from __future__ import annotations

import numpy as np

MAX_FACES = 5000  # Bounded O(n^2) work per owner per run.


class ClusteringInterrupted(RuntimeError):
    """No partial clustering result is published after Stop or a worker deadline."""


def cluster(
    embeddings: np.ndarray, threshold: float, min_size: int = 2, *, deadline=None, heartbeat=None
) -> list[list[int]]:
    """Average-linkage groups, with bounded scratch space and interruptible work.

    The largest linkage table is disk backed. Only a small block of candidate
    scores exists in RAM; unlike the original implementation this never allocates
    a second n-by-n mean/denominator matrix on every merge.
    """
    import tempfile
    import time

    n = len(embeddings)
    if n > MAX_FACES:
        raise ValueError("too many faces for one grouping pass")
    if n < min_size:
        return []

    def check():
        if (deadline is not None and time.monotonic() >= deadline) or (
            heartbeat is not None and not heartbeat()
        ):
            raise ClusteringInterrupted("face grouping paused")

    check()
    unit = embeddings / np.linalg.norm(embeddings, axis=1, keepdims=True)
    members = {i: [i] for i in range(n)}
    active = np.ones(n, bool)
    sizes = np.ones(n, np.float64)
    block = 64
    with tempfile.TemporaryDirectory(prefix="face-cluster-") as root:
        link = np.memmap(root + "/links", dtype=np.float64, mode="w+", shape=(n, n))
        try:
            for start in range(0, n, block):
                check()
                link[start : start + block] = unit[start : start + block] @ unit.T
            np.fill_diagonal(link, -np.inf)
            while len(members) > 1:
                best, pair = -np.inf, None
                for start in range(0, n, block):
                    check()
                    end = min(start + block, n)
                    mean = np.asarray(link[start:end]) / (sizes[start:end, None] * sizes[None, :])
                    mean[~active[start:end], :] = -np.inf
                    mean[:, ~active] = -np.inf
                    local = int(np.argmax(mean))
                    i, j = np.unravel_index(local, mean.shape)
                    score = mean[i, j]
                    # Strict greater-than retains the original row-major tie order.
                    if score > best:
                        best, pair = score, (start + i, j)
                if pair is None or not np.isfinite(best) or best < threshold:
                    break
                check()
                a, b = sorted(pair)
                members[a].extend(members.pop(b))
                sizes[a] += sizes[b]
                link[a, :] += link[b, :]
                link[:, a] += link[:, b]
                link[a, a] = -np.inf
                active[b] = False
                link[b, :] = -np.inf
                link[:, b] = -np.inf
            check()
            groups = [sorted(group) for group in members.values() if len(group) >= min_size]
            return sorted(groups, key=lambda group: (-len(group), group[0]))
        finally:
            link._mmap.close()


def cohesion(embeddings: np.ndarray, group: list[int]) -> list[float]:
    """Each member's mean similarity to the rest of its group (stored as the score)."""
    unit = embeddings[group] / np.linalg.norm(embeddings[group], axis=1, keepdims=True)
    sim = unit @ unit.T
    k = len(group)
    return [round(float((sim[i].sum() - 1.0) / (k - 1)), 4) for i in range(k)]


def closest_link(a: np.ndarray, b: np.ndarray, k: int = 3) -> float:
    """Group similarity as the matcher sees it: the median over all faces of their mean
    similarity to the k closest faces in the other group.

    Whole-group averages fail across age, lighting and angle; nearest references do not.
    """
    a = a / np.linalg.norm(a, axis=1, keepdims=True)
    b = b / np.linalg.norm(b, axis=1, keepdims=True)
    sim = a @ b.T
    from_a = np.sort(sim, axis=1)[:, -min(k, sim.shape[1]) :].mean(axis=1)
    from_b = np.sort(sim, axis=0)[-min(k, sim.shape[0]) :, :].mean(axis=0)
    return float(np.median(np.concatenate([from_a, from_b])))


def merge_groups(groups: list[np.ndarray], threshold: float) -> list[list[int]]:
    """Agglomerates groups whose closest-faces link stays at or above threshold.

    Links are recomputed on the merged members after every merge, which makes it much
    less likely that a chain of pairwise look-alikes joins two people. Returns sets of
    input indices with more than one member, largest first.
    """
    if sum(len(g) for g in groups) > MAX_FACES:
        raise ValueError("too many faces for one merge pass")
    members = {i: [i] for i in range(len(groups))}
    vectors = {i: g for i, g in enumerate(groups)}
    while len(members) > 1:
        keys = sorted(members)
        best, pair = threshold, None
        for x, i in enumerate(keys):
            for j in keys[x + 1 :]:
                link = closest_link(vectors[i], vectors[j])
                if link >= best:
                    best, pair = link, (i, j)
        if pair is None:
            break
        i, j = pair
        members[i] += members.pop(j)
        vectors[i] = np.vstack([vectors[i], vectors.pop(j)])
    merged = [sorted(m) for m in members.values() if len(m) > 1]
    return sorted(merged, key=lambda m: (-len(m), m[0]))


class ClosestLinkScan:
    """Exact closest-link score in bounded matrix blocks, resumable between blocks.

    Inputs are normalized, disk-backed complete groups. The per-face top-k values
    are disk-backed too; no owner-wide embeddings or quadratic matrix is retained.
    """

    def __init__(self, a, b, directory, block_size=256, k=3):
        from pathlib import Path

        if len(a) == 0 or len(b) == 0 or k < 1 or block_size < 1:
            raise ValueError("nonempty groups and positive scan limits required")
        self.a, self.b = a, b
        self.block_size = block_size
        self.ka, self.kb = min(k, len(b)), min(k, len(a))
        root = Path(directory)
        self.top_a = np.memmap(root / "top-a", mode="w+", dtype=np.float32, shape=(len(a), self.ka))
        self.top_b = np.memmap(root / "top-b", mode="w+", dtype=np.float32, shape=(len(b), self.kb))
        self.top_a[:] = -np.inf
        self.top_b[:] = -np.inf
        self.i = self.j = 0
        self.done = False
        self.score = None
        self.directory = root

    def step(self):
        """Process one bounded block; returns True only once the full score exists."""
        if self.done:
            return True
        i, j, size = self.i, self.j, self.block_size
        a, b = self.a[i : i + size], self.b[j : j + size]
        sim = a @ b.T
        old_a, old_b = self.top_a[i : i + len(a)], self.top_b[j : j + len(b)]
        old_a[:] = np.sort(np.concatenate((old_a, sim), axis=1), axis=1)[:, -self.ka :]
        old_b[:] = np.sort(np.concatenate((old_b, sim.T), axis=1), axis=1)[:, -self.kb :]
        self.j += len(b)
        if self.j >= len(self.b):
            self.j = 0
            self.i += len(a)
        if self.i < len(self.a):
            return False
        # Mean/median over every face, including groups larger than MAX_FACES.
        values = np.memmap(
            self.directory / "medians",
            mode="w+",
            dtype=np.float32,
            shape=(len(self.a) + len(self.b),),
        )
        for start in range(0, len(self.a), size):
            values[start : min(start + size, len(self.a))] = self.top_a[start : start + size].mean(
                axis=1
            )
        for start in range(0, len(self.b), size):
            values[len(self.a) + start : len(self.a) + start + min(size, len(self.b) - start)] = (
                self.top_b[start : start + size].mean(axis=1)
            )
        self.score = float(np.median(values, overwrite_input=True))
        values._mmap.close()
        self.done = True
        return True

    def close(self):
        self.top_a._mmap.close()
        self.top_b._mmap.close()
