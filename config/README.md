# Closing-price collection universe

`active-close-prices.json` is the production policy that selects instruments
from `public/data/instruments.json`. The search catalog remains unchanged and
continues to contain the larger KR/US stock and ETF list used by the UI.

The current production universe contains 4,068 instruments:

- Every Korean stock in the committed catalog: 2,822
- Every Korean ETF in the committed catalog: 1,146
- An explicit snapshot of 50 high-market-cap US stocks
- An explicit list of 50 US ETFs, including `SOXL`, `TQQQ`, and `QLD`

Korean groups use `selection: "all"`, so regenerating the catalog
automatically adds newly listed Korean instruments and removes instruments no
longer present. `minimumCount` prevents a damaged or incomplete catalog from
silently shrinking production coverage.

US groups use `selection: "explicit"`. Update their `tickers` arrays when the
market-cap snapshot or ETF selection should change. Every explicit ticker must
exist in the matching catalog group.

Production divides the resolved universe into eight deterministic shards.
Each instrument belongs to exactly one shard, no shard exceeds the collector's
750-instrument safety limit, and at most two shards run concurrently.

Validate all selection, sharding, history, R2, time-budget, and circuit-breaker
logic after changing this file:

```bash
python -m unittest scripts/test_collect_close_prices.py
```
