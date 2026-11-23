"""Synthetic isolated-image driver; no production credentials or entrypoint fallback."""
import os
import sys
from pathlib import Path

import psycopg
from psycopg.rows import dict_row
from PIL import Image, ImageDraw
import worker


if __name__ == '__main__':
    if '--short-lease' in sys.argv:
        worker.PHOTO_LEASE_SECONDS = 1
        worker.CLAIM_RENEW_SECONDS = .1
        worker.RUN_HEARTBEAT_SECONDS = .1
    # Share only the disposable database container's network namespace.
    root = Path('/tmp/ocr-recovery-input')
    root.mkdir()
    for name in ('photo1', 'photo2'):
        image = Image.new('RGB', (320, 180), 'white')
        ImageDraw.Draw(image).text((30, 60), 'RECOVERY TEST 123', fill='black')
        image.save(root / name, format='PNG')
    os.environ['WORKER_INPUT'] = str(root)
    os.environ['WORKER_MAX_SECONDS'] = '120'
    # Shorten warm idle only, while exercising the actual scheduling/inference code.
    original = worker.process_automatic_photos

    def immediate_idle(*args, **kwargs):
        return original(*args, **{**kwargs, 'idle_seconds': 0})

    worker.process_automatic_photos = immediate_idle
    with psycopg.connect(host='127.0.0.1', port=5432, dbname='postgres',
                        user='personal_photos_search_worker', autocommit=True,
                        connect_timeout=5, options='-c statement_timeout=5000',
                        row_factory=dict_row) as db:
        worker.run(db, sys.argv[1], worker.Models())
