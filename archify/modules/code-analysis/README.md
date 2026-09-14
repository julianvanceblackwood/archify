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

## Interactive architecture view

```sh
npm run code-analysis -- serve /path/to/repo --ir architecture.json --out out/interactive --language ts
```

Open the local URL printed by the command and keep it running. The architecture
is delivered first; source extraction does not run until you click **Code Analysis**
in the top-right toolbar. **分析图切换**, on the right side, becomes available after
analysis succeeds. It shows or hides the analysis layer and its component details
without running analysis again. Failures show a retry action. Restart the command
for a fresh analysis after changing source code.

The interactive page requires this local process because standalone HTML cannot
run the Python/TypeScript extractor. The existing `run` and `analyze` commands
remain available for batch output. The service listens only on loopback and accepts
analysis requests only from its own page; browser requests cannot select arbitrary
repository or output paths.
