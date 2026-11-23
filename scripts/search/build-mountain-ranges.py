"""Build the search label index from GeoNames allCountries.zip and countryInfo.txt.
GeoNames geographical database, https://www.geonames.org/, CC BY 4.0.
The index contains names/aliases of named mountain ranges grouped by country.
"""
import json
import sys
from pathlib import Path
from zipfile import ZipFile

countries = {
    parts[0]: parts[4].lower()
    for line in Path(sys.argv[2]).read_text().splitlines()
    if line and not line.startswith("#") and (parts := line.split("\t"))
}
ranges = {}
with ZipFile(sys.argv[1]) as archive, archive.open("allCountries.txt") as rows:
    for row in rows:
        cols = row.rstrip(b"\n").split(b"\t")
        if cols[7] != b"MTS":
            continue
        country = countries.get(cols[8].decode())
        if country:
            ranges.setdefault(country, set()).update(
                name.strip().lower()
                for name in [cols[1].decode(), cols[2].decode(), *cols[3].decode().split(",")]
                if name.strip()
            )
Path(sys.argv[3]).write_text(json.dumps({k: sorted(v) for k,v in sorted(ranges.items())},ensure_ascii=False,indent=2)+"\n")
