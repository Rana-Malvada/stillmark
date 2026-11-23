"""Regenerate hashed Linux/amd64 worker locks with uv 0.9.7; review and test upgrades."""

import pathlib
import subprocess

ROOT = pathlib.Path(__file__).resolve().parents[2]
LOCKS = (
    ("face-cpu", "workers/face-cpu/requirements.txt", "3.12"),
    ("upload-cpu", "workers/shared/requirements.txt", "3.13"),
    ("search-cpu", "workers/search-cpu/requirements-linux-amd64.in", "3.12"),
)


def main():
    if not subprocess.check_output(["uv", "--version"], text=True).startswith("uv 0.9.7"):
        raise RuntimeError("Use uv 0.9.7 to regenerate reviewed worker locks")
    for worker, source, version in LOCKS:
        target = ROOT / "workers" / worker / "requirements-linux-amd64.lock"
        args = [
            "uv",
            "pip",
            "compile",
            source,
            "--python-version",
            version,
            "--python-platform",
            "x86_64-manylinux_2_28",
            "--generate-hashes",
            "--emit-index-url",
            "-o",
            str(target.relative_to(ROOT)),
        ]
        if worker == "search-cpu":
            args += ["--torch-backend", "cpu"]
        subprocess.run(args, cwd=ROOT, check=True)
        if worker == "search-cpu":
            # uv chooses PyTorch's CPU index for torch only; pip needs the index
            # explicitly at install time. --require-hashes constrains all bytes.
            target.write_text(
                target.read_text().replace(
                    "--index-url https://pypi.org/simple",
                    "--index-url https://pypi.org/simple\n--extra-index-url https://download.pytorch.org/whl/cpu",
                )
            )


if __name__ == "__main__":
    main()
