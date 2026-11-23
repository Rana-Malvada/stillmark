-- Access managers may archive only the exact managed identity being removed.
GRANT INSERT ON public.deleted_accounts TO personal_photos_app;
CREATE POLICY admin_archive ON public.deleted_accounts FOR INSERT TO personal_photos_app
WITH CHECK (photo_security.flag('access_manager') AND deleted_by=photo_security.username()
 AND EXISTS (SELECT 1 FROM public.gallery_access_objects o
 WHERE o.kind='user' AND o.name=deleted_accounts.name AND o.marker=deleted_accounts.marker));
