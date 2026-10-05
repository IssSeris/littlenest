---
name: Repeated list items
description: Why grocery/chore paste recovery cannot deduplicate or infer saved drafts from title matching
---

Preserve repeated grocery and chore lines in their original order. Do not infer that a pending draft has saved merely because a record has the same title, even if other visible fields match.

**Why:** The requested paste flow explicitly preserves repeated lines and excludes automatic duplicate-title removal. Multiple identical items can be intentional; title matching cannot distinguish an earlier item, another household member's addition, or a write whose response was lost.

**How to apply:** For an uncertain creation without a server-supported correlation key, refresh the saved list and require an explicit user decision before retrying or discarding the uncertain draft. Never silently resubmit the original list or match drafts to saved records by title.

Treat a paste request interrupted by navigation or reload as uncertain, and require a new saved-list review when resuming even if the user checked the list earlier.

**Why:** The draft-recovery requirement explicitly forbids resuming uncertainty as a blind retry. A previously viewed list is not proof of the result of a later or still-pending write.

**How to apply:** Checkpoint uncertainty before sending, retain only remaining rows after confirmed responses, and do not persist a prior saved-list review as permission to retry after resuming.