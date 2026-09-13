# Preserved portfolio universe snapshots

These files are byte-for-byte copies of the existing local market-report cache,
retained for the explicitly requested I1 reconstruction beginning 2026-08-17.
The original filenames and snapshot dates are preserved. The rebuild selects
the most recent archived snapshot dated strictly before each Korean report date;
it never downloads today's membership and labels it as historical membership.

The first report uses `sp500_20260816.parquet` and the completed 2026-08-14 US
session. Later reports use only snapshots eligible on their respective dates.
Payloads record the source SHA-256, information cutoff, actual generation time,
and reconstruction status. Historical adjusted prices reconstructed now are not
represented as prices actually observed or reports published at that time.
