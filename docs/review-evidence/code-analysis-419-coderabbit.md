# CodeRabbit follow-up for PR 419

Reviewed PR head: `3bcad34bd55ac3758f15b7b961ee976d985c1ee8`.
Target base: `fdc5b183f743cbce1b6dacd07c43ecc224b05b78`.
These results describe local changes on top of that head, not a new remote CI result.

## Disposition

- [Python source encoding](https://github.com/tt-a1i/archify/pull/419#discussion_r4043380955): fixed. Detect the declared Python encoding from captured bytes once, then reuse the decoded text for parsing and source display. Invalid encodings remain per-file parse diagnostics.
- [Concurrent dependency installation](https://github.com/tt-a1i/archify/pull/419#discussion_r4044781943): fixed. Atomic directory locking coordinates separate processes sharing the canonical module directory. Recheck the manifests under the lock; release on failure. Waits are bounded and stale locks require explicit recovery rather than risking a second installer.
- [JSON stage contract](https://github.com/tt-a1i/archify/pull/419#discussion_r4044781957) and [diagnostic fields](https://github.com/tt-a1i/archify/pull/419#discussion_r4044781965): fixed in the guide, including its later description of the pipeline.
- [Recursive SCC traversal](https://github.com/tt-a1i/archify/pull/419#discussion_r4044781969): fixed. Both rules use a shared iterative Tarjan implementation. Module-cycle and file self-cycle behavior remain distinct. A 16,000-node chain regression exercises both public rule entry points.
- [Shadowed Python loaders](https://github.com/tt-a1i/archify/pull/419#discussion_r4044781976): fixed for lexical bindings. Eager statements respect binding order; deferred bodies use conservative enclosing bindings. Parameters, local assignments, global/nonlocal writes, aliases, classes, and comprehension bindings are accounted for. Arbitrary runtime monkey-patching remains outside static extraction's guarantees.
- [Relative imports beyond a package](https://github.com/tt-a1i/archify/pull/419#discussion_r4044781987): fixed. Reject imports above package depth, including src layouts; retain relative imports when the analyzed root is itself a package. Corrected the hand-verified fixture, without changing the cycle policy.
- Nested glob alternatives: fixed. Brace alternatives share wildcard translation with the surrounding expression, including nested braces and escaped literals. Unclosed braces retain the existing diagnostic.
- Standalone interactive test: fixed. The IR-change regression uses the same checkout-availability guard as the other integration test.

The older scratch-workspace and AI Voice output comments are already addressed in the reviewed head: neither set of paths remains tracked. Previously addressed launcher, dependency-manifest, workflow, NOTICE, and independent test-setup changes remain intact.

## Filesystem-race finding: hardened, not fully closed

[Directory replacement race](https://github.com/tt-a1i/archify/pull/419#discussion_r4044781999): the finding is valid. The original walker trusted old directory entries, and the adapters subsequently reopened live paths.

The follow-up adopts the repository's package-stager pattern: record ancestor identities and metadata, reject symlinks and real-path escapes, open regular files with no-follow flags where supported, compare descriptor identity and path state before and after reading, and retain source bytes in memory. TypeScript's compiler host reads that snapshot; Python receives the captured bytes rather than reopening paths. Regressions reject directory replacement after enumeration and file replacement before opening, skip preexisting external links, and verify captured bytes survive later edits.

This is a practical mitigation, not an OS-atomic filesystem snapshot or a proof against every adversarial replacement sequence. In particular, portable Node APIs do not provide descriptor-relative no-follow traversal of every ancestor on all supported hosts. Fully closing that stronger security requirement needs a reviewed native/OS-specific traversal or trusted filesystem snapshot design and host-specific attack tests. Do not mark this review thread fully resolved based only on these checks.

## Validation

- `node --test archify/modules/code-analysis/test/*.test.mjs`: 88 passed, zero failed or skipped on Windows, using the bundled Python interpreter through `BAUIFY_PYTHON`.
- `node --test archify/modules/code-analysis/test/review-regressions.test.mjs` under Node 22.23.2: all 10 new regressions passed on the final source.
- `npm test` from `archify/` under Node 22.23.2: 1,691 tests, 1,616 passed, 8 failed, 67 skipped. All eight failures are in `repository-evidence-replacement.test.mjs`, at fixture `git init --template=`, with `fatal: unable to access '\\.\nul': Invalid argument`. They do not reach the code under review. The full suite is not claimed green. Its Code Analysis integration check passed; the final narrow Python changes were subsequently verified by the module and Node 22 regression runs above.
- Standalone checkout-availability check: setting `BAUIFY_ARCHIFY_ROOT` to an absent temporary path and running `interactive.test.mjs` produced one passing argument test and two intentional checkout-dependent skips.
- Final `scripts/build-zip.sh` under Node 22.23.2: 149 files. A second build compared byte-for-byte equal with `archify.zip`.
- `node scripts/package-smoke.mjs <temporary-extraction>/archify`: passed on Windows for the final ZIP, extracted outside the repository.
- `git diff --check` and `git diff --cached --check`: passed. No new visual layout is introduced by this follow-up; no fresh perceptual review is claimed.

No GitHub review replies or thread-resolution actions were performed. No live Archify installation was changed.
