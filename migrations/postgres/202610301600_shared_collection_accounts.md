# Shared collection access for customer accounts

GALLERY is the existing explicit “shared with all users” visibility setting. It
includes self-service accounts and future users. The earlier customer migration
incorrectly restricted application-role reads to managed accounts while catalog
reads still allowed all authenticated users. This additive correction aligns both
paths without changing any album visibility or ownership.

Private albums remain owner/admin/explicit-share only. Anonymous requests receive
no collection access. Tests cover both reader and application roles.
