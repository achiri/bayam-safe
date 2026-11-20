# Definition of Done (BayamSafe)

An item is done when every box applies:

- [ ] Meets the item's acceptance criteria in `sprints/backlog.md`.
- [ ] `cd backend && npm run typecheck` is clean (strict TypeScript, no `any` escapes added).
- [ ] Unit or integration tests cover the new logic, including the failure paths. Tests run on both the memory store and the Postgres (PGlite) store, via `test/order-flows.ts`.
- [ ] Money: every ledger journal sums to 0 and is idempotent (stable `key`). No path leaves funds in ESCROW for a terminal order.
- [ ] Security: OWASP Top 10 practices.
  - Input validated with the existing helpers (`text`, `optText`, phone normalizers).
  - Buyer endpoints check the link token. Escrow-sensitive actions check the paying-device session.
  - Admin endpoints sit behind admin auth and write to the audit log.
  - No secrets in code.
- [ ] UI: WCAG 2.2 AA (labels, focus states, contrast, 44 px touch targets). French first, English supported.
- [ ] Docs updated: README, `docs/USER-GUIDE.md`, `docs/POLICIES.md`, CHANGELOG.
- [ ] Conventional Commit, pushed to `staging`, CI green (typecheck → tests → build).
- [ ] Review packet given to the customer. They sign off before the item moves to Done.
