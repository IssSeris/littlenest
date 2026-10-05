---
name: OpenAPI export collisions
description: Orval's validator and type generators can collide in the shared API barrel
---

Avoid inline operation-body names and operations with both path and query parameters when their generated names collide between the Zod validators and generated type exports.

**Why:** This workspace's Orval configuration has emitted identical body or `*Params` export names into both generated modules, causing TS2308 in their shared barrel. Type checking the spec's generated libraries is necessary even when generation itself reports success.

**How to apply:** Prefer named request-body component schemas. For file downloads, distinct read/download route paths avoid the path/query parameter name collision. Fix the source contract and regenerate; do not hand-edit generated files.