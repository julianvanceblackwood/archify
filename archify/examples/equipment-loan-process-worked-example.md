# Equipment-loan as-is / to-be worked example

This example is fully fictional. Its source is [equipment-loan-process-notes.md](equipment-loan-process-notes.md).

## Source classification

| Source statement | Class | As-is | To-be |
| --- | --- | --- | --- |
| Employee submits an equipment-loan request | documented fact | `submit_request` | preserved |
| Service Desk reviews required request details | documented fact | `review_request` | preserved |
| Service Desk checks the equipment register | documented fact | `check_availability` in Service Desk | execution moves to Automation |
| Manager approves or rejects an available request | documented fact | `manager_approval` | preserved as human decision |
| Service Desk hands over approved equipment | documented fact | `handover` | preserved |
| Employee returns the equipment | documented fact | `return_equipment` | preserved |
| Service Desk records the return | documented fact | `record_return` | preserved |
| Automate only the availability lookup | proposed improvement | absent | `check_availability` moves to Automation |
| Maximum duration, overdue handling, damage handling, approver variation | open questions | unanswered | unanswered |

No additional assumption is required for the worked pair.

## Comparison contract

The two Workflow documents intentionally reuse the same ids and reader-facing labels for every process step. Their relationship topology is also identical. The proposed state changes only the execution owner and presentation of `check_availability`; manager approval remains human.

The proposal does not add an API, automatic reservation, automatic approval, vendor product, notification platform, or external integration.

## Artifacts

- [As-is Workflow JSON](equipment-loan-as-is.workflow.json)
- [To-be Workflow JSON](equipment-loan-to-be.workflow.json)

Both inputs are Workflow schema v2, use automatic routing, and are expected to render independently. The regression suite checks schema/render success, stable comparison identity, proposal isolation, preserved human approval, and open-question parity.

## Layout findings

The first showcase validation surfaced two concrete business-process layout costs rather than a semantic failure:

- several reader-facing business labels and the availability explanation were wider than the default Workflow node width, so the example reserves measured node width instead of shortening established meaning;
- the two terminal Service Desk outcomes initially shared routing corridors and made the page too tall for the desktop Reader budget, so they are placed as a same-column vertical stack in one exception lane. Workflow v2 measures that lane and exposes the existing intrinsic-height Reader fit without authored `viewBox` coordinates.

No `via`, `channelX`, `channelY`, `labelAt`, or other absolute route pin is required. These repairs keep the process topology unchanged and document the normal renderer behavior that #512 asked the example to exercise.
