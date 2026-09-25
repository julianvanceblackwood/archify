# Fictional equipment-loan process notes

These notes are synthetic and exist only as an Archify worked example.

## Documented current process

1. An employee submits an equipment-loan request to the Service Desk.
2. The Service Desk checks that the request contains the employee name, requested equipment, and requested return date.
3. The Service Desk checks the equipment register to see whether the requested item is available.
4. If the item is unavailable, the Service Desk tells the employee that the request cannot be fulfilled and the process stops.
5. If the item is available, a manager decides whether to approve the loan.
6. If the manager rejects the request, the Service Desk tells the employee that the request was rejected and the process stops.
7. If the manager approves the request, the Service Desk hands the equipment to the employee.
8. The employee later returns the equipment to the Service Desk.
9. The Service Desk records the return in the equipment register.

## Proposed improvement

Automate only the availability lookup. A system may read the equipment register and present the availability result to the Service Desk. Manager approval remains a human decision. The proposal does not add automatic reservation, automatic approval, or a new external integration.

## Open questions

- The notes do not define the maximum loan duration.
- The notes do not define an overdue-return process.
- The notes do not define a damaged-equipment process.
- The notes do not state whether different equipment categories require different approvers.

## Explicit non-facts

The worked example must not invent an API, vendor product, database engine, notification service, automatic reservation step, automatic manager approval, or SLA.
