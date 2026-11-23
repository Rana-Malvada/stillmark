# Explicit folder creation

Registration creates the account and allowances without creating a folder. Upload
keeps its folder selector and offers inline creation of a personal folder, selecting
it after successful creation. Non-admin upload forms omit Sort Order.

Apply using the migration runner before deploying. Existing folders and albums are
preserved; this migration does not delete or rename user content. The replacement
function retains its existing security, admission checks and execution grants.
