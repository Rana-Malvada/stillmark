"""Face scan job: claims queued photos for one run, publishes faces, then matches and groups.

Runs as a finite Snowpark Container Services job. Logs carry counts and error classes
only, never names, crops, embeddings or image content.
"""

from __future__ import annotations

import json
import multiprocessing
import os
import sys
import time
import uuid
from pathlib import Path

import numpy as np
import psycopg

from cluster import MAX_FACES, ClusteringInterrupted, cluster, cohesion
from bounded_merge import merge_unnamed, has_pending, clear_sessions
from faces import MODEL_VERSION, Face, Models, analyze
from inference_pool import InferencePool

class ClaimsLost(InterruptedError):
    """Every claim in the batch was lost, for example because its photos were deleted.

    The batch has nothing left to publish, but the run itself is healthy.
    """


class Deferred(Exception):
    """Analysis did not finish because another photo in the batch reached the deadline.

    The photo is not at fault: it is left for a later claim without a failed attempt.
    """


INPUT = Path(os.environ.get("WORKER_INPUT", "/input")).resolve()
OUTPUT = Path(os.environ.get("WORKER_OUTPUT", "/output")).resolve()
CROP_PREFIX = "faces/"
MAX_SOURCE_BYTES = 200 * 1024 * 1024


def setting(name: str, default: str, low: float, high: float) -> float:
    value = float(os.environ.get(name, default))
    if not low <= value <= high:
        raise SystemExit(f"{name} out of range")
    return value


def log(event: str, **fields: object) -> None:
    print(json.dumps({"event": event, **fields}, separators=(",", ":")), flush=True)


def source_file(path: str) -> Path:
    """Resolves a catalog path inside the read-only originals mount."""
    candidate = (INPUT / path).resolve()
    if candidate == INPUT or INPUT not in candidate.parents:
        raise ValueError("source path outside input mount")
    return candidate


def read_and_analyze(models: Models, file: Path) -> list[Face]:
    if file.stat().st_size > MAX_SOURCE_BYTES:
        raise ValueError("source exceeds size limit")
    return analyze(models, file.read_bytes())


# Each analysis process loads its own models and uses one OpenCV thread, so N
# processes use N cores without contending. Publication stays in the main process.
_process_models: Models | None = None


def _init_analyzer(detector: str, recognizer: str) -> None:
    global _process_models
    import cv2

    cv2.setNumThreads(1)
    _process_models = Models(detector, recognizer)


def _analyze_in_process(path: str) -> list[Face]:
    assert _process_models is not None
    return read_and_analyze(_process_models, Path(path))


def write_crop(data: bytes, crop_id: uuid.UUID | None = None) -> str:
    """Writes a crop and returns its derived-stage path.

    Stage mounts do not support atomic renames, so the file is written once under its
    final name. The scanner reserves cleanup before calling this function; unknown
    publication outcomes must never delete a possibly committed crop directly.
    """
    if crop_id is not None and not isinstance(crop_id, uuid.UUID):
        raise TypeError("crop_id must be a UUID")
    name = f"{crop_id or uuid.uuid4()}.webp"
    with open(OUTPUT / name, "xb") as handle:
        handle.write(data)
    return CROP_PREFIX + name


def check_output() -> None:
    """Fails the run before claiming work if crops cannot be written."""
    probe = OUTPUT / f".probe-{uuid.uuid4()}"
    with open(probe, "xb") as handle:
        handle.write(b"ok")
    probe.unlink()


def connect() -> psycopg.Connection:
    password = Path(os.environ.get("PG_PASSWORD_FILE", "/secrets/PG_SECRET/password")).read_text()
    return psycopg.connect(
        host=os.environ["PG_HOST"],
        port=int(os.environ.get("PG_PORT", "5432")),
        dbname=os.environ.get("PG_DATABASE", "postgres"),
        user=os.environ.get("PG_USER", "personal_photos_face_worker"),
        password=password.strip(),
        sslmode="verify-full",
        sslrootcert=os.environ.get("PG_SSL_ROOT_CERT", "/worker/postgres-root.crt"),
        connect_timeout=10,
        options="-c statement_timeout=30000",
        autocommit=True,
    )


class Job:
    def __init__(
        self,
        db: psycopg.Connection,
        models: Models,
        run: str,
        model_paths: tuple[str, str] | None = None,
    ):
        self.db, self.models, self.run, self.model_paths = db, models, run, model_paths
        self.parallel = int(setting("WORKER_PARALLEL", "1", 1, 64))
        self.pool: InferencePool | None = None
        self.analysis_timeout = setting("WORKER_ANALYSIS_SECONDS", "300", 1, 1800)
        self.deadline = time.monotonic() + setting("WORKER_MAX_SECONDS", "7200", 60, 7200)
        self.batch = int(setting("WORKER_BATCH", "16", 1, 256))
        # Keep every analysis process busy for a whole claimed batch.
        self.batch = min(256, max(self.batch, self.parallel * 2))
        # Calibrated on the owner-labelled pilot (389 photos, 26 groups, 66 labelled pairs):
        # 0.60 auto-tagged 99% of same-person faces with no wrong-person hit; the highest
        # different-person score seen was 0.445; merging unnamed groups reproduced
        # the owner's three people exactly at 0.45 with no wrong merge (closest different pair:
        # 0.35); 0.48 left one person split.
        self.auto_at = setting("MATCH_AUTO", "0.60", 0.2, 0.99)
        self.review_at = setting("MATCH_REVIEW", "0.45", 0.1, 0.99)
        self.group_at = setting("GROUP_AT", "0.6", 0.2, 0.99)
        self.merge_at = setting("MERGE_AT", "0.45", 0.3, 0.99)

    def heartbeat(self) -> bool:
        row = self.db.execute("SELECT face_worker.heartbeat(%s::uuid)", (self.run,)).fetchone()
        return bool(row and row[0] == "running")

    def idle_state(self) -> str:
        return self.db.execute(
            "SELECT photo_security.worker_idle('faces',%s::uuid)", (self.run,)
        ).fetchone()[0]

    def owners(self):
        # Organization-only continuation retains the previous runs' owners even
        # after every photo has been published. The function rechecks ownership.
        return self.db.execute(
            """WITH RECURSIVE lineage AS (
              SELECT id,continued_from FROM face_scan_runs WHERE id=%s::uuid
              UNION ALL SELECT r.id,r.continued_from FROM face_scan_runs r JOIN lineage l ON r.id=l.continued_from
            ) SELECT DISTINCT owner FROM lineage l CROSS JOIN LATERAL face_worker.run_owners(l.id) owner""",
            (self.run,),
        ).fetchall()

    def organization_heartbeat(self):
        if time.monotonic() < getattr(self, 'next_organization_heartbeat', 0):
            return True
        if not self.heartbeat():
            return False
        self.next_organization_heartbeat = time.monotonic()+10
        return True

    def scan_one(self, photo: int, path: str, token: str) -> int:
        return self.publish(photo, path, token, read_and_analyze(self.models, source_file(path)))

    def analyze_many(self, paths: list[str], tokens: list[str] | None = None) -> list[list[Face] | Exception]:
        """Analyzes photos in order, in parallel when configured. Never raises per photo."""
        results: list[list[Face] | Exception | None] = [None] * len(paths)
        files: list[Path | None] = [None] * len(paths)
        for i, path in enumerate(paths):
            try:
                files[i] = source_file(path)
            except Exception as error:
                results[i] = error
        if not self.model_paths:
            for i, file in enumerate(files):
                if file is not None:
                    try:
                        results[i] = read_and_analyze(self.models, file)
                    except Exception as error:
                        results[i] = error
            return results  # type: ignore[return-value]
        if self.pool is None:
            # Spawn, not fork: the main process holds threads (OpenCV, psycopg), and
            # forking a threaded process can deadlock the children.
            self.pool = InferencePool(self.parallel, self.model_paths)
        futures = {
            i: self.pool.apply_async(_analyze_in_process, (str(f),))
            for i, f in enumerate(files)
            if f is not None
        }
        # Poll the child result so native inference cannot block Stop, the cycle
        # deadline, or queue renewal. A poisoned pool is terminated, never joined
        # while its native call is still running.
        deadline = min(self.deadline, time.monotonic() + self.analysis_timeout)
        next_renew = 0.0
        waiting = -1
        try:
            for i, future in futures.items():
                waiting = i
                while True:
                    now = time.monotonic()
                    if now >= deadline:
                        raise TimeoutError("Face analysis deadline reached")
                    if tokens and now >= next_renew:
                        if not self.heartbeat():
                            raise InterruptedError("Face scan stopped")
                        renewed = self.db.execute(
                            "SELECT face_worker.renew(%s::uuid[])", (tokens,)
                        ).fetchone()[0]
                        if renewed == 0:
                            raise ClaimsLost("Face scan claims lost")
                        next_renew = now + 15
                    try:
                        results[i] = future.get(timeout=min(1, max(0.001, deadline-now)))
                        break
                    except multiprocessing.TimeoutError:
                        continue
                    except Exception as error:
                        results[i] = error
                        break
        except Exception as error:
            if isinstance(error, TimeoutError):
                # Collect batch-mates that already finished before the pool is killed.
                for index, future in futures.items():
                    if results[index] is None and index != waiting:
                        try:
                            results[index] = future.get(timeout=0.001)
                        except multiprocessing.TimeoutError:
                            pass
                        except Exception as finished_error:
                            results[index] = finished_error
            self.close(terminate=True)
            if isinstance(error, InterruptedError):
                raise
            if not isinstance(error, TimeoutError):
                raise
            for index in futures:
                if results[index] is None:
                    results[index] = error if index == waiting else Deferred()
        return results  # type: ignore[return-value]

    def close(self, terminate: bool = False) -> None:
        if self.pool is not None:
            if terminate:
                self.pool.terminate()
            else:
                self.pool.close()
            self.pool.join()
            self.pool = None

    def publish(self, photo: int, path: str, token: str, found: list[Face]) -> int:
        crop_ids = [uuid.uuid4() for _ in found]
        # This commits before storage I/O. A failed reservation writes no files;
        # any later failure leaves a durable cleanup intent for every possible file.
        self.db.execute(
            "SELECT face_worker.reserve_crops(%s::integer,%s::uuid,%s::text[])",
            (photo, token, [f"{CROP_PREFIX}{crop_id}.webp" for crop_id in crop_ids]),
        )
        payload = []
        for face, crop_id in zip(found, crop_ids):
            crop_path = write_crop(face.crop_webp, crop_id)
            payload.append(
                {
                    "index": face.index,
                    "x": face.x,
                    "y": face.y,
                    "w": face.w,
                    "h": face.h,
                    "score": face.score,
                    "quality": face.quality,
                    "quality_ok": face.quality_ok,
                    "embedding": face.embedding,
                    "crop_path": crop_path,
                }
            )
        # A transport error may arrive after commit. The existing reference-aware
        # cleanup preserves live crops and retires only unreferenced paths.
        row = self.db.execute(
            "SELECT face_worker.publish(%s::integer,%s::uuid,%s::text,%s::text,%s::jsonb)",
            (photo, token, MODEL_VERSION, path, json.dumps(payload)),
        ).fetchone()
        return int(row[0])

    def scan(self) -> tuple[int, int, bool]:
        processed = failed = 0
        while time.monotonic() < self.deadline:
            if not self.heartbeat():
                log("run_stopped")
                return processed, failed, False
            claimed = self.db.execute(
                "SELECT photo_id,source_path,claim_token FROM face_worker.claim(%s::uuid,%s::integer)",
                (self.run, self.batch),
            ).fetchall()
            if not claimed:
                # A bounded retry may be queued but not due. Do not finish its run
                # merely because this particular claim found nothing immediately.
                if self.idle_state() == "work":
                    time.sleep(2)
                    continue
                return processed, failed, True
            tokens = [str(row[2]) for row in claimed]
            try:
                analyses = self.analyze_many([row[1] for row in claimed], tokens)
            except ClaimsLost:
                log("claims_lost", photos=len(claimed))
                continue
            except InterruptedError:
                return processed, failed, False
            for (photo, path, token), result in zip(claimed, analyses):
                if isinstance(result, Deferred):
                    log("deferred", photo=photo)
                    continue
                try:
                    if isinstance(result, Exception):
                        raise result
                    self.publish(photo, path, str(token), result)
                    processed += 1
                except psycopg.errors.SerializationFailure:
                    log("claim_lost", photo=photo)
                except Exception as error:  # Record and continue; retries are bounded.
                    failed += 1
                    self.db.execute(
                        "SELECT face_worker.fail(%s::integer,%s::uuid,%s::text)",
                        (photo, token, type(error).__name__),
                    )
                self.db.execute("SELECT face_worker.renew(%s::uuid[])", (tokens,))
            log("batch", processed=processed, failed=failed)
        return processed, failed, False

    def organize(self, owner: str) -> dict[str, int]:
        matched = self.db.execute(
            "SELECT face_worker.match(%s::text,%s::text,%s::real,%s::real)",
            (owner, MODEL_VERSION, self.auto_at, self.review_at),
        ).fetchone()[0]
        rows = self.db.execute(
            "SELECT face_id,embedding FROM face_worker.unassigned(%s::text,%s::text,%s::integer)",
            (owner, MODEL_VERSION, MAX_FACES),
        ).fetchall()
        groups = 0
        if len(rows) >= 2:
            ids = [row[0] for row in rows]
            vectors = np.array([row[1] for row in rows], np.float32)
            for group in cluster(vectors, self.group_at, deadline=self.deadline,
                                 heartbeat=self.organization_heartbeat):
                created = self.db.execute(
                    "SELECT face_worker.create_group(%s::text,%s::bigint[],%s::real[])",
                    (owner, [ids[i] for i in group], cohesion(vectors, group)),
                ).fetchone()[0]
                groups += created is not None
        return {"matched": int(matched), "groups": groups, "merged": 0}

    def merge_unnamed(self, owner: str) -> int:
        """Check complete groups in resumable slices without delaying the next upload."""
        return merge_unnamed(self.db, owner, MODEL_VERSION, self.merge_at,
                             min(self.deadline, time.monotonic()+10), self.organization_heartbeat)

    def merge_slice(self) -> int:
        owners = sorted(owner for (owner,) in self.owners())
        active = getattr(self, 'merge_owner', None)
        if active in owners:
            owners.remove(active)
            owners.insert(0, active)
        count = 0
        for owner in owners:
            if has_pending(self.db, owner, MODEL_VERSION, self.merge_at):
                self.merge_owner = owner
                count = self.merge_unnamed(owner)
                break
        pending = any(has_pending(self.db, owner, MODEL_VERSION, self.merge_at) for owner in owners)
        self.organization_pending = pending
        self.db.execute(
            "UPDATE face_scan_runs SET organization_pending=%s,idle_since=CASE WHEN %s THEN NULL ELSE idle_since END WHERE id=%s::uuid",
            (pending,pending,self.run),
        )
        return count

    def run_job(self) -> None:
        processed = failed = 0
        drained = False
        totals = {"matched": 0, "groups": 0, "merged": 0}
        try:
            saved = self.db.execute(
                "SELECT organization_pending,greatest(0,extract(epoch from cycle_deadline-now()))::float FROM face_scan_runs WHERE id=%s::uuid",
                (self.run,),
            ).fetchone()
            needs_organization = bool(saved and saved[0] is True)
            if saved and isinstance(saved[1], (int,float)):
                self.deadline = min(self.deadline,time.monotonic()+saved[1])
            while time.monotonic() < self.deadline:
                # Fence the crash gap between publishing the last face and
                # entering organization: a replacement must still organize it.
                self.organization_pending = True
                self.db.execute("UPDATE face_scan_runs SET organization_pending=true WHERE id=%s::uuid", (self.run,))
                done, errors, drained = self.scan()
                processed += done
                failed += errors
                # Publish people/group organization before waiting, rather than
                # withholding visible results for the fifteen-minute warm period.
                if done or errors or needs_organization:
                    self.organization_pending = True
                    self.db.execute("UPDATE face_scan_runs SET organization_pending=true WHERE id=%s::uuid", (self.run,))
                    try:
                        for (owner,) in self.owners():
                            for key, value in self.organize(owner).items():
                                totals[key] += value
                    except ClusteringInterrupted:
                        drained = False
                        break
                    needs_organization = False
                    totals["merged"] += self.merge_slice()
                if not drained:
                    break
                state = "idle"
                while time.monotonic() < self.deadline and self.heartbeat():
                    state = self.idle_state()
                    if state != "idle":
                        break
                    totals["merged"] += self.merge_slice()
                    time.sleep(5)
                if state != "work":
                    break
                drained = False
        finally:
            # Admission takes this run row's lock. Once sealed, later uploads keep
            # their durable signals for the next run instead of entering a job exiting.
            try:
                self.db.execute(
                    "UPDATE face_scan_runs SET accepting_work=false WHERE id=%s::uuid", (self.run,)
                )
            finally:
                self.close()
                clear_sessions()
        if getattr(self, 'organization_pending', False):
            drained = False
        outcome = "completed" if drained and failed == 0 else "attention"
        reason = None if drained else "Time budget reached; remaining photos stay queued"
        if drained and failed:
            reason = f"{failed} photo(s) could not be scanned"
        self.db.execute(
            "SELECT face_worker.finish(%s::uuid,%s::text,%s::text)", (self.run, outcome, reason)
        )
        log("finished", outcome=outcome, processed=processed, failed=failed, **totals)


def main() -> None:
    run = os.environ.get("WORKER_RUN_ID", "")
    try:
        uuid.UUID(run)
    except ValueError:
        raise SystemExit("WORKER_RUN_ID must be a UUID")
    models_dir = Path(os.environ.get("MODEL_DIR", "/worker/models"))
    model_paths = (
        str(models_dir / "face_detection_yunet_2023mar.onnx"),
        str(models_dir / "face_recognition_sface_2021dec.onnx"),
    )
    models = Models(*model_paths)
    with connect() as db:
        try:
            check_output()
            Job(db, models, run, model_paths).run_job()
        except Exception as error:
            db.execute(
                "SELECT face_worker.finish(%s::uuid,'attention',%s::text)",
                (run, "Worker interrupted; automatic recovery pending" if isinstance(error, (psycopg.OperationalError, psycopg.InterfaceError)) else "Worker error: " + type(error).__name__),
            )
            log("failed", error=type(error).__name__)
            sys.exit(1)


if __name__ == "__main__":
    main()
