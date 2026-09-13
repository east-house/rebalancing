# Development handoff

Reviewed 2026-09-13 after pulling main through `df35df9`.

Update: both historical data issues were repaired and verified in production
on 2026-09-13. See `HISTORY_REPAIR_2026-09-13.md` for the current result,
workflow evidence and reproducible public verification command.

## Implemented

- Portfolio management, allocation/rebalancing, device-local saved portfolios,
  asset history, ETF comparison and ETF research interfaces.
- Market and model portfolio reports with dated history, publication status,
  refresh on focus and periodic refresh, and consistent release reads.
- Atomic report publication, bounded quote retries, price diagnostics and
  separate daily reconciliation and historical recovery.
- Separate G55/R2 account views, transaction history and independent
  start-date replays. The checked replay release ends on US session 2026-09-11.
- Complete device record selection, JSON backup export and responsive report
  tables. Historical model reports are read-only.

## Verification in this review

- `npm test`: 129 passed, including frontend interactions and Worker tests.
- `npm run build`: TypeScript and production build passed.
- `npm run report:test`: 95 passed, none skipped. Existing calendar/integrity
  regression tests are included. This run used Windows; the Linux CI timezone
  matrix was not rerun here.
- `uv run --with-requirements requirements-market-report.txt python -X utf8 scripts/verify_trading_replays.py`:
  9 starts, 45 dated reports and 90 account reports passed balance/session-order
  validation. The optional input-based future-price test was not run.
- Read-only production status checks: market and portfolio reports show
  2026-09-11 published with the same release; trading shows 2026-09-12 published.
  These are observations, not guarantees about future publication timing.
- Live browser visual testing and deployment were not performed in this review.

## Changes made in this review

- Explicit UTF-8 reads in price retry tests.
- Installer tests use Git Bash on Windows, LF shell fixtures and explicit
  command stubs so Windows executable lookup cannot bypass the mocks.
- Service code, strategies, dependencies, date rules and schedules were unchanged.
- Four pre-existing local report files were copied and hash-verified in
  `action-output/local-report-backup-before-cleanup/` (ignored by Git). The
  tracked report index was restored and the three untracked copies removed
  from `public/data/market-reports/`.

## Historical issues resolved on 2026-09-13

- Both missing report dates are published with 12 sourced news items each and
  valid market/portfolio reports and PNGs. The latest report date is preserved.
- The revised regular ledger and start-date replay agree across all nine
  compared US sessions. Original records were archived, and future replays
  use the regular reports' preserved session inputs instead of a separate feed.

## Other product limitations
- Personal account records remain browser-local; cloud synchronization and
  backup import are not implemented. Replay constituent changes require review.
- Python emitted 15 existing deprecation/future warnings from matplotlib's
  parser integration and pandas concatenation. No dependency update or warning
  suppression was applied.

New date/time behavior requires an explicit textual request under `AGENTS.md`.
Choose the next feature against this baseline. Do not reopen the resolved data
issues based on the older audit documents without new evidence of a regression.
