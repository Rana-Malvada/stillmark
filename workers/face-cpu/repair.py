"""One-time, resumable repair of legacy tiled boxes; never regroups or deletes faces.

Uses the pinned detector to reproduce the original row and verifies its embedding
before changing geometry. Receipts and original records are saved to the private
stage before publication. Ordinary scanner startup never invokes this module.
"""
from __future__ import annotations

import json
import os
import time
import uuid
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from threading import local

import cv2
import numpy as np

import faces
import worker

GEOMETRY = ('source', 'source_path', 'model_version', 'embedding', 'box_x', 'box_y', 'box_w', 'box_h', 'crop_path', 'quality', 'quality_ok')
_local = local()


def candidates(models, image):
    """Pair pre-fix and corrected rows, before either suppression pass."""
    working, scale = faces._scaled(image, faces.WORKING_EDGE)
    found = faces._detect(models, working).copy()
    if len(found):
        found[:, :14] /= scale
    pairs = [(r.copy(), r.copy()) for r in found]
    small = len(found) == 0 or bool(np.any(np.minimum(found[:, 2], found[:, 3]) * scale < faces.SMALL_FACE_PX))
    if small and scale < 1:
        h, w = image.shape[:2]
        for y in faces._tiles(h):
            for x in faces._tiles(w):
                rows = faces._detect(models, np.ascontiguousarray(image[y:y+faces.TILE, x:x+faces.TILE]))
                for row in rows:
                    old, fixed = row.copy(), row.copy()
                    old[0:14:2] += x
                    old[1:14:2] += y
                    fixed[0] += x
                    fixed[1] += y
                    fixed[4:14:2] += x
                    fixed[5:14:2] += y
                    pairs.append((old, fixed))
    return pairs


def box(row, width, height):
    x, y = max(0., float(row[0])), max(0., float(row[1]))
    return [round(x/width, 6), round(y/height, 6), round(min(float(row[2]), width-x)/width, 6), round(min(float(row[3]), height-y)/height, 6)]


def match_record(record, pairs, width, height, embedding):
    """Require matching old geometry AND near-identical aligned-face features."""
    stored = np.array([record['box_'+k] for k in 'xywh'])
    vector = np.array(json.loads(record['embedding']))
    matches = []
    for index, (old, fixed) in enumerate(pairs):
        if np.max(np.abs(np.array(box(old, width, height))-stored)) > .000003:
            continue
        v = embedding(index, fixed)
        norm = float(np.linalg.norm(v)*np.linalg.norm(vector))
        if not np.isfinite(norm) or norm <= 0 or float(np.dot(v, vector)/norm) < .9999:
            continue
        matches.append((index, fixed))
    # Duplicated identical detections are safe only if corrected geometry agrees.
    if not matches:
        return None
    if any(not np.allclose(matches[0][1][:14], r[:14], atol=.001, rtol=0) for _, r in matches[1:]):
        return None
    return matches[0]


def analyze_photo(records):
    if not hasattr(_local, 'models'):
        directory = Path(os.environ.get('MODEL_DIR', '/worker/models'))
        _local.models = faces.Models(str(directory/'face_detection_yunet_2023mar.onnx'), str(directory/'face_recognition_sface_2021dec.onnx'))
    models = _local.models
    source = worker.source_file(records[0]['source_path'])
    if source.stat().st_size > worker.MAX_SOURCE_BYTES:
        raise ValueError('source exceeds size limit')
    image = faces.decode(source.read_bytes())
    height, width = image.shape[:2]
    pairs = candidates(models, image)
    features, aligned = {}, {}
    def embedding(index, row):
        if index not in features:
            aligned[index] = models.recognizer.alignCrop(image, row)
            features[index] = models.recognizer.feature(aligned[index]).reshape(-1)
        return features[index]
    changes, unmatched = [], []
    for record in records:
        match = match_record(record, pairs, width, height, embedding)
        if match is None:
            # Already repaired records may match the corrected row exactly.
            match = match_record(record, [(fixed, fixed) for _, fixed in pairs], width, height, embedding)
            if match is None:
                unmatched.append(record['face_id'])
            continue
        index, fixed = match
        corrected = box(fixed, width, height)
        if np.max(np.abs(np.array(corrected)-[record['box_'+k] for k in 'xywh'])) <= .000003:
            continue
        quality, quality_ok = faces.assess(fixed, aligned[index])
        crop = worker.write_crop(faces.crop(image, fixed))
        changes.append({'before': record, 'box': corrected, 'quality': quality, 'quality_ok': quality_ok, 'crop_path': crop})
    return {'photo_id': records[0]['photo_id'], 'changes': changes, 'unmatched': unmatched, 'checked': len(records)}


def apply(db, plan):
    repaired, conflicts = 0, []
    with db.transaction():
        with db.cursor() as cursor:
            cursor.execute("SET LOCAL lock_timeout='5s'")
            for change in plan['changes']:
                before = change['before']
                cursor.execute('SELECT row_to_json(f) FROM public.faces f WHERE face_id=%s FOR UPDATE', [before['face_id']])
                result = cursor.fetchone()
                if not result or any(result[0][k] != before[k] for k in GEOMETRY):
                    conflicts.append(before['face_id'])
                    continue
                cursor.execute('SELECT original_stage_path FROM public.photos WHERE photo_id=%s', [before['photo_id']])
                source = cursor.fetchone()
                if not source or source[0] != before['source_path']:
                    conflicts.append(before['face_id'])
                    continue
                cursor.execute('UPDATE public.faces SET box_x=%s,box_y=%s,box_w=%s,box_h=%s,quality=%s,quality_ok=%s,crop_path=%s WHERE face_id=%s', [*change['box'], change['quality'], change['quality_ok'], change['crop_path'], before['face_id']])
                if cursor.rowcount != 1:
                    raise RuntimeError('repair update count mismatch')
                repaired += 1
    return repaired, conflicts


def repair_photo(records, prefix):
    # Each task owns its connection and one photo; no concurrent transaction sharing.
    plan = analyze_photo(records)
    pid = plan['photo_id']
    receipt = worker.OUTPUT/(prefix+str(pid)+'-'+str(uuid.uuid4())+'-before.json')
    with receipt.open('x') as handle:
        json.dump(plan, handle)
    with worker.connect() as db:
        count, skipped = apply(db, plan)
    result = {'photo_id': pid, 'checked': plan['checked'], 'repaired': count, 'unmatched': plan['unmatched'], 'conflicts': skipped, 'receipt': receipt.name}
    with (worker.OUTPUT/(prefix+str(pid)+'-done.json')).open('x') as handle:
        json.dump(result, handle)
    return result


def main():
    cv2.setNumThreads(1)
    run = str(uuid.UUID(os.environ['REPAIR_RUN_ID']))
    limit = int(os.environ.get('REPAIR_LIMIT', '100000'))
    maximum = int(os.environ['REPAIR_MAX_FACE_ID'])
    budget = int(os.environ.get('WORKER_MAX_SECONDS', '3000'))
    prefix = f'repair-{run}-'
    worker.check_output()
    with worker.connect() as db:
        # Separate advisory lock prevents concurrent repair jobs, including retries.
        if not db.execute('SELECT pg_try_advisory_lock(185279, 1)').fetchone()[0]:
            raise RuntimeError('another repair is active')
        rows = db.execute("SELECT row_to_json(f) FROM public.faces f JOIN public.photos p ON p.photo_id=f.photo_id WHERE f.source='detected' AND f.model_version=%s AND f.face_id<=%s AND f.source_path=p.original_stage_path ORDER BY f.photo_id,f.face_id", [faces.MODEL_VERSION, maximum]).fetchall()
        groups = {}
        for (r,) in rows:
            groups.setdefault(r['photo_id'], []).append(r)
        complete = {int(p.name.removeprefix(prefix).removesuffix('-done.json')) for p in worker.OUTPUT.glob(prefix+'*-done.json')}
        pending = [r for pid,r in groups.items() if pid not in complete][:limit]
        worker.log('repair_start', photos=len(groups), completed=len(complete), pending=len(pending))
        started = time.monotonic()
        processed = repaired = unmatched = conflicts = errors = 0
        parallel = int(worker.setting('WORKER_PARALLEL', '2', 1, 32))
        with ThreadPoolExecutor(max_workers=parallel) as pool:
            batch = iter(pending)
            while time.monotonic()-started < budget:
                items = [next(batch, None) for _ in range(parallel)]
                jobs = [pool.submit(repair_photo, r, prefix) for r in items if r]
                if not jobs:
                    break
                for job in as_completed(jobs):
                    try:
                        result = job.result()
                        processed += 1; repaired += result['repaired']; unmatched += len(result['unmatched']); conflicts += len(result['conflicts'])
                    except Exception as exc:
                        errors += 1
                        worker.log('repair_error', error=type(exc).__name__)
                    worker.log('repair_progress', processed=processed, repaired=repaired, unmatched=unmatched, conflicts=conflicts, errors=errors, remaining=len(pending)-processed-errors)
        worker.log('repair_finished', processed=processed, repaired=repaired, unmatched=unmatched, conflicts=conflicts, errors=errors, remaining=len(pending)-processed-errors)
        if errors:
            raise SystemExit(1)


if __name__ == '__main__':
    main()
