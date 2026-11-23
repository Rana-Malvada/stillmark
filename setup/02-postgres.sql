-- Personal Photos App - Postgres Schema Setup
-- Run this against the Snowflake Postgres instance after it's ready
-- psql "service=personal_media_pg" -f setup/02-postgres.sql

-- 1. Folders
CREATE TABLE IF NOT EXISTS folders (
  folder_id    SERIAL PRIMARY KEY,
  folder_name  VARCHAR(255) NOT NULL,
  sort_order   INTEGER DEFAULT 0,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

-- 2. Users
CREATE TABLE IF NOT EXISTS users (
  user_id       SERIAL PRIMARY KEY,
  username      VARCHAR(100) NOT NULL UNIQUE,
  display_name  VARCHAR(255) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  role          VARCHAR(20) NOT NULL DEFAULT 'viewer',
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  last_login    TIMESTAMPTZ
);

-- 3. Events
CREATE TABLE IF NOT EXISTS events (
  event_id       SERIAL PRIMARY KEY,
  sort_order     INTEGER NOT NULL,
  event_name     VARCHAR(255) NOT NULL,
  source_folder  VARCHAR(512) NOT NULL,
  event_month    SMALLINT,
  event_year     SMALLINT,
  cover_photo_id INTEGER,
  photo_count    INTEGER DEFAULT 0,
  visibility     VARCHAR(50) DEFAULT 'PRIVATE',
  created_at     TIMESTAMPTZ DEFAULT NOW(),
  updated_at     TIMESTAMPTZ DEFAULT NOW(),
  location       VARCHAR(255),
  folder_id      INTEGER REFERENCES folders(folder_id)
);

CREATE INDEX IF NOT EXISTS idx_events_sort_order ON events(sort_order);
CREATE UNIQUE INDEX IF NOT EXISTS idx_events_source_folder_unique ON events(source_folder);
CREATE INDEX IF NOT EXISTS idx_events_folder_id ON events(folder_id);

-- 4. Photos
CREATE TABLE IF NOT EXISTS photos (
  photo_id              SERIAL PRIMARY KEY,
  event_id              INTEGER NOT NULL REFERENCES events(event_id),
  source_filename       VARCHAR(512) NOT NULL,
  source_relative_path  VARCHAR(1024),
  original_stage_path   VARCHAR(1024),
  display_stage_path    VARCHAR(1024),
  thumbnail_stage_path  VARCHAR(1024),
  file_size_bytes       BIGINT,
  content_type          VARCHAR(100),
  file_extension        VARCHAR(20),
  file_hash             VARCHAR(64),
  stage_etag            VARCHAR(255),
  width                 INTEGER,
  height                INTEGER,
  aspect_ratio          REAL,
  orientation           SMALLINT,
  date_taken            TIMESTAMPTZ,
  date_taken_raw        VARCHAR(255),
  camera_make           VARCHAR(255),
  camera_model          VARCHAR(255),
  lens_model            VARCHAR(255),
  focal_length          VARCHAR(50),
  aperture              VARCHAR(50),
  shutter_speed         VARCHAR(50),
  iso                   INTEGER,
  exposure_compensation VARCHAR(50),
  flash_used            BOOLEAN,
  latitude              DOUBLE PRECISION,
  longitude             DOUBLE PRECISION,
  altitude              DOUBLE PRECISION,
  gps_direction         DOUBLE PRECISION,
  gps_speed             DOUBLE PRECISION,
  gps_timestamp         TIMESTAMPTZ,
  gps_h_positioning_error DOUBLE PRECISION,
  country               VARCHAR(255),
  region                VARCHAR(255),
  city                  VARCHAR(255),
  location_name         VARCHAR(255),
  lens_make             VARCHAR(255),
  lens_serial           VARCHAR(255),
  software              VARCHAR(255),
  artist                VARCHAR(255),
  copyright             VARCHAR(512),
  exposure_program      VARCHAR(50),
  metering_mode         VARCHAR(50),
  light_source          VARCHAR(50),
  white_balance         VARCHAR(50),
  exposure_mode         VARCHAR(50),
  scene_capture_type    VARCHAR(50),
  contrast              VARCHAR(50),
  saturation            VARCHAR(50),
  sharpness             VARCHAR(50),
  brightness            VARCHAR(50),
  focal_length_35mm     VARCHAR(50),
  digital_zoom_ratio    VARCHAR(50),
  color_space           VARCHAR(50),
  subject_distance_range VARCHAR(50),
  iptc_keywords         TEXT[],
  iptc_headline         VARCHAR(255),
  iptc_copyright        VARCHAR(512),
  exif_raw              JSONB,
  xmp_raw               JSONB,
  iptc_raw              JSONB,
  icc_raw               JSONB,
  caption               TEXT,
  ai_description        TEXT,
  favorite              BOOLEAN DEFAULT FALSE,
  rating                SMALLINT,
  visibility            VARCHAR(50) DEFAULT 'PRIVATE',
  ingest_status         VARCHAR(50) DEFAULT 'DISCOVERED',
  ingest_error          TEXT,
  created_at            TIMESTAMPTZ DEFAULT NOW(),
  updated_at            TIMESTAMPTZ DEFAULT NOW(),
  media_type            VARCHAR(10) DEFAULT 'photo',
  duration              REAL
);

CREATE INDEX IF NOT EXISTS idx_photos_event_id ON photos(event_id);
CREATE INDEX IF NOT EXISTS idx_photos_date_taken ON photos(date_taken);
CREATE INDEX IF NOT EXISTS idx_photos_file_hash ON photos(file_hash);
CREATE INDEX IF NOT EXISTS idx_photos_ingest_status ON photos(ingest_status);

-- 5. Upload Jobs
CREATE TABLE IF NOT EXISTS upload_jobs (
  upload_job_id  SERIAL PRIMARY KEY,
  event_id       INTEGER,
  source_folder  VARCHAR(512),
  started_at     TIMESTAMPTZ DEFAULT NOW(),
  completed_at   TIMESTAMPTZ,
  file_count     INTEGER DEFAULT 0,
  success_count  INTEGER DEFAULT 0,
  skipped_count  INTEGER DEFAULT 0,
  failed_count   INTEGER DEFAULT 0,
  total_bytes    BIGINT DEFAULT 0,
  status         VARCHAR(50) DEFAULT 'PENDING'
);

-- 6. Upload Files
CREATE TABLE IF NOT EXISTS upload_files (
  upload_file_id  SERIAL PRIMARY KEY,
  upload_job_id   INTEGER NOT NULL REFERENCES upload_jobs(upload_job_id),
  photo_id        INTEGER,
  source_filename VARCHAR(512) NOT NULL,
  file_hash       VARCHAR(64),
  stage_path      VARCHAR(1024),
  status          VARCHAR(50) DEFAULT 'PENDING',
  error_message   TEXT,
  file_size_bytes BIGINT,
  started_at      TIMESTAMPTZ,
  completed_at    TIMESTAMPTZ
);
