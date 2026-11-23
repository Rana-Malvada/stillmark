"""Durable, highest-score-first unnamed-group merging with bounded resident memory.

The database checkpoints completed pair scores and invalidates a pass after any
face/curation change. An unfinished pair retains its block cursor in this process;
a worker restart retries only that pair. Eligible groups are never truncated.
"""

from __future__ import annotations

from collections import OrderedDict
import tempfile
import time

import numpy as np

from cluster import ClosestLinkScan

PAGE_SIZE = 512
# Two owners at most retain unfinished pair work. Evicted work is safely replayed
# from the last database pair checkpoint. Each owner retains only its current pair.
_SESSIONS = OrderedDict()


class _Pair:
    def __init__(self, left, right, left_count, right_count):
        self.ids = (left, right)
        self.counts = (int(left_count), int(right_count))
        self.directory = tempfile.TemporaryDirectory(prefix="face-merge-")
        self.vectors = [None, None]
        self.offsets = [0, 0]
        self.cursors = [0, 0]
        self.scan = None

    def step(self, db, owner, model):
        """One page download or one score block, then yield to the worker heartbeat."""
        for side in (0, 1):
            if self.offsets[side] >= self.counts[side]:
                continue
            rows = db.execute(
                "SELECT face_id,embedding FROM face_worker.merge_face_page(%s::text,%s::text,%s::uuid,%s::bigint,%s::integer)",
                (owner, model, self.ids[side], self.cursors[side], PAGE_SIZE),
            ).fetchall()
            if not rows or self.offsets[side] + len(rows) > self.counts[side]:
                raise _ChangedGroup()
            page = np.asarray([row[1] for row in rows], dtype=np.float32)
            norms = np.linalg.norm(page, axis=1, keepdims=True)
            if page.ndim != 2 or not np.all(np.isfinite(page)) or np.any(norms <= 0):
                raise ValueError("invalid face embedding in merge group")
            if self.vectors[side] is None:
                self.vectors[side] = np.memmap(
                    self.directory.name + f"/group-{side}",
                    mode="w+",
                    dtype=np.float32,
                    shape=(self.counts[side], page.shape[1]),
                )
            start = self.offsets[side]
            self.vectors[side][start : start + len(page)] = page / norms
            self.offsets[side] += len(page)
            self.cursors[side] = rows[-1][0]
            return False
        if self.scan is None:
            self.scan = ClosestLinkScan(*self.vectors, self.directory.name)
        return self.scan.step()

    def close(self):
        if self.scan:
            self.scan.close()
        for vector in self.vectors:
            if vector is not None:
                vector._mmap.close()
        self.directory.cleanup()


class _ChangedGroup(Exception):
    pass


class _Session:
    def __init__(self, generation):
        self.generation = generation
        self.pairs = []
        self.pair = None

    def close(self):
        if self.pair:
            self.pair.close()
            self.pair = None


def clear_sessions():
    """Release temporary pair data, also used when a worker finishes."""
    while _SESSIONS:
        _, session = _SESSIONS.popitem(last=False)
        session.close()


def merge_unnamed(db, owner, model, threshold, deadline, heartbeat=lambda: True):
    """Return merged group count; stop at deadline without losing pair-pass progress.

    Completed scans are quiet until the database generation changes. No mutation
    occurs until *all* eligible pairs have been scored and the global best pair is
    known. Each commit absorbs one group, below the SQL limit of 500.
    """
    merged = 0
    key = (owner, model, float(threshold))
    while time.monotonic() < deadline:
        if not heartbeat():
            break
        state = db.execute(
            "SELECT generation,left_id,right_id,complete FROM face_worker.merge_state(%s::text,%s::text,%s::real)",
            (owner, model, threshold),
        ).fetchone()
        generation, left, right, complete = state
        session = _SESSIONS.get(key)
        if session and (session.generation != generation or complete):
            session.close()
            del _SESSIONS[key]
            session = None
        if complete:
            break
        if session is None:
            session = _Session(generation)
            _SESSIONS[key] = session
            while len(_SESSIONS) > 2:
                _, old = _SESSIONS.popitem(last=False)
                old.close()
        _SESSIONS.move_to_end(key)
        # Retain intra-pair progress across time slices without querying state on
        # every matrix block. The final checkpoint checks its generation atomically.
        while time.monotonic() < deadline and heartbeat():
            if session.pair is None:
                if not session.pairs:
                    session.pairs = db.execute(
                        "SELECT left_id,right_id,left_count,right_count FROM face_worker.merge_next_pair(%s::text,%s::text,%s::uuid,%s::uuid)",
                        (owner, model, left, right),
                    ).fetchall()
                if not session.pairs:
                    count = db.execute(
                        "SELECT face_worker.merge_finish_pass(%s::text,%s::text,%s::bigint)",
                        (owner, model, generation),
                    ).fetchone()[0]
                    merged += max(0, count)
                    session.close()
                    del _SESSIONS[key]
                    break
                session.pair = _Pair(*session.pairs.pop(0))
            try:
                if not session.pair.step(db, owner, model):
                    continue
            except _ChangedGroup:
                # New assignments/curation changed the page counts. Reload the
                # generation, never score only the downloaded subset.
                session.close()
                del _SESSIONS[key]
                break
            score = session.pair.scan.score
            left, right = session.pair.ids
            accepted = db.execute(
                "SELECT face_worker.merge_checkpoint(%s::text,%s::text,%s::bigint,%s::uuid,%s::uuid,%s::real)",
                (owner, model, generation, left, right, score),
            ).fetchone()[0]
            session.pair.close()
            session.pair = None
            if not accepted:
                del _SESSIONS[key]
                break
    return merged


def has_pending(db, owner, model, threshold):
    """Cheap durable status for worker warm-idle/recovery decisions."""
    return not db.execute(
        "SELECT complete FROM face_worker.merge_state(%s::text,%s::text,%s::real)",
        (owner, model, threshold),
    ).fetchone()[0]
