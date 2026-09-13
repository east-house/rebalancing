# I1 portfolio history reconstruction completed

The public portfolio archive now contains all 20 Korean weekday reports from
2026-08-17 through 2026-09-11. The previous archive contained five reports;
15 missing report dates were filled and all 20 reports now use `i1_core_satellite`.

- Initial information boundary: 2026-08-16, preserved universe snapshot with that date.
- First signal: 2026-08-14 US close; first Korean report: 2026-08-17.
- Initial selection: IVV, FTNT, PANW, DDOG, VLO, each at 20%.
- Weekend reports are excluded. Both September 7 and 8 use the September 4
  US close and September 8 proposed execution, accounting for Labor Day.
- Latest Korean report: September 11, using the September 10 US close.
- Each report uses only its eligible dated universe snapshot and prices through
  its signal session. Historical adjusted prices are reconstructed now; these
  are not claims of original publication or contemporaneous observation.
- Prior reports and release manifest remain archived. Only portfolio objects,
  their index and latest pointer were changed in the shared morning release.

The first run stopped before publication because it requested current prices
for two former constituents. The successful revision validates required dates
against each report's eligible constituents without weakening current-membership
freshness checks. Intermediate historical price gaps are checked separately.

Public verification fetched every report against the same release, validating
strategy, equal weights, signal/execution dates, initial snapshot, reconstruction
provenance, index completeness and latest consistency: 20 passed, zero missing.

- Successful rebuild: https://github.com/east-house/rebalancing/actions/runs/34755416772
- Strategy/rebuild commits: `f941067`, `511a7c0`.
- UTC, Asia/Seoul and America/New_York CI and Workers deployment succeeded.
- Release: `23d537870bbdbb163385aa4c12fed4037fa6697350bc3f1bcdb3aea311f06f5f`.
- Local verification evidence: `action-output/portfolio-history/public-verification.json`.

Recheck with:

```sh
uv run --with-requirements requirements-market-report.txt python -X utf8 scripts/verify_portfolio_history.py
```
