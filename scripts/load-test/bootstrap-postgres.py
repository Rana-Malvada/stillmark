#!/usr/bin/env python3
"""Restore schema only into the dedicated test instance; credentials never go to stdout."""
import json, os, pathlib, secrets, subprocess, sys

BIN = pathlib.Path('/opt/homebrew/opt/libpq/bin')
TARGET = 'stillmark_loadtest_baseline'
ROLES = ('personal_photos_app','personal_photos_face_worker','personal_photos_maintenance',
         'personal_photos_reader','personal_photos_search_worker','personal_photos_upload_queue',
         'personal_photos_video_worker')

def main():
    os.umask(0o077)
    private = pathlib.Path('.load-tests/provisioning')
    response = private / 'postgres-create-result.json'
    if response.stat().st_mode & 0o077:
        raise RuntimeError('Provisioning response must be private')
    row = json.loads(response.read_text())[-1][0]
    access = row['access_roles']
    if isinstance(access,str): access=json.loads(access)
    production = json.loads(pathlib.Path('config/deployment.json').read_text())
    host=row['host']
    if host==production['PG_HOST'] or not host.endswith('.postgres.snowflake.app'):
        raise RuntimeError('Distinct isolated Postgres host required')
    env={**os.environ,'PGHOST':host,'PGPORT':'5432','PGUSER':'snowflake_admin',
         'PGPASSWORD':access['snowflake_admin'],'PGSSLMODE':'verify-full',
         'PGSSLROOTCERT':str(pathlib.Path('certs/postgres-root.crt').resolve()),
         'PGCONNECT_TIMEOUT':'10','PGDATABASE':'postgres'}
    def run(tool,*args,input=None):
        p=subprocess.run([str(BIN/tool),*args],env=env,text=True,input=input,capture_output=True)
        if p.returncode:
            (private/'bootstrap-error.txt').write_text(p.stderr)
            raise RuntimeError(f'{tool} failed; diagnostics saved privately')
        return p.stdout
    def sql(text):return run('psql','-X','-v','ON_ERROR_STOP=1','-At',input=text)
    archive=private/'schema.dump'
    toc=run('pg_restore','--list',str(archive))
    if any(marker in toc for marker in ('TABLE DATA','SEQUENCE SET','MATERIALIZED VIEW DATA','BLOB')):
        raise RuntimeError('Only a schema-only archive is permitted')
    # Non-idempotent by design: an existing target needs inspection, never a destructive reset.
    sql(f'CREATE DATABASE {TARGET};')
    env['PGDATABASE']=TARGET
    for role in ROLES:
        sql(f'CREATE ROLE {role} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;')
    for ext in ('vector','pg_trgm','pg_stat_statements','pgaudit'):
        sql(f'CREATE EXTENSION IF NOT EXISTS {ext};')
    selection=private/'schema.list'
    selection.write_text('\n'.join(line for line in toc.splitlines() if
      ' SCHEMA - public ' not in line and ' COMMENT - SCHEMA public ' not in line
      and ' DEFAULT ACL public DEFAULT PRIVILEGES FOR TABLES application' not in line)+'\n')
    run('pg_restore','--dbname='+TARGET,'--exit-on-error','--no-owner','--use-list='+str(selection),str(archive))
    # pg_dump restores object ACLs, not cluster-wide role memberships. Browsing
    # explicitly SET ROLEs to the catalog reader; preserve that narrow capability.
    sql('GRANT personal_photos_reader TO personal_photos_app WITH INHERIT FALSE, SET TRUE;')
    if sql("SELECT pg_has_role('personal_photos_app','personal_photos_reader','SET');").strip() != 't':
        raise RuntimeError('Catalog reader role membership was not restored')
    sql(pathlib.Path('scripts/load-test/install-telemetry.sql').read_text())
    passwords={role:secrets.token_urlsafe(48) for role in ('personal_photos_app','personal_photos_upload_queue')}
    # Write recovery material before altering roles; it is never committed or bundled.
    (private/'test-secrets.json').write_text(json.dumps({'host':host,'database':TARGET,'passwords':passwords}))
    for role,password in passwords.items():
        sql(f"ALTER ROLE {role} LOGIN PASSWORD '{password}'; GRANT CONNECT ON DATABASE {TARGET} TO {role};")
    proof=sql('SELECT current_database(),(SELECT count(*) FROM photos),(SELECT count(*) FROM upload_processing_jobs);')
    (private/'bootstrap-proof.txt').write_text(proof)
    print('Isolated schema restored; fixture guards installed; app and queue credentials saved privately.')

if __name__=='__main__':
    try:main()
    except Exception as error:
        print(str(error),file=sys.stderr);sys.exit(1)
