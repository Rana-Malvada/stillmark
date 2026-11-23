"""Validated PostgreSQL clients shared by migration and backup commands."""

import os
import pathlib
import re
import shutil
import subprocess

TOOLS = {"psql", "pg_dump", "pg_restore"}


def tool(name):
    if name not in TOOLS:
        raise ValueError(f"Unsupported PostgreSQL client: {name}")
    override = os.environ.get("GALLERY_PG_BIN")
    if override:
        candidate = pathlib.Path(override).expanduser() / name
        if candidate.is_file() and os.access(candidate, os.X_OK):
            return str(candidate.resolve())
        raise RuntimeError(f"GALLERY_PG_BIN does not contain an executable {name}")
    found = shutil.which(name)
    if found:
        return found
    for directory in ("/opt/homebrew/opt/libpq/bin", "/usr/local/opt/libpq/bin"):
        candidate = pathlib.Path(directory) / name
        if candidate.is_file() and os.access(candidate, os.X_OK):
            return str(candidate)
    raise RuntimeError(f"PostgreSQL client {name} not found; install it on PATH or set GALLERY_PG_BIN")


def major_version(text):
    match = re.search(r"\(PostgreSQL\)\s+(\d+)(?:\.(\d+))?", text)
    if not match or int(match[1]) < 10:
        raise RuntimeError("Expected supported PostgreSQL 10+ client version")
    return int(match[1])


def backup_clients(server_version_num):
    """Fail before dumping/creating a database when client tools cannot restore."""
    server_major = int(server_version_num) // 10000
    if server_major < 10:
        raise RuntimeError("Expected supported PostgreSQL 10+ server")
    clients = {name: tool(name) for name in sorted(TOOLS)}
    versions = {
        name: major_version(
            subprocess.run([path, "--version"], check=True, capture_output=True, text=True, timeout=10).stdout
        )
        for name, path in clients.items()
    }
    # pg_dump supports older servers but refuses a newer server major. Restore
    # must understand the selected dump format; require a matching client set.
    # The mandatory real restore still validates generated SQL on this server.
    if versions["pg_dump"] < server_major or len(set(versions.values())) != 1:
        raise RuntimeError(
            f"Backup drill requires one client major at least as new as PostgreSQL {server_major}; "
            f"found {versions}. Set GALLERY_PG_BIN to a compatible client directory."
        )
    return clients, {"serverMajor": server_major, "clientMajors": versions}
