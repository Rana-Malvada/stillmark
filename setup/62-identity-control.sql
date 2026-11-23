-- CLI MUST use --enable-templating NONE to preserve JavaScript && operators.
-- Staged cutover: preserve the old app until the new release is healthy.
USE ROLE ACCOUNTADMIN;
CREATE ROLE IF NOT EXISTS PERSONAL_PHOTOS_IDENTITY_OWNER;
-- Read-only current user metadata; SHOW avoids warehouse work during authentication.
GRANT MONITOR USER ON ACCOUNT TO ROLE PERSONAL_PHOTOS_RUNTIME;
GRANT ROLE PERSONAL_PHOTOS_IDENTITY_OWNER TO ROLE SYSADMIN;
GRANT ROLE PERSONAL_PHOTOS_IDENTITY_OWNER TO ROLE PERSONAL_PHOTOS_RUNTIME;
GRANT USAGE ON DATABASE PERSONAL_MEDIA TO ROLE PERSONAL_PHOTOS_IDENTITY_OWNER;
CREATE SCHEMA IF NOT EXISTS PERSONAL_MEDIA.IDENTITY;
GRANT OWNERSHIP ON SCHEMA PERSONAL_MEDIA.IDENTITY TO ROLE PERSONAL_PHOTOS_IDENTITY_OWNER COPY CURRENT GRANTS;
GRANT CREATE USER,CREATE ROLE ON ACCOUNT TO ROLE PERSONAL_PHOTOS_IDENTITY_OWNER;
GRANT USAGE ON NETWORK POLICY PERSONAL_PHOTOS_NO_DIRECT_LOGIN TO ROLE PERSONAL_PHOTOS_IDENTITY_OWNER;
GRANT OWNERSHIP ON USER GALLERYOWNER TO ROLE PERSONAL_PHOTOS_IDENTITY_OWNER COPY CURRENT GRANTS;
GRANT OWNERSHIP ON USER GALLERYMEMBER TO ROLE PERSONAL_PHOTOS_IDENTITY_OWNER COPY CURRENT GRANTS;
GRANT OWNERSHIP ON USER RAUL TO ROLE PERSONAL_PHOTOS_IDENTITY_OWNER COPY CURRENT GRANTS;
GRANT OWNERSHIP ON USER MEMBERONE TO ROLE PERSONAL_PHOTOS_IDENTITY_OWNER COPY CURRENT GRANTS;
GRANT OWNERSHIP ON USER VL TO ROLE PERSONAL_PHOTOS_IDENTITY_OWNER COPY CURRENT GRANTS;
GRANT OWNERSHIP ON ROLE PERSONAL_PHOTOS_VIEWER TO ROLE PERSONAL_PHOTOS_IDENTITY_OWNER COPY CURRENT GRANTS;
GRANT OWNERSHIP ON ROLE PERSONAL_PHOTOS_ADMIN TO ROLE PERSONAL_PHOTOS_IDENTITY_OWNER COPY CURRENT GRANTS;
GRANT OWNERSHIP ON ROLE PERSONAL_PHOTOS_ADMIN_READONLY TO ROLE PERSONAL_PHOTOS_IDENTITY_OWNER COPY CURRENT GRANTS;
GRANT OWNERSHIP ON ROLE PERSONAL_PHOTOS_ACCESS_MANAGER TO ROLE PERSONAL_PHOTOS_IDENTITY_OWNER COPY CURRENT GRANTS;
GRANT OWNERSHIP ON ROLE PERSONAL_PHOTOS_APP_OWNER TO ROLE PERSONAL_PHOTOS_IDENTITY_OWNER COPY CURRENT GRANTS;
GRANT OWNERSHIP ON ROLE PERSONAL_PHOTOS_GROUP_VIEWER TO ROLE PERSONAL_PHOTOS_IDENTITY_OWNER COPY CURRENT GRANTS;
USE ROLE PERSONAL_PHOTOS_IDENTITY_OWNER;
CREATE OR REPLACE PROCEDURE PERSONAL_MEDIA.IDENTITY.GALLERY_IDENTITY_CONTROL(ACTION VARCHAR,PAYLOAD VARCHAR)
RETURNS VARIANT LANGUAGE JAVASCRIPT EXECUTE AS OWNER AS $$
// Embedded in an EXECUTE AS OWNER procedure. No caller-supplied SQL is executed.
var p=JSON.parse(PAYLOAD), base=['PERSONAL_PHOTOS_VIEWER','PERSONAL_PHOTOS_ADMIN','PERSONAL_PHOTOS_ADMIN_READONLY','PERSONAL_PHOTOS_APP_OWNER','PERSONAL_PHOTOS_ACCESS_MANAGER'];
var owner='PERSONAL_PHOTOS_IDENTITY_OWNER';
function fail(){throw 'Gallery identity operation rejected';}
function id(x){if(typeof x!=='string'||!/^[A-Z][A-Z0-9_]{1,99}$/.test(x))fail();return '"'+x+'"';}
function lit(x){if(typeof x!=='string')fail();return "'"+x.replace(/\\/g,'\\\\').replace(/'/g,"''")+"'";}
function marker(x){if(typeof x!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(x))fail();return 'Personal Photos managed access '+x;}
function run(sql){var st=snowflake.createStatement({sqlText:sql}), rs=st.execute(),out=[];while(rs.next()){var r={};for(var i=1;i<=st.getColumnCount();i++)r[st.getColumnName(i).toLowerCase()]=rs.getColumnValue(i);out.push(r);}return out;}
function find(kind,name){id(name);return run('SHOW '+kind+' LIKE '+lit(name)).filter(function(r){return r.name===name;})[0];}
function owned(r){return r&&r.owner===owner;}
function managed(kind,name){var r=find(kind,name);if(!owned(r)||!/^Personal Photos managed access [0-9a-f-]{36}$/i.test(r.comment||''))fail();return r;}
function group(name){return typeof name==='string'&&/^PERSONAL_PHOTOS_GROUP_[A-Z0-9_]+$/.test(name);}
function role(name){
 id(name);if(base.indexOf(name)<0&&!group(name))fail();
 var obj=find('ROLES',name);if(!owned(obj))fail();
 var grants=run('SHOW GRANTS TO ROLE '+id(name));
 if(group(name)){
  managed('ROLES',name);
  if(grants.length!==1||grants[0].granted_on!=='ROLE'||grants[0].privilege!=='USAGE'||base.slice(0,3).indexOf(grants[0].name)<0)fail();
  role(grants[0].name);
 }else{
  // An externally expanded base role must not become a privilege escalation path.
  grants.forEach(function(g){
   var usage=g.privilege==='USAGE';
   var ok=usage&&((g.granted_on==='DATABASE'&&g.name==='PERSONAL_MEDIA')||(g.granted_on==='SCHEMA'&&g.name==='PERSONAL_MEDIA.APP')||(g.granted_on==='APPLICATION SERVICE'&&['PERSONAL_MEDIA.APP.PERSONAL_PHOTOS','PERSONAL_MEDIA.APP.PERSONAL_PHOTOS_APP'].indexOf(g.name)>=0)||(g.granted_on==='ROLE'&&name==='PERSONAL_PHOTOS_APP_OWNER'&&['PERSONAL_PHOTOS_ADMIN','PERSONAL_PHOTOS_ACCESS_MANAGER'].indexOf(g.name)>=0));
   if(!ok)fail();
   if(g.granted_on==='ROLE')role(g.name);
  });
 }
 return grants;
}
function user(name){
 managed('USERS',name);
 var grants=run('SHOW GRANTS TO USER '+id(name));
 grants.forEach(function(g){
  if(g.granted_on==='ROLE'&&g.privilege==='USAGE'){if(g.role!=='PUBLIC')role(g.role);return;}
  var db='USER$'+name;
  if(g.role==null&&g.granted_to==='USER'&&g.grantee_name===name&&((g.granted_on==='DATABASE'&&g.name===db&&['USAGE','CREATE SCHEMA'].indexOf(g.privilege)>=0)||(g.granted_on==='SCHEMA'&&[db+'.PUBLIC',db+'.LOCAL'].indexOf(g.name)>=0&&g.privilege==='OWNERSHIP')))return;
  fail();
 });return grants;
}
function password(x){if(typeof x!=='string'||x.length<14||x.length>256||!/[A-Z]/.test(x)||!/[a-z]/.test(x)||!/[0-9]/.test(x)||/[\x00-\x1f\x7f-\x9f]/.test(x))fail();return lit(x);}
if(!p||typeof p!=='object'||Array.isArray(p))fail();
var name=p.name;id(name);
if(ACTION==='findUser'||ACTION==='findRole'){
 var r=find(ACTION==='findUser'?'USERS':'ROLES',name);
 // Existing unmanaged objects are only reported as occupied names, never adopted.
 if(!r)return [];
 return [{name:r.name,comment:owned(r)?r.comment:null,disabled:owned(r)?r.disabled:true}];
}
if(ACTION==='userGrants')return user(name);
if(ACTION==='roleGrants')return role(name);
if(ACTION==='createUser'){
 if(/^(ACCOUNTADMIN|SECURITYADMIN|SYSADMIN|USERADMIN|PUBLIC|SNOWFLAKE|PERSONAL_PHOTOS_)/.test(name))fail();
 if(typeof p.displayName!=='string'||!p.displayName.trim()||p.displayName.length>100||typeof p.email!=='string'||p.email.length>254||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(p.email))fail();
 var comment=marker(p.marker),existing=find('USERS',name);
 if(existing){if(!owned(existing)||existing.comment!==comment)fail();user(name);return [];}
 return run('CREATE USER '+id(name)+' TYPE=PERSON NETWORK_POLICY=PERSONAL_PHOTOS_NO_DIRECT_LOGIN LOGIN_NAME='+lit(name)+' DISPLAY_NAME='+lit(p.displayName)+' EMAIL='+lit(p.email)+" DEFAULT_ROLE='PUBLIC' DEFAULT_SECONDARY_ROLES=('ALL') COMMENT="+lit(comment)+(p.password===undefined?'':' PASSWORD='+password(p.password)+' MUST_CHANGE_PASSWORD=FALSE'));
}
if(ACTION==='createRole'){
 if(!group(name)||['viewer','admin','admin_readonly'].indexOf(p.profile)<0)fail();
 var parent=base[['viewer','admin','admin_readonly'].indexOf(p.profile)];role(parent);
 var comment=marker(p.marker),existing=find('ROLES',name);
 if(existing){if(!owned(existing)||existing.comment!==comment)fail();var grants=run('SHOW GRANTS TO ROLE '+id(name));if(grants.some(function(g){return g.granted_on!=='ROLE'||g.privilege!=='USAGE'||g.name!==parent;}))fail();}
 else run('CREATE ROLE '+id(name)+' COMMENT='+lit(comment));
 return run('GRANT ROLE '+id(parent)+' TO ROLE '+id(name));
}
var allowed=['restrictUser','disableUser','deleteUser','setPassword','setupLink','grantRole','revokeRole','setDefaultRole'];
if(allowed.indexOf(ACTION)<0)fail();
var grants=user(name);
if(ACTION==='restrictUser')return run('ALTER USER '+id(name)+' SET NETWORK_POLICY=PERSONAL_PHOTOS_NO_DIRECT_LOGIN');
if(ACTION==='disableUser'||ACTION==='deleteUser'){
 if(managed('USERS',name).comment!==marker(p.marker)||grants.some(function(g){return g.role==='PERSONAL_PHOTOS_APP_OWNER';}))fail();
 return run(ACTION==='disableUser'?'ALTER USER '+id(name)+' SET DISABLED=TRUE':'DROP USER '+id(name));
}
if(ACTION==='setPassword')return run('ALTER USER '+id(name)+' SET PASSWORD='+password(p.password)+' MUST_CHANGE_PASSWORD=FALSE');
if(ACTION==='setupLink')return run('ALTER USER '+id(name)+' RESET PASSWORD');
if(ACTION==='setDefaultRole'){
 id(p.role);if(p.role!=='PUBLIC'&&!grants.some(function(g){return g.role===p.role&&g.granted_on==='ROLE'&&g.privilege==='USAGE';}))fail();
 return run('ALTER USER '+id(name)+' SET DEFAULT_ROLE='+lit(p.role));
}
if(p.role==='PERSONAL_PHOTOS_ACCESS_MANAGER')fail(); // assign App Owner through the existing UI instead
role(p.role);
return run((ACTION==='grantRole'?'GRANT':'REVOKE')+' ROLE '+id(p.role)+(ACTION==='grantRole'?' TO':' FROM')+' USER '+id(name));

$$;
GRANT USAGE ON SCHEMA PERSONAL_MEDIA.IDENTITY TO ROLE PERSONAL_PHOTOS_RUNTIME;
GRANT USAGE ON PROCEDURE PERSONAL_MEDIA.IDENTITY.GALLERY_IDENTITY_CONTROL(VARCHAR,VARCHAR) TO ROLE PERSONAL_PHOTOS_RUNTIME;
