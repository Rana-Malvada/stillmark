SET LOCAL lock_timeout='5s';
CREATE INDEX IF NOT EXISTS events_owner_page_sort_idx ON public.events(owner_username,(COALESCE(sort_order,0)),event_id);
