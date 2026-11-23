-- Migration: Add comprehensive EXIF/IPTC/ICC metadata columns
-- Run this against an existing database to add the new columns.
-- Safe to re-run: all statements use IF NOT EXISTS / already-exists checks.
-- psql "service=personal_media_pg" -f setup/03-add-metadata-columns.sql

DO $$
BEGIN
  -- Camera & Lens
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='photos' AND column_name='lens_make') THEN
    ALTER TABLE photos ADD COLUMN lens_make VARCHAR(255);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='photos' AND column_name='lens_serial') THEN
    ALTER TABLE photos ADD COLUMN lens_serial VARCHAR(255);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='photos' AND column_name='software') THEN
    ALTER TABLE photos ADD COLUMN software VARCHAR(255);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='photos' AND column_name='artist') THEN
    ALTER TABLE photos ADD COLUMN artist VARCHAR(255);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='photos' AND column_name='copyright') THEN
    ALTER TABLE photos ADD COLUMN copyright VARCHAR(512);
  END IF;

  -- Exposure & Scene
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='photos' AND column_name='exposure_program') THEN
    ALTER TABLE photos ADD COLUMN exposure_program VARCHAR(50);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='photos' AND column_name='metering_mode') THEN
    ALTER TABLE photos ADD COLUMN metering_mode VARCHAR(50);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='photos' AND column_name='light_source') THEN
    ALTER TABLE photos ADD COLUMN light_source VARCHAR(50);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='photos' AND column_name='white_balance') THEN
    ALTER TABLE photos ADD COLUMN white_balance VARCHAR(50);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='photos' AND column_name='exposure_mode') THEN
    ALTER TABLE photos ADD COLUMN exposure_mode VARCHAR(50);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='photos' AND column_name='scene_capture_type') THEN
    ALTER TABLE photos ADD COLUMN scene_capture_type VARCHAR(50);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='photos' AND column_name='contrast') THEN
    ALTER TABLE photos ADD COLUMN contrast VARCHAR(50);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='photos' AND column_name='saturation') THEN
    ALTER TABLE photos ADD COLUMN saturation VARCHAR(50);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='photos' AND column_name='sharpness') THEN
    ALTER TABLE photos ADD COLUMN sharpness VARCHAR(50);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='photos' AND column_name='brightness') THEN
    ALTER TABLE photos ADD COLUMN brightness VARCHAR(50);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='photos' AND column_name='focal_length_35mm') THEN
    ALTER TABLE photos ADD COLUMN focal_length_35mm VARCHAR(50);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='photos' AND column_name='digital_zoom_ratio') THEN
    ALTER TABLE photos ADD COLUMN digital_zoom_ratio VARCHAR(50);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='photos' AND column_name='color_space') THEN
    ALTER TABLE photos ADD COLUMN color_space VARCHAR(50);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='photos' AND column_name='subject_distance_range') THEN
    ALTER TABLE photos ADD COLUMN subject_distance_range VARCHAR(50);
  END IF;

  -- GPS
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='photos' AND column_name='gps_speed') THEN
    ALTER TABLE photos ADD COLUMN gps_speed DOUBLE PRECISION;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='photos' AND column_name='gps_timestamp') THEN
    ALTER TABLE photos ADD COLUMN gps_timestamp TIMESTAMPTZ;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='photos' AND column_name='gps_h_positioning_error') THEN
    ALTER TABLE photos ADD COLUMN gps_h_positioning_error DOUBLE PRECISION;
  END IF;

  -- IPTC
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='photos' AND column_name='iptc_keywords') THEN
    ALTER TABLE photos ADD COLUMN iptc_keywords TEXT[];
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='photos' AND column_name='iptc_headline') THEN
    ALTER TABLE photos ADD COLUMN iptc_headline VARCHAR(255);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='photos' AND column_name='iptc_copyright') THEN
    ALTER TABLE photos ADD COLUMN iptc_copyright VARCHAR(512);
  END IF;

  -- Segment JSONB dumps
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='photos' AND column_name='iptc_raw') THEN
    ALTER TABLE photos ADD COLUMN iptc_raw JSONB;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='photos' AND column_name='icc_raw') THEN
    ALTER TABLE photos ADD COLUMN icc_raw JSONB;
  END IF;
END $$;
