# Allow authorized account deletion to preserve its archive

The prior archive migration granted only SELECT to the request role. User deletion
in an authenticated request must insert the retained profile before removing its
registry row. This grants INSERT with an access-manager policy requiring the current
actor and the exact existing account marker. It does not grant UPDATE, DELETE, or
public access to archived profiles. Apply using the verified migration runner.
