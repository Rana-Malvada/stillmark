-- Bounded cancellation of a named preparation run, with split privilege roles.
CREATE OR REPLACE PROCEDURE PERSONAL_MEDIA.APP.VIDEO_JOB_CONTROL(RUN_ID VARCHAR,ACTION VARCHAR) RETURNS VARIANT LANGUAGE JAVASCRIPT EXECUTE AS OWNER AS $$
if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(RUN_ID))throw 'Invalid run ID';
if(ACTION!=='START'&&ACTION!=='STATUS'&&ACTION!=='CANCEL')throw 'Invalid action';
function exec(sql,binds){return snowflake.createStatement({sqlText:sql,binds:binds||[]}).execute();}
var name='VIDEO_PREP_'+RUN_ID.replace(/-/g,'').toUpperCase();
var jobs=exec("SHOW JOB SERVICES LIKE '"+name+"' IN SCHEMA PERSONAL_MEDIA.APP"),status='NOT_FOUND';
while(jobs.next()){if(jobs.getColumnValue('name')===name)status=jobs.getColumnValue('status');}
if(ACTION==='CANCEL'){exec('DROP SERVICE IF EXISTS PERSONAL_MEDIA.APP.'+name);return {status:'CANCELLED',job:name};}
if(ACTION==='START'&&status==='NOT_FOUND'){
 var spec={"spec": {"containers": [{"name": "worker", "image": "/personal_media/app/photos_repo/video-worker:l40s-v6", "command": ["/usr/bin/timeout"], "args": ["7500", "/usr/local/bin/node", "/worker/worker.mjs"], "env": {"NVIDIA_DRIVER_CAPABILITIES": "compute,video,utility", "PG_HOST": "pg-instance.exampleorg-exampleacct.us-east-2.aws.postgres.snowflake.app", "PG_DATABASE": "postgres", "PG_USER": "personal_photos_video_worker", "PG_SSL_ROOT_CERT": "/worker/postgres-root.crt", "WORKER_CONCURRENCY": "2", "WORKER_MAX_JOBS": "10000", "WORKER_MAX_SECONDS": "7200", "WORKER_RUN_ID": "RUN_ID"}, "secrets": [{"snowflakeSecret": "PERSONAL_MEDIA.APP.VIDEO_WORKER_PG_SECRET", "directoryPath": "/secrets/PG_SECRET"}], "resources": {"requests": {"cpu": 4, "memory": "8Gi", "nvidia.com/gpu": 1}, "limits": {"cpu": 6, "memory": "24Gi", "nvidia.com/gpu": 1}}, "volumeMounts": [{"name": "originals", "mountPath": "/input"}, {"name": "playback", "mountPath": "/output"}]}], "volumes": [{"name": "originals", "source": "stage", "stageConfig": {"name": "@PERSONAL_MEDIA.RAW.PHOTO_FILES"}}, {"name": "playback", "source": "stage", "stageConfig": {"name": "@PERSONAL_MEDIA.RAW.DERIVED_FILES/display/prepared"}}]}};
 spec.spec.containers[0].env.WORKER_RUN_ID=RUN_ID;
 var text=JSON.stringify(spec).replace(/'/g,"''");
 try{exec("EXECUTE JOB SERVICE IN COMPUTE POOL PERSONAL_PHOTOS_VIDEO_L40S NAME=PERSONAL_MEDIA.APP."+name+" EXTERNAL_ACCESS_INTEGRATIONS=(PERSONAL_PHOTOS_VIDEO_EAI) ASYNC=TRUE FROM SPECIFICATION '"+text+"'");status='PENDING';}
 catch(e){if(String(e).indexOf('already exists')<0)throw e;status='PENDING';}
}
return {status:status,job:name};
$$;
GRANT OWNERSHIP ON PROCEDURE PERSONAL_MEDIA.APP.VIDEO_JOB_CONTROL(VARCHAR,VARCHAR) TO ROLE PERSONAL_PHOTOS_VIDEO_WORKER COPY CURRENT GRANTS;
CREATE OR REPLACE PROCEDURE PERSONAL_MEDIA.APP.VIDEO_PREPARATION_CONTROL(RUN_ID VARCHAR,ACTION VARCHAR) RETURNS VARIANT LANGUAGE JAVASCRIPT EXECUTE AS OWNER AS $$
if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(RUN_ID))throw 'Invalid run ID';
if(ACTION!=='START'&&ACTION!=='STATUS'&&ACTION!=='CANCEL')throw 'Invalid action';
function exec(sql,binds){return snowflake.createStatement({sqlText:sql,binds:binds||[]}).execute();}
var pools=exec("SHOW COMPUTE POOLS LIKE 'PERSONAL_PHOTOS_VIDEO_L40S'"),pool='UNKNOWN';
while(pools.next()){if(pools.getColumnValue('name')==='PERSONAL_PHOTOS_VIDEO_L40S')pool=pools.getColumnValue('state');}
var result=exec('CALL PERSONAL_MEDIA.APP.VIDEO_JOB_CONTROL(?,?)',[RUN_ID,ACTION==='CANCEL'?'CANCEL':'STATUS']);result.next();
var value=result.getColumnValue(1);if(typeof value==='string')value=JSON.parse(value);
if(ACTION==='START'&&value.status==='NOT_FOUND'){
 if(pool==='SUSPENDED')exec('ALTER COMPUTE POOL PERSONAL_PHOTOS_VIDEO_L40S RESUME');
 result=exec('CALL PERSONAL_MEDIA.APP.VIDEO_JOB_CONTROL(?,?)',[RUN_ID,'START']);result.next();
 value=result.getColumnValue(1);if(typeof value==='string')value=JSON.parse(value);
}
if(ACTION==='CANCEL'){
 var check=exec("SHOW COMPUTE POOLS LIKE 'PERSONAL_PHOTOS_VIDEO_L40S'");
 while(check.next()){if(check.getColumnValue('name')==='PERSONAL_PHOTOS_VIDEO_L40S'&&Number(check.getColumnValue('num_jobs'))===0&&Number(check.getColumnValue('num_services'))===0)exec('ALTER COMPUTE POOL PERSONAL_PHOTOS_VIDEO_L40S SUSPEND');}
}
value.pool=pool;return value;
$$;
GRANT OWNERSHIP ON PROCEDURE PERSONAL_MEDIA.APP.VIDEO_PREPARATION_CONTROL(VARCHAR,VARCHAR) TO ROLE PERSONAL_PHOTOS_VIDEO_LAUNCHER COPY CURRENT GRANTS;
GRANT USAGE ON PROCEDURE PERSONAL_MEDIA.APP.VIDEO_JOB_CONTROL(VARCHAR,VARCHAR) TO ROLE PERSONAL_PHOTOS_VIDEO_LAUNCHER;
GRANT USAGE ON PROCEDURE PERSONAL_MEDIA.APP.VIDEO_PREPARATION_CONTROL(VARCHAR,VARCHAR) TO ROLE PERSONAL_PHOTOS_RUNTIME;
