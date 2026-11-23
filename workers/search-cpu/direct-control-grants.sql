-- Direct CPU job orchestration replaces warehouse-backed stored-procedure CALLs.
-- The worker role has no warehouse privileges. Keep all job access on its existing
-- scoped role; the trusted app needs these rights to issue metadata/DDL directly.
GRANT ROLE PERSONAL_PHOTOS_SEARCH_WORKER TO ROLE PERSONAL_PHOTOS_RUNTIME;
GRANT OPERATE, MONITOR ON COMPUTE POOL PERSONAL_PHOTOS_SEARCH_CPU TO ROLE PERSONAL_PHOTOS_RUNTIME;
