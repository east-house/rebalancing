import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  ArrowRight,
  BarChart3,
  Calculator,
  CalendarDays,
  Check,
  ChevronRight,
  CircleDollarSign,
  Database,
  Info,
  Landmark,
  LockKeyhole,
  Plus,
  ShieldCheck,
  Sparkles,
  Trash2,
  WalletCards,
} from "lucide-react";

import AssetChart from "./components/AssetChart";
import InstrumentSearch from "./components/InstrumentSearch";
import {
  latestQuoteDate,
  parseMarketDataPayload,
  quotesForPolicy,
  type MarketDataPayload,
  type PricePolicy,
} from "./api/marketData";
import {
  calculateRebalancePreview,
  normalizeTicker,
  samplePortfolio,
  sampleSnapshots,
  validateTargetWeights,
  type Holding,
  type Portfolio,
  type RebalancePreview,
} from "./domain";
import type {
  Instrument,
  InstrumentCatalogMeta,
  InstrumentCatalogPayload,
} from "./types/instrument";
import {
  deleteLocalAppState,
  loadLocalAppState,
  parseLocalAppState,
  PORTFOLIO_STORAGE_KEY,
  saveLocalAppState,
  upsertDailySnapshot,
  type LocalAppState,
  type LocalStateSource,
} from "./storage/portfolioStorage";

type AllocationMode = "current" | "target";

const FALLBACK_INSTRUMENTS: Instrument[] = [
  {
    ticker: "VOO",
    name: "Vanguard S&P 500 ETF",
    market: "NYSE Arca",
    country: "US",
    assetType: "ETF",
  },
  {
    ticker: "QQQ",
    name: "Invesco QQQ Trust",
    market: "NASDAQ",
    country: "US",
    assetType: "ETF",
  },
  {
    ticker: "GOOG",
    name: "Alphabet Inc. Class C",
    market: "NASDAQ",
    country: "US",
    assetType: "STOCK",
  },
  {
    ticker: "GOOGL",
    name: "Alphabet Inc. Class A",
    market: "NASDAQ",
    country: "US",
    assetType: "STOCK",
  },
  {
    ticker: "SPY",
    name: "SPDR S&P 500 ETF Trust",
    market: "NYSE Arca",
    country: "US",
    assetType: "ETF",
  },
  {
    ticker: "SCHD",
    name: "Schwab U.S. Dividend Equity ETF",
    market: "NYSE Arca",
    country: "US",
    assetType: "ETF",
  },
  {
    ticker: "AAPL",
    name: "Apple Inc.",
    market: "NASDAQ",
    country: "US",
    assetType: "STOCK",
  },
  {
    ticker: "MSFT",
    name: "Microsoft Corporation",
    market: "NASDAQ",
    country: "US",
    assetType: "STOCK",
  },
  {
    ticker: "AMZN",
    name: "Amazon.com, Inc.",
    market: "NASDAQ",
    country: "US",
    assetType: "STOCK",
  },
  {
    ticker: "META",
    name: "Meta Platforms, Inc.",
    market: "NASDAQ",
    country: "US",
    assetType: "STOCK",
  },
  {
    ticker: "NVDA",
    name: "NVIDIA Corporation",
    market: "NASDAQ",
    country: "US",
    assetType: "STOCK",
  },
  {
    ticker: "TSLA",
    name: "Tesla, Inc.",
    market: "NASDAQ",
    country: "US",
    assetType: "STOCK",
  },
];

const WON = new Intl.NumberFormat("ko-KR", {
  style: "currency",
  currency: "KRW",
  maximumFractionDigits: 0,
});

const COMPACT_WON = new Intl.NumberFormat("ko-KR", {
  style: "currency",
  currency: "KRW",
  notation: "compact",
  maximumFractionDigits: 1,
});

const NUMBER = new Intl.NumberFormat("ko-KR", { maximumFractionDigits: 0 });

const ALLOCATION_COLORS = ["#3f7657", "#56866a", "#6d967c", "#84a68e", "#9bb5a2"];

const USD = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 2,
});

function formatPriceDate(value?: string) {
  if (!value) return "종가 연결 대기";
  const [year, month, day] = value.split("-");
  return `${year}. ${month}. ${day} 종가`;
}

function cloneSamplePortfolio(): Portfolio {
  return {
    ...samplePortfolio,
    holdings: samplePortfolio.holdings.map((holding) => ({ ...holding })),
  };
}

function createDefaultLocalState(): LocalAppState {
  return {
    portfolio: cloneSamplePortfolio(),
    allocationMode: "target",
    pricePolicy: "previous",
    snapshots: sampleSnapshots.map((snapshot) => ({ ...snapshot })),
  };
}

function formatPercent(value: number) {
  if (!Number.isFinite(value)) return "—";
  return `${value.toFixed(value < 10 && value % 1 !== 0 ? 1 : 0)}%`;
}

function actionLabel(action: "BUY" | "SELL" | "HOLD") {
  if (action === "BUY") return "매수";
  if (action === "SELL") return "매도";
  return "유지";
}

function App() {
  const [initialLocalState] = useState(() =>
    loadLocalAppState(createDefaultLocalState()),
  );
  const [portfolio, setPortfolio] = useState<Portfolio>(
    initialLocalState.state.portfolio,
  );
  const [allocationMode, setAllocationMode] = useState<AllocationMode>(
    initialLocalState.state.allocationMode,
  );
  const [pricePolicy, setPricePolicy] = useState<PricePolicy>(
    initialLocalState.state.pricePolicy,
  );
  const [snapshots, setSnapshots] = useState(
    initialLocalState.state.snapshots,
  );
  const [storageSource, setStorageSource] = useState<LocalStateSource>(
    initialLocalState.source,
  );
  const [storageMessage, setStorageMessage] = useState(
    initialLocalState.source === "saved"
      ? "이 기기에 저장된 자산 정보를 복구했습니다."
      : initialLocalState.source === "invalid"
        ? "저장 데이터가 손상되어 안전한 샘플 상태로 시작했습니다."
        : initialLocalState.source === "unavailable"
          ? "브라우저 설정으로 로컬 저장소를 사용할 수 없어 재방문 시 복구할 수 없습니다."
        : "",
  );
  const skipNextSave = useRef(false);
  const [preview, setPreview] = useState<RebalancePreview | null>(null);
  const [calculationMessage, setCalculationMessage] = useState("");
  const [instruments, setInstruments] =
    useState<readonly Instrument[]>(FALLBACK_INSTRUMENTS);
  const [catalogMeta, setCatalogMeta] = useState<InstrumentCatalogMeta | null>(
    null,
  );
  const [catalogStatus, setCatalogStatus] = useState<
    "loading" | "ready" | "fallback"
  >("loading");
  const [marketData, setMarketData] = useState<MarketDataPayload | null>(null);
  const [marketStatus, setMarketStatus] = useState<
    "loading" | "ready" | "error"
  >("loading");
  const [marketMessage, setMarketMessage] = useState(
    "R2에서 최신 종가를 불러오는 중입니다.",
  );

  useEffect(() => {
    const controller = new AbortController();

    fetch(`${import.meta.env.BASE_URL}data/instruments.json`, {
      cache: "force-cache",
      signal: controller.signal,
    })
      .then((response) => {
        if (!response.ok) {
          throw new Error(`종목 목록을 불러오지 못했습니다 (${response.status})`);
        }
        return response.json() as Promise<InstrumentCatalogPayload>;
      })
      .then((payload) => {
        if (!Array.isArray(payload.instruments) || payload.instruments.length === 0) {
          throw new Error("종목 목록이 비어 있습니다.");
        }
        setInstruments(payload.instruments);
        setCatalogMeta(payload.meta);
        setCatalogStatus("ready");
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setCatalogStatus("fallback");
      });

    return () => controller.abort();
  }, []);

  useEffect(() => {
    const controller = new AbortController();

    fetch(`${import.meta.env.BASE_URL}api/market-data/latest`, {
      headers: { accept: "application/json" },
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`종가 API 응답 오류 (${response.status})`);
        }
        return parseMarketDataPayload(await response.json());
      })
      .then((payload) => {
        setMarketData(payload);
        setMarketStatus("ready");
        setMarketMessage(
          payload.complete
            ? `${NUMBER.format(payload.quoteCount)}개 종목의 R2 종가를 불러왔습니다.`
            : `${NUMBER.format(payload.quoteCount)}개 종목의 종가를 불러왔지만 일부 수집 조각은 이전 상태입니다.`,
        );
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setMarketData(null);
        setMarketStatus("error");
        setMarketMessage(
          error instanceof Error
            ? error.message
            : "R2 종가를 불러오지 못했습니다.",
        );
      });

    return () => controller.abort();
  }, []);

  const activeQuotes = useMemo(
    () => (marketData ? quotesForPolicy(marketData, pricePolicy) : []),
    [marketData, pricePolicy],
  );
  const quoteMap = useMemo(
    () =>
      new Map(
        activeQuotes.map((quote) => [normalizeTicker(quote.ticker), quote]),
    ),
    [activeQuotes],
  );
  const heldQuotes = useMemo(
    () =>
      portfolio.holdings.flatMap((holding) => {
        const quote = quoteMap.get(normalizeTicker(holding.ticker));
        return quote ? [quote] : [];
      }),
    [portfolio.holdings, quoteMap],
  );
  const priceDate = latestQuoteDate(heldQuotes);

  const valuations = useMemo(
    () =>
      portfolio.holdings.map((holding) => {
        const quote = quoteMap.get(normalizeTicker(holding.ticker));
        const marketValue = quote ? holding.quantity * quote.close : 0;
        const weight =
          portfolio.totalAssets > 0 ? (marketValue / portfolio.totalAssets) * 100 : 0;
        return { holding, quote, marketValue, weight };
      }),
    [portfolio, quoteMap],
  );

  const investedValue = valuations.reduce((sum, item) => sum + item.marketValue, 0);
  const cash = portfolio.totalAssets - investedValue;
  const cashWeight =
    portfolio.totalAssets > 0 ? (cash / portfolio.totalAssets) * 100 : 0;
  const targetValidation = validateTargetWeights(portfolio);
  const normalizedTickers = portfolio.holdings.map((holding) =>
    normalizeTicker(holding.ticker),
  );
  const duplicateTickers = new Set(
    normalizedTickers.filter(
      (ticker, index) => ticker && normalizedTickers.indexOf(ticker) !== index,
    ),
  );
  const missingPriceTickers = portfolio.holdings
    .filter((holding) => !quoteMap.has(normalizeTicker(holding.ticker)))
    .map((holding) => normalizeTicker(holding.ticker) || "미입력 종목");

  const canRebalance =
    allocationMode === "target" &&
    portfolio.totalAssets > 0 &&
    cash >= 0 &&
    targetValidation.valid &&
    duplicateTickers.size === 0 &&
    missingPriceTickers.length === 0 &&
    portfolio.holdings.length > 0;

  const chartData = snapshots;

  useEffect(() => {
    if (skipNextSave.current) {
      skipNextSave.current = false;
      return;
    }

    const saved = saveLocalAppState({
      portfolio,
      allocationMode,
      pricePolicy,
      snapshots: chartData,
    });
    setStorageSource(saved ? "saved" : "unavailable");
  }, [allocationMode, chartData, portfolio, pricePolicy]);

  useEffect(() => {
    const handleStorageChange = (event: StorageEvent) => {
      if (event.key !== PORTFOLIO_STORAGE_KEY) return;

      const nextState =
        event.newValue === null
          ? createDefaultLocalState()
          : parseLocalAppState(event.newValue);
      if (!nextState) return;

      skipNextSave.current = true;
      setPortfolio(nextState.portfolio);
      setAllocationMode(nextState.allocationMode);
      setPricePolicy(nextState.pricePolicy);
      setSnapshots(nextState.snapshots);
      setPreview(null);
      setCalculationMessage("");
      setStorageSource(event.newValue === null ? "default" : "saved");
      setStorageMessage(
        event.newValue === null
          ? "다른 탭에서 로컬 데이터를 삭제해 샘플 상태로 초기화했습니다."
          : "다른 탭에서 변경한 자산 정보를 반영했습니다.",
      );
    };

    window.addEventListener("storage", handleStorageChange);
    return () => window.removeEventListener("storage", handleStorageChange);
  }, []);

  const allocationItems = [
    ...valuations.map((item, index) => ({
      key: `${normalizeTicker(item.holding.ticker)}-${index}`,
      label: normalizeTicker(item.holding.ticker) || "새 종목",
      value: Math.max(0, item.weight),
      color: ALLOCATION_COLORS[index % ALLOCATION_COLORS.length],
    })),
    {
      key: "cash",
      label: "현금",
      value: Math.max(0, cashWeight),
      color: "#c4cec8",
    },
  ];

  const clearResult = () => {
    setPreview(null);
    setCalculationMessage("");
  };

  const updatePortfolio = (updater: (current: Portfolio) => Portfolio) => {
    setPortfolio(updater);
    clearResult();
  };

  const updateHolding = (index: number, patch: Partial<Holding>) => {
    updatePortfolio((current) => ({
      ...current,
      holdings: current.holdings.map((holding, holdingIndex) =>
        holdingIndex === index ? { ...holding, ...patch } : holding,
      ),
    }));
  };

  const updateTotalAssets = (totalAssets: number) => {
    updatePortfolio((current) => ({
      ...current,
      totalAssets,
    }));
    setSnapshots((current) =>
      upsertDailySnapshot(current, totalAssets),
    );
  };

  const handleInstrumentSelect = (index: number, instrument: Instrument) => {
    updateHolding(index, {
      ticker: instrument.ticker,
      name: instrument.name,
      assetType: instrument.assetType,
    });
  };

  const addHolding = () => {
    const used = new Set(normalizedTickers);
    const nextInstrument =
      instruments.find((instrument) => !used.has(instrument.ticker)) ??
      FALLBACK_INSTRUMENTS[0];
    if (!nextInstrument) return;
    updatePortfolio((current) => ({
      ...current,
      holdings: [
        ...current.holdings,
        {
          ticker: nextInstrument.ticker,
          name: nextInstrument.name,
          assetType: nextInstrument.assetType,
          quantity: 0,
          targetWeight: 0,
        },
      ],
    }));
  };

  const removeHolding = (index: number) => {
    updatePortfolio((current) => ({
      ...current,
      holdings: current.holdings.filter((_, holdingIndex) => holdingIndex !== index),
    }));
  };

  const calculatePreview = () => {
    if (!canRebalance) return;
    try {
      setPreview(calculateRebalancePreview(portfolio, heldQuotes));
      setCalculationMessage(
        `${formatPriceDate(priceDate)}를 기준으로 리밸런싱 미리보기를 계산했습니다.`,
      );
      window.setTimeout(() => {
        document
          .getElementById("rebalance-results")
          ?.scrollIntoView?.({ behavior: "smooth", block: "start" });
      }, 50);
    } catch (error) {
      setPreview(null);
      setCalculationMessage(
        error instanceof Error ? error.message : "계산 중 오류가 발생했습니다.",
      );
    }
  };

  const deleteSavedData = () => {
    const confirmed = window.confirm(
      "이 브라우저에 저장된 보유 종목, 수량, 목표 비중과 자산 이력을 삭제할까요?",
    );
    if (!confirmed) return;

    skipNextSave.current = true;
    const defaults = createDefaultLocalState();
    const deleted = deleteLocalAppState();
    setPortfolio(defaults.portfolio);
    setAllocationMode(defaults.allocationMode);
    setPricePolicy(defaults.pricePolicy);
    setSnapshots(defaults.snapshots);
    setPreview(null);
    setCalculationMessage("");
    setStorageSource(deleted ? "default" : "unavailable");
    setStorageMessage(
      deleted
        ? "이 기기에 저장된 자산 정보를 삭제하고 샘플 상태로 초기화했습니다."
        : "브라우저 저장소에 접근할 수 없어 저장 데이터를 삭제하지 못했습니다.",
    );
  };

  return (
    <div className="app-shell">
      <header className="topbar">
        <a className="brand" href="#top" aria-label="Balance 홈">
          <span className="brand-mark" aria-hidden="true">
            <span />
            <span />
            <span />
          </span>
          <span className="brand-word">balance</span>
          <span className="brand-dot">.</span>
        </a>

        <div className="topbar-meta">
          <span className="status-pill status-pill--demo">
            <Database size={14} />
            {marketStatus === "loading"
              ? "종가 불러오는 중"
              : marketStatus === "ready"
                ? "R2 종가"
                : "종가 연결 오류"}
          </span>
          <span className="status-pill status-pill--private">
            <ShieldCheck size={14} />
            서버 저장 없음
          </span>
        </div>
      </header>

      <main className="dashboard" id="top">
        <div className="intro-row">
          <div>
            <p className="eyebrow">MY PORTFOLIO</p>
            <h1>
              자산을 한눈에,
              <span className="mobile-title-break"> 조정은 정확하게.</span>
            </h1>
            <p className="intro-copy">
              한글 종목명, 6자리 종목코드 또는 영문 Ticker로 자산을 찾아보세요.
            </p>
          </div>
          <div className="price-date">
            <CalendarDays size={16} />
            <div>
              <span>가격 기준일</span>
              <strong>{formatPriceDate(priceDate)}</strong>
            </div>
          </div>
        </div>

        <section className="summary-card" aria-labelledby="total-assets-title">
          <div className="summary-copy">
            <div className="summary-label">
              <span className="summary-icon">
                <WalletCards size={18} />
              </span>
              <span id="total-assets-title">현재 총자산</span>
            </div>
            <div className="summary-amount">{WON.format(portfolio.totalAssets)}</div>
            <p className="summary-note">
              입력한 총자산을 기준으로 투자자산과 현금을 함께 계산합니다.
            </p>

            <div className="summary-stats">
              <div className="summary-stat">
                <span>투자자산</span>
                <strong>{WON.format(investedValue)}</strong>
              </div>
              <div className="summary-stat">
                <span>가용 현금</span>
                <strong className={cash < 0 ? "negative" : ""}>{WON.format(cash)}</strong>
              </div>
              <div className="summary-stat">
                <span>보유 종목</span>
                <strong>{portfolio.holdings.length}개</strong>
              </div>
            </div>
          </div>

          <div className="allocation-overview">
            <div className="allocation-heading">
              <div>
                <span>현재 자산 구성</span>
                <strong>{formatPercent(Math.max(0, 100 - cashWeight))} 투자 중</strong>
              </div>
              <BarChart3 size={18} />
            </div>
            <div className="allocation-bar" aria-label="현재 자산 구성">
              {allocationItems.map((item) => (
                <span
                  key={item.key}
                  style={{
                    width: `${Math.min(100, Math.max(0, item.value))}%`,
                    backgroundColor: item.color,
                  }}
                  title={`${item.label} ${formatPercent(item.value)}`}
                />
              ))}
            </div>
            <div className="allocation-legend">
              {allocationItems.slice(0, 5).map((item) => (
                <div key={item.key}>
                  <i style={{ backgroundColor: item.color }} />
                  <span>{item.label}</span>
                  <strong>{formatPercent(item.value)}</strong>
                </div>
              ))}
            </div>
          </div>
        </section>

        <div className="workspace-grid">
          <section className="panel holdings-panel" aria-labelledby="holdings-title">
            <div className="panel-header">
              <div>
                <p className="panel-kicker">HOLDINGS</p>
                <h2 id="holdings-title">보유 자산</h2>
                <p>한국·미국 회사 및 ETF를 종목명이나 Ticker로 검색할 수 있습니다.</p>
              </div>
              <button className="secondary-button" type="button" onClick={addHolding}>
                <Plus size={16} />
                종목 추가
              </button>
            </div>

            <div className="holdings-table">
              <div className="holdings-head" aria-hidden="true">
                <span>TICKER / NAME</span>
                <span>보유수</span>
                <span>기준 종가</span>
                <span>평가금액</span>
                <span>현재 비중</span>
                <span>목표 비중</span>
                <span />
              </div>

              {valuations.map(({ holding, quote, marketValue, weight }, index) => {
                const ticker = normalizeTicker(holding.ticker);
                const isDuplicate = duplicateTickers.has(ticker);
                return (
                  <div className="holding-row" key={`holding-${index}`}>
                    <div className="asset-field" data-label="Ticker / 종목명">
                      <div className="ticker-line">
                        <InstrumentSearch
                          ariaLabel={`${index + 1}번째 종목 검색`}
                          instruments={instruments}
                          value={holding.ticker}
                          selectedName={holding.name}
                          hasError={isDuplicate}
                          onSelect={(instrument) =>
                            handleInstrumentSelect(index, instrument)
                          }
                        />
                        <span>{holding.assetType}</span>
                      </div>
                      <small>{isDuplicate ? "중복 종목입니다" : holding.name}</small>
                    </div>

                    <label className="table-field" data-label="보유수">
                      <span className="sr-only">보유수</span>
                      <input
                        aria-label={`${ticker || index + 1} 보유수`}
                        type="number"
                        min="0"
                        step="1"
                        inputMode="numeric"
                        value={holding.quantity}
                        onChange={(event) =>
                          updateHolding(index, {
                            quantity: Math.max(0, Math.floor(Number(event.target.value) || 0)),
                          })
                        }
                      />
                      <small>주</small>
                    </label>

                    <div className="table-value" data-label="기준 종가">
                      <strong>
                        {quote
                          ? quote.nativeCurrency === "USD"
                            ? USD.format(quote.nativeClose ?? quote.close)
                            : WON.format(quote.nativeClose ?? quote.close)
                          : "가격 없음"}
                      </strong>
                      <small>
                        {quote
                          ? quote.nativeCurrency === "USD"
                            ? `${WON.format(quote.close)} 환산 · ${quote.asOf}`
                            : `R2 종가 · ${quote.asOf}`
                          : marketStatus === "loading"
                            ? "R2 종가 확인 중"
                            : "수집 종가 없음"}
                      </small>
                    </div>

                    <div className="table-value" data-label="평가금액">
                      <strong>{quote ? COMPACT_WON.format(marketValue) : "—"}</strong>
                      <small>{quote ? WON.format(marketValue) : "계산 불가"}</small>
                    </div>

                    <div className="weight-value" data-label="현재 비중">
                      <strong>{quote ? formatPercent(weight) : "—"}</strong>
                      <span>
                        <i style={{ width: `${Math.min(100, Math.max(0, weight))}%` }} />
                      </span>
                    </div>

                    <label
                      className={`target-field ${
                        allocationMode === "current" ? "target-field--disabled" : ""
                      }`}
                      data-label="목표 비중"
                    >
                      <span className="sr-only">목표 비중</span>
                      <input
                        aria-label={`${ticker || index + 1} 목표 비중`}
                        type="number"
                        min="0"
                        max="100"
                        step="1"
                        value={holding.targetWeight}
                        disabled={allocationMode === "current"}
                        onChange={(event) =>
                          updateHolding(index, {
                            targetWeight: Number(event.target.value) || 0,
                          })
                        }
                      />
                      <small>%</small>
                    </label>

                    <button
                      className="icon-button"
                      type="button"
                      aria-label={`${ticker || "종목"} 삭제`}
                      onClick={() => removeHolding(index)}
                    >
                      <Trash2 size={16} />
                    </button>
                  </div>
                );
              })}
            </div>

            {portfolio.holdings.length === 0 && (
              <div className="empty-state">
                <CircleDollarSign size={24} />
                <strong>아직 보유 자산이 없습니다</strong>
                <p>첫 종목을 추가해 자산 구성을 시작하세요.</p>
                <button className="secondary-button" type="button" onClick={addHolding}>
                  <Plus size={16} />
                  첫 종목 추가
                </button>
              </div>
            )}

            <div className="panel-footnotes">
              <div className="panel-footnote">
                <Database size={14} />
                {catalogStatus === "ready" && catalogMeta
                  ? `${NUMBER.format(catalogMeta.counts.total)}개 정적 종목 목록 · 검색 시 서버 호출 없음`
                  : catalogStatus === "loading"
                    ? "한국·미국 정적 종목 목록을 불러오는 중입니다."
                    : "종목 목록을 불러오지 못해 샘플 목록으로 검색합니다."}
              </div>
              <div className="panel-footnote panel-footnote--secondary">
                <Info size={14} />
                {marketStatus === "ready" && marketData
                  ? `${marketMessage} 미국 종목은 수집된 USD/KRW 종가로 원화 환산합니다.`
                  : marketMessage}
              </div>
            </div>
          </section>

          <aside className="panel rebalance-panel" aria-labelledby="rebalance-title">
            <div className="panel-header panel-header--compact">
              <div>
                <p className="panel-kicker">REBALANCE</p>
                <h2 id="rebalance-title">리밸런싱 설정</h2>
              </div>
              <span className="spark-icon" aria-hidden="true">
                <Sparkles size={17} />
              </span>
            </div>

            <div className="mode-toggle" role="group" aria-label="비중 설정 모드">
              <button
                type="button"
                className={allocationMode === "current" ? "active" : ""}
                aria-pressed={allocationMode === "current"}
                onClick={() => {
                  setAllocationMode("current");
                  clearResult();
                }}
              >
                현재 비중
              </button>
              <button
                type="button"
                className={allocationMode === "target" ? "active" : ""}
                aria-pressed={allocationMode === "target"}
                onClick={() => {
                  setAllocationMode("target");
                  clearResult();
                }}
              >
                목표 비중 지정
              </button>
            </div>

            <label className="setting-field">
              <span>
                <span>현재 총자산</span>
                <small>현금 포함</small>
              </span>
              <div className="amount-input">
                <input
                  aria-label="현재 총자산"
                  type="number"
                  min="0"
                  step="100000"
                  inputMode="numeric"
                  value={portfolio.totalAssets}
                  onChange={(event) =>
                    updateTotalAssets(
                      Math.max(0, Number(event.target.value) || 0),
                    )
                  }
                />
                <span>원</span>
              </div>
              <small className="formatted-value">{WON.format(portfolio.totalAssets)}</small>
            </label>

            <label className="setting-field">
              <span>
                <span>가격 기준</span>
                <small>R2 수집 데이터</small>
              </span>
              <select
                value={pricePolicy}
                onChange={(event) => {
                  setPricePolicy(event.target.value as PricePolicy);
                  clearResult();
                }}
              >
                <option value="previous">전일 종가</option>
                <option value="today">당일 확정 종가</option>
              </select>
            </label>

            {allocationMode === "target" ? (
              <>
                <label className="setting-field">
                  <span>
                    <span>목표 현금 비중</span>
                    <small>리밸런싱 후</small>
                  </span>
                  <div className="percent-input">
                    <input
                      type="number"
                      min="0"
                      max="100"
                      step="1"
                      value={portfolio.targetCashWeight}
                      onChange={(event) =>
                        updatePortfolio((current) => ({
                          ...current,
                          targetCashWeight: Number(event.target.value) || 0,
                        }))
                      }
                    />
                    <span>%</span>
                  </div>
                </label>

                <div className="target-summary">
                  <div className="target-summary-row">
                    <span>목표 비중 합계</span>
                    <strong className={targetValidation.valid ? "valid" : "invalid"}>
                      {targetValidation.totalWeight.toFixed(0)}%
                    </strong>
                  </div>
                  <div className="target-progress">
                    <span
                      className={targetValidation.valid ? "valid" : ""}
                      style={{
                        width: `${Math.min(
                          100,
                          Math.max(0, targetValidation.totalWeight),
                        )}%`,
                      }}
                    />
                  </div>
                  <p>
                    {targetValidation.valid ? (
                      <>
                        <Check size={13} /> 현금 포함 100%로 설정되었습니다.
                      </>
                    ) : (
                      <>
                        <AlertCircle size={13} />
                        {targetValidation.difference > 0
                          ? `${targetValidation.difference.toFixed(0)}%를 더 배분해 주세요.`
                          : `${Math.abs(targetValidation.difference).toFixed(
                              0,
                            )}%를 줄여 주세요.`}
                      </>
                    )}
                  </p>
                </div>
              </>
            ) : (
              <div className="current-mode-card">
                <Landmark size={18} />
                <div>
                  <strong>현재 구성만 확인 중</strong>
                  <p>목표 비중을 지정하면 매수·매도 수량을 계산할 수 있습니다.</p>
                </div>
              </div>
            )}

            {cash < 0 && (
              <div className="inline-alert">
                <AlertCircle size={15} />
                보유자산 평가액이 총자산보다 {WON.format(Math.abs(cash))} 큽니다.
              </div>
            )}
            {duplicateTickers.size > 0 && (
              <div className="inline-alert">
                <AlertCircle size={15} />
                중복된 Ticker를 정리해 주세요.
              </div>
            )}
            {missingPriceTickers.length > 0 && (
              <div className="inline-alert">
                <AlertCircle size={15} />
                {missingPriceTickers.join(", ")}의 선택 기준 종가가 없습니다.
              </div>
            )}

            <button
              className="primary-button"
              type="button"
              disabled={!canRebalance}
              onClick={calculatePreview}
            >
              <Calculator size={18} />
              리밸런싱 계산
              <ArrowRight size={17} />
            </button>

            <p className="estimate-note">
              수수료·세금을 제외한 정수 주식 기준 예상치입니다. 실제 주문은 실행되지
              않습니다.
            </p>
            <div className="privacy-inline">
              <LockKeyhole size={15} />
              <span>
                공개 종가 묶음만 내려받으며 입력값은 서버나 R2로 전송하지 않고 이
                브라우저에만 저장합니다.
              </span>
            </div>
          </aside>
        </div>

        {preview && (
          <section
            className="panel result-panel"
            id="rebalance-results"
            aria-labelledby="result-title"
          >
            <div className="panel-header">
              <div>
                <p className="panel-kicker">PREVIEW</p>
                <h2 id="result-title">리밸런싱 미리보기</h2>
                <p>정수 주식으로 계산하여 목표 비중과 약간의 차이가 생길 수 있습니다.</p>
              </div>
              <div className="result-cash">
                <span>예상 잔여 현금</span>
                <strong>{WON.format(preview.projectedCash)}</strong>
                <small>{formatPercent(preview.projectedCashWeight)}</small>
              </div>
            </div>

            <div className="result-list">
              {preview.items.map((item) => (
                <article className="result-item" key={item.ticker}>
                  <div className="result-asset">
                    <span className="result-symbol">{item.ticker.slice(0, 2)}</span>
                    <div>
                      <strong>{item.ticker}</strong>
                      <span>{item.name}</span>
                    </div>
                  </div>
                  <div className="result-metric">
                    <span>현재 → 예상</span>
                    <strong>
                      {NUMBER.format(item.currentQuantity)}주
                      <ChevronRight size={14} />
                      {NUMBER.format(item.targetQuantity)}주
                    </strong>
                  </div>
                  <div className="result-metric">
                    <span>예상 거래금액</span>
                    <strong>{WON.format(item.estimatedTradeValue)}</strong>
                  </div>
                  <div className="result-metric">
                    <span>예상 비중</span>
                    <strong>
                      {formatPercent(item.currentWeight)}
                      <ChevronRight size={14} />
                      {formatPercent(item.projectedWeight)}
                    </strong>
                  </div>
                  <span className={`action-badge action-badge--${item.action.toLowerCase()}`}>
                    {actionLabel(item.action)}
                    {item.action !== "HOLD" &&
                      ` ${NUMBER.format(Math.abs(item.quantityDelta))}주`}
                  </span>
                </article>
              ))}
            </div>
          </section>
        )}

        <div className="chart-wrap">
          <AssetChart data={chartData} currency="KRW" initialPeriod="1Y" />
          <div className="chart-demo-note">
            <Database size={14} />
            자산 시계열도 이 브라우저에만 저장되며 마지막 값은 현재 총자산을 반영합니다.
          </div>
        </div>

        <section className="security-banner" aria-label="데이터 안내">
          <span className="security-icon">
            <ShieldCheck size={22} />
          </span>
          <div>
            <strong>당신의 자산 정보는 현재 브라우저 기기에만 머뭅니다.</strong>
            <p>
              보유 종목·수량·목표 비중·현금 설정과 자산 이력은 브라우저 로컬 저장소에
              보관되어 재방문 시 복구됩니다. 화면은 R2의 전체 공개 종가 묶음을
              내려받아 현재 브라우저 안에서만 보유 종목과 매칭합니다. 입력 정보는
              서버와 R2에 전송하지 않지만, 같은 브라우저 프로필을 쓰는 사람은 볼 수
              있으며 브라우저 데이터 삭제 시 함께 사라집니다.
            </p>
            {storageMessage && (
              <p className="storage-message" role="status">
                {storageMessage}
              </p>
            )}
          </div>
          <div className="local-data-actions">
            <span className="local-chip">
              {storageSource === "unavailable" ? "저장 불가" : "LOCAL ONLY"}
            </span>
            <button
              className="delete-local-button"
              type="button"
              onClick={deleteSavedData}
            >
              <Trash2 size={14} />
              내 데이터 삭제
            </button>
          </div>
        </section>

        <p className="live-region" aria-live="polite">
          {calculationMessage}
        </p>
      </main>

      <footer>
        <div className="brand brand--footer" aria-hidden="true">
          <span className="brand-mark">
            <span />
            <span />
            <span />
          </span>
          <span className="brand-word">balance</span>
          <span className="brand-dot">.</span>
        </div>
        <p>R2 종가와 로컬 전용 자산 정보를 사용하는 포트폴리오 도구</p>
      </footer>
    </div>
  );
}

export default App;
