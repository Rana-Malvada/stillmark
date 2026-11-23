"""Read-only OCR/CLIP benchmark; run each worker count in a fresh container.

Example: python benchmark_parallel.py --workers 2 --input /samples --output /results/2.json
No database writes or search-index updates are performed.
"""
import argparse
import hashlib
from concurrent.futures import ProcessPoolExecutor
import json
import multiprocessing
import os
from pathlib import Path
import resource
import time


def initialize(threads):
    os.environ['OMP_NUM_THREADS'] = str(threads)
    os.environ['OMP_THREAD_LIMIT'] = str(threads)
    os.environ['MKL_NUM_THREADS'] = str(threads)
    import torch
    torch.set_num_threads(threads)
    torch.set_num_interop_threads(1)
    from worker import Models
    global model
    model = Models()


def photo(path):
    started = time.monotonic()
    text, confidence, vector = model.photo(path)
    return dict(file=Path(path).name, text=text, confidence=confidence,
                vector=vector, seconds=time.monotonic() - started,
                pid=os.getpid(), rss_kib=resource.getrusage(resource.RUSAGE_SELF).ru_maxrss)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--workers', type=int, choices=(1, 2, 4, 6), required=True)
    parser.add_argument('--threads', type=int, default=None, help='Threads per model; use 1 to match production')
    parser.add_argument('--manifest', help='JSON array of relative paths under input; avoids scanning a stage')
    parser.add_argument('--input', required=True)
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    if args.manifest:
        from worker import source_file
        paths = [str(source_file(args.input, p)) for p in json.loads(Path(args.manifest).read_text())]
    else:
        paths = sorted(str(p) for p in Path(args.input).iterdir()
                       if p.suffix.lower() in ('.jpg', '.jpeg', '.png', '.webp'))
    if len(paths) < args.workers:
        raise SystemExit('Need at least one sample per worker')
    threads = args.threads if args.threads is not None else max(1, 4 // args.workers)
    if threads < 1:
        parser.error('threads must be positive')
    results = dict(workers=args.workers, threads_per_worker=threads, sample_count=len(paths), rounds=[])
    started = time.monotonic()
    with ProcessPoolExecutor(max_workers=args.workers,
                             mp_context=multiprocessing.get_context('spawn'),
                             initializer=initialize, initargs=(threads,)) as pool:
        for label in ('cold', 'warm1', 'warm2'):
            begin = time.monotonic()
            rows = list(pool.map(photo, paths, chunksize=1))
            seconds = time.monotonic() - begin
            result = dict(label=label, seconds=seconds,
                          photos_per_minute=len(paths) * 60 / seconds, results=rows)
            results['rounds'].append(result)
            summary = {k: v for k, v in result.items() if k != 'results'}
            summary['workers'] = args.workers
            summary['peak_child_rss_kib'] = max(row['rss_kib'] for row in rows)
            summary['output_digest'] = hashlib.sha256(json.dumps(
                [(r['text'], r['confidence'], r['vector']) for r in rows], sort_keys=True).encode()).hexdigest()
            print(json.dumps(summary), flush=True)
    results['total_seconds'] = time.monotonic() - started
    Path(args.output).write_text(json.dumps(results))
