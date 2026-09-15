# Code Analysis — Architecture of the code-module analysis module

Status: draft · 2026-09-15
Home: `archify/modules/code-analysis`, Archify's integrated code analysis, imported from Bauify (`yijiez666-alt/bauify`, commit 4bb811c) and maintained here. The module produces facts and findings and layers them onto the diagram Archify delivered; validation, layout, and rendering stay Archify's. The module calls Archify only through its CLI (`archify deliver`) and touches the delivered page only by appending to a copy of it.

> Origin: this work was first proposed as an `analyzers/` subdirectory of Archify (tt-a1i/archify PR #352), then developed as the standalone tool Bauify, and finally brought back as this module. There is one way to use it, and it follows Archify's own order: Archify delivers the authored diagram; the page gets a **Code Analysis** button; clicking it runs the analysis and switches the page to the analysis view. Nothing is analyzed before the click.

---

## 0. Design essentials

- "The analyzer owns facts, an LLM owns explanation" is the system boundary: the analysis core stays deterministic, and LLM explanation is an **optional last-stage consumer** that never enters the pipeline.
- The intermediate representation is **five related graphs** (Symbol / Module / Call / Test / Git-Change): pass-through chains, dead exports, change impact, and test-coverage mapping all need symbol- and call-level information; a module graph alone cannot do them.
- Six analysis dimensions: coupling, complexity, redundancy, error handling, change impact, and AI-generated-code smells.
- Dimensions explicitly **not** done: cross-function data-flow / taint analysis, contract consistency, runtime / concurrency / resource safety, behaviour-level test robustness scores, and any single composite score. See §1.3 and the item-by-item rulings in Appendix A.
- The JS/TS front end is the TypeScript Compiler API (`allowJs`) throughout: one traversal yields module edges, symbols, references, and calls.
- A dependency cycle is a fact, not a verdict. The rules distinguish dependency structure from unverified loading risk (not-proven / potential-at-import / potential-partial-init) and leave the design judgment to the reader.

---

## 1. Goals, boundaries, and ruling principles

### 1.1 Goals

Perform **deterministic, reproducible, evidence-backed** static analysis of a local Git repository and answer:

1. Is the module coupling reasonable (direction, strength, cycles, layering, hidden coupling)?
2. Is the code concise; is there redundancy (duplication, dead code, over-abstraction, wrapper layers that add nothing)?
3. Is function complexity under control?
4. Are the failure paths of external calls handled?
5. If one module changes, which modules and tests does it statically reach?
6. Does new code drift from the repository's established dependency patterns (the AI-generated-code scenario)?

Outputs: JSON for the five graphs, `findings.json`, `report.json` grouped by dimension, and an IR that can be handed directly to `archify deliver architecture --repo-root`.

### 1.2 Non-goals

- Archify's IR and delivered artifact are not modified; the analysis is a layer appended to a copy of the delivered page, and validation and rendering are left to `archify deliver`.
- The analyzed code is never executed (no tests run, no sampling, no instrumentation).
- The analysis core calls no LLM; every finding traces back to a file, line, edge, or set of commits.
- No automatic fixes in the first phase.
- No single composite score, and no 0–100 number without a published formula.

### 1.3 Ruling principles (for screening candidate dimensions)

A dimension enters this architecture only if it satisfies all of:

1. **Statically decidable**: the fact can be obtained from the AST, references, or Git history without executing code.
2. **Precision first**: better to miss than to misreport. False positives destroy the "evidence you can trust" premise the product rests on.
3. **Mature infrastructure exists**: it can be built on the TypeScript API, Python `ast`, and Git, without a home-grown data-flow engine.
4. **Evidence is presentable**: each finding's evidence lands on `file:line` or an edge / commit list and can be attached to an Archify node card.

Anything that fails is either downgraded to an "optional external-tool adapter" or explicitly not done. The rulings are in Appendix A.

---

## 2. Pipeline

```
authored IR ──▶ archify deliver ──▶ architecture.html ──▶ served locally with a "Code Analysis" button
                                                                      │ click
target repo ──▶ 1. extract ──▶ 2. build-graphs ──▶ 3. evaluate ──▶ 4. overlay ──▶ repo.analysis.html (delivered page + layer)
(git checkout)   language        five graphs +        rule engine        │
                 adapters        function metrics                        └─▶ (later) report per dimension, optional LLM explanation
                     │                 │                  │
              raw-facts.json     graphs/*.json       findings.json
```

Every stage is a pure JSON → JSON transformation whose input and output are written to disk, have a schema, and can be tested on their own. Any stage can be replaced independently.

### 2.1 Extraction `extract/`

The language-adapter interface:

```ts
interface LanguageAdapter {
  id: 'ts' | 'py';
  detect(repoRoot): boolean;
  extract(repoRoot, options): RawFacts;   // files, symbols, references, imports, calls, function metrics
}
```

| Language | Front end | Output | Notes |
|---|---|---|---|
| JS / TS | TypeScript Compiler API (`createProgram` + `allowJs`) | import edges (static / dynamic / require / export), symbol definitions, references, calls, function AST metrics | one traversal gets everything; TS's reference resolution is good enough for JS too, so Archify can be analyzed by itself |
| Python | standard-library `ast` (`extract/py/extract.py`, a subprocess emitting JSON) + resolution on the Node side | import edges — relative imports, `__init__.py` packages, PEP 420 namespace packages, `importlib.import_module` literals; function-scope imports flagged `lazy`; module-scope symbol bindings with their line | both languages share one set of external / outside / unknown / opaque counting semantics; the call graph (M2) will be less precise than for TS |

`unresolved.opaque` counts `import()` / `require()` / `import_module()` calls whose argument is not a string literal. Archify's `bin` launches renderers through `spawnSync` and a computed `import()`; static analysis cannot see those edges, and the count makes that blind spot explicit instead of letting an edge silently vanish from the diagram.

Function-level metrics are computed from the AST during extraction and emitted alongside the symbols; the CFG is **not persisted**: cyclomatic complexity, cognitive complexity (SonarSource's published definition), maximum nesting, branch count, return points, LOC.

### 2.2 Graph construction `graphs/`

Five graphs are built from `raw-facts.json`, each written to `graphs/<name>.json`:

| Graph | Nodes | Edges | Used for |
|---|---|---|---|
| **Symbol Graph** | functions / classes / variables / types / exports | definition, export, reference | dead exports, unused imports, single-implementation interfaces |
| **Module Graph** | modules (grouping: explicit groups > package boundary > directory depth; root-level files are modules of their own) | import, with weight and evidence | cycles, layering, fan-in / fan-out, instability |
| **Call Graph** | functions | statically resolvable calls | pass-through chains, change impact, locating external calls |
| **Test Graph** | test files, test cases | test → imported module / symbol | untested modules, tests reached by a change |
| **Git Change Graph** | files | co-change counts (last N commits) | change coupling, hotspots |

The call graph only records **statically resolvable** calls (direct calls, same-module methods, named imports); dynamic dispatch, reflection, and string-based calls are never recorded and are counted in `graphs/call.json#unresolved`, so the omission stays visible.

### 2.3 Evaluation `evaluate/`

The rule interface:

```ts
interface Rule {
  code: string;                         // 'coupling/import-cycle'
  dimension: Dimension;                 // see §4
  severity: 'error' | 'warning' | 'info';
  confidence: 1.0 | 0.7 | 0.5;
  run(ctx: { graph, facts, config }): Finding[];
}
```

Constraints: thresholds come from configuration and are echoed in the evidence; rules have no ordering dependencies on each other; suppression (`// bauify-ignore <code>` or the `ignore` config) is counted in `summary.suppressed`, never silent. Finding ids are stable (`COUP-0001`) and derived from a deterministic sort, not from insertion order.

### 2.4 Reporting `report/`

Groups findings by dimension and reports each dimension's **error / warning / info counts and the raw values of its key metrics** (number of cycles, maximum fan-in, duplicate-code ratio, …). No 0–100 score. If a score is ever wanted, its formula must be published in `config/scoring.json` and the formula version echoed in the report.

### 2.5 The Archify side: `serve` and `overlay/`

The module meets Archify at exactly one point. `archify code-analysis serve <repo> --ir <architecture.json> --out <dir>` first runs `archify deliver architecture` on the authored IR — the same command, the same checks, the same artifact a person would get without this module — then serves that page on a loopback port with one extra toolbar button, **Code Analysis**. The button is the only trigger: clicking it runs extract → graphs → evaluate → overlay for the repository (`lib/analysis.mjs`, in the serving process), writes every stage to `<dir>/analysis/`, and switches the page to the analysis view. A second click never re-runs the analysis; from then on the same button shows or hides the layer. There is no batch command, no auto-generated diagram, and no way to run a stage on its own from the product CLI; the stages remain separate, schema-checked JSON files so a result can still be inspected and diffed.

An earlier "bridge" that generated an Archify IR from the module graph was removed: a folded dependency graph is far more detailed than a diagram a person would draw, and the order above — diagram first, analysis on request — is the one the product wants.

**`overlay/inject.mjs` — the analysis layer.** An agent-authored Archify diagram says how a system *runs*; the analysis says what the code *imports*. The overlay appends one data block, one style block, and one script to a *copy* of the delivered HTML. The delivered file is never rewritten, so `deliver`'s sha receipt still holds for the original.

- Component-to-module mapping comes from the IR's `sources` by default; `--map` states it explicitly. Modules no component claims are listed as "not on this diagram" rather than dropped.
- With the button on, the authored diagram and guided views recede and every component gets a blurred halo just outside its box, coloured by danger level: red (pulsing) = a supplied error finding (not currently emitted by cycle rules); amber = a rule warns (a module-scope cycle or a hub); blue = structural coupling with initialization behavior unverified; green = nothing fired; grey = no code maps here. A legend next to the button names the levels. No import lines are drawn on the diagram; Archify's picture stays the subject.
- Clicking a component opens a panel with its indicators (circular dependency, hub module, instability), the mapped modules, every file with LOC and import counts, and module edges with file:line evidence. Clicking an indicator opens a second panel with the findings behind it and a small diagram Bauify draws to explain them: the cycle as a ring with lazy edges dashed, the hub as a star of dependents and dependencies with links to its source files, instability as in/out bars. Every file:line a finding cites is a button; the cited files are embedded whole, and the button opens a third, draggable panel scrolled to the cited line. GitHub links are pinned to the analyzed commit.
- The page embeds the full Bauify dataset (module graph plus every file's facts), and `findings.json` next to the module graph is picked up automatically; findings attach to components through `subject.component`, `subject.module(s)`, and `subject.files`, so future `redundancy/*` findings land in the same panels without changes to the page.
- Root-level files are modules of their own (`main.py` → `main`, `config.py` → `config`); merging an entry point with a constants table into one `root` module manufactured a false cycle in an early run.

Later: `coupling/*` and `impact/*` findings may carry `views` (Archify guided views, ≤ 5 chapters) so a diagram can narrate an analysis conclusion.

### 2.6 LLM explanation (optional, `explain/`)

Input `findings.json` + `report.json`, output natural-language explanation and improvement suggestions. It **may only cite evidence already present in the findings** and may not add facts. It is not on the CI-gate path and does not affect the determinism of any JSON artifact.

---

## 3. Data contracts

### 3.1 Finding (a typed finding aligned with Archify's diagnostic contract)

```json
{
  "id": "COUP-0003",
  "code": "coupling/import-cycle",
  "dimension": "coupling",
  "severity": "info",
  "confidence": 0.7,
  "message": "A dependency component contains deferred imports. Initialization behavior is not proven; function calls may occur during import. Any module-scope subcycles are reported separately.",
  "subject": { "files": ["llm/llm_client.py", "tools/local_tool.py", "tools/news/digest.py", "tools/search/pipeline.py"] },
  "evidence": {
    "kind": "deferred",
    "risk": { "loading": "not-proven", "coupling": "present", "loadingNote": "call timing is not modeled; a deferred function may run during initialization" },
    "path": ["llm/llm_client.py", "tools/local_tool.py", "tools/news/digest.py"],
    "imports": [ { "file": "llm/llm_client.py", "line": 46, "to": "tools/local_tool.py", "names": ["*"] }, { "file": "tools/news/digest.py", "line": 78, "to": "llm/llm_client.py", "names": ["ask_llm"], "lazy": true } ],
    "lazyImports": 3,
    "totalImports": 6,
    "threshold": null
  },
  "supportedFixes": ["keep the lazy import if the call-back is intentional, and say so in a comment at the import", "if the two sides should be testable in isolation, inject the callee (a callback or protocol) from the composition root instead of importing it"]
}
```

`confidence` has fixed semantics: `1.0` = derived directly from static facts (cycles, dead exports); `0.7` = depends on heuristic matching (an external call without a timeout, pass-through detection); `0.5` = statistical inference (change coupling, pattern deviation). A rule declares its confidence; it may not float at run time.

### 3.2 Other artifacts

`raw-facts.json`, `graphs/{symbol,module,call,test,git-change}.json`, `findings.json`, and `report.json` each have a JSON Schema under `schemas/`, validated with ajv. All arrays are sorted by stable keys and contain no timestamps, so output is byte-for-byte reproducible.

---

## 4. Rule catalog (by dimension)

### 4.1 `coupling` — is the coupling reasonable

| code | severity | confidence | detects | graphs |
|---|---|---|---|---|
| `coupling/import-cycle` | info / warning | 0.7 | File-level runtime SCCs, excluding type-only edges. Deferred/conditional components are `not-proven`; module-scope cycles are `potential-at-import`. Recorded binding order may add an inspectable `partialInitCandidate` (`potential-partial-init`), not an execution proof. Current rules never emit error severity or claim import safety. | raw facts (with symbols) |
| `coupling/cycle` | info | 1.0 | module (package) level strongly connected components; may be an artifact of directory grouping, and points at `import-cycle` for whether any file actually cycles | Module |
| `coupling/layer-violation` | error | 1.0 | an edge against the layer order declared in configuration | Module |
| `coupling/pattern-deviation` | warning | 0.5 | **when no layers are declared**: for every pair of directories compute the dominant dependency direction; an edge against it with weight < 20 % of the pair is a deviation; can be limited to edges added after `--since <ref>` | Module, Git |
| `coupling/hub` | warning | 1.0 | fan-in ≥ 5 and fan-out ≥ 5 (thresholds from config, echoed in evidence). A coordination point, not a bug; the dependents list usually shows where a split would go | Module |
| `coupling/unstable-dependency` | warning | 1.0 | a stable module depends on an unstable one, instability difference > 0.4 | Module |
| `coupling/internal-leak` | warning | 1.0 | a cross-module reference to a symbol in a non-entry file (bypassing the module's public surface) | Symbol, Module |
| `coupling/change-coupling` | warning | 0.5 | two modules with no static dependency co-change in > 50 % of the last 200 commits | Module, Git |
| `coupling/orphan` | info | 1.0 | not an entry point and has no edges in or out | Module |

`coupling/pattern-deviation` is the decidable version of the idea "learn the repository's dominant pattern": it does not learn semantics such as "Controller → Service", only the majority direction of dependencies.

### 4.2 `complexity`

| code | severity | detects |
|---|---|---|
| `complexity/cyclomatic` | warning | cyclomatic complexity > 15 |
| `complexity/cognitive` | warning | cognitive complexity > 20 (SonarSource definition) |
| `complexity/nesting` | info | maximum nesting > 5 |
| `complexity/exits` | info | return points > 6 |
| `complexity/long-function` | warning | LOC > 80 |
| `complexity/large-file` | info | file LOC > 800 |
| `complexity/hotspot` | warning | cognitive complexity × recent change count in the top 5 % |

All confidence 1.0. "Number of responsibilities per function" is excluded: it cannot be decided statically.

### 4.3 `redundancy`

| code | severity | confidence | detects |
|---|---|---|---|
| `redundancy/duplicate-block` | warning | 1.0 | cross-file token-level duplication (winnowing, 50-token window, compared after identifier normalisation, so it covers exact and near duplicates) |
| `redundancy/dead-export` | warning | 1.0 | exported and unreferenced anywhere in the repository; entry points, `package.json#exports`, and tests are excluded |
| `redundancy/unused-import` | info | 1.0 | imported and never referenced |
| `redundancy/unused-symbol` | info | 1.0 | a non-exported function / class / variable with no reference inside its module |
| `redundancy/pass-through` | warning | 0.7 | a function body that is a single call forwarding its parameters and return value unchanged; chain depth is computed along the call graph and reported at depth ≥ 2 |
| `redundancy/single-impl-abstraction` | info | 1.0 | an interface / abstract class with one implementation, or a factory that produces one type (TS / Python class level) |
| `redundancy/unreachable` | info | 1.0 | statements after `return` / `throw`; branches under always-true / always-false conditions (literal constants only) |

"Semantic duplication" is narrowed to two decidable rules: `duplicate-block` (structurally identical after normalisation) and `pass-through` (for example `get_user / fetch_user / retrieve_user` all forwarding to `db.get_user`, reported as "several pass-throughs to the same callee"). Semantic equivalence in the general sense is not attempted.

### 4.4 `error-handling` — failure paths of external calls

| code | severity | confidence | detects |
|---|---|---|---|
| `error-handling/external-call-unguarded` | warning | 0.7 | a call to a known network / IO API from the catalog (`fetch`, `axios.*`, `http.request`, the synchronous `fs.*` family, Python `requests.*`, `urllib`, `open`) with neither a `try/catch` around it nor a `.catch` in the same function |
| `error-handling/missing-timeout` | warning | 0.7 | the same APIs called without a timeout / `AbortSignal` (judged by the parameter position in the catalog) |
| `error-handling/unchecked-status` | info | 0.7 | a `fetch` result whose `.ok` / `.status` is never read before `.json()` |
| `error-handling/swallowed-error` | warning | 1.0 | an empty `catch` block, or one containing only `console.log` / `pass` |

The API catalog lives in `config/external-apis.json` and is extensible. Retry / backoff / fallback / idempotency detection is **not** done: the implementation shapes are too varied for static matching to have an acceptable false-positive rate.

### 4.5 `impact` — static change impact

| code | severity | detects |
|---|---|---|
| `impact/dependents` | info | each module's direct and transitive dependents and the number of test files involved (reachability over Module + Test graphs) |
| `impact/untested-module` | warning | a module with edges but no test file importing it |
| `impact/high-reach` | warning | transitive dependents ≥ 50 % of all modules |

The terms are fixed as **static dependents / static reach**, never "blast radius", and no risk score is given. This follows Archify's DESIGN.md ("Don't call graph reachability runtime impact, blast radius, or breakage"): we have import evidence, not runtime evidence.

### 4.6 `ai-smell` — smells typical of AI-generated code (composite rules)

This dimension adds no detectors; it recombines the rules above into aggregate views of patterns common in AI-generated code:

| code | composed from |
|---|---|
| `ai-smell/over-abstraction` | `redundancy/single-impl-abstraction` + a `redundancy/pass-through` chain of depth ≥ 3 |
| `ai-smell/pattern-drift` | `coupling/pattern-deviation` where the edge was added after `--since` |
| `ai-smell/sibling-inconsistency` | several functions in one module calling the same external API, some hit by `error-handling/*` and some not |

Their confidence is the minimum of their components.

---

## 5. Repository layout

```
archify/modules/code-analysis/
  ARCHITECTURE.md  README.md  LICENSE  NOTICE
  package.json                  ← devDependencies: typescript, ajv
  bin/serve.mjs                 ← the one entry point: archify deliver → serve → analyze on click
  lib/analysis.mjs              ← the stages as a library: extractFacts, buildGraph, evaluateGraph, overlayHtml, analyzeRepository
  config/
    defaults.json               ← every threshold, include / exclude, roles
    external-apis.json          ← API catalog for the error-handling rules (planned)
  schemas/                      ← raw-facts / module-graph / findings (the other graphs and report follow)
  extract/
    index.mjs
    ts/                         ← TypeScript Compiler API adapter
    py/                         ← standard-library ast script + Node-side resolution
    shared/                     ← git, files, glob, schema, diagnostics, semantics
  graphs/
    module.mjs                  ← symbol.mjs call.mjs test.mjs git-change.mjs follow
  evaluate/
    index.mjs
    rules/coupling/{import-cycle,cycle,hub}.mjs   ← complexity, redundancy, error-handling, impact, ai-smell follow
  overlay/inject.mjs            ← appends the analysis layer to a copy of the delivered page
  docs/TECH-GUIDE.md
  test/
    fixtures/<case>/            ← one minimal synthetic repository per case + expected output
    run-extract.mjs             ← test harness only (extraction in a child process)
    *.test.mjs
```

---

## 6. CLI

```bash
# from the archify/ package directory
node bin/archify.mjs code-analysis serve <repo-root> --ir <architecture.json> --out <dir> \
  [--language ts|py] [--map overlay-map.json] [--config file.json] [--quality standard|showcase]
```

That is the whole surface. `serve` delivers the diagram with `archify deliver` (with `--repo-root` when the IR pins a repository), prints a loopback URL, and analyzes the repository when **Code Analysis** is clicked on that page. `--since <ref>` (planned) will restrict `pattern-deviation` and `ai-smell/pattern-drift` to edges added after that ref for reviewing one AI-generated PR; a `--fail-on` gate and the optional `explain` step are also still planned and will hang off the same command.

---

## 7. Tests and acceptance

1. Rule-level fixtures: at least one positive and one negative case each, expected findings compared field by field. The `import-cycle` proof is checked against a real Python `ImportError`.
2. Contract tests: every artifact passes ajv; the analysis page is the delivered page plus the appended layer, byte for byte.
3. Self-analysis golden: the whole pipeline over `archify/`, output frozen; changes must be updated explicitly and explained in the PR.
4. Determinism: two runs on the same input are byte-identical.
5. Precision sampling: from M2, every rule with `confidence < 1.0` is spot-checked by hand on 20 findings across three real open-source repositories; a rule above 20 % false positives is downgraded to info or narrowed.
6. CI: this repository's own workflow; the self-analysis tests find Archify through `BAUIFY_ARCHIFY_ROOT` pointing at a pinned checkout and are skipped, not failed, when it is absent.

M1 acceptance: self-analysis of Archify's `archify/` package finds the `bin → renderers/<type> → renderers/shared` layering with zero false `layer-violation` findings, and the click flow on a delivered page passes end to end.

---

## 8. Milestones

Progress (2026-09-15): `extract` (TS + Python, with lazy / conditional / type-only import flags and module-scope symbols), `graphs` (Module Graph), `evaluate` (`coupling/import-cycle` in tiers, `coupling/cycle`, `coupling/hub`), `overlay`, and the `serve` click flow are done and exercised end to end on Archify's `archify/` package and on AI-voice-assistant. The Python adapter moved from M6 to M1 because the end-to-end test needed it. The bridge and the batch commands were removed in favour of the single deliver → click → analyze path. Next: `coupling/layer-violation` and the redundancy rules.

| # | Scope | Deliverable |
|---|---|---|
| M1 | TS + Python extraction, Module Graph, `overlay`, `serve` click flow, `coupling/import-cycle` / `cycle` / `hub` (done); `layer-violation` | two real repositories end to end |
| M2 | Symbol / Call / Git graphs + the remaining `coupling/*` + `complexity/*` | coupling and complexity complete |
| M3 | `redundancy/*` (duplicate blocks, dead exports, pass-through, single-implementation abstractions) | redundancy analysis |
| M4 | Test graph + `impact/*` + `error-handling/*` + `ai-smell/*` + `--since` | PR-review usage |
| M5 | `report` per-dimension summary + `--fail-on` gate + optional `explain` | fitness function + explanation |
| M6 | a third language adapter (by demand; Java is the candidate) | third language |

---

## 9. Open questions

- Is a default grouping depth of 2 right for monorepos? It may need to switch to package boundaries automatically when `workspaces` is present.
- The 20 % "dominant direction" threshold of `pattern-deviation` needs calibration on real repositories.
- Is a Python call graph worth bringing in `pycg` (a research-grade tool with uneven maintenance), or should Python stay at import level for now?
- Should `explain` live in this repository, or be a prompt the calling agent runs itself?
- The overlay relies on a few viewer hooks (`g[data-node-id]`, `path[data-edge-id]`, `.toolbar`, the panel CSS variables). Now that the module lives in Archify, a viewer change that renames them must update the overlay in the same change; a test that renders a fixture and clicks through guards it.

---

## Appendix A. Rulings on candidate analysis dimensions

During design a broader "repository robustness analysis" list was considered (architecture, complexity, redundancy, data flow, error handling, state, contracts, tests, change impact, Git history, runtime safety, and smells of AI-generated code). The table rules on each item by the principles in §1.3: adopted, narrowed, or explicitly not done.

| Candidate | Ruling | Reason / destination |
|---|---|---|
| 2.1 Architecture / Coupling | **adopted** | every metric is statically available; "Architecture Health 72/100" becomes per-dimension counts and raw values |
| 2.2 Complexity | **adopted (partly)** | cyclomatic / cognitive complexity, nesting, return points, LOC adopted; "function responsibility count" is not statically decidable and is dropped |
| 2.3 Redundancy | **adopted (narrowed)** | exact / near duplicates, unused, unreachable adopted; "semantic duplicate" narrowed to normalised duplication + pass-through; "duplicate abstraction" merged into single-impl-abstraction |
| 2.4 Data Flow / Taint | **not done** | cross-function taint analysis is CodeQL / Semgrep-scale engineering; a home-grown version is infeasible and its precision unguaranteed. Later possible as an external-tool adapter converting Semgrep JSON into findings |
| 2.5 Error Handling | **adopted (narrowed)** | timeout, exception guarding, status check, swallowed errors are decidable against an API catalog; retry / backoff / fallback / idempotency dropped |
| 2.6 State & Side Effect | **deferred** | counting readers / writers of module-level mutable globals is possible but of limited value; real side-effect analysis needs inter-procedural data flow. Re-evaluate after M6 |
| 2.7 Contract | **not done** | inconsistent return types belong to `tsc` / `mypy` (whose diagnostics could be ingested through an adapter); cross-service producer / consumer contracts need external schemas such as OpenAPI / protobuf, beyond repository static analysis |
| 2.8 Test Robustness | **adopted (narrowed to static mapping)** | test → module mapping, untested modules, affected-test counts are feasible; "happy / failure / boundary coverage" and "Behavioural Robustness 43 %" cannot be decided statically and would be invented numbers. Behaviour-level protection belongs to mutation testing (Stryker / mutmut), which executes code and could be an optional adapter |
| 2.9 Change Impact | **adopted (renamed)** | direct / transitive dependents and affected tests adopted; "blast radius" and "risk score 8.4/10" dropped |
| 2.10 Git History | **adopted** | co-change and hotspots adopted; bug-fix frequency depends on commit-message keywords and is info only; ownership concentration (bus factor) is an info metric and never enters a gate |
| 2.11 Operational Robustness | **not done** | thread safety, races, and unbounded memory are not statically decidable; heuristics such as "`results.append` inside a loop means unbounded memory" produce floods of false positives on real repositories; resource cleanup is left to existing linters |
| 3.1 Over-abstraction | **adopted** | single-implementation interfaces / single-product factories are statically countable |
| 3.2 Wrapper Explosion | **adopted** | pass-through chain depth; needs the Call Graph |
| 3.3 Defensive-Code Inconsistency | **adopted (narrowed)** | "shares the same contract" cannot be decided; narrowed to "functions in one module calling the same external API handle errors inconsistently" |
| 3.4 Pattern Inconsistency | **adopted (narrowed)** | no semantic pattern learning; only the majority dependency direction between directory pairs |
| 4 Multi-graph IR | **five adopted, three dropped** | Symbol / Module / Call / Test / Git-Change adopted; the CFG is only computed for metrics at extraction time and not persisted; Data Flow Graph and State Graph go with their dimensions |
| 5 Pipeline with Risk Engine + LLM | **structure adopted, Risk Engine dropped** | a Risk Engine is a scoring formula and conflicts with §1.2; LLM explanation is an optional end consumer |
| 6 Evidence-First | **adopted** | the premise of this architecture |
| 7 Typed Finding | **adopted (merged)** | merged with Archify's diagnostic contract, adding `dimension` and `confidence` |
| 8 Multi-dimension report | **adopted (without scores)** | per-dimension split kept; no 0–100 score until a formula is published |
| 9 Product positioning "Can I trust this codebase?" | **partly adopted** | the positioning is sound, but this tool only promises the six statically decidable questions in §1.1; data-flow safety, production failure, and contracts are explicitly outside the promise |
