# Integer I1 account tracker

The portfolio report now starts a virtual account from a selected Korean report
date and initial USD capital. It processes every report through the latest
available date and appends newly published reports on refresh or return visits.

Orders use the report's existing proposed US execution date. They remain pending
until that exact session's close appears in a later report. Report dates, US
session dates, holiday handling and publication schedules retain their existing
definitions. A missing report or execution price blocks the update atomically.

All shares are whole numbers. Allocations that cannot buy one share remain cash.
Monthly selection retains eligible top-ten target names and applies the original
sector and absolute-correlation limits. Point-in-time correlations are exported
by the report generator. Sales precede buys; average cost includes buy costs and
realized profit deducts sale costs. The I1 cost is 0.10% per side. Prices are the
report's historical adjusted closes, not actual broker executions.

The screen shows total equity, cash, total profit and return, realized/unrealized
profit, an equity chart, historical holdings, first/latest buy dates, average
cost, security returns, every fill and its reason, and daily account snapshots.
Past views use saved snapshots instead of applying old prices to today's holdings.

Accounts use browser key `stock_strategy.us_portfolio.integer.v3`. Old records
are preserved separately and are not rounded or assigned fictional buy dates.
Filled trades are not overwritten by historical report revisions. Initial capital
is fixed for an account; changing it starts a new account after preserving the old
one. There is no broker connection or external notification delivery.

Validation:

- 116 Python tests, 133 frontend/Worker tests and production build passed.
- UTC, Asia/Seoul and America/New_York CI passed for `5b382ac`.
- Published reports: all 20 weekdays from 2026-08-17 to 2026-09-11.
- Rebuild: https://github.com/east-house/rebalancing/actions/runs/34756855923
- Release: `7a51a5c1869f1f6b0eb401a1cbbe7c0b2c659a706e26f2400e95d3bba2f604d5`.
- 80 real-data scenarios (20 starts, four capital amounts) passed whole-share,
  nonnegative-cash, accounting-identity, duplicate-fill and incremental-catchup checks.
- Local evidence: `action-output/integer-account/verification.json` and
  `action-output/integer-account/example-account.json`.

Recheck against the running local preview:

```sh
node --experimental-strip-types scripts/verify_portfolio_account.mjs
```
