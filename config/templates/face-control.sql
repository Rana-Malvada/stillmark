-- Face scan controls. The job procedure is owned by the job role and only creates,
-- inspects or drops FACE_SCAN_<run> jobs. The public procedure is owned by the
-- launcher role, resumes the face pool for START and suspends it only when no job or
-- service remains on it. Neither touches the video GPU pool.
CREATE OR REPLACE PROCEDURE {{DATABASE}}.{{APP_SCHEMA}}.{{FACE_JOB_CONTROL}}(RUN_ID VARCHAR,ACTION VARCHAR) RETURNS VARIANT LANGUAGE JAVASCRIPT EXECUTE AS OWNER AS $$
if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(RUN_ID))throw 'Invalid run ID';
if(ACTION!=='START'&&ACTION!=='STATUS'&&ACTION!=='CANCEL')throw 'Invalid action';
function exec(sql,binds){return snowflake.createStatement({sqlText:sql,binds:binds||[]}).execute();}
var name='FACE_SCAN_'+RUN_ID.replace(/-/g,'').toUpperCase();
var jobs=exec("SHOW JOB SERVICES LIKE '"+name+"' IN SCHEMA {{DATABASE}}.{{APP_SCHEMA}}"),status='NOT_FOUND';
while(jobs.next()){if(jobs.getColumnValue('name')===name)status=jobs.getColumnValue('status');}
if(ACTION==='CANCEL'){exec('DROP SERVICE IF EXISTS {{DATABASE}}.{{APP_SCHEMA}}.'+name);return {status:'CANCELLED',job:name};}
if(ACTION==='START'&&status==='NOT_FOUND'){
 var spec=SPEC;
 spec.spec.containers[0].env.WORKER_RUN_ID=RUN_ID;
 var text=JSON.stringify(spec).replace(/'/g,"''");
 try{exec("EXECUTE JOB SERVICE IN COMPUTE POOL {{FACE_POOL}} NAME={{DATABASE}}.{{APP_SCHEMA}}."+name+" EXTERNAL_ACCESS_INTEGRATIONS=({{FACE_EAI}}) ASYNC=TRUE FROM SPECIFICATION '"+text+"'");status='PENDING';}
 catch(e){if(String(e).indexOf('already exists')<0)throw e;status='PENDING';}
}
var containers=[];
if(ACTION==='STATUS'&&status!=='NOT_FOUND'){
 try{
  var cs=exec("SELECT SYSTEM$GET_SERVICE_STATUS(?)",['{{DATABASE}}.{{APP_SCHEMA}}.'+name]);cs.next();
  var rows=cs.getColumnValue(1);if(typeof rows==='string')rows=JSON.parse(rows);
  containers=rows.slice(0,4).map(function(r){return {status:String(r.status||'').slice(0,80),message:String(r.message||'').slice(0,1200)};});
 }catch(e){containers=[{status:'UNKNOWN',message:'Container status unavailable'}];}
}
return {status:status,job:name,containers:containers};
$$;
GRANT OWNERSHIP ON PROCEDURE {{DATABASE}}.{{APP_SCHEMA}}.{{FACE_JOB_CONTROL}}(VARCHAR,VARCHAR) TO ROLE {{FACE_ROLE}} COPY CURRENT GRANTS;
CREATE OR REPLACE PROCEDURE {{DATABASE}}.{{APP_SCHEMA}}.{{FACE_CONTROL}}(RUN_ID VARCHAR,ACTION VARCHAR) RETURNS VARIANT LANGUAGE JAVASCRIPT EXECUTE AS OWNER AS $$
if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(RUN_ID))throw 'Invalid run ID';
if(ACTION!=='START'&&ACTION!=='STATUS'&&ACTION!=='CANCEL'&&ACTION!=='SETTLE')throw 'Invalid action';
function exec(sql,binds){return snowflake.createStatement({sqlText:sql,binds:binds||[]}).execute();}
function job(action){var r=exec('CALL {{DATABASE}}.{{APP_SCHEMA}}.{{FACE_JOB_CONTROL}}(?,?)',[RUN_ID,action]);r.next();var v=r.getColumnValue(1);return typeof v==='string'?JSON.parse(v):v;}
function poolState(){var p=exec("SHOW COMPUTE POOLS LIKE '{{FACE_POOL}}'"),s={state:'UNKNOWN',jobs:0,services:0};
 while(p.next()){if(p.getColumnValue('name')==='{{FACE_POOL}}')s={state:p.getColumnValue('state'),jobs:Number(p.getColumnValue('num_jobs')),services:Number(p.getColumnValue('num_services'))};}return s;}
var value=job(ACTION==='CANCEL'?'CANCEL':'STATUS');
if(ACTION==='START'&&value.status==='NOT_FOUND'){
 if(poolState().state==='SUSPENDED')exec('ALTER COMPUTE POOL {{FACE_POOL}} RESUME');
 value=job('START');
}
// Suspend after cancel or once the run's job has ended, never while any job remains.
var ended=value.status==='CANCELLED'||value.status==='DONE'||value.status==='FAILED'||value.status==='NOT_FOUND';
var pool=poolState();
if((ACTION==='CANCEL'||ACTION==='SETTLE')&&ended&&pool.jobs===0&&pool.services===0&&pool.state!=='SUSPENDED'){
 exec('ALTER COMPUTE POOL {{FACE_POOL}} SUSPEND');pool.state='SUSPENDING';
}
value.pool=pool.state;return value;
$$;
GRANT OWNERSHIP ON PROCEDURE {{DATABASE}}.{{APP_SCHEMA}}.{{FACE_CONTROL}}(VARCHAR,VARCHAR) TO ROLE {{FACE_LAUNCHER_ROLE}} COPY CURRENT GRANTS;
GRANT USAGE ON PROCEDURE {{DATABASE}}.{{APP_SCHEMA}}.{{FACE_JOB_CONTROL}}(VARCHAR,VARCHAR) TO ROLE {{FACE_LAUNCHER_ROLE}};
GRANT USAGE ON PROCEDURE {{DATABASE}}.{{APP_SCHEMA}}.{{FACE_CONTROL}}(VARCHAR,VARCHAR) TO ROLE {{RESOURCE_PERSONAL_PHOTOS_RUNTIME}};
