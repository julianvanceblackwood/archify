# Code Analysis

Code Analysis is Archify's integrated static code analysis module, imported from
Bauify (commit 4bb811c). It extracts Python and JS/TS dependencies, checks coupling
and import cycles, exports architecture IR, and overlays findings on delivered diagrams.

From the `archify/` package directory:

```sh
npm run setup:code-analysis
npm run code-analysis -- --help
npm run code-analysis -- run /path/to/repo --language ts --out out/analysis --json
npm run code-analysis -- analyze /path/to/repo --ir architecture.json --out out/analysis --json
npm run test:code-analysis
```

The equivalent CLI entry is `node bin/archify.mjs code-analysis`.
Commands: `extract`, `graphs`, `evaluate`, `bridge`, `run`, `overlay`, `analyze`.
Python analysis requires Python 3; `BAUIFY_PYTHON` can select its executable.
`analyze` uses the containing Archify installation by default. Explicit `--archify`
and `BAUIFY_ARCHIFY_ROOT` overrides remain supported for compatibility.
The original Bauify source repository remains independent; future changes to this
module are maintained here. Existing evidence schemas and diagnostic codes remain compatible.

Analysis does not execute repository code. Cycle findings describe potential risk,
not proven runtime failure. See [technical guide](docs/TECH-GUIDE.md) for details.
