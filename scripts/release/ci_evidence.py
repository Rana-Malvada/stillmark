"""Whether GitHub already ran the release checks on exactly this source.

A release repeats checks whose answer depends only on the source. When the hosted run
passed on a commit with the identical file tree, repeating them here proves nothing
new. Checks that depend on today's advisories, on this machine, or on what is deployed
are never skipped on this evidence. Any doubt means "not verified": run everything.
"""

import json
import subprocess

from common import ROOT

# The two checks the main branch requires, by their exact names.
REQUIRED = (
    "Types, formatting, lint and unit tests",
    "Release checks and browser regressions",
)


def _text(args):
    return subprocess.run(
        args, cwd=ROOT, check=True, text=True, capture_output=True, timeout=60
    ).stdout.strip()


def _git(*args):
    return _text(["git", *args])


def _api(path):
    return json.loads(_text(["gh", "api", f"repos/{{owner}}/{{repo}}/{path}"]))


def _passed(sha, tree, api):
    """Both required checks succeeded on `sha`, and `sha` has exactly this file tree."""
    if api(f"git/commits/{sha}")["tree"]["sha"] != tree:
        return False
    latest = {}
    for check in api(f"commits/{sha}/check-runs?per_page=100")["check_runs"]:
        # Only GitHub's own runner counts; another app could report any name it likes.
        if check.get("app", {}).get("slug") != "github-actions" or check["name"] not in REQUIRED:
            continue
        if check["name"] not in latest or check["id"] > latest[check["name"]]["id"]:
            latest[check["name"]] = check
    return all(latest.get(name, {}).get("conclusion") == "success" for name in REQUIRED)


def verified(*, git=_git, api=_api):
    """(True, where) when the hosted checks passed on this exact source, else (False, why)."""
    try:
        if git("status", "--porcelain"):
            return False, "this folder has changes that are not in the commit"
        head = git("rev-parse", "HEAD")
        tree = git("rev-parse", "HEAD^{tree}")
        # A squash merge creates a new commit; the checks ran on the pull request's last
        # commit. Identical trees mean identical files, whatever the commit is called.
        candidates = [head] + [
            pull["head"]["sha"] for pull in api(f"commits/{head}/pulls") if pull.get("merged_at")
        ]
        for sha in candidates:
            if _passed(sha, tree, api):
                return True, f"GitHub passed both required checks on {sha[:7]}, same files as {head[:7]}"
        return False, "GitHub has no passing run of both required checks for these exact files"
    except Exception as error:  # no network, no gh, unexpected answer: never assume a pass
        return False, f"GitHub could not be asked ({type(error).__name__})"
