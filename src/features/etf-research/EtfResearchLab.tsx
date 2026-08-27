import { useEffect, useMemo, useState } from "react";
import {
  BarChart3,
  CheckCircle2,
  Database,
  Download,
  FlaskConical,
  Plus,
  RefreshCw,
  Search,
  SlidersHorizontal,
  TriangleAlert,
  Upload,
  X,
} from "lucide-react";

import { loadEtfResearch, loadEtfReturns } from "../../api/etfResearch";
import ProductTabs from "../../components/ProductTabs";
import SiteFooter from "../../components/SiteFooter";
import {
  calculateHoldingOverlap,
  calculateReturnCorrelation,
  generatePortfolioCandidates,
  PORTFOLIO_PRESETS,
  runPortfolioBacktest,
  scoreEtfQuality,
} from "../../domain";
import type {
  BacktestResult,
  EtfAnalysisBundle,
  EtfResearchManifest,
  EtfResearchProfile,
  EtfReturnsBundle,
  PortfolioCandidate,
  PortfolioGeneratorConfig,
} from "../../domain";
import "./etfResearchLab.css";

interface EtfResearchLabProps {
  onOpenReport: () => void;
  onOpenPortfolio: () => void;
  onOpenPortfolioReport: () => void;
  onOpenTradingTestReport?: () => void;
  onOpenEtfCompare: () => void;
}

type Tab = "explorer" | "generator" | "backtest";

const DEFAULT_CONFIG: PortfolioGeneratorConfig = {
  sleeves: PORTFOLIO_PRESETS.balanced.sleeves,
  investmentAmountKrw: 10_000_000,
  maxEtfs: 8,
  maxEtfWeightPercent: 50,
  maxPairOverlapPercent: 70,
  minimumTradingValue20dKrw: 100_000_000,
  maximumExpenseRatioPercent: 0.7,
  hedgePreference: "any",
  fixedStocks: [],
};

function won(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "자료 없음";
  return `${Math.round(value).toLocaleString("ko-KR")}원`;
}

function shortWon(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  if (value >= 1_000_000_000_000) return `${(value / 1_000_000_000_000).toFixed(1)}조`;
  if (value >= 100_000_000) return `${(value / 100_000_000).toFixed(0)}억`;
  return won(value);
}

function pct(value: number | null, digits = 2): string {
  return value === null || !Number.isFinite(value) ? "—" : `${value.toFixed(digits)}%`;
}

function ratio(value: number | null): string {
  return value === null || !Number.isFinite(value) ? "—" : value.toFixed(2);
}

function confidenceLabel(value: "exact" | "partial" | "unavailable" | "exposure-only") {
  if (value === "exact") return "전체 구성 기준";
  if (value === "partial") return "공개된 부분 구성 기준";
  if (value === "exposure-only") return "자산 노출 기준";
  return "계산 불가";
}

function CurveChart({ results }: { results: readonly BacktestResult[] }) {
  const width = 760;
  const height = 220;
  const allValues = results.flatMap((result) => result.curve.map((point) => point.totalValue));
  const min = Math.min(...allValues);
  const max = Math.max(...allValues);
  const span = Math.max(max - min, 1);
  const colors = ["#1d4ed8", "#60a5fa", "#94a3b8"];
  if (results.length === 0) return null;
  return (
    <div className="research-chart" role="img" aria-label="리밸런싱 주기별 백테스트 자산가치 곡선">
      <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none">
        {[0, 1, 2, 3, 4].map((line) => (
          <line key={line} x1="0" x2={width} y1={(height * line) / 4} y2={(height * line) / 4} />
        ))}
        {results.map((result, resultIndex) => {
          const points = result.curve
            .map((point, index) => {
              const x = (index / Math.max(result.curve.length - 1, 1)) * width;
              const y = height - ((point.totalValue - min) / span) * (height - 12) - 6;
              return `${x.toFixed(1)},${y.toFixed(1)}`;
            })
            .join(" ");
          return <polyline key={result.frequency} points={points} style={{ stroke: colors[resultIndex] }} />;
        })}
      </svg>
    </div>
  );
}

export default function EtfResearchLab({
  onOpenReport,
  onOpenPortfolio,
  onOpenPortfolioReport,
  onOpenTradingTestReport,
  onOpenEtfCompare,
}: EtfResearchLabProps) {
  const [tab, setTab] = useState<Tab>("explorer");
  const [manifest, setManifest] = useState<EtfResearchManifest | null>(null);
  const [analysis, setAnalysis] = useState<EtfAnalysisBundle | null>(null);
  const [returns, setReturns] = useState<EtfReturnsBundle | null>(null);
  const [loading, setLoading] = useState(true);
  const [returnsLoading, setReturnsLoading] = useState(false);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [assetFilter, setAssetFilter] = useState("ALL");
  const [selected, setSelected] = useState<string[]>([]);
  const [config, setConfig] = useState(DEFAULT_CONFIG);
  const [strategyToAdd, setStrategyToAdd] = useState("");
  const [fixedStockName, setFixedStockName] = useState("");
  const [fixedStockWeight, setFixedStockWeight] = useState(0);
  const [generation, setGeneration] = useState<ReturnType<typeof generatePortfolioCandidates> | null>(null);
  const [candidate, setCandidate] = useState<PortfolioCandidate | null>(null);
  const [backtests, setBacktests] = useState<BacktestResult[]>([]);

  useEffect(() => {
    let active = true;
    loadEtfResearch()
      .then((data) => {
        if (!active) return;
        setManifest(data.manifest);
        setAnalysis(data.analysis);
      })
      .catch((loadError: unknown) => {
        if (active) setError(loadError instanceof Error ? loadError.message : "ETF 자료를 불러오지 못했습니다.");
      })
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, []);

  const profiles = analysis?.profiles ?? [];
  const qualityScores = useMemo(() => scoreEtfQuality(profiles), [profiles]);
  const availableStrategies = useMemo(
    () =>
      [...new Map(
        profiles
          .filter((profile) => profile.usage === "GENERATOR_ELIGIBLE")
          .map((profile) => [profile.strategyKey, profile.strategyLabel]),
      )].map(([key, label]) => ({ key, label })),
    [profiles],
  );
  const filtered = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    return profiles.filter((profile) => {
      const searchMatch = !normalized || `${profile.ticker} ${profile.name} ${profile.strategyLabel}`.toLocaleLowerCase().includes(normalized);
      return searchMatch && (assetFilter === "ALL" || profile.assetClass === assetFilter);
    });
  }, [assetFilter, profiles, query]);
  const selectedProfiles = selected.flatMap((ticker) => profiles.find((profile) => profile.ticker === ticker) ?? []);
  const overlap = selectedProfiles.length === 2 ? calculateHoldingOverlap(selectedProfiles[0], selectedProfiles[1]) : null;
  const selectedReturnSeries = selected.flatMap((ticker) => returns?.series.find((series) => series.ticker === ticker) ?? []);
  const correlation = selectedReturnSeries.length === 2 ? calculateReturnCorrelation(selectedReturnSeries[0].points, selectedReturnSeries[1].points) : null;

  const ensureReturns = async () => {
    if (returns || !manifest) return returns;
    setReturnsLoading(true);
    setError("");
    try {
      const bundle = await loadEtfReturns(manifest);
      setReturns(bundle);
      return bundle;
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "가격 이력을 불러오지 못했습니다.");
      return null;
    } finally {
      setReturnsLoading(false);
    }
  };

  const selectProfile = (ticker: string) => {
    setSelected((current) =>
      current.includes(ticker)
        ? current.filter((item) => item !== ticker)
        : current.length >= 2
          ? [current[1], ticker]
          : [...current, ticker],
    );
  };

  const applyPreset = (key: keyof typeof PORTFOLIO_PRESETS) => {
    setConfig((current) => ({ ...current, sleeves: PORTFOLIO_PRESETS[key].sleeves }));
    setGeneration(null);
    setCandidate(null);
    setBacktests([]);
  };

  const generate = () => {
    const result = generatePortfolioCandidates(profiles, {
      ...config,
      sleeves: config.sleeves.filter((sleeve) => sleeve.targetWeightPercent > 0),
    });
    setGeneration(result);
    setCandidate(result.candidates[0] ?? null);
    setBacktests([]);
  };

  const runBacktests = async () => {
    if (!candidate) return;
    const bundle = await ensureReturns();
    if (!bundle) return;
    try {
      const common = { initialValue: config.investmentAmountKrw, transactionCostBps: 5, riskFreeRatePercent: 2.5 };
      setBacktests([
        runPortfolioBacktest(candidate, bundle.series, { ...common, rebalanceFrequency: "none" }),
        runPortfolioBacktest(candidate, bundle.series, { ...common, rebalanceFrequency: "quarterly" }),
        runPortfolioBacktest(candidate, bundle.series, { ...common, rebalanceFrequency: "annual" }),
      ]);
      setTab("backtest");
    } catch (backtestError) {
      setError(backtestError instanceof Error ? backtestError.message : "백테스트를 실행하지 못했습니다.");
    }
  };

  const importHoldings = (file: File | undefined) => {
    if (!file || !analysis) return;
    file.text().then((text) => {
      const rows = text.trim().split(/\r?\n/).map((row) => row.split(",").map((cell) => cell.trim()));
      const headers = rows.shift()?.map((header) => header.toLocaleLowerCase()) ?? [];
      const indexOf = (names: string[]) => names.map((name) => headers.indexOf(name)).find((index) => index >= 0) ?? -1;
      const tickerIndex = indexOf(["etf_ticker", "ticker", "etf코드"]);
      const keyIndex = indexOf(["holding_key", "종목코드", "holding_ticker"]);
      const nameIndex = indexOf(["holding_name", "종목명", "name"]);
      const weightIndex = indexOf(["weight", "weight_percent", "비중"]);
      if ([tickerIndex, nameIndex, weightIndex].some((index) => index < 0)) {
        setError("CSV 헤더에 etf_ticker, holding_name, weight가 필요합니다.");
        return;
      }
      const uploaded = new Map<string, EtfResearchProfile["holdings"]>();
      for (const row of rows) {
        const ticker = row[tickerIndex]?.padStart(6, "0");
        const weight = Number(row[weightIndex]?.replace("%", ""));
        if (!ticker || !row[nameIndex] || !Number.isFinite(weight) || weight < 0) continue;
        const items = uploaded.get(ticker) ?? [];
        items.push({ key: row[keyIndex] || row[nameIndex], name: row[nameIndex], weightPercent: weight });
        uploaded.set(ticker, items);
      }
      const adjusted: EtfAnalysisBundle = {
        ...analysis,
        profiles: analysis.profiles.map((profile) => {
          const holdings = uploaded.get(profile.ticker);
          if (!holdings) return profile;
          return { ...profile, holdings, holdingsCoveragePercent: holdings.reduce((sum, holding) => sum + holding.weightPercent, 0) };
        }),
      };
      setAnalysis(adjusted);
      setError("");
    }).catch(() => setError("CSV 파일을 읽지 못했습니다."));
  };

  if (loading) {
    return <main className="research-loading"><RefreshCw className="spin" /> ETF 연구 자료를 불러오는 중입니다.</main>;
  }

  return (
    <div className="research-shell">
      <header className="research-topbar">
        <div className="research-brand"><FlaskConical size={20} /><strong>ETF비교</strong><span>관리형 카탈로그 · 로컬 계산</span></div>
        <ProductTabs
          current="etf-compare"
          onOpenReport={onOpenReport}
          onOpenPortfolio={onOpenPortfolio}
          onOpenPortfolioReport={onOpenPortfolioReport}
          onOpenTradingTestReport={onOpenTradingTestReport}
          onOpenEtfCompare={onOpenEtfCompare}
        />
      </header>

      <main className="research-main">
        <section className="research-hero">
          <div><span className="eyebrow">FREE RESEARCH WORKSPACE</span><h1>ETF를 비교하고, 자산군부터 포트폴리오를 설계하세요.</h1><p>종목을 찍어 주는 블랙박스가 아니라 데이터 품질, 선정 근거, 중복 위험과 과거 검증을 함께 보여줍니다.</p></div>
          <dl className="research-summary">
            <div><dt>관리 ETF</dt><dd>{manifest?.etfCount ?? 0}개</dd></div>
            <div><dt>생성기 대상</dt><dd>{manifest?.generatorEligibleCount ?? 0}개</dd></div>
            <div><dt>가격 기준</dt><dd>{manifest?.priceAsOf ?? "—"}</dd></div>
            <div><dt>자료 버전</dt><dd>{manifest?.dataVersion ?? "—"}</dd></div>
          </dl>
        </section>

        {error ? <div className="research-alert"><TriangleAlert size={17} />{error}</div> : null}

        <nav className="research-tabs" aria-label="ETF 연구 기능">
          <button className={tab === "explorer" ? "active" : ""} onClick={() => setTab("explorer")}><Search size={16} /> 3. ETF 분석</button>
          <button className={tab === "generator" ? "active" : ""} onClick={() => setTab("generator")}><SlidersHorizontal size={16} /> 4. 포트폴리오 생성</button>
          <button className={tab === "backtest" ? "active" : ""} onClick={() => setTab("backtest")}><BarChart3 size={16} /> 5. 위험·백테스트</button>
        </nav>

        {tab === "explorer" ? (
          <section className="research-grid research-grid--explorer">
            <div className="research-card">
              <div className="research-card__head"><div><span>MANAGED UNIVERSE</span><h2>ETF 검색·필터</h2></div><label className="upload-button"><Upload size={15} /> 구성 CSV 보완<input type="file" accept=".csv,text/csv" onChange={(event) => importHoldings(event.target.files?.[0])} /></label></div>
              <div className="research-filters"><label><Search size={15} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="ETF명·코드·전략 검색" /></label><select value={assetFilter} onChange={(event) => setAssetFilter(event.target.value)}><option value="ALL">전체 자산군</option><option value="KR_EQUITY">국내 주식</option><option value="GLOBAL_EQUITY">해외 주식</option><option value="EMERGING_EQUITY">신흥국 주식</option><option value="BOND">채권</option><option value="CASH">현금성</option><option value="GOLD">금</option><option value="REIT">리츠</option></select></div>
              <div className="etf-table-wrap"><table className="etf-table"><thead><tr><th>비교</th><th>ETF</th><th>전략</th><th>품질</th><th>보수</th><th>20일 거래대금</th><th>1년 수익</th><th>1년 변동성</th><th>등급</th></tr></thead><tbody>{filtered.map((profile) => <tr key={profile.ticker}><td><input type="checkbox" checked={selected.includes(profile.ticker)} onChange={() => selectProfile(profile.ticker)} aria-label={`${profile.name} 비교 선택`} /></td><td><strong>{profile.name}</strong><small>{profile.ticker}</small></td><td>{profile.strategyLabel}</td><td>{qualityScores.get(profile.ticker)?.total.toFixed(0) ?? "—"}</td><td>{pct(profile.expenseRatioPercent)}</td><td>{shortWon(profile.metrics.averageTradingValue20dKrw)}</td><td>{pct(profile.metrics.return1yPercent)}</td><td>{pct(profile.metrics.volatility1yPercent)}</td><td><span className={`grade grade--${profile.dataGrade.toLocaleLowerCase()}`}>{profile.dataGrade}</span></td></tr>)}</tbody></table></div>
            </div>
            <aside className="research-card compare-card">
              <div className="research-card__head"><div><span>PAIR CHECK</span><h2>두 ETF 비교</h2></div></div>
              {selectedProfiles.length < 2 ? <p className="empty-copy">표에서 ETF 두 개를 선택하면 구성 중복도와 수익률 상관관계를 분리해 보여줍니다.</p> : <>
                <div className="compare-names">{selectedProfiles.map((profile) => <div key={profile.ticker}><strong>{profile.name}</strong><span>{profile.ticker} · {profile.strategyLabel}</span></div>)}</div>
                <div className="metric-stack"><div><span>구성종목 중복도</span><strong>{pct(overlap?.overlapPercent ?? null, 1)}</strong><small>{confidenceLabel(overlap?.confidence ?? "unavailable")} · 공개범위 {pct(overlap?.coveragePercent ?? null, 1)}</small></div><div><span>일별 수익률 상관계수</span><strong>{ratio(correlation)}</strong><small>{returns ? "공통 거래일 기준" : "가격 이력을 불러오면 계산"}</small></div></div>
                {!returns ? <button className="research-primary" onClick={ensureReturns} disabled={returnsLoading}>{returnsLoading ? <RefreshCw className="spin" size={15} /> : <Download size={15} />} 상관관계 자료 불러오기</button> : null}
                <div className="compare-holdings"><h3>공통 구성종목</h3>{overlap?.commonHoldings.length ? overlap.commonHoldings.map((holding) => <div key={holding.name}><span>{holding.name}</span><strong>{pct(holding.weightPercent, 2)}</strong></div>) : <p>공개된 구성자료에서 공통 항목을 확인하지 못했습니다.</p>}</div>
              </>}
              <div className="research-note"><Database size={15} /><p>현재 기본 데이터는 공개 화면에서 확인되는 부분 구성정보입니다. 전체 합계가 90% 미만이면 정확한 전체 중복도로 표시하지 않습니다. CSV는 브라우저 메모리에서만 사용됩니다.</p></div>
            </aside>
          </section>
        ) : null}

        {tab === "generator" ? (
          <section className="generator-layout">
            <div className="research-card generator-controls">
              <div className="research-card__head"><div><span>ASSET FIRST</span><h2>포트폴리오 설계 조건</h2></div></div>
              <p className="section-copy">먼저 자산군 비중을 정하고, 같은 노출을 가진 ETF끼리 유동성 30%·비용 25%·NAV 안정성 20%·규모/이력 15%·자료품질 10%로 비교합니다.</p>
              <div className="preset-row">{(Object.keys(PORTFOLIO_PRESETS) as Array<keyof typeof PORTFOLIO_PRESETS>).map((key) => <button key={key} onClick={() => applyPreset(key)}>{PORTFOLIO_PRESETS[key].label}</button>)}</div>
              <div className="sleeve-list">{config.sleeves.map((sleeve) => <label key={sleeve.id}><span>{sleeve.label}<small>{sleeve.strategyKey}</small></span><input type="number" min="0" max="100" value={sleeve.targetWeightPercent} onChange={(event) => setConfig((current) => ({ ...current, sleeves: current.sleeves.map((item) => item.id === sleeve.id ? { ...item, targetWeightPercent: Number(event.target.value) } : item) }))} /><b>%</b><button type="button" aria-label={`${sleeve.label} 삭제`} onClick={() => setConfig((current) => ({ ...current, sleeves: current.sleeves.filter((item) => item.id !== sleeve.id) }))}><X size={13} /></button></label>)}</div>
              <div className="add-sleeve"><select value={strategyToAdd} onChange={(event) => setStrategyToAdd(event.target.value)}><option value="">자산 노출 추가</option>{availableStrategies.filter((strategy) => !config.sleeves.some((sleeve) => sleeve.strategyKey === strategy.key)).map((strategy) => <option key={strategy.key} value={strategy.key}>{strategy.label}</option>)}</select><button type="button" disabled={!strategyToAdd} onClick={() => { const strategy = availableStrategies.find((item) => item.key === strategyToAdd); if (!strategy) return; setConfig((current) => ({ ...current, sleeves: [...current.sleeves, { id: `custom-${strategy.key}`, label: strategy.label, strategyKey: strategy.key, targetWeightPercent: 0 }] })); setStrategyToAdd(""); }}><Plus size={14} /> 추가</button></div>
              <div className="fixed-stock-box"><span>직접 보유 주식 노출 반영(선택)</span><div><input value={fixedStockName} onChange={(event) => setFixedStockName(event.target.value)} placeholder="예: 삼성전자" /><input type="number" min="0" max="100" value={fixedStockWeight || ""} onChange={(event) => setFixedStockWeight(Number(event.target.value))} placeholder="비중 %" /><button type="button" onClick={() => { if (!fixedStockName.trim() || fixedStockWeight <= 0) return; setConfig((current) => ({ ...current, fixedStocks: [...current.fixedStocks, { name: fixedStockName.trim(), weightPercent: fixedStockWeight }] })); setFixedStockName(""); setFixedStockWeight(0); }}><Plus size={14} /></button></div>{config.fixedStocks.map((stock, index) => <button className="fixed-stock-chip" type="button" key={`${stock.name}-${index}`} onClick={() => setConfig((current) => ({ ...current, fixedStocks: current.fixedStocks.filter((_, itemIndex) => itemIndex !== index) }))}>{stock.name} {stock.weightPercent}% <X size={11} /></button>)}</div>
              <div className="weight-total"><span>ETF + 직접보유 비중 합계</span><strong>{config.sleeves.reduce((sum, sleeve) => sum + sleeve.targetWeightPercent, 0) + config.fixedStocks.reduce((sum, stock) => sum + stock.weightPercent, 0)}%</strong></div>
              <div className="constraint-grid"><label><span>투자금</span><input type="number" value={config.investmentAmountKrw} onChange={(event) => setConfig((current) => ({ ...current, investmentAmountKrw: Number(event.target.value) }))} /></label><label><span>최대 ETF 비중</span><input type="number" value={config.maxEtfWeightPercent} onChange={(event) => setConfig((current) => ({ ...current, maxEtfWeightPercent: Number(event.target.value) }))} /></label><label><span>최대 쌍 중복도</span><input type="number" value={config.maxPairOverlapPercent} onChange={(event) => setConfig((current) => ({ ...current, maxPairOverlapPercent: Number(event.target.value) }))} /></label><label><span>최소 20일 거래대금</span><input type="number" value={config.minimumTradingValue20dKrw} onChange={(event) => setConfig((current) => ({ ...current, minimumTradingValue20dKrw: Number(event.target.value) }))} /></label></div>
              <button className="research-primary research-primary--wide" onClick={generate}><FlaskConical size={16} /> 조건으로 3개 후보 만들기</button>
            </div>
            <div className="candidate-area">
              <div className="research-card generator-explanation"><h3>생성기가 실제로 하는 일</h3><ol><li><strong>자산군 확정</strong><span>사용자가 정한 비중은 바꾸지 않습니다.</span></li><li><strong>동일 노출 ETF 필터</strong><span>유동성·보수·환헤지·자료 이력을 확인합니다.</span></li><li><strong>가능한 조합 평가</strong><span>중복 제한과 최대 비중을 적용합니다.</span></li><li><strong>서로 다른 3안 제시</strong><span>균형·저비용·저중복 관점을 비교합니다.</span></li></ol></div>
              {generation?.errors.length ? <div className="research-alert">{generation.errors.join(" ")}</div> : null}
              {generation?.candidates.map((item) => <article className={`research-card candidate-card ${candidate?.kind === item.kind ? "selected" : ""}`} key={item.kind} onClick={() => { setCandidate(item); setBacktests([]); }}><div className="candidate-title"><div><span>{item.kind.toLocaleUpperCase()}</span><h3>{item.label}</h3></div>{candidate?.kind === item.kind ? <CheckCircle2 size={20} /> : null}</div><div className="candidate-metrics"><span>종합 {item.score.toFixed(0)}</span><span>보수 {pct(item.weightedExpenseRatioPercent)}</span><span>중복 {pct(item.weightedOverlapPercent, 1)}</span><span>신뢰 {item.dataReliabilityScore.toFixed(0)}</span></div><div className="candidate-items">{item.items.map((holding) => <div key={holding.ticker}><span><strong>{holding.name}</strong><small>{holding.sleeveLabel} · 품질 {holding.qualityScore.toFixed(0)}</small></span><b>{holding.targetWeightPercent}%</b><em>{holding.expectedQuantity === null ? "수량 미산출" : `${holding.expectedQuantity.toLocaleString()}주`}</em></div>)}</div><p className="candidate-confidence">{confidenceLabel(item.overlapConfidence)} · 예상 ETF 잔여현금 {won(item.remainingCashKrw)}</p></article>)}
              {candidate ? <button className="research-primary research-primary--wide" onClick={runBacktests} disabled={returnsLoading}>{returnsLoading ? <RefreshCw className="spin" size={16} /> : <BarChart3 size={16} />} 선택 후보를 3가지 주기로 검증</button> : null}
            </div>
          </section>
        ) : null}

        {tab === "backtest" ? (
          <section className="research-card backtest-card">
            <div className="research-card__head"><div><span>HISTORICAL CHECK</span><h2>위험·백테스트 비교</h2></div>{candidate ? <strong>{candidate.label}</strong> : null}</div>
            {!candidate ? <div className="empty-state"><BarChart3 size={28} /><h3>먼저 포트폴리오 후보를 생성하세요.</h3><button onClick={() => setTab("generator")}>생성기로 이동</button></div> : backtests.length === 0 ? <div className="empty-state"><BarChart3 size={28} /><h3>{candidate.label}의 과거 경로를 검증합니다.</h3><p>미실행·분기·연간 리밸런싱을 동일한 5bp 거래비용과 2.5% 무위험수익률 가정으로 비교합니다.</p><button onClick={runBacktests} disabled={returnsLoading}>백테스트 실행</button></div> : <>
              <div className="backtest-disclosure"><TriangleAlert size={17} /><p>현재 {manifest?.totalReturnCount ?? 0}개 ETF만 총수익률 자료를 보유합니다. 이 결과는 <strong>분배금 반영이 보장되지 않는 가격수익률</strong> 기준이며 투자 추천이나 미래 예측이 아닙니다.</p></div>
              <CurveChart results={backtests} />
              <div className="backtest-table-wrap"><table className="backtest-table"><thead><tr><th>리밸런싱</th><th>기간</th><th>누적수익률</th><th>연환산수익률</th><th>변동성</th><th>최대낙폭</th><th>샤프</th><th>소르티노</th><th>최악 월</th><th>회전율</th></tr></thead><tbody>{backtests.map((result) => <tr key={result.frequency}><td>{result.frequency === "none" ? "미실행" : result.frequency === "quarterly" ? "분기" : "연간"}</td><td>{result.metrics.startDate}<br />~ {result.metrics.endDate}</td><td>{pct(result.metrics.cumulativeReturnPercent)}</td><td>{pct(result.metrics.annualizedReturnPercent)}</td><td>{pct(result.metrics.annualizedVolatilityPercent)}</td><td>{pct(result.metrics.maximumDrawdownPercent)}</td><td>{ratio(result.metrics.sharpeRatio)}</td><td>{ratio(result.metrics.sortinoRatio)}</td><td>{pct(result.metrics.worstMonthPercent)}</td><td>{pct(result.metrics.totalTurnoverPercent)}</td></tr>)}</tbody></table></div>
              <div className="method-grid"><div><h3>공통 조건</h3><p>후보 ETF 모두에 가격이 있는 거래일만 사용하고, 비중은 후보 내 ETF 합계로 재정규화합니다.</p></div><div><h3>거래비용</h3><p>리밸런싱 회전율 × 5bp를 포트폴리오 가치에서 차감합니다. 세금과 호가 스프레드는 포함하지 않습니다.</p></div><div><h3>해석 제한</h3><p>상장 전 대체지수 연결, 생존편향 보정, 분배금 재투자는 아직 제공하지 않습니다.</p></div></div>
            </>}
          </section>
        ) : null}
        <SiteFooter note="공개 자료를 비교하고 브라우저에서 계산하는 ETF 연구 도구" />
      </main>
    </div>
  );
}
