# Security and privacy hardening — review notes

This change set is for the isolated `codex/security-reliability-20260910` branch. It does not deploy, migrate data, send mail, rotate secrets, or change D1/KV/R2 bindings.

## Implemented

- Email HTML renders inside a scriptless sandbox iframe. Parent code alone measures height and opens validated links. Forms, scripts, nested frames and top navigation remain disabled.
- HTML and CSS use allowlists, with CSSOM validation and fail-closed handling of escapes/comments/resource functions.
- Remote images default to hidden, with per-message consent. They are not proxied through an authenticated request.
- Private inline raster images use owner-checked API calls bound to an exact message, then short-lived in-memory Blob URLs. Requests cancel and object URLs are revoked on message changes/unmount.
- Anonymous `/attachments/` URLs return 404. Public `/static/` assets are unchanged. Regular attachment downloads also check the parent mail owner/deletion state.
- The admin inline endpoint requires `all-email:query`, preserving existing admin access to logically deleted mail. Missing user identity never grants admin access.
- Persisted reading state contains navigation metadata only. Legacy cache is sanitized on hydration; content, subject, recipients, verification codes, previews and future fields are not retained.
- `--deploy` no longer bypasses backend/frontend tests. Tests, configuration checks and release build gate deployment together.

## Compatibility and rollout

No database migration is needed. Existing stored mail is not rewritten. Legacy inline key forms, including `{{domain}}attachments/...` and old object-domain URLs, are mapped to authenticated access.

**Important:** a separately public R2/S3 bucket, custom object domain, or previously cached public objects can bypass Worker authorization. Before production rollout, disable direct public access for private mail objects and invalidate old public caches as appropriate. Keep intentional public site assets separate. This repository change cannot verify or alter external storage settings.

The reader displays raster images only. SVG and advanced email CSS are intentionally not rendered. Inline display is bounded to 64 unique images, 16 MiB per image and 32 MiB total; these are browser display budgets, not new inbound-mail rejection rules. Failure is visible instead of silently treated as successful rendering.

## Verification

New regressions cover CSS escapes, blocked remote resources, safe links, legacy key normalization, cache privacy, exact-mail ownership, missing identities, parent/attachment states, admin scope and private cache headers. Backend authorization tests use local D1 via the existing Cloudflare Vitest pool. The existing full release gate must remain green.

## Not included in this change set

Authoritative session storage/revocation, user-intent send idempotency, unified recipient eligibility, durable search-index work, recovery throughput, full-body search, truthful verification-code timing and resource-addressable message routes still require separate implementation and validation. No claim is made that this change set completes the entire audit or a production penetration test.
