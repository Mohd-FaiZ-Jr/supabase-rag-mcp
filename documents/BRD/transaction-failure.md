# Sample Banking BRD: Transaction Failure Handling

> Test document for RAG evaluation. This is not a real bank specification.

## Requirement ID

TRX-FAIL-001

## Requirement

When a transfer fails, the system must persist the failure reason, retain the original request identifier, and expose a retry-safe status to the client.

## Business Rules

Transient provider errors may be retried with the same idempotency key. Permanent validation errors must not be retried automatically.