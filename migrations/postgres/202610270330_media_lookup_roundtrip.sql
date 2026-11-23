-- One implicit transaction performs identity setup and the indexed media read.
-- Invoker security preserves the app role's existing RLS. Only the trusted app
-- credential may execute this function; clients never supply the identity object.
SET LOCAL lock_timeout='5s';
CREATE OR REPLACE FUNCTION photo_security.lookup_media(p_path text,p_identity jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER
SET search_path=pg_catalog,public AS $function$
DECLARE result jsonb;
BEGIN
 IF coalesce(p_identity->>'username','')='' THEN
  RAISE EXCEPTION 'Media identity required' USING ERRCODE='42501';
 END IF;
 PERFORM set_config('photos.username',p_identity->>'username',true),
 set_config('photos.main_admin',coalesce(p_identity->>'mainAdmin','false'),true),
 set_config('photos.admin_read',coalesce(p_identity->>'adminRead','false'),true),
 set_config('photos.admin_write','false',true),
 set_config('photos.can_write','false',true),
 set_config('photos.access_manager','false',true),
 set_config('photos.public_hash','',true);
 SELECT to_jsonb(hit) INTO result FROM (
WITH candidate AS MATERIALIZED (
 SELECT photo_id,event_id,original_stage_path,file_size_bytes,thumbnail_stage_path FROM photos WHERE original_stage_path=p_path
 UNION ALL
 SELECT photo_id,event_id,original_stage_path,file_size_bytes,thumbnail_stage_path FROM photos WHERE display_stage_path=p_path
 UNION ALL
 SELECT photo_id,event_id,original_stage_path,file_size_bytes,thumbnail_stage_path FROM photos WHERE thumbnail_stage_path=p_path
 UNION ALL
 SELECT p.photo_id,p.event_id,p.original_stage_path,p.file_size_bytes,p.thumbnail_stage_path
 FROM video_playback v JOIN photos p ON p.photo_id=v.photo_id AND p.original_stage_path=v.original_path
 WHERE v.status='ready' AND v.stage_path=p_path
 UNION ALL
 SELECT p.photo_id,p.event_id,p.original_stage_path,p.file_size_bytes,p.thumbnail_stage_path
 FROM video_rendition_paths r JOIN video_playback v ON v.photo_id=r.photo_id
 JOIN photos p ON p.photo_id=v.photo_id AND p.original_stage_path=v.original_path
 WHERE v.status='ready' AND r.stage_path=p_path
)
SELECT c.* FROM candidate c JOIN events e ON e.event_id=c.event_id
WHERE coalesce((p_identity->>'mainAdmin')::boolean,false) OR e.owner_username=p_identity->>'username' OR e.visibility='GALLERY'
 OR EXISTS(SELECT 1 FROM album_shares s WHERE s.event_id=e.event_id AND s.username=p_identity->>'username')
LIMIT 1
 ) hit;
 RETURN result;
END
$function$;
REVOKE ALL ON FUNCTION photo_security.lookup_media(text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION photo_security.lookup_media(text,jsonb) TO personal_photos_app;
