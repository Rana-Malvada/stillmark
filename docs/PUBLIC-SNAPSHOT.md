# Public snapshot

The application is developed and released from a private repository. A public copy is
published from time to time so the work can be read and judged. It is a snapshot with
no history, and nothing runs in it.

`scripts/publish/export.py` (kept in the private repository) writes the snapshot into an
empty folder from the current commit and then proves it:

| Step          | What happens                                                                                                                                                          |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Leave out     | The package inventories of the running worker images, the review of advisories in the video image, and the export script itself                                       |
| Empty         | The accepted-advisory records, kept as a valid file with no entries                                                                                                   |
| Make inactive | Automation files move from `.github/` to `docs/reference/`, so the public repository runs nothing                                                                     |
| Replace       | Account, host, tenant and client identifiers, the administrator and member names, and internal member ids become placeholders, the same value always mapping the same |
| Regenerate    | The frozen-setup checksum inventory, since those files now hold placeholders                                                                                          |
| Verify        | No original identifier remains in any file or file name, and the secret scanner finds nothing; otherwise the script stops                                             |

`--also-forbid FILE` adds further strings that must not appear, one per line. It is used
with the current member names read from the live database, which are never written
into this repository.

The script never pushes. Before publishing, run the unit tests in the snapshot
(`npm ci && npm test`), read its printed summary, and get the owner's approval.

The placeholders are chosen not to collide with the made-up values tests already use.
Readers can still learn the architecture from the documentation; that is the purpose of
publishing it.
