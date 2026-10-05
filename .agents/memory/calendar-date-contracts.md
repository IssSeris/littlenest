---
name: Calendar date contracts
description: Avoid converting date-only API fields into timestamps during response validation
---

Preserve calendar-only values as YYYY-MM-DD strings through OpenAPI generation and server response validation.

**Why:** The workspace's generated validators coerce OpenAPI `format: date` values into Date objects. JSON responses then contain full UTC timestamps, which break date inputs and the strict date-only write contract.

**How to apply:** Use a string pattern for date-only fields, or explicitly configure a date-only transform. Verify the serialized response and a write using that response, not just generated TypeScript types. Date-time fields have different semantics.