---
name: Private synced drafts
description: Privacy and recovery constraints for cross-device pasted lists
---

Keep synced paste drafts opt-in and account-private within the authenticated household. Do not automatically import older browser-local household records.

**Why:** The user explicitly requested a private server-backed option without importing older browser-local household records. Local data is not proof of current account ownership or consent to upload.

**How to apply:** Keep browser recovery separate from cross-device recovery. New syncing or migration features must not silently upload legacy browser data or expose another household member's draft.

Do not treat browser locks or versioned draft checkpoints alone as cross-device protection for record creation. The record write and removal of its draft row must commit together under the same revision check.

**Why:** Two devices can both see uncertainty while a save is in flight. A separate record write followed by a draft checkpoint leaves a gap where a stale client can submit again, or a confirmed row can reappear after the response is lost.

**How to apply:** Preserve atomic server save/draft updates when extending synced paste saving. Keep uncertain recovery behind a fresh saved-list review, and never deduplicate repeated titles.

Discard must synchronously block edits and invalidate queued operations from the discarded session, before returning the UI to browser mode.

**Why:** While a discard response is delayed, an edit queued behind it can reuse the new empty-slot revision and silently recreate private content that the user just deleted. Server revision checks alone cannot distinguish that edit from a new draft.

**How to apply:** Fence destructive transitions at invocation, not only when their queued request starts. Test edits during a delayed discard and callbacks retained from the closed panel; both must leave the server slot empty.