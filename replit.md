### Journal attachment privacy

Journal files belong in private App Storage, never public assets or signed read URLs. Serving a file must recheck the journal's current visibility on every request and use `Cache-Control: no-store`; making an entry private immediately denies subsequent household-member file requests. Parent role does not override another author's privacy or editing rights.

Uploads are staged for their owner until the journal save transaction binds them to that entry. Draft cleanup must never delete an already-saved attachment. Failed uploads/saves retain the text, mood, and attachment draft; failed uploads must be retried or dismissed before saving. Entries may contain only attachments. Limits are ten files per entry and 10 MB per file; unused staged uploads expire after 24 hours and are cleaned up on the owner's next upload.
# Little Nest

A gentle household organizer covering shared routines, allowance, calendar events, household money, flexible school/work tasks and goals, and optional shared journaling.

The product should grow with its users. Do not hardcode a school stage, career, or age into tracking spaces; keep their names customizable. Parent/member account permissions remain independent of school or work choices.

Child accounts must be able to choose and save their own avatar, but not edit other profiles, profile names, invitations, or household finances.

Monthly budgets and money notes remain parent-only and manually entered. A savings target is a planned set-aside, not a claim that funds were transferred or actually saved.

Chores can be assigned to an individual member or Household. Users chose a preset amount for paid chores: completion creates an earned allowance note, not an actual payment. A Household chore earns one shared amount. Credit each chore once per due date; reopening never deletes or duplicates an earned note, and a new due date identifies a new occurrence.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — API server command; managed workflow injects its port (currently 8080).
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages; run with managed artifact build environment variables.
- `PORT=24429 BASE_PATH=/ pnpm --filter @workspace/little-nest build` — standalone frontend build check for the current artifact routing.
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- `pnpm --filter @workspace/api-server test` — focused authorization and persistence regression tests; creates and removes only its own development fixtures.
- Required env: `DATABASE_URL`, managed `CLERK_SECRET_KEY`, `CLERK_PUBLISHABLE_KEY`, `VITE_CLERK_PUBLISHABLE_KEY`. Do not expose values. Production Clerk proxy env is platform-managed.

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

- `artifacts/little-nest/` — authenticated Little Nest frontend.
- `artifacts/api-server/` — Clerk middleware/proxy and household API.
- `lib/` — shared workspace packages and API specification.

## Architecture decisions

- Each household member uses a separate managed Clerk sign-in. Household profiles use Parent, Child, or Household member roles; invitations are bound to one profile. Public `/`, branded `/sign-in` and `/sign-up`, and protected organizer `/app` with relative feature routes.
- PostgreSQL is the source of truth. `/api/nest/snapshot` is authenticated, uncached, and contains only authorized records. Browser calls use cookies, never explicit bearer tokens.
- Initial setup creates a household with its parent and an unlinked child profile. A parent can add any number of profiles and issue a 24-hour, random, hashed, single-use invitation for each unlinked profile. Invitations bind to one profile; replacing one code does not affect others, and callers cannot select roles.
- Parents can change profile roles or remove profiles. Role changes revoke unused invitations; the last active Parent cannot be demoted or removed. Removal disconnects the sign-in identity and revokes unused invitations without deleting the identity-provider account. The profile is archived so authorship and assigned-record references remain intact. Private journals, moods, and saved attachments stay hidden from the remaining household; deliberately shared journals remain shared. Synced grocery/chore drafts, staged journal uploads, and notifications involving the removed profile are deleted. Existing assignments remain as history, while new assignments cannot target archived profiles.
- Chores/routines, calendar, school tasks/goals, and allowance are shared. Finances and household settings are parent-only, enforced by the server.
- Groceries and grocery favorites are shared household records. Favorites are independent reusable templates, retained when shopping items are bought or removed.
- Journal entries are private by default. Only their author can edit/delete/share/unshare; parent status never grants access to a child's private journal. Shared copies already seen or saved cannot be recalled.
- Journal moods are optional and follow the entry's privacy. Older entries without a mood remain valid; choosing "No mood selected" clears the saved mood.
- Mood history is personal, never a household or parent view of another author's moods, even for shared entries. Include only deliberate selections; do not infer moods, assign happiness scores, or make diagnostic/clinical conclusions.
- Both accounts can reply to shared journals; only a reply's author may edit/delete it. Making the entry private hides and pauses the thread for both accounts until reshared. Entry deletion atomically removes its replies.
- Today shows the latest 50 updates from the other linked member, recorded transactionally from this feature onward. Read status is account-specific and persistent; visiting Today does not automatically mark updates read.
- Notifications never contain journal text/mood previews or child-visible financial updates. Every feed query rechecks current journal sharing; making a journal private also hides its earlier entry/reply notifications.
- Account changes remount the organizer and clear query caches. Snapshot polling runs every three seconds while visible, plus on focus and manual refresh.
- The old `little-nest-v1` browser data is untouched: no deletion, automatic import, or transfer of the other person's journals. Secure households start empty. Plain-text grocery/chore lists can be pasted and reviewed; older browser-local household data cannot be imported.
- Money entries are manually entered; there is no bank connection.
- Development schema changes only; publishing applies production schema changes. Do not publish or mutate production data without a separate request.

## Product

Little Nest helps a household see the next manageable action for home and school. Parents manage household profiles and finances; each profile has its own private journal and mood history, with optional sharing. The first version supports chore check-offs, allowance tracking, shared calendar entries, manually entered household money, separate school tasks and goals, and prompted journal entries with opt-in sharing.

## User preferences

- The app should feel cute, AUDHD friendly, simple, and extremely easy to use.
- The app should be something the family wants to use, not another demanding planner.
- Journaling should help household members deepen communication while allowing each author to choose which answers to share. Parent authority never grants access to another person's private data.

## Gotchas

- Preserve the central React 19.1.0 catalog pin for Expo. Little Nest uses app-local React/React DOM 19.1.4 for Clerk peer compatibility.
- Auth configuration belongs in the Replit Auth pane. Keep canonical Clerk key/host/proxy wiring and exact `/sign-in/*?`, `/sign-up/*?` routes.
- Requests validate both API envelopes and strict per-collection domain fields. Server-generated identity, authorship, role, IDs, and timestamps must not become client-controlled.
- Generated record schemas are generic envelopes; do not send their stripped NestItem parse result as the snapshot. Strict domain validation occurs before database writes.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
