"""Bounded CPU enrichment and query reranking. No runtime downloads."""
from concurrent.futures import wait, FIRST_COMPLETED
from capacity import detect_capacity
from inference_pool import InferencePool
from travel_summaries import refresh_travel_summaries
import json
import math
import os
import time
from pathlib import Path
import uuid

import psycopg
from psycopg.rows import dict_row

VERSION = 'clip-b32@3d74acf9+ocr-tesseract5'
RANKER = 'minilm-l6@233902d2'
PHOTO_LEASE_SECONDS = 300
RERANK_LEASE_SECONDS = 900
CLAIM_RENEW_SECONDS = 15
RUN_HEARTBEAT_SECONDS = 5


def source_file(root, path):
    root = Path(root).resolve()
    file = (root / path).resolve()
    if root not in file.parents or file.stat().st_size > 200 * 1024 * 1024:
        raise ValueError('Invalid or oversized source')
    return file


def ordered_ids(documents, scores):
    if len(documents) != len(scores) or not all(math.isfinite(float(s)) for s in scores):
        raise ValueError('Invalid reranker scores')
    return [d['id'] for d, _ in sorted(zip(documents, scores), key=lambda x: -float(x[1]))]


class Models:
    def __init__(self):
        self.visual = self.ranker = None

    def photo(self, file):
        import torch
        import pytesseract
        from image_decode import decode_image
        from transformers import CLIPModel, CLIPProcessor
        if self.visual is None:
            self.visual = CLIPModel.from_pretrained('/models/visual', local_files_only=True).eval()
            self.processor = CLIPProcessor.from_pretrained('/models/visual', local_files_only=True)
        image, _ = decode_image(file)
        with image:
            data = pytesseract.image_to_data(image, output_type=pytesseract.Output.DICT, timeout=45)
            words = [(t, float(c)) for t, c in zip(data['text'], data['conf']) if t.strip() and float(c)>=40]
            with torch.inference_mode():
                # Transformers 5 returns structured model output; pooler_output is
                # the projected CLIP embedding, not the sequence hidden states.
                features = self.visual.get_image_features(**self.processor(images=image, return_tensors='pt'))
                vector = features.pooler_output[0]
                if vector.ndim != 1 or vector.shape[0] != 512 or not torch.isfinite(vector).all():
                    raise ValueError('Invalid CLIP embedding')
                vector = (vector / vector.norm()).tolist()
            return ' '.join(t for t,_ in words)[:30000], (sum(c for _,c in words)/len(words) if words else 0), vector

    def rank(self, query, documents):
        import torch
        from transformers import AutoTokenizer, AutoModelForSequenceClassification
        if self.ranker is None:
            self.ranker = AutoModelForSequenceClassification.from_pretrained('/models/reranker',local_files_only=True).eval()
            self.tokenizer = AutoTokenizer.from_pretrained('/models/reranker',local_files_only=True)
        scores=[]
        for start in range(0,len(documents),16):
            batch=documents[start:start+16]
            tokens=self.tokenizer([query]*len(batch),[d['text'] for d in batch],padding=True,truncation=True,max_length=512,return_tensors='pt')
            with torch.inference_mode():
                scores.extend(self.ranker(**tokens).logits[:,0].tolist())
        return ordered_ids(documents,scores)


def initialize_photo_worker():
    # Each isolated model gets one CPU thread; four processes share four CPUs.
    os.environ['OMP_NUM_THREADS'] = '1'
    os.environ['OMP_THREAD_LIMIT'] = '1'
    os.environ['MKL_NUM_THREADS'] = '1'
    import torch
    torch.set_num_threads(1)
    torch.set_num_interop_threads(1)
    global photo_models
    photo_models = Models()


def process_photo(path):
    return photo_models.photo(source_file(os.environ.get('WORKER_INPUT', '/input'), path))


def process_pending_photos(pool, workers, limit, heartbeat, claim, consume, renew=None):
    """Only the coordinator touches the DB. Never claim ahead of capacity."""
    pending = {}
    submitted = 0
    accepting = True
    while pending or (accepting and submitted < limit):
        alive = heartbeat()
        accepting = accepting and alive
        if not alive and hasattr(pool, 'cancel'):
            for future in pending:
                pool.cancel(future, InterruptedError('Search run stopped or deadline reached'))
        elif renew and pending:
            for future, row in list(pending.items()):
                if not renew(row):
                    pool.cancel(future, InterruptedError('Search claim lost'))
        while accepting and len(pending) < workers and submitted < limit:
            row = claim()
            if row is None:
                accepting = False
                break
            # A submit failure is fatal; the existing lease recovery handles it.
            pending[pool.submit(process_photo, row['source_path'])] = row
            submitted += 1
        if not pending:
            break
        if hasattr(pool, 'poll'):
            pool.poll(.25)
            done = [future for future in pending if future.done()]
        else:
            done, _ = wait(pending, timeout=.25, return_when=FIRST_COMPLETED)
        for future in done:
            consume(pending.pop(future), future)
        # Cancellation kills active children; consume releases only our claims.
        # Publication additionally checks status, revision, token and live lease.
    return submitted


def process_automatic_photos(pool, workers, heartbeat, claim, consume, idle_state,
                             clock=time.monotonic, sleep=time.sleep, idle_seconds=900,
                             renew=None):
    """Reuse model processes for fifteen minutes after work, within the run budget."""
    last_work = clock()
    while heartbeat():
        args = (pool, workers, 100000, heartbeat, claim, consume)
        submitted = process_pending_photos(*args, renew=renew) if renew else process_pending_photos(*args)
        if submitted:
            last_work = clock()
        idle_state(True)
        if clock() - last_work >= idle_seconds:
            break
        sleep(max(0, min(5, idle_seconds - (clock() - last_work))))


def publish_rerank(db, row, ids, run_id):
    """Count only a committed ranking; discard only the claim we still own."""
    result = db.execute("""UPDATE search_sessions SET reranked_ids=%s,rerank_model=%s,rerank_status='completed',rerank_error=NULL,claim_token=NULL,lease_until=NULL
      WHERE id=%s AND claim_token=%s AND rerank_status='running' AND lease_until>now()
        AND scope_revision=search_scope_revision(scope_ids,username)
        AND EXISTS(SELECT FROM search_batch_runs WHERE id=%s AND status='running')""",
      (ids,RANKER,row['id'],row['claim_token'],run_id))
    if not result.rowcount:
        # A replay or replacement claim owns any newer work. Leave it untouched.
        db.execute("""UPDATE search_sessions SET rerank_status=CASE WHEN attempts>=3 THEN 'failed' ELSE 'queued' END,
          claim_token=NULL,lease_until=NULL WHERE id=%s AND claim_token=%s AND rerank_status='running'""",
          (row['id'],row['claim_token']))
    return result.rowcount


def run(db, run_id, models):
    start=time.monotonic()
    budget=min(3000,int(os.environ.get('WORKER_MAX_SECONDS','3000')))
    if os.environ.get('SEARCH_UPDATE_DEADLINE'):
        budget=min(budget,max(0,float(os.environ['SEARCH_UPDATE_DEADLINE'])-time.time()))
    run=db.execute("UPDATE search_batch_runs SET status='running',heartbeat_at=now() WHERE id=%s AND status='starting' RETURNING *",(run_id,)).fetchone()
    if not run: return
    counts={'photos_done':0,'searches_done':0,'failures':0}
    idle = False
    next_heartbeat = 0
    def idle_state(value):
        nonlocal idle
        if idle == value: return
        db.execute("UPDATE search_batch_runs SET idle_since=CASE WHEN %s THEN now() ELSE NULL END WHERE id=%s AND status='running'",(value,run_id))
        idle = value
    def heartbeat():
        nonlocal next_heartbeat
        if time.monotonic()-start>=budget: return False
        if time.monotonic()<next_heartbeat: return True
        row=db.execute("UPDATE search_batch_runs SET heartbeat_at=now(),photos_done=%s,searches_done=%s,failures=%s WHERE id=%s AND status='running' RETURNING id",(*counts.values(),run_id)).fetchone()
        next_heartbeat=time.monotonic()+RUN_HEARTBEAT_SECONDS
        return bool(row) and time.monotonic()-start<budget
    # Expired leases are retried at most three times within admitted work.
    db.execute("""UPDATE search_enrichment SET status=CASE WHEN attempts>=3 THEN 'failed' ELSE 'queued' END,claim_token=NULL,lease_until=NULL
      WHERE status='running' AND lease_until<now() AND EXISTS(SELECT FROM search_batch_runs r WHERE r.id=%s
        AND r.status='running' AND (r.automatic_photo_ids IS NULL OR photo_id=ANY(r.automatic_photo_ids)))""",(run_id,))
    if run['search_limit'] > 0:
        db.execute("UPDATE search_sessions SET rerank_status=CASE WHEN attempts>=3 THEN 'failed' ELSE 'queued' END,claim_token=NULL,lease_until=NULL WHERE rerank_status='running' AND lease_until<now()")
    def claim_photo():
        row = db.execute("""UPDATE search_enrichment SET status='running',claim_token=gen_random_uuid(),lease_until=now()+(%s * interval '1 second'),attempts=attempts+1
          WHERE photo_id=(SELECT q.photo_id FROM search_enrichment q JOIN search_batch_runs r ON r.id=%s
            WHERE q.status='queued' AND q.attempts<3 AND r.status='running'
              AND (r.automatic_photo_ids IS NULL OR q.photo_id=ANY(r.automatic_photo_ids))
            ORDER BY q.photo_id LIMIT 1 FOR UPDATE OF q SKIP LOCKED)
          AND EXISTS(SELECT FROM search_batch_runs WHERE id=%s AND status='running') RETURNING *""", (PHOTO_LEASE_SECONDS,run_id,run_id)).fetchone()
        if row: idle_state(False)
        return row

    renew_at = {}
    def renew_photo(row):
        token=row['claim_token']
        if time.monotonic()<renew_at.get(token,0): return True
        result=db.execute("""UPDATE search_enrichment SET lease_until=now()+(%s * interval '1 second')
          WHERE photo_id=%s AND revision=%s AND claim_token=%s AND status='running' AND lease_until>now()
          AND EXISTS(SELECT FROM search_batch_runs WHERE id=%s AND status='running')""",
          (PHOTO_LEASE_SECONDS,row['photo_id'],row['revision'],token,run_id))
        renew_at[token]=time.monotonic()+CLAIM_RENEW_SECONDS
        return result.rowcount==1

    def consume_photo(row, future):
        renew_at.pop(row['claim_token'],None)
        try:
            text,confidence,vector=future.result()
            if not heartbeat():
                raise InterruptedError('Search run stopped or deadline reached')
        except Exception as error:
            counts['failures']+=1
            db.execute("UPDATE search_enrichment SET status=CASE WHEN attempts>=3 THEN 'failed' ELSE 'queued' END,error=%s,claim_token=NULL,lease_until=NULL WHERE photo_id=%s AND revision=%s AND claim_token=%s",(type(error).__name__,row['photo_id'],row['revision'],row['claim_token']))
            return
        result=db.execute("""UPDATE search_enrichment SET ocr_text=%s,ocr_confidence=%s,visual_embedding=%s::vector,model_version=%s,status='completed',error=NULL,updated_at=now(),claim_token=NULL,lease_until=NULL
          WHERE photo_id=%s AND revision=%s AND claim_token=%s AND lease_until>now() AND EXISTS(SELECT FROM search_batch_runs WHERE id=%s AND status='running')""",(text,confidence,json.dumps(vector),VERSION,row['photo_id'],row['revision'],row['claim_token'],run_id))
        counts['photos_done']+=result.rowcount
        if not result.rowcount:
            # Cancellation or a stale result must not strand our own claim.
            db.execute("UPDATE search_enrichment SET status=CASE WHEN attempts>=3 THEN 'failed' ELSE 'queued' END,claim_token=NULL,lease_until=NULL WHERE photo_id=%s AND revision=%s AND claim_token=%s",(row['photo_id'],row['revision'],row['claim_token']))

    workers=detect_capacity()
    if run['photo_limit'] > 0:
        with InferencePool(workers, timeout=min(600,max(1,float(os.environ.get('SEARCH_PHOTO_TIMEOUT_SECONDS','180'))))) as pool:
            if run.get('automatic_photo_ids') is not None:
                process_automatic_photos(pool, workers, heartbeat, claim_photo, consume_photo, idle_state, renew=renew_photo)
            else:
                process_pending_photos(pool, workers, run['photo_limit'], heartbeat, claim_photo, consume_photo, renew_photo)
    if run['search_limit'] > 0:
        with InferencePool(1, timeout=min(900,max(1,float(os.environ.get('SEARCH_RERANK_TIMEOUT_SECONDS','300'))))) as pool:
            for _ in range(run['search_limit']):
                if not heartbeat(): break
                row=db.execute("""UPDATE search_sessions SET rerank_status='running',claim_token=gen_random_uuid(),lease_until=now()+(%s * interval '1 second'),attempts=attempts+1
                  WHERE id=(SELECT id FROM search_sessions WHERE rerank_status='queued' AND attempts<3 AND scope_revision=search_scope_revision(scope_ids,username)
                  ORDER BY hits DESC,last_used_at DESC LIMIT 1 FOR UPDATE SKIP LOCKED)
                  AND EXISTS(SELECT FROM search_batch_runs WHERE id=%s AND status='running') RETURNING *""",(RERANK_LEASE_SECONDS,run_id)).fetchone()
                if not row: break
                try:
                    future=pool.submit_rank(row['payload'].get('rankingQuery') or row['query'],row['documents'])
                    next_renew=0
                    while not future.done():
                        if not heartbeat():
                            pool.cancel(future,InterruptedError('Search run stopped or deadline reached'))
                        elif time.monotonic()>=next_renew:
                            renewed=db.execute("""UPDATE search_sessions SET lease_until=now()+(%s * interval '1 second')
                              WHERE id=%s AND claim_token=%s AND rerank_status='running' AND lease_until>now()
                              AND scope_revision=search_scope_revision(scope_ids,username)
                              AND EXISTS(SELECT FROM search_batch_runs WHERE id=%s AND status='running')""",
                              (RERANK_LEASE_SECONDS,row['id'],row['claim_token'],run_id))
                            if renewed.rowcount!=1: pool.cancel(future,InterruptedError('Search claim lost'))
                            next_renew=time.monotonic()+CLAIM_RENEW_SECONDS
                        pool.poll(.25)
                    ids=future.result()
                    if not heartbeat(): raise InterruptedError('Search run stopped or deadline reached')
                    if set(ids)!=set(row['candidate_ids']): raise ValueError('Candidate mismatch')
                    counts['searches_done']+=publish_rerank(db,row,ids,run_id)
                except Exception as error:
                    counts['failures']+=1
                    db.execute("UPDATE search_sessions SET rerank_status=CASE WHEN attempts>=3 THEN 'failed' ELSE 'queued' END,rerank_error=%s,claim_token=NULL,lease_until=NULL WHERE id=%s AND claim_token=%s AND rerank_status='running'",(type(error).__name__,row['id'],row['claim_token']))
    travel_done = refresh_travel_summaries(db, heartbeat)
    if travel_done:
        print(json.dumps({'travel_albums_refreshed': travel_done}), flush=True)
    db.execute("UPDATE search_batch_runs SET status='completed',finished_at=now(),elapsed_ms=%s,photos_done=%s,searches_done=%s,failures=%s WHERE id=%s AND status='running'",(int((time.monotonic()-start)*1000),*counts.values(),run_id))


if __name__=='__main__':
    run_id=str(uuid.UUID(os.environ['WORKER_RUN_ID']))
    password=Path('/secrets/PG_SECRET/password').read_text().strip()
    with psycopg.connect(host=os.environ['PG_HOST'],dbname='postgres',user='personal_photos_search_worker',password=password,
        sslmode='verify-full',sslrootcert='/worker/postgres-root.crt',connect_timeout=10,
        options='-c statement_timeout=30000',autocommit=True,row_factory=dict_row) as db:
        try: run(db,run_id,Models())
        except Exception as error:
            db.execute("UPDATE search_batch_runs SET status='failed',finished_at=now(),error=%s WHERE id=%s AND status='running'",('Worker interrupted; automatic recovery pending',run_id))
            raise
