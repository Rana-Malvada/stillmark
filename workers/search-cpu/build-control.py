"""Render search batch job controls. Uses the EXISTING finite face CPU pool."""
import json,re
from pathlib import Path
root=Path(__file__).resolve().parents[2]
profile=json.loads((root/'config/deployment.json').read_text())
spec=json.loads((root/'workers/face-cpu/production-spec.json').read_text())
c=spec['spec']['containers'][0]
c['image']='/personal_media/app/photos_repo/search-worker:cpu-v1'
c['env']={k:v for k,v in c['env'].items() if k in ['PG_HOST','PG_DATABASE','PG_SSL_ROOT_CERT','WORKER_MAX_SECONDS','WORKER_RUN_ID']}
c['env']['PG_USER']='personal_photos_search_worker'
c['secrets'][0]['snowflakeSecret']='PERSONAL_MEDIA.APP.SEARCH_WORKER_PG_SECRET'
c['volumeMounts']=[v for v in c['volumeMounts'] if v['name']=='originals']
spec['spec']['volumes']=[v for v in spec['spec']['volumes'] if v['name']=='originals']
profile.update(FACE_JOB_CONTROL='SEARCH_BATCH_JOB_CONTROL',FACE_CONTROL='SEARCH_BATCH_CONTROL',FACE_ROLE='PERSONAL_PHOTOS_SEARCH_WORKER',FACE_EAI='PERSONAL_PHOTOS_SEARCH_EAI')
source=(root/'config/templates/face-control.sql').read_text().replace("'FACE_SCAN_'","'SEARCH_BATCH_'")
source=re.sub(r'\{\{([A-Z0-9_]+)\}\}',lambda m:profile[m[1]],source)
source=source.replace('var spec=SPEC;','var spec='+json.dumps(spec)+';')
print(source)
