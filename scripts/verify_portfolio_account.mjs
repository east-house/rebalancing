import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { advanceAccount, createAccount } from "../src/features/portfolio-report/portfolioReportModel.ts";

const base = process.argv[2] ?? "http://127.0.0.1:5173";
const directory = "action-output/integer-account";
const response = await fetch(`${base}/api/portfolio-reports`, { headers: { "cache-control": "no-cache" } });
assert(response.ok);
const release = response.headers.get("x-report-release");
assert(release);
const index = await response.json();
const dates = index.reports.map(item => item.reportDate).sort();
const reports = [];
for (let i = 0; i < dates.length; i += 4) {
  reports.push(...await Promise.all(dates.slice(i, i + 4).map(async day => {
    const result = await fetch(`${base}/api/portfolio-reports/${day}?release=${release}`);
    assert(result.ok); assert.equal(result.headers.get("x-report-release"), release);
    const report = await result.json();
    assert.equal(report.default_fractional_shares, false);
    assert(report.selection_correlations);
    return report;
  })));
}
const results = [];
for (const start of dates) {
  for (const capital of [100, 2819, 10000, 50000]) {
    const account = advanceAccount(createAccount(start, capital), reports);
    assert.equal(account.days[0].reportDate, start);
    assert.equal(account.days.at(-1).reportDate, dates.at(-1));
    assert(account.trades.every(item => Number.isInteger(item.shares) && item.shares > 0 && item.signalDate < item.executionDate));
    assert.equal(new Set(account.trades.map(item => item.id)).size, account.trades.length);
    for (const day of account.days) {
      assert(day.cash >= 0);
      assert(day.holdings.every(item => Number.isInteger(item.shares) && item.shares > 0));
      assert(Math.abs(day.totalPnl - day.realizedPnl - day.unrealizedPnl) < 1e-7);
      assert(Math.abs(day.equity - day.cash - day.holdings.reduce((sum, item) => sum + item.value, 0)) < 1e-7);
    }
    assert.deepEqual(advanceAccount(account, reports), account);
    const incremental = reports.reduce((value, report) => advanceAccount(value, [report]), createAccount(start, capital));
    assert.deepEqual(incremental.days, account.days);
    assert.deepEqual(incremental.trades, account.trades);
    results.push({ start, capital, days: account.days.length, trades: account.trades.length,
      equity: account.days.at(-1).equity, pnl: account.days.at(-1).totalPnl, cash: account.cash });
    if (start === dates[0] && capital === 2819) {
      await mkdir(directory, { recursive: true });
      await writeFile(`${directory}/example-account.json`, JSON.stringify(account, null, 2));
    }
  }
}
await mkdir(directory, { recursive: true });
await writeFile(`${directory}/reports.json`, JSON.stringify(reports));
await writeFile(`${directory}/verification.json`, JSON.stringify({ passed: true, release, scenarios: results.length, results }, null, 2));
console.log(JSON.stringify({ passed: true, release, reportCount: reports.length, scenarios: results.length, examples: results.slice(0, 4) }));
