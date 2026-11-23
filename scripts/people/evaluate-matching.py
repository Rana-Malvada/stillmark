"""Read-only recognition audit. Requires numpy; never changes database labels.

Hold out every reference from the query photo, not just the query face, to avoid
same-photo leakage. Output contains aggregate counts only (no biometric data).
"""
import argparse
import json
import os
import subprocess
import numpy as np

p = argparse.ArgumentParser()
p.add_argument('--service', default='personal_media_pg')
p.add_argument('--owner', required=True)
p.add_argument('--psql', default='/opt/homebrew/opt/libpq/bin/psql')
a = p.parse_args()
owner = "'" + a.owner.replace("'", "''") + "'"
sql = f"""SELECT json_build_object(
 'faces',(SELECT json_agg(x) FROM (SELECT f.face_id,f.photo_id,f.model_version,f.quality_ok,
 f.embedding::text AS embedding,a.person_id,a.status,p.name,p.hidden
 FROM faces f LEFT JOIN face_assignments a USING(face_id) LEFT JOIN face_people p USING(person_id)
 WHERE f.owner_username={owner} AND f.source='detected' AND NOT f.ignored AND f.embedding IS NOT NULL) x),
 'rejections',(SELECT coalesce(json_agg(x),'[]') FROM (SELECT face_id,person_id FROM face_rejections WHERE owner_username={owner}) x));"""
env = dict(os.environ, PGOPTIONS='-c default_transaction_read_only=on -c statement_timeout=30000')
data = json.loads(subprocess.check_output([a.psql, 'service='+a.service, '-XAt', '-v', 'ON_ERROR_STOP=1', '-c', sql], env=env, text=True))
rows = data['faces'] or []
rejected = {(r['face_id'], r['person_id']) for r in data['rejections']}
report = {}
for quality_only in (True, False):
    stats = {k: 0 for k in ('tested', 'auto_correct', 'auto_wrong', 'review_correct', 'review_wrong', 'unmatched', 'pending', 'pending_auto', 'pending_review', 'pending_unknown')}
    for model in sorted({r['model_version'] for r in rows}):
        candidates = [r for r in rows if r['model_version'] == model and (r['status'] is None or (r['status']=='confirmed' and r['name'] and not r['hidden']))]
        refs = [r for r in rows if r['model_version'] == model and r['status']=='confirmed' and r['name'] and not r['hidden'] and (r['quality_ok'] or not quality_only)]
        if not refs: continue
        vectors = np.array([json.loads(r['embedding']) for r in refs], dtype=np.float32)
        vectors /= np.maximum(np.linalg.norm(vectors, axis=1, keepdims=True), 1e-12)
        persons = sorted({r['person_id'] for r in refs})
        groups = [[i for i, r in enumerate(refs) if r['person_id']==person] for person in persons]
        photos = np.array([r['photo_id'] for r in refs])
        for offset in range(0,len(candidates),128):
            batch = candidates[offset:offset+128]
            query = np.array([json.loads(r['embedding']) for r in batch], dtype=np.float32)
            query /= np.maximum(np.linalg.norm(query,axis=1,keepdims=True),1e-12)
            sim = query @ vectors.T
            for row, scores in zip(batch,sim):
                scores[photos==row['photo_id']] = -np.inf
                ranked = []
                for person, indices in zip(persons,groups):
                    if (row['face_id'],person) in rejected: continue
                    # One vote per photo, so duplicate detections cannot supply consensus.
                    best = {}
                    for i in indices:
                        if np.isfinite(scores[i]): best[photos[i]] = max(best.get(photos[i],-1),float(scores[i]))
                    top = sorted(best.values(),reverse=True)[:3]
                    if top: ranked.append((sum(top)/len(top),person,len(top)))
                ranked.sort(reverse=True)
                score, person, count = ranked[0] if ranked else (-1,None,0)
                margin = score-ranked[1][0] if len(ranked)>1 else 2
                automatic = score>=.75 and count>=3 and margin>=.12
                review = score>=.60 and not automatic
                if row['status'] is None:
                    stats['pending'] += 1
                    stats['pending_auto' if automatic else 'pending_review' if review else 'pending_unknown'] += 1
                else:
                    stats['tested'] += 1
                    correct = person==row['person_id']
                    stats[('auto_' if automatic else 'review_')+('correct' if correct else 'wrong') if automatic or review else 'unmatched'] += 1
    report['quality_filtered_references' if quality_only else 'all_confirmed_references'] = stats
print(json.dumps(report,indent=2))
