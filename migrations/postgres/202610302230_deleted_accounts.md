# Deleted accounts archive

User deletion retains original album, folder, photo and Trash ownership. The account
profile and membership dates are retained in an administrator-only archive. Album
visibility becomes private and explicit/public sharing is revoked atomically with
registry removal. No content is automatically assigned to the deleting administrator.

Collection places archived albums under **Deleted accounts**. Empty inherited
folders are hidden from Collection; My Albums still permits managing own empty folders.

The additive migration must precede application rollout. Database policies and
read/write helpers independently restrict archived albums to the main administrator,
even if a stale share or public link remains. Deleted internal identity names cannot
be reused; registering a new Auth0 identity does not recover archived ownership.

Apply through the release migration runner with a verified backup. Existing transferred
content is not guessed or reassigned by this migration. Recovery requires checking
pre-deletion ownership evidence for each affected album and folder. Rollback of the
application must not resume the former deletion workflow, which transfers ownership.
