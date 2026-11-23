#!/usr/bin/python3
import sys, json, pathlib, subprocess, hashlib, shutil

args = sys.argv[2:]
kind = sys.argv[1]
lock = json.loads(pathlib.Path("/locks/vendor-dependency-lock.json").read_text())
if kind == "git":
    if args[0] != "clone":
        raise SystemExit("Only clone uses pinned helper")
    url = next(a for a in args if a.startswith("https://"))
    ref = args[args.index("-b") + 1]
    entry = next(e for e in lock if e["url"] == url and e.get("ref") == ref)
    dest = pathlib.Path(url.rstrip("/").split("/")[-1].removesuffix(".git"))
    subprocess.run(["/usr/bin/git", "init", str(dest)], check=True)
    subprocess.run(["/usr/bin/git", "-C", str(dest), "remote", "add", "origin", url], check=True)
    subprocess.run(
        ["/usr/bin/git", "-C", str(dest), "fetch", "--depth=1", "origin", entry["commit"]],
        check=True,
    )
    subprocess.run(
        ["/usr/bin/git", "-C", str(dest), "checkout", "--detach", "FETCH_HEAD"], check=True
    )
    got = subprocess.check_output(
        ["/usr/bin/git", "-C", str(dest), "rev-parse", "HEAD"], text=True
    ).strip()
    if got != entry["commit"]:
        raise SystemExit("Source mismatch")
    if "--recursive" in args:
        subprocess.run(
            ["/usr/bin/git", "-C", str(dest), "submodule", "update", "--init", "--recursive"],
            check=True,
        )
else:
    url = next(a for a in args if a.startswith("https://"))
    entry = next(e for e in lock if e["url"] == url)
    data = pathlib.Path("/locks/downloads", entry["sha256"]).read_bytes()
    if hashlib.sha256(data).hexdigest() != entry["sha256"]:
        raise SystemExit("Hash mismatch")
    out = args[args.index("-O") + 1]
    if out == "-":
        sys.stdout.buffer.write(data)
    else:
        pathlib.Path(out).write_bytes(data)
