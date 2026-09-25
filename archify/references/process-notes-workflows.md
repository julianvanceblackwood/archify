# Process-note workflows

Use this reference when the source is meeting notes, interview notes, a plain-language process description, or another non-executable account of how work is performed and the user wants current-state and proposed-state workflow diagrams.

## Truth classes

Separate every extracted statement into one of four classes before authoring:

- **Documented fact**: directly stated by the source. It may become an as-is node, relationship, lane, decision, waiting state, exception, or card item.
- **Assumption**: needed to interpret an ambiguous statement but not established by the source. Do not silently render it as topology. Keep it out of the diagram unless the user explicitly accepts it.
- **Proposed improvement**: a future-state change requested by the source or user. It belongs only in the to-be artifact; never render a proposal as current-state fact.
- **Open question**: a material uncertainty that could change ownership, ordering, a decision, or an exception. Keep it visible in the worked result instead of inventing an answer.

Do not invent integrations, APIs, databases, automation, approval rules, service-level targets, or exception handling that the notes do not establish.

## As-is and to-be pair

Author two independent Workflow v2 documents.

1. **As-is** contains only documented current behavior.
2. **To-be** starts from the same documented facts and applies only explicit proposed improvements.

For unchanged responsibilities, reuse the same node ids and reader-facing labels across both documents. A node may move to another lane or change technical type only when the proposed change actually changes ownership or execution. Preserve human approval when the proposal automates an adjacent lookup rather than the decision itself.

Use consistent lane labels where ownership is unchanged. Keep branch labels explicit so approval, rejection, unavailable, retry, and return paths are visible as relationships instead of being implied by cards.

## Comparison discipline

Before delivery, compare the two JSON documents as a pair:

- every as-is fact is either preserved or intentionally changed by an explicit proposal;
- every to-be-only behavior maps to an explicit proposal;
- unchanged nodes retain stable ids and labels;
- human decisions remain human unless automation was explicitly proposed;
- unanswered questions remain unanswered;
- no proposal is back-projected into the as-is diagram.

Cards may summarize source facts, proposed changes, and open questions, but they never replace required topology.

## Worked-example evidence

A worked example should ship with:

- the synthetic source notes;
- separate as-is and to-be Workflow JSON;
- a compact fact/proposal/open-question mapping;
- reproducible rendering for both artifacts;
- a regression that checks the pair for semantic fidelity before visual delivery.

Use fictional organizations and people. Do not publish private meeting transcripts or customer process details as examples.

## Layout and readability

Business-process labels are often longer than technical labels. Start with readable Workflow v2 placement and automatic routing. Use phases for broad process stages, lanes for responsibility, and exception lanes for denial or unavailable paths. Prefer concise labels plus short sublabels over shrinking text or manually pinning routes.

If multiple steps share one stage, let the compiler measure the layout before adding explicit geometry. Record any manual repair that was required; a renderer limitation discovered by the example is evidence for a separate follow-up, not a reason to weaken factual fidelity.
