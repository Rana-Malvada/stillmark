#!/usr/bin/env python3
import argparse, hashlib, json, pathlib, subprocess

root = pathlib.Path("/locks")


def fetch(url, path, expected):
    if not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        subprocess.run(
            [
                "curl",
                "--fail",
                "--location",
                "--retry",
                "3",
                "--max-time",
                "300",
                url,
                "-o",
                str(path),
            ],
            check=True,
        )
    if hashlib.sha256(path.read_bytes()).hexdigest() != expected:
        raise ValueError("Source checksum mismatch: " + str(path))


def apply_vendor_patches(root, ffmpeg):
    policy = json.loads((root / "build-inputs.json").read_text())["vendorPatches"]
    directory = ffmpeg / "debian/patches"
    series = directory / "series"
    if hashlib.sha256(series.read_bytes()).hexdigest() != policy["seriesSHA256"]:
        raise ValueError("Vendor patch series checksum mismatch")
    names = [line.strip() for line in series.read_text().splitlines()
             if line.strip() and not line.lstrip().startswith("#")]
    if len(names) != policy["count"] or len(set(names)) != len(names):
        raise ValueError("Vendor patch series count/duplicates mismatch")
    for name in names:
        if pathlib.PurePosixPath(name).name != name or not name.endswith(".patch"):
            raise ValueError("Invalid vendor patch path")
        patch = directory / name
        if patch.is_symlink() or not patch.is_file():
            raise ValueError("Invalid vendor patch file")
    for name in names:
        patch = (directory / name).resolve()
        subprocess.run(["git", "apply", "--check", str(patch)], cwd=ffmpeg, check=True)
        subprocess.run(["git", "apply", str(patch)], cwd=ffmpeg, check=True)
        print(name + " " + hashlib.sha256(patch.read_bytes()).hexdigest(), flush=True)
    print(f"Verified and applied {len(names)} ordered vendor patches", flush=True)


def preflight_patches(root, ffmpeg, zlib):
    # This vendor revision already includes CFHD. Require that exact fix; do
    # not silently accept a patch which neither applies nor reverses cleanly.
    checks = [
        (ffmpeg, "cfhd-official.patch", True),
        (ffmpeg, "flic-official.patch", False),
        (zlib, "zlib-official.patch", False),
    ]
    for directory, patch, reverse in checks:
        command = ["git", "apply", "--check"]
        if reverse:
            command.append("--reverse")
        subprocess.run([*command, str(root / patch)], cwd=directory, check=True)
        print(patch + (": verified upstream fix present" if reverse else ": verified applicable"), flush=True)
    # Apply only after every source/patch pair has passed, before compilation.
    subprocess.run(["git", "apply", str(root / "flic-official.patch")], cwd=ffmpeg, check=True)


def verify_test_registration(ffmpeg):
    """Exercise the actual pinned makefiles/preprocessor in both feature states."""
    source = (ffmpeg / "tests/checkasm/checkasm.c").read_text()
    block = source.split("#if CONFIG_SWSCALE\n", 1)[1].split("#if CONFIG_AVUTIL\n", 1)[0]
    block = "#if CONFIG_SWSCALE\n" + block
    results = {}
    for enabled in (False, True):
        state = "yes" if enabled else "no"
        makefile = f"""SRC_PATH=.
CONFIG_SWSCALE=yes
CONFIG_UNSTABLE={state}
include tests/checkasm/Makefile
include tests/fate/checkasm.mak
include libswscale/Makefile
.PHONY: verify-registration
verify-registration:
\t@echo $(CHECKASMOBJS) $(FATE_CHECKASM) $(TESTPROGS) $(TESTPROGS-yes)
"""
        targets = subprocess.check_output(
            ["make", "--no-print-directory", "-f", "-", "verify-registration"],
            input=makefile, cwd=ffmpeg, text=True,
        ).split()
        registration = subprocess.check_output(
            ["cc", "-E", "-P", "-x", "c", "-DCONFIG_SWSCALE=1",
             f"-DCONFIG_UNSTABLE={int(enabled)}", "-"],
            input=block, text=True,
        )
        conditional = {"tests/checkasm/sw_ops.o", "fate-checkasm-sw_ops", "sws_ops"}
        if any((target in targets) != enabled for target in conditional):
            raise ValueError("Unstable test targets do not match configured library")
        if ("checkasm_check_sw_ops" in registration) != enabled:
            raise ValueError("Unstable checkasm registration does not match configured library")
        results[enabled] = set(targets) - conditional
        print(f"CONFIG_UNSTABLE={state}: make targets and C registration verified", flush=True)
    if results[False] != results[True] or "tests/checkasm/sw_scale.o" not in results[False]:
        raise ValueError("Applicable stable tests changed with unstable feature gate")


def apply_test_config_patch(root, ffmpeg):
    patch = root / "swscale-test-config.patch"
    subprocess.run(["git", "apply", "--check", str(patch)], cwd=ffmpeg, check=True)
    subprocess.run(["git", "apply", str(patch)], cwd=ffmpeg, check=True)
    verify_test_registration(ffmpeg)


def fetch_all():
    source = json.loads((root / "build-inputs.json").read_text())
    for name, expected in source["patches"].items():
        if hashlib.sha256((root / name).read_bytes()).hexdigest() != expected:
            raise ValueError("Patch checksum mismatch: " + name)
    fetch(source["sourceURL"], pathlib.Path("/tmp/source.tar.gz"), source["sourceSHA256"])
    for item in json.loads((root / "vendor-dependency-lock.json").read_text()):
        if "sha256" in item:
            fetch(item["url"], root / "downloads" / item["sha256"], item["sha256"])

    for item in json.loads((root / "fate-samples.json").read_text()):
        fetch(item["url"], pathlib.Path("/fate-samples") / item["file"], item["sha256"])


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--preflight", nargs=2, type=pathlib.Path, metavar=("FFMPEG", "ZLIB"))
    parser.add_argument("--vendor-patches", type=pathlib.Path)
    parser.add_argument("--test-config", type=pathlib.Path)
    args = parser.parse_args()
    if args.vendor_patches:
        apply_vendor_patches(root, args.vendor_patches)
    elif args.test_config:
        apply_test_config_patch(root, args.test_config)
    elif args.preflight:
        preflight_patches(root, *args.preflight)
    else:
        fetch_all()
