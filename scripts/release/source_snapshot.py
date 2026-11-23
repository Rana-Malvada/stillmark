"""Release only the checked Git commit, never ignored files from the developer laptop."""

import hashlib
import pathlib
import subprocess
import tarfile


def snapshot(root: pathlib.Path, commit: str, release: pathlib.Path):
    archive = release / "source.tar"
    source = release / "source"
    source.mkdir(mode=0o700)
    subprocess.run(
        ["git", "archive", "--format=tar", "--output", str(archive), commit],
        cwd=root,
        check=True,
        capture_output=True,
    )
    with tarfile.open(archive) as bundle:
        bundle.extractall(source, filter="data")
    with archive.open("rb") as stream:
        digest = hashlib.file_digest(stream, "sha256").hexdigest()
    return source, digest
