"""Render reviewed face-scan control SQL to stdout; never applies anything."""

import json
import re
import subprocess
from pathlib import Path

root = Path(__file__).resolve().parents[2]
spec = json.loads((root / "workers/face-cpu/production-spec.json").read_text())
container = spec["spec"]["containers"][0]
container["env"]["WORKER_RUN_ID"] = "RUN_ID"
# Validate through the shared loader before substituting SQL identifiers.
profile = json.loads(
    subprocess.check_output(
        [
            "node",
            "--input-type=module",
            "-e",
            "import {deployment} from './config/deployment.mjs'; console.log(JSON.stringify(deployment))",
        ],
        cwd=root,
        text=True,
    )
)
source = (root / "config/templates/face-control.sql").read_text()
source = re.sub(r"\{\{([A-Z0-9_]+)\}\}", lambda match: profile[match.group(1)], source)
rendered, count = re.subn(
    r"\bvar spec=SPEC;", lambda _: "var spec=" + json.dumps(spec) + ";", source
)
if count != 1:
    raise SystemExit("Expected exactly one worker specification")
if profile["GPU_POOL"] in rendered:
    raise SystemExit("Face controls must not reference the video GPU pool")
print(rendered, end="")
