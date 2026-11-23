-- Preserve bounded startup diagnostics before cancellation. No pool resume on STATUS.
CREATE OR REPLACE PROCEDURE {{DATABASE}}.{{APP_SCHEMA}}.{{VIDEO_JOB_CONTROL}}(RUN_ID VARCHAR,ACTION VARCHAR) RETURNS VARIANT LANGUAGE JAVASCRIPT EXECUTE AS OWNER AS $$
if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(RUN_ID))throw 'Invalid run ID';
if(ACTION!=='START'&&ACTION!=='STATUS'&&ACTION!=='CANCEL')throw 'Invalid action';
function exec(sql,binds){return snowflake.createStatement({sqlText:sql,binds:binds||[]}).execute();}
var name='VIDEO_PREP_'+RUN_ID.replace(/-/g,'').toUpperCase();
var jobs=exec("SHOW JOB SERVICES LIKE '"+name+"' IN SCHEMA {{DATABASE}}.{{APP_SCHEMA}}"),status='NOT_FOUND';
while(jobs.next()){if(jobs.getColumnValue('name')===name)status=jobs.getColumnValue('status');}
if(ACTION==='CANCEL'){exec('DROP SERVICE IF EXISTS {{DATABASE}}.{{APP_SCHEMA}}.'+name);return {status:'CANCELLED',job:name};}
if(ACTION==='START'&&status==='NOT_FOUND'){
 var spec={"spec": {"containers": [{"name": "worker", "image": "{{GPU_IMAGE}}", "command": ["/usr/bin/timeout"], "args": ["--kill-after=30s", "7500", "/usr/local/bin/node", "/worker/worker.mjs"], "env": {"NVIDIA_DRIVER_CAPABILITIES": "compute,video,utility", "PG_HOST": "{{PG_HOST}}", "PG_DATABASE": "{{PG_DATABASE}}", "PG_USER": "{{GPU_PG_USER}}", "PG_SSL_ROOT_CERT": "/worker/postgres-root.crt", "WORKER_CONCURRENCY": "2", "WORKER_MAX_JOBS": "10000", "WORKER_MAX_SECONDS": "7200", "WORKER_RUN_ID": "RUN_ID"}, "secrets": [{"snowflakeSecret": "{{DATABASE}}.{{APP_SCHEMA}}.{{GPU_SECRET}}", "directoryPath": "/secrets/PG_SECRET"}], "resources": {"requests": {"cpu": 4, "memory": "8Gi", "nvidia.com/gpu": 1}, "limits": {"cpu": 6, "memory": "24Gi", "nvidia.com/gpu": 1}}, "volumeMounts": [{"name": "originals", "mountPath": "/input"}, {"name": "playback", "mountPath": "/output"}]}], "volumes": [{"name": "originals", "source": "stage", "uid": 65532, "gid": 65532, "stageConfig": {"name": "@{{DATABASE}}.{{RAW_SCHEMA}}.{{PHOTO_STAGE}}"}}, {"name": "playback", "source": "stage", "uid": 65532, "gid": 65532, "stageConfig": {"name": "@{{DATABASE}}.{{RAW_SCHEMA}}.{{DERIVED_STAGE}}/display/prepared"}}]}};
 spec.spec.containers[0].env.WORKER_RUN_ID=RUN_ID;
 var text=JSON.stringify(spec).replace(/'/g,"''");
 try{exec("EXECUTE JOB SERVICE IN COMPUTE POOL {{GPU_POOL}} NAME={{DATABASE}}.{{APP_SCHEMA}}."+name+" EXTERNAL_ACCESS_INTEGRATIONS=({{GPU_EAI}}) ASYNC=TRUE FROM SPECIFICATION '"+text+"'");status='PENDING';}
 catch(e){if(String(e).indexOf('already exists')<0)throw e;status='PENDING';}
}
var containers=[];
if(ACTION==='STATUS'&&status!=='NOT_FOUND'){
 try{
  var cs=exec("SELECT SYSTEM$GET_SERVICE_STATUS(?)",[ '{{DATABASE}}.{{APP_SCHEMA}}.'+name ]);cs.next();
  var rows=cs.getColumnValue(1);if(typeof rows==='string')rows=JSON.parse(rows);
  containers=rows.slice(0,4).map(function(r){return {status:String(r.status||'').slice(0,80),message:String(r.message||'').slice(0,1200)};});
 }catch(e){containers=[{status:'UNKNOWN',message:'Container status unavailable'}];}
}
return {status:status,job:name,containers:containers};
$$;
GRANT OWNERSHIP ON PROCEDURE {{DATABASE}}.{{APP_SCHEMA}}.{{VIDEO_JOB_CONTROL}}(VARCHAR,VARCHAR) TO ROLE {{GPU_ROLE}} COPY CURRENT GRANTS;
CREATE OR REPLACE PROCEDURE {{DATABASE}}.{{APP_SCHEMA}}.{{VIDEO_CONTROL}}(RUN_ID VARCHAR,ACTION VARCHAR) RETURNS VARIANT LANGUAGE JAVASCRIPT EXECUTE AS OWNER AS $$
if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(RUN_ID))throw 'Invalid run ID';
if(ACTION!=='START'&&ACTION!=='STATUS'&&ACTION!=='CANCEL')throw 'Invalid action';
function exec(sql,binds){return snowflake.createStatement({sqlText:sql,binds:binds||[]}).execute();}
var pools=exec("DESCRIBE COMPUTE POOL {{GPU_POOL}}"),pool='UNKNOWN',diagnostics={};
while(pools.next()){
 pool=pools.getColumnValue('state');
 diagnostics={activeNodes:Number(pools.getColumnValue('active_nodes')),idleNodes:Number(pools.getColumnValue('idle_nodes')),targetNodes:Number(pools.getColumnValue('target_nodes')),errorCode:String(pools.getColumnValue('error_code')||'').slice(0,80),message:String(pools.getColumnValue('status_message')||'').slice(0,1200)};
}
var result=exec('CALL {{DATABASE}}.{{APP_SCHEMA}}.{{VIDEO_JOB_CONTROL}}(?,?)',[RUN_ID,ACTION==='CANCEL'?'CANCEL':'STATUS']);result.next();
var value=result.getColumnValue(1);if(typeof value==='string')value=JSON.parse(value);
if(ACTION==='START'&&value.status==='NOT_FOUND'){
 if(pool==='SUSPENDED')exec('ALTER COMPUTE POOL {{GPU_POOL}} RESUME');
 result=exec('CALL {{DATABASE}}.{{APP_SCHEMA}}.{{VIDEO_JOB_CONTROL}}(?,?)',[RUN_ID,'START']);result.next();
 value=result.getColumnValue(1);if(typeof value==='string')value=JSON.parse(value);
}
if(ACTION==='CANCEL'){
 var check=exec("SHOW COMPUTE POOLS LIKE '{{GPU_POOL}}'");
 while(check.next()){if(check.getColumnValue('name')==='{{GPU_POOL}}'&&Number(check.getColumnValue('num_jobs'))===0&&Number(check.getColumnValue('num_services'))===0)exec('ALTER COMPUTE POOL {{GPU_POOL}} SUSPEND');}
}
value.pool=pool;value.diagnostics=diagnostics;return value;
$$;
GRANT OWNERSHIP ON PROCEDURE {{DATABASE}}.{{APP_SCHEMA}}.{{VIDEO_CONTROL}}(VARCHAR,VARCHAR) TO ROLE PERSONAL_PHOTOS_VIDEO_LAUNCHER COPY CURRENT GRANTS;
GRANT USAGE ON PROCEDURE {{DATABASE}}.{{APP_SCHEMA}}.{{VIDEO_JOB_CONTROL}}(VARCHAR,VARCHAR) TO ROLE PERSONAL_PHOTOS_VIDEO_LAUNCHER;
GRANT USAGE ON PROCEDURE {{DATABASE}}.{{APP_SCHEMA}}.{{VIDEO_CONTROL}}(VARCHAR,VARCHAR) TO ROLE PERSONAL_PHOTOS_RUNTIME;
