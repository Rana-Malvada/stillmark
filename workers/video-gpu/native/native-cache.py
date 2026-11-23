#!/usr/bin/env python3
"""Optional local cache for the independently reproducible native build.

The cache never contains application code. Its key binds every source/patch/
configuration input and the complete installed compiler package inventory.
Every restored file is independently hashed and archive paths are constrained.
"""

import hashlib
import json
import os
import pathlib
import platform
import subprocess
import shutil
import sys
import tarfile
import tempfile

CACHE = pathlib.Path("/native-cache")
OUTPUT = pathlib.Path("/native-output")
INPUTS = pathlib.Path("/native-inputs")
EXPORT = pathlib.Path("/native-cache-export")
RECIPE = pathlib.Path("/native-recipe/Dockerfile")


def digest(data):
    return hashlib.sha256(data).hexdigest()


def identity():
    files = {
        str(p.relative_to(INPUTS)): digest(p.read_bytes())
        for p in sorted(INPUTS.rglob("*"))
        if p.is_file()
    }
    if not files:
        raise ValueError("Native cache cannot operate without bound inputs")
    packages = subprocess.check_output(["dpkg-query", "-W", "-f=${Package}=${Version}\\n"])
    tools = {}
    for name in ("gcc", "g++", "ld", "clang", "make", "nasm"):
        filename = subprocess.check_output(["which", name], text=True).strip()
        tools[name] = digest(pathlib.Path(filename).resolve().read_bytes())
    return {
        "version": 2,
        "recipeSHA256": digest(RECIPE.read_bytes()),
        "platform": {
            "system": platform.system(),
            "machine": platform.machine(),
            "byteorder": sys.byteorder,
        },
        "inputs": files,
        "packagesSHA256": digest(packages),
        "tools": tools,
    }


def file_manifest(root):
    files = {}
    for p in sorted(root.rglob("*")):
        name = str(p.relative_to(root))
        if p.is_symlink():
            target = os.readlink(p)
            if os.path.isabs(target) or not p.resolve().is_relative_to(root.resolve()):
                raise ValueError(f"Native cache link escapes output: {name}")
            files[name] = {"symlink": target}
        elif p.is_file():
            files[name] = {"sha256": digest(p.read_bytes()), "mode": p.stat().st_mode & 0o777}
    if not files or not any(name.endswith("/ffmpeg") for name in files):
        raise ValueError("Native output lacks FFmpeg")
    return files


def export_entry(folder):
    target = EXPORT / folder.name
    target.mkdir(parents=True, exist_ok=True)
    for filename in ("manifest.json", "runtime.tar.gz"):
        shutil.copy2(folder / filename, target / filename)


def main():
    current = identity()
    key = digest(json.dumps(current, sort_keys=True).encode())
    folder = CACHE / key
    if sys.argv[1] == "store":
        folder.mkdir(parents=True, exist_ok=True)
        files = file_manifest(OUTPUT)
        archive = folder / "runtime.tar.gz"
        with tarfile.open(archive, "w:gz") as tar:
            for p in sorted(OUTPUT.iterdir()):
                tar.add(p, arcname=p.name)
        manifest = {
            "identity": current,
            "files": files,
            "archiveSHA256": digest(archive.read_bytes()),
        }
        (folder / "manifest.json").write_text(json.dumps(manifest, sort_keys=True) + "\n")
        export_entry(folder)
        print("Stored verified native build cache " + key)
        return
    if not (folder / "manifest.json").exists():
        print("No matching native cache; source build required")
        raise SystemExit(3)
    manifest = json.loads((folder / "manifest.json").read_text())
    archive = folder / "runtime.tar.gz"
    if manifest["identity"] != current or digest(archive.read_bytes()) != manifest["archiveSHA256"]:
        raise ValueError("Native cache identity or archive hash mismatch")
    with tempfile.TemporaryDirectory() as name:
        scratch = pathlib.Path(name)
        with tarfile.open(archive, "r:gz") as tar:
            tar.extractall(scratch, filter="data")
        if file_manifest(scratch) != manifest["files"]:
            raise ValueError("Native cache file manifest mismatch")
        OUTPUT.mkdir(parents=True, exist_ok=True)
        subprocess.run(["cp", "-a", str(scratch) + "/.", str(OUTPUT)], check=True)
    export_entry(folder)
    print("Restored source/toolchain-bound native build cache " + key)


if __name__ == "__main__":
    main()
