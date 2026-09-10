# Frontend UX refinement — 2026-09-10

## Scope

Builds on the merged security hardening (`a89dd8b549dd7a33b78466da1aae09eb0640a0a0`). This is a frontend-only refinement, not a backend rewrite or a claim that the entire audit is finished. Existing sandboxed mail rendering and private attachment routes are unchanged. No production bindings, credentials, schema or mail delivery rules are changed.

## User-facing changes

- Code cards put sender and recipient before the code, with separate native Copy and View email buttons. Long codes wrap without truncating the value copied. Local copy feedback replaces the repeated success toast. Help is collapsible; the labels describe the existing 15-minute *display window*, never assert the sending service's true OTP validity.
- Waiting for a code is opt-in and restricted to the user's own recent/all view. A single abortable loop checks the last submitted query every 10 seconds, pauses when hidden, backs off to 60 seconds on errors and is disposed on exit. New arrivals are announced, not inserted under the pointer; the user applies them explicitly. The server's existing display-window hiding remains in force.
- Mobile search uses a full row, theme/notice actions move into an accessible More menu, Compose uses a labeled icon and is visually secondary on the code page. Main header buttons use 44px touch boxes. Existing desktop navigation and palette are retained; CJK font fallbacks and reduced-motion support are improved.
- Resizing within one breakpoint no longer resets a manually collapsed navigation panel. The account panel is shown only on mailbox/read views, not unrelated pages.
- Closing a message offers Keep editing, Save draft & close and Discard changes. Escape keeps editing; initial focus is the non-destructive action. Saves are awaited; storage errors leave content intact with a retry. Existing drafts save through the repository directly rather than depending on the drafts page being mounted. Attachment-only drafts are preserved too. Saves and file selections are guarded against stale sessions/writer instances.
- The writer remains visible and inert while sending; it is not presented as delivered merely because upload progressed. Old-session callbacks cannot reopen/reset a newer writer. Transport idempotency and provider status semantics are not changed.
- Editor loading failure has an explicit retry that preserves staged content. Header loading failures produce user-visible feedback.

## Review and validation

- Full release gate: `node scripts/verify.mjs` (configuration tests, local Worker tests, frontend tests and production build). Existing test coverage is retained; additional tests cover polling lifecycle/backoff, safe close actions, session races, attachment-only drafts, localization parity and card semantics.
- Local Chromium: real Vue layout/header/code page/writer components mounted in memory. HTTP and database connection are doubles; the rich-text runtime is a double. 20 combinations of 320/390/768/1024/1440px, Chinese/English and light/dark were checked for page/card horizontal overflow. Functional checks cover copying, long content, new-code announcements, window hiding, mobile actions, resize preferences, default focus, Escape, storage failure/retry and explicit discard.
- A separate browser check mounts the actual TinyEditor wrapper and injects a loader failure followed by success to verify retry and staged-content preservation.
- Browser navigation is restricted in the execution environment. These checks are **not** whole-site production E2E, Safari/Firefox coverage, or real mail delivery validation. No real message was sent. Preview screenshots use fictional sample data.

## Deferred

Desktop split reading, inbox full-text search, redesigned administration/settings, bottom navigation, automatic draft saving and backend session/send-intent changes are not included. Polling is not coordinated across tabs. External object storage/public cache and external preview compatibility limitations from the earlier security review remain unchanged.
