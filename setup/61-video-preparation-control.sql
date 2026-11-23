-- Historical migration. Current deployments must also apply 67 and 68; do not rerun this alone.
GRANT CREATE PROCEDURE ON SCHEMA PERSONAL_MEDIA.APP TO ROLE PERSONAL_PHOTOS_VIDEO_WORKER;
GRANT OPERATE,MONITOR,MODIFY ON COMPUTE POOL PERSONAL_PHOTOS_VIDEO_L40S TO ROLE PERSONAL_PHOTOS_VIDEO_WORKER;
USE ROLE PERSONAL_PHOTOS_VIDEO_WORKER;
CREATE OR REPLACE PROCEDURE PERSONAL_MEDIA.APP.VIDEO_PREPARATION_CONTROL(RUN_ID VARCHAR,ACTION VARCHAR)
RETURNS VARIANT LANGUAGE JAVASCRIPT EXECUTE AS OWNER AS $$
if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(RUN_ID))throw 'Invalid run ID';
if(ACTION!=='START'&&ACTION!=='STATUS')throw 'Invalid action';
var name='VIDEO_PREP_'+RUN_ID.replace(/-/g,'').toUpperCase();
function exec(sql){return snowflake.createStatement({sqlText:sql}).execute();}
var jobs=exec("SHOW JOB SERVICES LIKE '"+name+"' IN SCHEMA PERSONAL_MEDIA.APP");
var status='NOT_FOUND';while(jobs.next()){if(jobs.getColumnValue('name')===name)status=jobs.getColumnValue('status');}
var pools=exec("SHOW COMPUTE POOLS LIKE 'PERSONAL_PHOTOS_VIDEO_L40S'");var pool='UNKNOWN';
while(pools.next()){if(pools.getColumnValue('name')==='PERSONAL_PHOTOS_VIDEO_L40S')pool=pools.getColumnValue('state');}
if(ACTION==='START'&&status==='NOT_FOUND'){
 exec('ALTER COMPUTE POOL PERSONAL_PHOTOS_VIDEO_L40S SET AUTO_SUSPEND_SECS=60');
 if(pool==='SUSPENDED')exec('ALTER COMPUTE POOL PERSONAL_PHOTOS_VIDEO_L40S RESUME');
 var spec={"spec": {"containers": [{"name": "worker", "image": "/personal_media/app/photos_repo/video-worker:l40s-v4", "command": ["/usr/bin/timeout"], "args": ["7500", "/usr/local/bin/node", "/worker/worker.mjs"], "env": {"NVIDIA_DRIVER_CAPABILITIES": "compute,video,utility", "PG_HOST": "pg-instance.exampleorg-exampleacct.us-east-2.aws.postgres.snowflake.app", "PG_DATABASE": "postgres", "PG_USER": "personal_photos_video_worker", "PG_SSL_ROOT_CERT": "/worker/postgres-root.crt", "WORKER_CONCURRENCY": "2", "WORKER_MAX_JOBS": "10000", "WORKER_MAX_SECONDS": "7200", "WORKER_RUN_ID": "RUN_ID"}, "secrets": [{"snowflakeSecret": "PERSONAL_MEDIA.APP.VIDEO_WORKER_PG_SECRET", "directoryPath": "/secrets/PG_SECRET"}], "resources": {"requests": {"cpu": 4, "memory": "8Gi", "nvidia.com/gpu": 1}, "limits": {"cpu": 6, "memory": "24Gi", "nvidia.com/gpu": 1}}, "volumeMounts": [{"name": "originals", "mountPath": "/input"}, {"name": "playback", "mountPath": "/output"}]}], "volumes": [{"name": "originals", "source": "stage", "stageConfig": {"name": "@PERSONAL_MEDIA.RAW.PHOTO_FILES"}}, {"name": "playback", "source": "stage", "stageConfig": {"name": "@PERSONAL_MEDIA.RAW.PHOTO_FILES/display/video"}}]}};
 spec.spec.containers[0].env.WORKER_RUN_ID=RUN_ID;
 var text=JSON.stringify(spec).replace(/'/g,"''");
 try{exec("EXECUTE JOB SERVICE IN COMPUTE POOL PERSONAL_PHOTOS_VIDEO_L40S NAME=PERSONAL_MEDIA.APP."+name+" EXTERNAL_ACCESS_INTEGRATIONS=(PERSONAL_PHOTOS_VIDEO_EAI) ASYNC=TRUE FROM SPECIFICATION '"+text+"'");status='PENDING';}
 catch(e){if(String(e).indexOf('already exists')<0)throw e;status='PENDING';}
}
return {status:status,pool:pool,job:name};
$$;
GRANT USAGE ON PROCEDURE PERSONAL_MEDIA.APP.VIDEO_PREPARATION_CONTROL(VARCHAR,VARCHAR) TO ROLE PERSONAL_PHOTOS_RUNTIME;
