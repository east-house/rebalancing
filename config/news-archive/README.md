# Preserved report news

These two JSON files are byte-for-byte copies of this workspace's existing
`data/raw/us_market/news/` RSS caches for 2026-08-17 and 2026-09-01. They retain
the collected article titles, publisher names, original links and publication
timestamps. No publication timestamp or article text was invented or edited.

They supply news already preserved inside the unchanged report windows for the
failed 2026-08-18 and 2026-09-03 reconstructions. The collector uses archives
only when the requested report has no usable cached/news-feed results. It
applies the existing lower/upper bounds, deduplicates, ranks and limits articles
normally, and records the archive path and SHA-256 in the collection audit.

These are source caches, not proof that either missing report was originally
published. Recovered reports retain the existing `reconstructed` label and
actual regeneration timestamp.
