# Independent Strategy Accounts

## Scope

- Strategy tabs display one independent account at a time: assets, completed actions, next-session plans, holdings and transaction history.
- Holdings include USD market value, account weight including cash, shares, entry date, entry price, current adjusted close and unrealized P&L.
- Account keys drive the UI. Optional report `strategyDefinitions` provides labels and descriptions; legacy definitions remain available for preserved reports. New strategy identifiers do not require a separate page implementation.
- This is a strategy-independent presentation contract, not a production strategy editor. Existing G55/R2 trading rules, strategy version, capital, execution, schedules and date handling are unchanged. I1 is not activated; its rules have not been identified.
- Implementing a new trading algorithm still requires its explicit rules and engine validation. Do not rename historical accounts to imply that a different strategy generated them.

## Transaction History

- Newly generated reports copy each account's cumulative `transactions` from the existing ledger, without executing or replaying trades.
- Old immutable reports remain unchanged and explicitly show their available daily transactions rather than claiming cumulative completeness.
- The next newly generated report includes existing ledger history, not only transactions after deployment. A same-session retry may return the existing report and therefore does not add this field.
- HOLD events remain in the payload but are not counted as completed trades in the history table.

## Verification

- Frontend/Worker: 123 passing tests, including strategy isolation, replacement metadata, missing plans and zero-equity handling.
- Python: 87 passing tests, including independent ledger export and unchanged report/market dates.
- Production build passes.
- Browser checks: 1440/390/320px under UTC, Asia/Seoul and America/New_York; same dates, no page overflow or heading overlap, legacy compatibility.
- No historical reports, ledger state, workflow schedules or date computation files modified.
