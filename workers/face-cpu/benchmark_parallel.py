"""Read-only deployed-image benchmark. Never connects to Postgres or publishes faces."""
import argparse
from concurrent.futures import ProcessPoolExecutor
import hashlib
import json
import multiprocessing
from pathlib import Path
import resource
import time


def initialize():
    from worker import _init_analyzer
    _init_analyzer('/worker/models/face_detection_yunet_2023mar.onnx',
                   '/worker/models/face_recognition_sface_2021dec.onnx')


def photo(path):
    from worker import _analyze_in_process
    faces = _analyze_in_process(path)
    digest = hashlib.sha256()
    for face in faces:
        values = vars(face).copy()
        values['crop_webp'] = hashlib.sha256(values['crop_webp']).hexdigest()
        digest.update(json.dumps(values, sort_keys=True).encode())
    return len(faces), digest.hexdigest(), resource.getrusage(resource.RUSAGE_SELF).ru_maxrss


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--workers', type=int, choices=(4, 6), required=True)
    parser.add_argument('--manifest', required=True)
    args = parser.parse_args()
    from worker import source_file
    paths = [str(source_file(p)) for p in json.loads(Path(args.manifest).read_text())]
    if len(paths) < args.workers:
        parser.error('Need at least one photo per worker')
    with ProcessPoolExecutor(max_workers=args.workers,
                             mp_context=multiprocessing.get_context('spawn'),
                             initializer=initialize) as pool:
        for label in ('cold', 'warm1', 'warm2'):
            start = time.monotonic()
            rows = list(pool.map(photo, paths, chunksize=1))
            seconds = time.monotonic() - start
            print(json.dumps(dict(label=label, workers=args.workers, photos=len(rows),
                seconds=seconds, photos_per_minute=len(rows)*60/seconds,
                faces=sum(r[0] for r in rows), peak_child_rss_kib=max(r[2] for r in rows),
                output_digest=hashlib.sha256(json.dumps([r[:2] for r in rows]).encode()).hexdigest())), flush=True)
