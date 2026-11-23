#!/usr/bin/env python3
"""Require FATE's executable to load the libraries from this exact build."""
import hashlib
import json
import pathlib
import re
import subprocess
import sys


LIBRARY = re.compile(r"^(lib(?:avcodec|avdevice|avfilter|avformat|avutil|swresample|swscale|xml2|z)\.so\.\d+) => (\S+)")


def verify_dependencies(output, source, prefix, required=("libavcodec",)):
    verified = []
    seen = set()
    sonames = set()
    for line in output.splitlines():
        match = LIBRARY.match(line.strip())
        if not match:
            continue
        soname, loaded = match.groups()
        if soname in sonames:
            raise ValueError("Duplicate native library SONAME: " + soname)
        sonames.add(soname)
        loaded = pathlib.Path(loaded).resolve()
        # Ubuntu's transitive XML ABI2 is distinct from the rebuilt Jellyfin ABI16.
        # Require OS package ownership; it remains in the mandatory OS scan.
        if soname == "libxml2.so.2":
            if str(loaded.parent) not in ("/usr/lib/x86_64-linux-gnu", "/lib/x86_64-linux-gnu"):
                raise ValueError("Unexpected system XML library path")
            owner = subprocess.check_output(["dpkg-query", "--search", str(loaded)], text=True).strip()
            if not owner.startswith(("libxml2:amd64: ", "libxml2: ")):
                raise ValueError("Unowned system XML library")
            verified.append({"library": soname, "loaded": str(loaded), "osPackage": owner,
                             "sha256": hashlib.sha256(loaded.read_bytes()).hexdigest()})
            continue
        family = soname.split(".so.")[0]
        seen.add(family)
        built = (source / soname).resolve()
        if prefix.resolve() not in loaded.parents or not built.is_file():
            raise ValueError("Unexpected native library resolution: " + soname)
        digest = hashlib.sha256(built.read_bytes()).hexdigest()
        if hashlib.sha256(loaded.read_bytes()).hexdigest() != digest:
            raise ValueError("Executable loaded a different native build: " + soname)
        verified.append({"library": soname, "loaded": str(loaded), "sha256": digest})
    missing = set(required) - seen
    if missing:
        raise ValueError("Missing verified native libraries: " + ",".join(sorted(missing)))
    return verified


if __name__ == "__main__":
    source = pathlib.Path("/ffmpeg")
    evidence = {}
    expected = {
        "ffmpeg": ("libavcodec", "libavdevice", "libavfilter", "libavformat", "libavutil", "libswresample", "libswscale"),
        "ffprobe": ("libavcodec", "libavformat", "libavutil"),
    }
    if sys.argv[1:] == ["--zlib"]:
        source = pathlib.Path("/ffmpeg/zlib")
        expected = {"examplesh": ("libz",), "minigzipsh": ("libz",)}
    elif sys.argv[1:]:
        raise ValueError("Unexpected verification arguments")
    for binary, required in expected.items():
        output = subprocess.check_output(["ldd", str(source / binary)], text=True)
        if "not found" in output:
            raise ValueError("Unresolved native dependencies: " + binary)
        evidence[binary] = verify_dependencies(output, pathlib.Path("/patched/usr/lib/jellyfin-ffmpeg/lib"), pathlib.Path("/usr/lib/jellyfin-ffmpeg/lib"), required)
    print(json.dumps(evidence, indent=2))
