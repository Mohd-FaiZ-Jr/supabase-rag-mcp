# Sample Banking BRD: Payment Status

> Test document for RAG evaluation. This is not a real bank specification.

## Requirement ID

PAY-STATUS-001

## Requirement

The payment status lifecycle must progress from INITIATED to PROCESSING and then to SUCCESS or FAILED.

## Business Rules

The service may mark a payment SUCCESS only after the payment rail confirms completion. A failed payment must include a failure reason and must not be reported as successful.

## Acceptance Criteria

Clients can retrieve the current status and the timestamp of the latest transition.