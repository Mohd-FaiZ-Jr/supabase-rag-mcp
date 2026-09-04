# Sample Banking BRD: Money Transfer Processing

> Test document for RAG evaluation. This is not a real bank specification.

## Requirement ID

TRX-TRANSFER-001

## Requirement

The transfer service must validate the source account, beneficiary, amount, and available balance before submitting a money transfer.

## Processing Rules

Transfers that pass validation are submitted to the payment rail with a unique request key. A transfer must not be submitted twice when the client retries the same request.

## Expected Output

The client receives the transfer status and a stable request identifier.