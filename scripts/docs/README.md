# Documentation maintenance

Current guides start at [the documentation index](../../docs/README.md). Keep run
results, audit reports and live observations in ignored `.release/` or `output/`.
Update feature docs when behavior changes and link new guides from an index.

`npm run docs:check` checks repository-relative inline Markdown links and index
reachability for every Markdown file under `docs/`. Ignored local outputs cannot
satisfy a link; new non-ignored files are included before staging. The checker does
not validate remote URLs, heading anchors, reference-style links or prose accuracy.
Run its regression tests with `node --test scripts/docs/validate.test.mjs`.
Both checks run in the release gate.

## Architecture document build

`build-target-architecture.py` creates the architecture Word document and four diagram images from `docs/architecture/stillmark-target-state.md`. It requires Python with python-docx and Pillow, and uses the macOS Arial fonts for diagrams.

Run from any directory:

```sh
python3 scripts/docs/build-target-architecture.py
```

The checked-in page map in `docs/architecture/stillmark-target-state-assets/page-map.json` supplies the contents page numbers. After changing content or formatting, render the document, check every page, update the map if pagination changes, and regenerate. Do not reuse old page numbers without checking the newly rendered edition. Rendering and inspection files belong in ignored `output/architecture-qa/`, not in Git.

Word exports go to ignored `output/docs/`; Markdown is the version-controlled source.
Regenerate and visually verify exports before distributing them. Diagram assets are
version-controlled design illustrations. This builder does not connect to Snowflake, start infrastructure, or modify application behavior.

`build-security-design.py` creates the security review companion from `docs/security/stillmark-security-design.md`, with its own assets and reviewed page map. Render both documents and validate section page numbers after edits.
