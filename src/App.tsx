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
  LockKeyhole,
  Plus,
  ShieldCheck,
  Sparkles,
  Trash2,
  WalletCards,
} from "lucide-react";

import AssetChart from "./components/AssetChart";
import InstrumentSearch from "./components/InstrumentSearch";
import ProductTabs from "./components/ProductTabs";
import SiteFooter from "./components/SiteFooter";
import { parseMarketHistoryPayload } from "./api/marketHistory";
import {
  latestQuoteDate,
  parseMarketDataPayload,
  quotesForPolicy,
  type MarketDataPayload,
} from "./api/marketData";
import {
  calculateFixedHoldingsTrend,
  calculateKiwoomTradeFee,
  calculatePurchasePlan,
  calculateRebalancePreview,
  kiwoomFeeRateLabel,
  normalizeTicker,
  samplePortfolio,
  validateTargetWeights,
  type Holding,
  type HoldingPriceHistory,
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
  DEFAULT_PORTFOLIO_ID,
  loadLocalAppState,
  parseLocalAppState,
  PORTFOLIO_STORAGE_KEY,
  saveLocalAppState,
  upsertSnapshotForDate,
  type LocalAppState,
  type LocalStateSource,
  type PortfolioWorkspace,
} from "./storage/portfolioStorage";

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

const ALLOCATION_COLORS = ["#1d4ed8", "#2563eb", "#3b82f6", "#60a5fa", "#93c5fd"];

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
    activePortfolioId: DEFAULT_PORTFOLIO_ID,
    portfolios: [
      {
        id: DEFAULT_PORTFOLIO_ID,
        name: "나의 포트폴리오",
        portfolio: cloneSamplePortfolio(),
        snapshots: [],
        purchasePlanAmount: 0,
      },
    ],
    pricePolicy: "auto",
  };
}

function createPortfolioId() {
  const uuid = globalThis.crypto?.randomUUID?.();
  return uuid
    ? `portfolio-${uuid}`
    : `portfolio-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function formatPercent(value: number) {
  if (!Number.isFinite(value)) return "—";
  return `${value.toFixed(value < 10 && value % 1 !== 0 ? 1 : 0)}%`;
}

function formatSignedPercent(value: number) {
  if (!Number.isFinite(value)) return "—";
  return `${value > 0 ? "+" : ""}${value.toFixed(1)}%`;
}

function formatNativeAmount(value: number, country: "KR" | "US") {
  return country === "US" ? USD.format(value) : WON.format(value);
}

function formatSignedNativeAmount(value: number, country: "KR" | "US") {
  const formatted = formatNativeAmount(Math.abs(value), country);
  if (value > 0) return `+${formatted}`;
  if (value < 0) return `-${formatted}`;
  return formatted;
}

function actionLabel(action: "BUY" | "SELL" | "HOLD") {
  if (action === "BUY") return "매수";
  if (action === "SELL") return "매도";
  return "유지";
}

function holdingHistoryKey(country: "KR" | "US", ticker: string) {
  return `${country}:${normalizeTicker(ticker)}`;
}

interface AppProps {
  onOpenPortfolio?: () => void;
  onOpenPortfolioReport?: () => void;
  onOpenEtfCompare?: () => void;
}

function App({ onOpenPortfolio, onOpenPortfolioReport, onOpenEtfCompare }: AppProps) {
  const [initialLocalState] = useState(() =>
    loadLocalAppState(createDefaultLocalState()),
  );
  const [localAppState, setLocalAppState] = useState<LocalAppState>(
    initialLocalState.state,
  );
  const activeWorkspace =
    localAppState.portfolios.find(
      (workspace) => workspace.id === localAppState.activePortfolioId,
    ) ?? localAppState.portfolios[0]!;
  const portfolio = activeWorkspace.portfolio;
  const snapshots = activeWorkspace.snapshots;
  const purchasePlanAmount = activeWorkspace.purchasePlanAmount;
  const pricePolicy = localAppState.pricePolicy;

  const updateActiveWorkspace = (
    updater: (workspace: PortfolioWorkspace) => PortfolioWorkspace,
  ) => {
    setLocalAppState((current) => ({
      ...current,
      portfolios: current.portfolios.map((workspace) =>
        workspace.id === current.activePortfolioId
          ? updater(workspace)
          : workspace,
      ),
    }));
  };

  const setActivePortfolio = (updater: (current: Portfolio) => Portfolio) => {
    updateActiveWorkspace((workspace) => ({
      ...workspace,
      portfolio: updater(workspace.portfolio),
    }));
  };

  const setActiveSnapshots = (
    updater: (current: LocalAppState["portfolios"][number]["snapshots"]) =>
      LocalAppState["portfolios"][number]["snapshots"],
  ) => {
    updateActiveWorkspace((workspace) => ({
      ...workspace,
      snapshots: updater(workspace.snapshots),
    }));
  };
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
  const [marketHistories, setMarketHistories] = useState<
    Map<string, HoldingPriceHistory>
  >(new Map());
  const historyCacheRef = useRef(new Map<string, HoldingPriceHistory>());
  const [historyStatus, setHistoryStatus] = useState<
    "idle" | "loading" | "ready" | "partial"
  >("idle");

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
        const countryByTicker = new Map(
          payload.instruments.map((instrument) => [
            normalizeTicker(instrument.ticker),
            instrument.country,
          ]),
        );
        setInstruments(payload.instruments);
        setCatalogMeta(payload.meta);
        setCatalogStatus("ready");
        setLocalAppState((current) => ({
          ...current,
          portfolios: current.portfolios.map((workspace) => ({
            ...workspace,
            portfolio: {
              ...workspace.portfolio,
              holdings: workspace.portfolio.holdings.map((holding) => ({
                ...holding,
                country:
                  countryByTicker.get(normalizeTicker(holding.ticker)) ??
                  holding.country,
              })),
            },
          })),
        }));
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setCatalogStatus("fallback");
      });

    return () => controller.abort();
  }, []);

  const historyTargets = useMemo(() => {
    const targets = new Map<
      string,
      { country: "KR" | "US"; ticker: string }
    >();
    for (const holding of portfolio.holdings) {
      const ticker = normalizeTicker(holding.ticker);
      if (!ticker || holding.quantity <= 0) continue;
      targets.set(holdingHistoryKey(holding.country, ticker), {
        country: holding.country,
        ticker,
      });
    }
    return Array.from(targets.values()).sort((left, right) =>
      holdingHistoryKey(left.country, left.ticker).localeCompare(
        holdingHistoryKey(right.country, right.ticker),
      ),
    );
  }, [portfolio.holdings]);
  const historyRequestKey = historyTargets
    .map((target) => holdingHistoryKey(target.country, target.ticker))
    .join("|");

  useEffect(() => {
    const controller = new AbortController();
    if (historyTargets.length === 0) {
      setHistoryStatus("ready");
      return () => controller.abort();
    }

    const missingTargets = historyTargets.filter(
      ({ country, ticker }) =>
        !historyCacheRef.current.has(holdingHistoryKey(country, ticker)),
    );
    if (missingTargets.length === 0) {
      setMarketHistories(new Map(historyCacheRef.current));
      setHistoryStatus("ready");
      return () => controller.abort();
    }

    setHistoryStatus("loading");
    Promise.all(
      missingTargets.map(async ({ country, ticker }) => {
        try {
          const response = await fetch(
            `${import.meta.env.BASE_URL}api/market-data/history/${country}/${encodeURIComponent(ticker)}`,
            { headers: { accept: "application/json" }, signal: controller.signal },
          );
          if (!response.ok) return null;
          const payload = parseMarketHistoryPayload(await response.json());
          return [
            holdingHistoryKey(country, ticker),
            {
              ticker: payload.instrument.ticker,
              country: payload.instrument.country,
              prices: payload.prices,
            },
          ] as const;
        } catch (error) {
          if (error instanceof DOMException && error.name === "AbortError") {
            return null;
          }
          return null;
        }
      }),
    ).then((results) => {
      if (controller.signal.aborted) return;
      const available = results.filter(
        (result): result is NonNullable<typeof result> => result !== null,
      );
      for (const [key, history] of available) {
        historyCacheRef.current.set(key, history);
      }
      setMarketHistories(new Map(historyCacheRef.current));
      setHistoryStatus(
        historyTargets.every(({ country, ticker }) =>
          historyCacheRef.current.has(holdingHistoryKey(country, ticker)),
        )
          ? "ready"
          : "partial",
      );
    });

    return () => controller.abort();
  }, [historyRequestKey]);

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

  const baseValuations = useMemo(
    () =>
      portfolio.holdings.map((holding) => {
        const quote = quoteMap.get(normalizeTicker(holding.ticker));
        const marketValue = quote ? holding.quantity * quote.close : 0;
        const nativeClose = quote?.nativeClose ?? quote?.close;
        const purchaseNativeValue = holding.quantity * holding.averagePrice;
        const currentNativeValue = nativeClose
          ? holding.quantity * nativeClose
          : 0;
        const purchaseFee = calculateKiwoomTradeFee({
          country: holding.country,
          assetType: holding.assetType,
          action: "BUY",
          grossValue: purchaseNativeValue,
          quantity: holding.quantity,
        });
        const estimatedSellFee = calculateKiwoomTradeFee({
          country: holding.country,
          assetType: holding.assetType,
          action: "SELL",
          grossValue: currentNativeValue,
          quantity: holding.quantity,
        });
        const purchaseValue =
          holding.averagePrice > 0
            ? holding.country === "US"
              ? purchaseNativeValue * (quote?.fxRate ?? 0)
              : purchaseNativeValue
            : 0;
        const currencyMultiplier =
          holding.country === "US" ? (quote?.fxRate ?? 0) : 1;
        const purchaseFeeValue = purchaseFee.total * currencyMultiplier;
        const estimatedSellFeeValue =
          estimatedSellFee.total * currencyMultiplier;
        const profitNativeValue =
          nativeClose && holding.averagePrice > 0
            ? currentNativeValue -
              purchaseNativeValue -
              purchaseFee.total -
              estimatedSellFee.total
            : null;
        const profitRate =
          nativeClose && purchaseNativeValue > 0
            ? ((currentNativeValue -
                purchaseNativeValue -
                purchaseFee.total -
                estimatedSellFee.total) /
                (purchaseNativeValue + purchaseFee.total)) *
              100
            : null;
        return {
          holding,
          quote,
          marketValue,
          purchaseNativeValue,
          purchaseValue,
          purchaseFeeNativeValue: purchaseFee.total,
          estimatedSellFeeNativeValue: estimatedSellFee.total,
          purchaseFeeValue,
          estimatedSellFeeValue,
          profitNativeValue,
          profitRate,
        };
      }),
    [portfolio.holdings, quoteMap],
  );

  const investedValue = baseValuations.reduce(
    (sum, item) => sum + item.marketValue,
    0,
  );
  const purchaseValue = baseValuations.reduce(
    (sum, item) => sum + item.purchaseValue,
    0,
  );
  const purchaseFees = baseValuations.reduce(
    (sum, item) => sum + item.purchaseFeeValue,
    0,
  );
  const estimatedSellFees = baseValuations.reduce(
    (sum, item) => sum + item.estimatedSellFeeValue,
    0,
  );
  const missingAveragePriceTickers = portfolio.holdings
    .filter((holding) => holding.quantity > 0 && holding.averagePrice <= 0)
    .map((holding) => normalizeTicker(holding.ticker) || "미입력 종목");
  const purchaseDataComplete =
    missingAveragePriceTickers.length === 0 &&
    baseValuations.every(
      ({ holding, quote }) => holding.quantity === 0 || Boolean(quote),
    );
  const investmentDifference = purchaseDataComplete
    ? portfolio.totalAssets - purchaseValue
    : 0;
  const investmentShortfall = Math.max(0, -investmentDifference);
  const cash = purchaseDataComplete ? Math.max(0, investmentDifference) : 0;
  const currentTotalAssets = investedValue + cash;
  const totalProfit = purchaseDataComplete
    ? investedValue - purchaseValue - purchaseFees - estimatedSellFees
    : null;
  const cashWeight =
    currentTotalAssets > 0 ? (cash / currentTotalAssets) * 100 : 0;
  const valuations = baseValuations.map((item) => ({
    ...item,
    weight:
      currentTotalAssets > 0
        ? (item.marketValue / currentTotalAssets) * 100
        : 0,
  }));
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

  const purchasePlan = useMemo(() => {
    if (
      purchasePlanAmount <= 0 ||
      !targetValidation.valid ||
      duplicateTickers.size > 0 ||
      missingPriceTickers.length > 0 ||
      portfolio.holdings.length === 0
    ) {
      return null;
    }
    try {
      return calculatePurchasePlan(portfolio, heldQuotes, purchasePlanAmount);
    } catch {
      return null;
    }
  }, [heldQuotes, portfolio, purchasePlanAmount]);
  const purchasePlanByTicker = useMemo(
    () =>
      new Map(
        purchasePlan?.items.map((item) => [normalizeTicker(item.ticker), item]) ?? [],
      ),
    [purchasePlan],
  );

  const canRebalance =
    currentTotalAssets > 0 &&
    investmentShortfall === 0 &&
    purchaseDataComplete &&
    targetValidation.valid &&
    duplicateTickers.size === 0 &&
    missingPriceTickers.length === 0 &&
    portfolio.holdings.length > 0;

  const historicalTrend = useMemo(
    () =>
      purchaseDataComplete
        ? calculateFixedHoldingsTrend(
            portfolio.holdings,
            marketHistories,
            marketData?.fx.usdKrw.closes ?? [],
            cash,
          )
        : [],
    [
      cash,
      marketData,
      marketHistories,
      portfolio.holdings,
      purchaseDataComplete,
    ],
  );
  const chartData = historicalTrend.length > 0 ? historicalTrend : snapshots;

  useEffect(() => {
    if (
      marketStatus !== "ready" ||
      !purchaseDataComplete ||
      !priceDate ||
      currentTotalAssets < 0
    ) {
      return;
    }

    setActiveSnapshots((current) => {
      const next = upsertSnapshotForDate(
        current,
        currentTotalAssets,
        priceDate,
      );
      if (
        next.length === current.length &&
        next.every(
          (snapshot, index) =>
            snapshot.date === current[index]?.date &&
            snapshot.totalValue === current[index]?.totalValue,
        )
      ) {
        return current;
      }
      return next;
    });
  }, [currentTotalAssets, marketStatus, priceDate, purchaseDataComplete]);

  useEffect(() => {
    if (skipNextSave.current) {
      skipNextSave.current = false;
      return;
    }

    const saved = saveLocalAppState(localAppState);
    setStorageSource(saved ? "saved" : "unavailable");
  }, [localAppState]);

  useEffect(() => {
    const handleStorageChange = (event: StorageEvent) => {
      if (event.key !== PORTFOLIO_STORAGE_KEY) return;

      const nextState =
        event.newValue === null
          ? createDefaultLocalState()
          : parseLocalAppState(event.newValue);
      if (!nextState) return;

      skipNextSave.current = true;
      setLocalAppState(nextState);
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
      label:
        item.holding.country === "KR"
          ? item.holding.name.trim() ||
            normalizeTicker(item.holding.ticker) ||
            "새 종목"
          : normalizeTicker(item.holding.ticker) || item.holding.name.trim() || "새 종목",
      value: Math.max(0, item.weight),
      color: ALLOCATION_COLORS[index % ALLOCATION_COLORS.length],
    })),
    {
      key: "cash",
      label: "현금",
      value: Math.max(0, cashWeight),
      color: "#cbd5e1",
    },
  ];

  const clearResult = () => {
    setPreview(null);
    setCalculationMessage("");
  };

  const updatePortfolio = (updater: (current: Portfolio) => Portfolio) => {
    setActivePortfolio(updater);
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

  const updateInvestmentAmount = (totalAssets: number) => {
    updatePortfolio((current) => ({
      ...current,
      totalAssets,
    }));
  };

  const updatePurchasePlanAmount = (amount: number) => {
    updateActiveWorkspace((workspace) => ({
      ...workspace,
      purchasePlanAmount: amount,
    }));
  };

  const renameActivePortfolio = (name: string) => {
    updateActiveWorkspace((workspace) => ({ ...workspace, name: name.slice(0, 40) }));
  };

  const selectPortfolio = (id: string) => {
    if (id === localAppState.activePortfolioId) return;
    setLocalAppState((current) => ({ ...current, activePortfolioId: id }));
    clearResult();
    setStorageMessage("");
  };

  const addPortfolio = () => {
    if (localAppState.portfolios.length >= 20) {
      setStorageMessage("포트폴리오 화면은 최대 20개까지 만들 수 있습니다.");
      return;
    }
    const id = createPortfolioId();
    const workspace: PortfolioWorkspace = {
      id,
      name: `새 포트폴리오 ${localAppState.portfolios.length + 1}`,
      portfolio: { totalAssets: 0, targetCashWeight: 100, holdings: [] },
      snapshots: [],
      purchasePlanAmount: 0,
    };
    setLocalAppState((current) => ({
      ...current,
      activePortfolioId: id,
      portfolios: [...current.portfolios, workspace],
    }));
    clearResult();
    setStorageMessage("새 포트폴리오 화면을 만들었습니다.");
  };

  const removePortfolio = (id: string) => {
    if (localAppState.portfolios.length <= 1) return;
    const target = localAppState.portfolios.find((workspace) => workspace.id === id);
    if (!target) return;
    if (!window.confirm(`${target.name.trim() || "이름 없는 포트폴리오"} 화면을 삭제할까요?`)) {
      return;
    }
    setLocalAppState((current) => {
      const portfolios = current.portfolios.filter((workspace) => workspace.id !== id);
      return {
        ...current,
        portfolios,
        activePortfolioId:
          current.activePortfolioId === id
            ? (portfolios[0]?.id ?? DEFAULT_PORTFOLIO_ID)
            : current.activePortfolioId,
      };
    });
    clearResult();
    setStorageMessage("포트폴리오 화면을 삭제했습니다.");
  };

  const handleInstrumentSelect = (index: number, instrument: Instrument) => {
    updateHolding(index, {
      ticker: instrument.ticker,
      name: instrument.name,
      assetType: instrument.assetType,
      country: instrument.country,
      averagePrice: 0,
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
          country: nextInstrument.country,
          quantity: 0,
          averagePrice: 0,
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
      setPreview(
        calculateRebalancePreview(
          { ...portfolio, totalAssets: currentTotalAssets },
          heldQuotes,
        ),
      );
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
      "이 브라우저에 저장된 보유 종목, 수량, 평단가, 총 투자금, 목표 비중과 자산 이력을 삭제할까요?",
    );
    if (!confirmed) return;

    skipNextSave.current = true;
    const defaults = createDefaultLocalState();
    const deleted = deleteLocalAppState();
    setLocalAppState(defaults);
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
          {onOpenPortfolio && onOpenPortfolioReport && onOpenEtfCompare ? (
            <ProductTabs
              current="portfolio"
              onOpenPortfolio={onOpenPortfolio}
              onOpenPortfolioReport={onOpenPortfolioReport}
              onOpenEtfCompare={onOpenEtfCompare}
            />
          ) : null}
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

      <div className="portfolio-layout">
        <aside className="portfolio-sidebar" aria-label="포트폴리오 화면 목록">
          <div className="portfolio-sidebar__header">
            <div>
              <span>MY SCREENS</span>
              <strong>포트폴리오</strong>
            </div>
            <button
              type="button"
              aria-label="새 포트폴리오 추가"
              onClick={addPortfolio}
            >
              <Plus size={16} />
            </button>
          </div>
          <nav>
            {localAppState.portfolios.map((workspace) => {
              const displayName = workspace.name.trim() || "이름 없는 포트폴리오";
              const isActive = workspace.id === localAppState.activePortfolioId;
              return (
                <div className="portfolio-sidebar__item" key={workspace.id}>
                  <button
                    className={isActive ? "is-active" : ""}
                    type="button"
                    aria-label={`${displayName} 화면 열기`}
                    aria-current={isActive ? "page" : undefined}
                    onClick={() => selectPortfolio(workspace.id)}
                  >
                    <WalletCards size={15} />
                    <span>
                      <strong>{displayName}</strong>
                      <small>{NUMBER.format(workspace.portfolio.holdings.length)}개 종목</small>
                    </span>
                  </button>
                  {localAppState.portfolios.length > 1 && (
                    <button
                      className="portfolio-sidebar__delete"
                      type="button"
                      aria-label={`${displayName} 삭제`}
                      onClick={() => removePortfolio(workspace.id)}
                    >
                      <Trash2 size={13} />
                    </button>
                  )}
                </div>
              );
            })}
          </nav>
          <p>화면별 보유자산과 목표비중은 이 브라우저에 따로 저장됩니다.</p>
        </aside>

        <div className="portfolio-page">
          <main className="dashboard" id="top">
        <div className="intro-row">
          <div>
            <label className="portfolio-name-field">
              <span className="sr-only">포트폴리오 이름</span>
              <input
                aria-label="포트폴리오 이름"
                value={activeWorkspace.name}
                maxLength={40}
                onChange={(event) => renameActivePortfolio(event.target.value)}
                onBlur={() => {
                  if (!activeWorkspace.name.trim()) renameActivePortfolio("나의 포트폴리오");
                }}
              />
              <small>눌러서 이름 편집</small>
            </label>
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
            <div className="summary-amount">{WON.format(currentTotalAssets)}</div>
            <p className="summary-note">
              {purchaseDataComplete
                ? "보유자산의 종가 평가액과 총 투자금 중 남은 현금을 합산했습니다."
                : missingAveragePriceTickers.length > 0
                  ? "모든 보유 종목의 평단가를 입력하면 남은 현금까지 합산됩니다."
                  : "보유 종목의 종가가 연결되면 남은 현금까지 합산됩니다."}
            </p>

            <div className="summary-stats">
              <div className="summary-stat">
                <span>투자금</span>
                <strong>{WON.format(purchaseValue + purchaseFees)}</strong>
              </div>
              <div className="summary-stat">
                <span>평가손익</span>
                <strong
                  className={
                    totalProfit === null
                      ? ""
                      : totalProfit > 0
                        ? "positive"
                        : totalProfit < 0
                          ? "negative"
                          : ""
                  }
                >
                  {totalProfit === null
                    ? "—"
                    : `${totalProfit > 0 ? "+" : ""}${WON.format(totalProfit)}`}
                </strong>
              </div>
              <div className="summary-stat">
                <span>가용 현금</span>
                <strong className={cash < 0 ? "negative" : ""}>
                  {purchaseDataComplete ? WON.format(cash) : "—"}
                </strong>
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
            <div
              className="allocation-legend"
              role="list"
              aria-label="현재 자산 구성 범례"
            >
              {allocationItems.slice(0, 5).map((item) => (
                <div key={item.key} role="listitem">
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

            <div className="purchase-planner" aria-label="신규 투자금 매수 계산">
              <label>
                <span>
                  <strong>투자금액</strong>
                  <small>목표 비중별 신규 매수 계산</small>
                </span>
                <div className="amount-input">
                  <input
                    aria-label="목표 매수 투자금액"
                    type="number"
                    min="0"
                    step="100000"
                    inputMode="numeric"
                    value={purchasePlanAmount || ""}
                    placeholder="투자할 금액 입력"
                    onChange={(event) =>
                      updatePurchasePlanAmount(
                        Math.max(0, Number(event.target.value) || 0),
                      )
                    }
                  />
                  <span>원</span>
                </div>
              </label>
              <div className="purchase-planner__summary">
                {purchasePlan ? (
                  <>
                    <span>
                      예상 매수금액 <strong>{WON.format(purchasePlan.totalPurchaseValue)}</strong>
                    </span>
                    <span>
                      매수 수수료 <strong>{WON.format(purchasePlan.estimatedFees)}</strong>
                    </span>
                    <span>
                      매수 후 잔액 <strong>{WON.format(purchasePlan.remainingCash)}</strong>
                    </span>
                  </>
                ) : (
                  <p>
                    {purchasePlanAmount <= 0
                      ? "금액을 입력하면 종가와 목표 비중에 맞는 매수 수량을 표시합니다."
                      : !targetValidation.valid
                        ? "현금과 종목의 목표 비중 합계를 100%로 맞춰 주세요."
                        : missingPriceTickers.length > 0
                          ? "모든 종목의 종가가 연결되어야 매수 수량을 계산할 수 있습니다."
                          : "보유 종목을 추가하면 예상 매수 수량을 계산합니다."}
                  </p>
                )}
              </div>
            </div>

            <div className="holdings-table">
              <div className="holdings-head" aria-hidden="true">
                <span>TICKER / NAME</span>
                <span>보유수</span>
                <span>평단가</span>
                <span>거래비용</span>
                <span>매수금액</span>
                <span>종가</span>
                <span>현재금액</span>
                <span>수익률</span>
                <span>목표 비중</span>
                <span>예상 매수</span>
                <span />
              </div>

              {valuations.map(
                (
                  {
                    holding,
                    quote,
                    marketValue,
                    purchaseNativeValue,
                    purchaseValue: holdingPurchaseValue,
                    purchaseFeeNativeValue,
                    estimatedSellFeeNativeValue,
                    profitNativeValue,
                    weight,
                    profitRate,
                  },
                  index,
                ) => {
                  const ticker = normalizeTicker(holding.ticker);
                  const isDuplicate = duplicateTickers.has(ticker);
                  const averagePriceCountry = quote?.country ?? holding.country;
                  const purchasePlanItem = purchasePlanByTicker.get(ticker);
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

                    <label className="table-field" data-label="평단가">
                      <span className="sr-only">평균 매수가</span>
                      <input
                        aria-label={`${ticker || index + 1} 평균 매수가`}
                        type="number"
                        min="0"
                        step={averagePriceCountry === "US" ? "0.01" : "1"}
                        inputMode="decimal"
                        value={holding.averagePrice || ""}
                        placeholder="미입력"
                        onChange={(event) =>
                          updateHolding(index, {
                            averagePrice: Math.max(
                              0,
                              Number(event.target.value) || 0,
                            ),
                          })
                        }
                      />
                      <small>{averagePriceCountry === "US" ? "$" : "원"}</small>
                    </label>

                    <div className="table-value" data-label="자동 거래비용">
                      <strong>
                        {quote && holding.averagePrice > 0
                          ? formatNativeAmount(
                              purchaseFeeNativeValue +
                                estimatedSellFeeNativeValue,
                              averagePriceCountry,
                            )
                          : "—"}
                      </strong>
                      <small>
                        {quote
                          ? kiwoomFeeRateLabel(
                              averagePriceCountry,
                              holding.assetType,
                            )
                          : "종가 연결 필요"}
                      </small>
                    </div>

                    <div className="table-value" data-label="매수금액">
                      <strong>
                        {holding.averagePrice > 0
                          ? formatNativeAmount(
                              purchaseNativeValue,
                              averagePriceCountry,
                            )
                          : "평단 입력"}
                      </strong>
                      <small>
                        {holding.averagePrice > 0
                          ? averagePriceCountry === "US" && quote
                            ? `${WON.format(holdingPurchaseValue)} 환산`
                            : WON.format(holdingPurchaseValue)
                          : "보유수 × 평단가"}
                      </small>
                    </div>

                    <div className="table-value" data-label="종가">
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

                    <div className="table-value" data-label="현재금액">
                      <strong>{quote ? COMPACT_WON.format(marketValue) : "—"}</strong>
                      <small>
                        {quote
                          ? `${WON.format(marketValue)} · ${formatPercent(weight)}`
                          : "계산 불가"}
                      </small>
                    </div>

                    <div className="table-value profit-value" data-label="수익률">
                      <strong
                        className={
                          profitRate === null
                            ? ""
                            : profitRate > 0
                              ? "profit-positive"
                              : profitRate < 0
                                ? "profit-negative"
                                : ""
                        }
                      >
                        {profitRate === null ? "—" : formatSignedPercent(profitRate)}
                      </strong>
                      <small
                        className={
                          profitNativeValue === null
                            ? ""
                            : profitNativeValue > 0
                              ? "profit-positive"
                              : profitNativeValue < 0
                                ? "profit-negative"
                                : ""
                        }
                      >
                        {profitNativeValue === null
                          ? "평단가 필요"
                          : formatSignedNativeAmount(
                              profitNativeValue,
                              averagePriceCountry,
                            )}
                      </small>
                    </div>

                    <label className="target-field" data-label="목표 비중">
                      <span className="sr-only">목표 비중</span>
                      <input
                        aria-label={`${ticker || index + 1} 목표 비중`}
                        type="number"
                        min="0"
                        max="100"
                        step="1"
                        value={holding.targetWeight}
                        onChange={(event) =>
                          updateHolding(index, {
                            targetWeight: Number(event.target.value) || 0,
                          })
                        }
                      />
                      <small>%</small>
                    </label>

                    <div className="table-value planned-buy" data-label="예상 매수">
                      <strong>
                        {purchasePlanItem
                          ? `${NUMBER.format(purchasePlanItem.quantity)}주`
                          : "—"}
                      </strong>
                      <small>
                        {purchasePlanItem
                          ? `${WON.format(purchasePlanItem.totalCost)} · ${formatPercent(
                              purchasePlanItem.targetWeight,
                            )}`
                          : purchasePlanAmount > 0
                            ? "계산 조건 확인"
                            : "금액 입력 필요"}
                      </small>
                    </div>

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
                },
              )}
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
                  ? `${marketMessage} 미국 종목의 종가와 매수금액은 선택한 종가일의 USD/KRW 환율로 원화 환산합니다.`
                  : marketMessage}
              </div>
              <div className="panel-footnote panel-footnote--secondary">
                <Info size={14} />
                키움 일반 온라인 기준을 자동 적용합니다. 국내 ETF의 상품별 배당소득세와
                이벤트·협의·NXT 수수료는 포함하지 않습니다.
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

            <label className="setting-field">
              <span>
                <span>총 투자금</span>
                <small>미투자 현금 포함</small>
              </span>
              <div className="amount-input">
                <input
                  aria-label="총 투자금"
                  type="number"
                  min="0"
                  step="100000"
                  inputMode="numeric"
                  value={portfolio.totalAssets}
                  onChange={(event) =>
                    updateInvestmentAmount(
                      Math.max(0, Number(event.target.value) || 0),
                    )
                  }
                />
                <span>원</span>
              </div>
              <small className="formatted-value">{WON.format(portfolio.totalAssets)}</small>
              <small className="setting-help">
                매수금액 {WON.format(purchaseValue)}을 제외한 금액만 현금으로 계산하며,
                수수료는 평가손익에 반영합니다.
              </small>
            </label>

            <div className="setting-field">
              <span>
                <span>가격 기준</span>
                <small>자동 선택</small>
              </span>
              <div className="price-policy-auto">
                <CalendarDays size={16} />
                <div>
                  <strong>당일 종가 우선</strong>
                  <small>당일 데이터가 없으면 가장 최근 전일 종가를 사용합니다.</small>
                </div>
              </div>
            </div>

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

            <div className="rebalance-basis">
              <WalletCards size={18} />
              <div>
                <strong>리밸런싱 기준 현재 자산</strong>
                <p>
                  {WON.format(currentTotalAssets)}을 목표 비중에 맞춰 종목별 매수·매도
                  수량으로 계산합니다.
                </p>
              </div>
            </div>

              {investmentShortfall > 0 && (
              <div className="inline-alert">
                <AlertCircle size={15} />
                매수금액 합계가 총 투자금보다 {WON.format(investmentShortfall)} 큽니다.
              </div>
            )}
            {missingAveragePriceTickers.length > 0 && (
              <div className="inline-alert">
                <AlertCircle size={15} />
                {missingAveragePriceTickers.join(", ")}의 평단가를 입력해 주세요.
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
                {missingPriceTickers.join(", ")}의 선택한 종가가 없습니다.
              </div>
            )}

            <button
              className="primary-button"
              type="button"
              disabled={!canRebalance}
              onClick={calculatePreview}
            >
              <Calculator size={18} />
              매수·매도 수량 계산
              <ArrowRight size={17} />
            </button>

            <p className="estimate-note">
              키움 일반 온라인 수수료와 매도 제비용을 반영한 정수 주식 기준
              예상치입니다. 실제 주문은 실행되지 않습니다.
            </p>
            <div className="privacy-inline">
              <LockKeyhole size={15} />
              <span>
                최신 종가 묶음과 종목별 공개 과거 종가만 내려받습니다. 수량·평단가·투자금은
                서버나 R2로 전송하지 않습니다.
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
                <small>
                  거래비용 {WON.format(preview.projectedTransactionFees)} 반영 ·{" "}
                  {formatPercent(preview.projectedCashWeight)}
                </small>
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
                    <small>비용 {WON.format(item.estimatedTradeFee)}</small>
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
            {historicalTrend.length > 0
              ? `현재 보유수량과 현금을 고정해 R2 과거 종가 ${NUMBER.format(
                  historicalTrend.length,
                )}개 기준일을 재계산했습니다.`
              : historyStatus === "loading"
                ? "R2에서 보유 종목의 과거 종가를 불러오는 중입니다."
                : "과거 종가가 없는 종목은 브라우저에 기록된 실제 종가일 이력을 사용합니다."}
          </div>
        </div>

        <section className="security-banner" aria-label="데이터 안내">
          <span className="security-icon">
            <ShieldCheck size={22} />
          </span>
          <div>
            <strong>당신의 자산 정보는 현재 브라우저 기기에만 머뭅니다.</strong>
            <p>
              보유 종목·수량·평단가·목표 비중·총 투자금과 자산 이력은 브라우저 로컬 저장소에
              보관되어 재방문 시 복구됩니다. 화면은 R2의 전체 최신 종가 묶음과 보유
              Ticker의 공개 과거 종가를 내려받아 현재 브라우저 안에서 평가합니다.
              과거 종가 요청에는 국가와 Ticker만 포함되며 수량·평단가·목표 비중·투자금은
              서버와 R2에 전송하지 않습니다. 같은 브라우저 프로필을 쓰는 사람은 저장값을
              볼 수 있으며 브라우저 데이터 삭제 시 함께 사라집니다.
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

          <SiteFooter
            className="portfolio-footer"
            note="R2의 공개 종가와 브라우저 로컬 전용 자산 정보를 사용하는 포트폴리오 도구"
          />
        </div>
      </div>
    </div>
  );
}

export default App;
