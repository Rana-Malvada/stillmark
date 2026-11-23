-- Personal Photos App - Snowflake Setup
-- Run this as ACCOUNTADMIN on the new Snowflake account

-- 1. Database
CREATE DATABASE IF NOT EXISTS PERSONAL_MEDIA;

-- 2. Schemas
CREATE SCHEMA IF NOT EXISTS PERSONAL_MEDIA.DATA;
CREATE SCHEMA IF NOT EXISTS PERSONAL_MEDIA.RAW;
CREATE SCHEMA IF NOT EXISTS PERSONAL_MEDIA.APP;
CREATE SCHEMA IF NOT EXISTS PERSONAL_MEDIA.AI;

-- 3. Internal stage for photo/video storage
CREATE STAGE IF NOT EXISTS PERSONAL_MEDIA.RAW.PHOTO_FILES
  ENCRYPTION = (TYPE = 'SNOWFLAKE_SSE')
  DIRECTORY = (ENABLE = TRUE);

-- 4. Network rule for Postgres ingress (update the IP to your current IP)
-- Find your IP: curl -s ifconfig.me
CREATE NETWORK RULE IF NOT EXISTS PERSONAL_MEDIA.DATA.PERSONAL_MEDIA_PG_INGRESS
  MODE = INGRESS
  TYPE = IPV4
  VALUE_LIST = ('YOUR_IP_HERE/32')  -- <-- Replace with your IP
  COMMENT = 'Allow local dev access to Postgres';

-- 5. Network policy for Postgres
CREATE NETWORK POLICY IF NOT EXISTS PERSONAL_MEDIA_PG_POLICY
  ALLOWED_NETWORK_RULE_LIST = ('PERSONAL_MEDIA.DATA.PERSONAL_MEDIA_PG_INGRESS')
  COMMENT = 'Network policy for personal_media_pg Postgres instance';

-- 6. Postgres instance (Snowflake Postgres)
-- NOTE: Run this AFTER the network policy is created
CREATE POSTGRES INSTANCE PERSONAL_MEDIA.DATA.PERSONAL_MEDIA_PG
  COMPUTE_FAMILY = 'BURST_S'
  STORAGE_SIZE = 10
  AUTO_RESUME = TRUE
  NETWORK_POLICY = 'PERSONAL_MEDIA_PG_POLICY'
  COMMENT = 'Metadata store for Personal Photos app';

-- 7. Wait for instance to be ready (check status)
-- DESCRIBE POSTGRES INSTANCE PERSONAL_MEDIA.DATA.PERSONAL_MEDIA_PG;
-- Look for state = 'READY' and note the host for pg_service.conf
