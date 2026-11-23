"""Render reviewed control SQL to stdout; never edit or apply historical setup."""

import json
import re
import subprocess
from pathlib import Path

root = Path(__file__).resolve().parents[2]
spec = json.loads((root / "workers/video-gpu/production-spec.json").read_text())
container = spec["spec"]["containers"][0]
container["env"]["WORKER_RUN_ID"] = "RUN_ID"
container["env"]["WORKER_MAX_JOBS"] = "10000"
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
source = (root / "config/templates/video-control.sql").read_text()
source = re.sub(r"\{\{([A-Z0-9_]+)\}\}", lambda match: profile[match.group(1)], source)
rendered, count = re.subn(
    r" var spec=.*?;\n spec.spec.containers",
    lambda _: " var spec=" + json.dumps(spec) + ";\n spec.spec.containers",
    source,
    count=1,
)
if count != 1:
    raise SystemExit("Expected exactly one worker specification")
print(rendered, end="")
