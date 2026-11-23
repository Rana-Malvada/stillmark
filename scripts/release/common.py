import os, pathlib, subprocess, json
from postgres_tools import tool

ROOT = pathlib.Path(__file__).resolve().parents[2]
PROFILE = json.loads((ROOT / "config/deployment.json").read_text())


def run(args, **kwargs):
    return subprocess.run(args, check=True, text=True, **kwargs)


def sql(statement, database="postgres"):
    return run(
        [
            tool("psql"),
            f"service={os.environ.get('GALLERY_PG_SERVICE',PROFILE['PG_SERVICE'])} dbname={database}",
            "-X",
            "-v",
            "ON_ERROR_STOP=1",
            "-At",
            "-c",
            statement,
        ],
        capture_output=True,
    ).stdout.strip()


def quote(value):
    return "'" + str(value).replace("'", "''") + "'"
