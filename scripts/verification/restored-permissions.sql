-- Runs only against the disposable restored catalog, never the live database.
-- Exercise the restored policies and grants with synthetic rows; roll everything back.
BEGIN;
DO $$ BEGIN
  IF current_database() !~ '^gallery_restore_check_[a-f0-9]{32}$' THEN
    RAISE EXCEPTION 'A disposable restore database is required';
  END IF;
END $$;
DO $$
DECLARE
  owner_name text := 'RESTORE_OWNER_' || replace(gen_random_uuid()::text,'-','');
  viewer_name text := 'RESTORE_VIEWER_' || replace(gen_random_uuid()::text,'-','');
  album_id int;
  photo_id_value int;
  link_id uuid := gen_random_uuid();
  link_hash text := replace(gen_random_uuid()::text || gen_random_uuid()::text,'-','');
  changed int;
BEGIN
  INSERT INTO events(sort_order,event_name,source_folder,owner_username,visibility)
    VALUES(0,'__restore_permission_check','__restore_permission_check',owner_name,'PRIVATE')
    RETURNING event_id INTO album_id;
  INSERT INTO photos(event_id,source_filename,ingest_status)
    VALUES(album_id,'__restore_permission_check.jpg','DISCOVERED')
    RETURNING photo_id INTO photo_id_value;

  SET LOCAL ROLE personal_photos_app;
  IF current_user <> 'personal_photos_app' THEN RAISE EXCEPTION 'Wrong test role'; END IF;
  IF EXISTS(SELECT FROM photos WHERE photo_id=photo_id_value) THEN
    RAISE EXCEPTION 'Unscoped photo read allowed';
  END IF;
  PERFORM set_config('photos.username',owner_name,true),set_config('photos.can_write','true',true),
    set_config('photos.main_admin','false',true),set_config('photos.admin_read','false',true),
    set_config('photos.admin_write','false',true),set_config('photos.access_manager','false',true),
    set_config('photos.public_hash','',true);
  IF NOT EXISTS(SELECT FROM photos WHERE photo_id=photo_id_value) THEN
    RAISE EXCEPTION 'Owner cannot read own photo';
  END IF;
  UPDATE photos SET caption='owner edit' WHERE photo_id=photo_id_value;
  GET DIAGNOSTICS changed=ROW_COUNT;
  IF changed<>1 THEN RAISE EXCEPTION 'Owner cannot edit own photo'; END IF;

  PERFORM set_config('photos.username',viewer_name,true);
  IF EXISTS(SELECT FROM events WHERE event_id=album_id) OR
     EXISTS(SELECT FROM photos WHERE photo_id=photo_id_value) THEN
    RAISE EXCEPTION 'Private catalog leaked to another user';
  END IF;
  UPDATE photos SET caption='forbidden' WHERE photo_id=photo_id_value;
  GET DIAGNOSTICS changed=ROW_COUNT;
  IF changed<>0 THEN RAISE EXCEPTION 'Private photo write allowed'; END IF;
  BEGIN
    PERFORM 1 FROM photo_security.app_principals LIMIT 1;
    RAISE EXCEPTION 'App can read permission authority directly';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  IF pg_has_role(current_user,'personal_photos_maintenance','MEMBER') OR
     (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname=current_user) THEN
    RAISE EXCEPTION 'App role has elevated database privileges';
  END IF;

  PERFORM set_config('photos.username',owner_name,true);
  INSERT INTO album_shares(event_id,username,created_by) VALUES(album_id,viewer_name,owner_name);
  PERFORM set_config('photos.username',viewer_name,true);
  IF NOT EXISTS(SELECT FROM photos WHERE photo_id=photo_id_value) THEN
    RAISE EXCEPTION 'Shared photo is not visible';
  END IF;
  UPDATE photos SET caption='forbidden shared edit' WHERE photo_id=photo_id_value;
  GET DIAGNOSTICS changed=ROW_COUNT;
  IF changed<>0 THEN RAISE EXCEPTION 'Share recipient can edit owner photo'; END IF;
  PERFORM set_config('photos.username',owner_name,true);
  DELETE FROM album_shares WHERE event_id=album_id AND username=viewer_name;
  PERFORM set_config('photos.username',viewer_name,true);
  IF EXISTS(SELECT FROM photos WHERE photo_id=photo_id_value) THEN
    RAISE EXCEPTION 'Revoked share still readable';
  END IF;

  PERFORM set_config('photos.username',owner_name,true);
  INSERT INTO album_public_links(id,event_id,token_hash,owner_username,created_by,expires_at)
    VALUES(link_id,album_id,link_hash,owner_name,owner_name,now()+interval '1 hour');
  PERFORM set_config('photos.username','',true),set_config('photos.can_write','false',true),
    set_config('photos.public_hash',link_hash,true);
  IF NOT EXISTS(SELECT FROM photos WHERE photo_id=photo_id_value) THEN
    RAISE EXCEPTION 'Public capability cannot read its album';
  END IF;
  UPDATE photos SET caption='forbidden public edit' WHERE photo_id=photo_id_value;
  GET DIAGNOSTICS changed=ROW_COUNT;
  IF changed<>0 THEN RAISE EXCEPTION 'Public capability permits writes'; END IF;
  PERFORM set_config('photos.username',owner_name,true),set_config('photos.can_write','true',true),
    set_config('photos.public_hash','',true);
  UPDATE album_public_links SET revoked_at=now() WHERE id=link_id;
  PERFORM set_config('photos.username','',true),set_config('photos.can_write','false',true),
    set_config('photos.public_hash',link_hash,true);
  IF EXISTS(SELECT FROM photos WHERE photo_id=photo_id_value) THEN
    RAISE EXCEPTION 'Revoked public capability still readable';
  END IF;
  PERFORM set_config('photos.username',owner_name,true),set_config('photos.public_hash','',true),
    set_config('photos.admin_read','true',true);
  UPDATE photos SET caption='forbidden readonly edit' WHERE photo_id=photo_id_value;
  GET DIAGNOSTICS changed=ROW_COUNT;
  IF changed<>0 THEN RAISE EXCEPTION 'Read-only owner can mutate photo'; END IF;
END $$;
ROLLBACK;
