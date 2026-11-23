import type { SearchExpression } from '@/lib/search/search-expression'

const field = (field: string, op: string, value: string): SearchExpression => ({ field, op, value })
const all = (...all: SearchExpression[]): SearchExpression => ({ all })
const any = (...any: SearchExpression[]): SearchExpression => ({ any })
const not = (not: SearchExpression): SearchExpression => ({ not })
const person: SearchExpression = { person: 'Alex' }
export const acceptanceCases: {
  query: string
  kind: 'photo' | 'event'
  expected: number[]
  where: SearchExpression
}[] = [
  {
    query: 'Alex in Italy but not in Rome or the mountains',
    kind: 'photo',
    expected: [101],
    where: all(person, { place: 'Italy' }, not({ place: 'Rome' }), not({ terrain: 'mountains' })),
  },
  {
    query: 'Show Alex in Italy excluding Rome and mountain destinations',
    kind: 'photo',
    expected: [101],
    where: all(person, { place: 'Italy' }, not({ place: 'Rome' }), not({ terrain: 'mountains' })),
  },
  {
    query: 'Alex in Paris in the summer',
    kind: 'photo',
    expected: [104, 105],
    where: all(person, { place: 'Paris' }, { period: 'in summer' }),
  },
  {
    query: 'Alex in Paris or Rome',
    kind: 'photo',
    expected: [102, 104, 105, 106],
    where: all(person, any({ place: 'Paris' }, { place: 'Rome' })),
  },
  {
    query: 'Photos taken with Canon in Paris or Nikon in Rome',
    kind: 'photo',
    expected: [102, 104],
    where: any(
      all(field('camera_make', 'contains', 'Canon'), { place: 'Paris' }),
      all(field('camera_make', 'contains', 'Nikon'), { place: 'Rome' }),
    ),
  },
  {
    query: 'Photos at ISO 800 or higher without flash',
    kind: 'photo',
    expected: [102, 104],
    where: all(field('iso', 'gte', '800'), field('flash_used', 'equals', 'false')),
  },
  {
    query: 'Photos without a capture date',
    kind: 'photo',
    expected: [105, 108],
    where: field('date_taken', 'missing', ''),
  },
  {
    query: 'Photos with aperture below f/4',
    kind: 'photo',
    expected: [101, 104],
    where: field('aperture', 'lt', '4'),
  },
  {
    query: 'Photos with shutter speed faster than 1/100 second',
    kind: 'photo',
    expected: [101, 104],
    where: field('shutter_speed', 'lt', '0.01'),
  },
  {
    query: 'Photos tagged holiday',
    kind: 'photo',
    expected: [101, 104],
    where: field('user_tags', 'contains', 'holiday'),
  },
  {
    query: 'Photos with caption containing "sunset"',
    kind: 'photo',
    expected: [101],
    where: field('caption', 'contains', 'sunset'),
  },
  {
    query: 'Photos with AI description containing "mountains"',
    kind: 'photo',
    expected: [101, 103],
    where: field('ai_description', 'contains', 'mountains'),
  },
  {
    query: 'Photos with OCR text containing "AB123"',
    kind: 'photo',
    expected: [104],
    where: field('ocr_text', 'contains', 'AB123'),
  },
  {
    query: 'Photos with filename ending in .heic',
    kind: 'photo',
    expected: [105],
    where: field('source_filename', 'ends_with', '.heic'),
  },
  {
    query: 'Photos rated at least 4 and marked favorite',
    kind: 'photo',
    expected: [101],
    where: all(field('rating', 'gte', '4'), field('favorite', 'equals', 'true')),
  },
  {
    query: 'Photos wider than 4000 pixels',
    kind: 'photo',
    expected: [101, 104],
    where: field('width', 'gt', '4000'),
  },
  {
    query: 'Videos longer than 60 seconds',
    kind: 'photo',
    expected: [107],
    where: all(field('media_type', 'equals', 'video'), field('duration', 'gt', '60')),
  },
  {
    query: 'Photos in albums named Paris summer',
    kind: 'photo',
    expected: [104, 105, 106],
    where: field('album_event_name', 'contains', 'Paris summer'),
  },
  {
    query: 'Albums named Empty with zero photos',
    kind: 'event',
    expected: [105],
    where: all(
      field('album_event_name', 'contains', 'Empty'),
      field('album_photo_count', 'equals', '0'),
    ),
  },
  {
    query: 'Albums with photos of Alex in Italy but not Rome or the mountains',
    kind: 'event',
    expected: [101],
    where: {
      photo: all(person, { place: 'Italy' }, not({ place: 'Rome' }), not({ terrain: 'mountains' })),
    },
  },
  {
    query: 'Photos with a camera make other than Canon',
    kind: 'photo',
    expected: [102, 103, 105, 106],
    where: not(field('camera_make', 'equals', 'Canon')),
  },
  {
    query: 'Photos in a folder named Travel',
    kind: 'photo',
    expected: [101, 102, 103],
    where: field('album_folder', 'equals', 'Travel'),
  },
  {
    query: 'Photos in Italy taken before 2024',
    kind: 'photo',
    expected: [],
    where: all({ place: 'Italy' }, { period: 'before 2024' }),
  },
]
acceptanceCases.push(
  {
    query: 'Albums with a photo taken with Canon at ISO 400',
    kind: 'event',
    expected: [101],
    where: {
      photo: {
        all: [
          { field: 'camera_make', op: 'contains', value: 'Canon' },
          { field: 'iso', op: 'equals', value: 400 },
        ],
      },
    },
  },
  {
    query: 'Albums with a Canon photo and a separate Nikon photo',
    kind: 'event',
    expected: [104],
    where: {
      all: [
        { photo: { field: 'camera_make', op: 'contains', value: 'Canon' } },
        { photo: { field: 'camera_make', op: 'contains', value: 'Nikon' } },
      ],
    },
  },
  {
    query: 'Photos showing mountains or gardens',
    kind: 'photo',
    expected: [101, 103, 106],
    where: {
      any: [
        { field: 'descriptive_text', op: 'matches', value: 'mountain' },
        { field: 'descriptive_text', op: 'matches', value: 'garden' },
      ],
    },
  },
  {
    query: 'Find Alex in Italy with no mountains visible',
    kind: 'photo',
    expected: [102],
    where: {
      all: [
        { person: 'Alex' },
        { place: 'Italy' },
        { not: { field: 'descriptive_text', op: 'matches', value: 'mountain' } },
      ],
    },
  },
  {
    query: 'Photos within 5 km of latitude 48.85 longitude 2.35',
    kind: 'photo',
    expected: [104],
    where: { near: { latitude: 48.85, longitude: 2.35, km: 5 } },
  },
  {
    query: 'Videos with analysis containing "sailboat"',
    kind: 'photo',
    expected: [107],
    where: {
      all: [
        { field: 'media_type', op: 'equals', value: 'video' },
        { field: 'video_analysis', op: 'contains', value: 'sailboat' },
      ],
    },
  },
  {
    query: 'Photos with manually assigned locations',
    kind: 'photo',
    expected: [104],
    where: { field: 'location_manually_assigned', op: 'equals', value: 'true' },
  },
  {
    query: 'Albums with no photos of Alex',
    kind: 'event',
    expected: [105, 106],
    where: { not: { photo: { person: 'Alex' } } },
  },
  {
    query: 'Albums named Empty or containing photos taken with Canon',
    kind: 'event',
    expected: [101, 104, 105],
    where: {
      any: [
        { field: 'album_event_name', op: 'contains', value: 'Empty' },
        { photo: { field: 'camera_make', op: 'contains', value: 'Canon' } },
      ],
    },
  },
)
export async function seedAcceptance(db: { exec: (sql: string) => Promise<unknown> }) {
  await db.exec(`INSERT INTO folders(folder_id,folder_name,owner_username) VALUES (101,'Travel','SEARCH_TEST');
 INSERT INTO events(event_id,sort_order,event_name,source_folder,owner_username,visibility,event_year,event_month,location,folder_id,photo_count) VALUES
 (101,101,'Italy lakes','fixture/101','SEARCH_TEST','PRIVATE',2024,7,'Lake Como, Italy',101,1),
 (102,102,'Italian city','fixture/102','SEARCH_TEST','PRIVATE',2024,7,'Rome, Italy',101,1),
 (103,103,'Mountain trip','fixture/103','SEARCH_TEST','PRIVATE',2024,7,'Dolomites, Italy',101,1),
 (104,104,'Paris summer','fixture/104','SEARCH_TEST','PRIVATE',2024,7,'Paris, France',NULL,3),
 (105,105,'Empty vacation','fixture/105','SEARCH_TEST','PRIVATE',2024,7,NULL,NULL,0),
 (106,106,'Unsorted','fixture/106','SEARCH_TEST','PRIVATE',2024,1,NULL,NULL,2),
 (107,107,'Empty private','fixture/107','OTHER_OWNER','PRIVATE',2024,7,'Paris, France',NULL,0);
 INSERT INTO photos(photo_id,event_id,source_filename,original_stage_path,media_type,ingest_status,date_taken,city,country,camera_make,iso,flash_used,aperture,shutter_speed,user_tags,caption,ai_description,rating,favorite,width,duration,latitude) VALUES
 (101,101,'lake.jpg','fixture/101','photo','READY','2024-07-15','Lake Como','Italy','Canon',400,false,'f/2.8','1/250',ARRAY['holiday'],'sunset at lake','mountains across the water',5,true,6000,NULL,46),
 (102,102,'rome.jpg','fixture/102','photo','READY','2024-07-15','Rome','Italy','Nikon',800,false,'f/8','1/60',ARRAY['city'],NULL,'city square',3,false,3000,NULL,42),
 (103,103,'range.jpg','fixture/103','photo','READY','2024-07-15',NULL,NULL,'Nikon',800,true,'8','1/60',ARRAY['holiday-ish'],NULL,'mountains',NULL,false,3000,NULL,46),
 (104,104,'paris.jpg','fixture/104','photo','READY','2024-07-15','Paris','France','Canon',1600,false,'2.8','1/500',ARRAY['holiday'],NULL,'Eiffel tower',NULL,false,5000,NULL,49),
 (105,104,'fallback.heic','fixture/105','photo','READY',NULL,NULL,NULL,'Nikon',400,false,NULL,NULL,NULL,NULL,'museum',NULL,false,3000,NULL,49),
 (106,104,'spring.jpg','fixture/106','photo','READY','2024-04-15','Paris','France','Nikon',400,true,NULL,NULL,NULL,NULL,'gardens',NULL,false,3000,NULL,49),
 (107,106,'clip.mp4','fixture/107','video','READY','2024-01-15',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,'movie',NULL,false,1920,90,NULL),
 (108,106,'unknown.jpg','fixture/108','photo','READY',NULL,NULL,NULL,NULL,NULL,NULL,'unknown','1/0',NULL,NULL,NULL,NULL,false,1000,NULL,NULL),
 (109,107,'private.jpg','fixture/private','photo','READY','2024-07-15','Paris','France','Canon',1600,false,'2.8','1/500',ARRAY['holiday'],'sunset','mountains',5,true,6000,NULL,49),
 (110,104,'unfinished.jpg','fixture/unfinished','photo','UPLOADING','2024-07-15','Paris','France','Canon',1600,false,'2.8','1/500',ARRAY['holiday'],'sunset','mountains',5,true,6000,NULL,49);
 UPDATE photos SET latitude=48.85,longitude=2.35,location_assignment_id='aaaaaaaa-0000-4000-8000-000000000000' WHERE photo_id=104;
 INSERT INTO video_analyses(id,photo_id,requested_by,owner_username,model,prompt_version,status,search_text) VALUES('bbbbbbbb-0000-4000-8000-000000000000',107,'SEARCH_TEST','SEARCH_TEST','fixture','fixture','completed','A sailboat crossing the lake');
 UPDATE search_enrichment SET status='completed',ocr_text='AB123' WHERE photo_id=104;
 INSERT INTO face_settings(owner_username,enabled) VALUES('SEARCH_TEST',true);
 INSERT INTO face_people(person_id,owner_username,name) VALUES('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','SEARCH_TEST','Alex');
 INSERT INTO faces(photo_id,owner_username,source,source_path,model_version,face_index,box_x,box_y,box_w,box_h,detection_score,quality,quality_ok,embedding)
 SELECT photo_id,'SEARCH_TEST','detected',original_stage_path,'fixture',0,0.1,0.1,0.2,0.2,0.9,0.9,true,'[1,0]' FROM photos WHERE photo_id BETWEEN 101 AND 106;
 INSERT INTO face_assignments(face_id,person_id,owner_username,status,score) SELECT face_id,'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','SEARCH_TEST','confirmed',0.9 FROM faces WHERE owner_username='SEARCH_TEST';`)
}
