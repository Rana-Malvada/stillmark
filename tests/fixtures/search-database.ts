import { createTestDatabase } from './test-database'

const DANA = '22222222-2222-4222-8222-222222222222'
const KEITH = '33333333-3333-4333-8333-333333333333'
const BOBS = '44444444-4444-4444-8444-444444444444'
export async function createSearchDatabase() {
  const db = await createTestDatabase({
    extensions: true,
    roles: [
      'snowflake_admin',
      'personal_photos_app NOINHERIT',
      'personal_photos_reader',
      'personal_photos_video_worker',
      'personal_photos_maintenance',
    ],
    steps: [
      {
        sql: `SET search_path=public;GRANT USAGE ON SCHEMA public TO personal_photos_app;
 GRANT SELECT ON folders,video_analyses,photo_trash TO personal_photos_app; GRANT SELECT,INSERT,UPDATE,DELETE ON events,photos,album_shares,album_public_links,stage_cleanup TO personal_photos_app;
 INSERT INTO events(event_id,sort_order,event_name,source_folder,owner_username,visibility,event_year) VALUES
  (1,1,'Beach week','a','ALICE','PRIVATE',2024),(2,2,'Ski trip','b','ALICE','PRIVATE',2025),(3,3,'Bob album','c','BOB','PRIVATE',2025);
 INSERT INTO album_shares(event_id,username,created_by) VALUES(1,'CAROL','ALICE');`,
      },
      'setup/72-app-rls.sql',
      '202610072000_people_faces',
      '202610072010_people_worker_queue',
      '202610212100_search_sessions',
      '202610212110_search_enrichment',
      '202610212120_search_batch_completion',
      '202610212130_search_revision_changes',
      '202610291900_scoped_search_revisions',
      {
        sql: `INSERT INTO face_settings(owner_username,enabled) VALUES('ALICE',true),('BOB',true);
 INSERT INTO photos(photo_id,event_id,source_filename,media_type,ingest_status,original_stage_path,ai_description) VALUES
  (1,1,'1.jpg','photo','READY','o/1','sunny beach sand'),
  (2,1,'2.jpg','photo','READY','o/2','beach dinner'),
  (3,2,'3.jpg','photo','READY','o/3','ski slope snow'),
  (4,2,'4.jpg','photo','READY','o/4','Dana written in a caption'),
  (5,3,'5.jpg','photo','READY','o/5','beach');
 INSERT INTO face_people(person_id,owner_username,name) VALUES('${DANA}','ALICE','Dana'),('${KEITH}','ALICE','Keith Lambert'),('${BOBS}','BOB','Dana');
 INSERT INTO faces(photo_id,owner_username,source,source_path,model_version,face_index,box_x,box_y,box_w,box_h,detection_score,quality,quality_ok,embedding) VALUES
  (1,'ALICE','detected','o/1','m',0,0.1,0.1,0.2,0.2,0.9,0.9,true,'[1,0]'),
  (1,'ALICE','detected','o/1','m',1,0.5,0.1,0.2,0.2,0.9,0.9,true,'[0,1]'),
  (2,'ALICE','detected','o/2','m',0,0.1,0.1,0.2,0.2,0.9,0.9,true,'[1,0]'),
  (3,'ALICE','detected','o/3','m',0,0.1,0.1,0.2,0.2,0.9,0.9,true,'[1,0]'),
  (3,'ALICE','detected','o/3','m',1,0.5,0.1,0.2,0.2,0.9,0.9,true,'[0,1]'),
  (5,'BOB','detected','o/5','m',0,0.1,0.1,0.2,0.2,0.9,0.9,true,'[1,0]');
 INSERT INTO face_assignments(face_id,person_id,owner_username,status,score)
  SELECT f.face_id,x.person,f.owner_username,x.status,0.8 FROM faces f JOIN (VALUES
   (1,0,'${DANA}'::uuid,'confirmed'),(1,1,'${KEITH}'::uuid,'auto'),(2,0,'${DANA}'::uuid,'auto'),
   (3,0,'${DANA}'::uuid,'suggested'),(3,1,'${KEITH}'::uuid,'confirmed'),(5,0,'${BOBS}'::uuid,'confirmed'))
   x(photo,idx,person,status) ON x.photo=f.photo_id AND x.idx=f.face_index;`,
      },
    ],
  })
  return db
}
