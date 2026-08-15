import { calculateHoldingOverlap, calculateLookthroughExposure, scoreEtfQuality } from "./etfAnalytics";
import type {
  EtfResearchProfile,
  EtfSleeve,
  PortfolioCandidate,
  PortfolioCandidateItem,
  PortfolioGenerationResult,
  PortfolioGeneratorConfig,
} from "./etfResearchTypes";

interface CombinationEvaluation {
  profiles: EtfResearchProfile[];
  balancedScore: number;
  weightedExpense: number | null;
  weightedOverlap: number | null;
  overlapConfidence: PortfolioCandidate["overlapConfidence"];
  dataReliability: number;
  warnings: string[];
}

function finite(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function combinations<T>(groups: readonly (readonly T[])[]): T[][] {
  if (groups.length === 0) return [];
  return groups.reduce<T[][]>(
    (results, group) => results.flatMap((result) => group.map((item) => [...result, item])),
    [[]],
  );
}

function candidateKey(profiles: readonly EtfResearchProfile[]): string {
  return profiles.map((profile) => profile.ticker).sort().join("|");
}

function weightForSleeve(sleeves: readonly EtfSleeve[], strategyKey: string): number {
  return sleeves.find((sleeve) => sleeve.strategyKey === strategyKey)?.targetWeightPercent ?? 0;
}

function evaluateCombination(
  profiles: EtfResearchProfile[],
  config: PortfolioGeneratorConfig,
  qualityScores: ReturnType<typeof scoreEtfQuality>,
): CombinationEvaluation | null {
  const weights = profiles.map((profile) => weightForSleeve(config.sleeves, profile.strategyKey));
  if (weights.some((weight) => weight > config.maxEtfWeightPercent)) return null;

  let pairWeightTotal = 0;
  let overlapWeightedTotal = 0;
  let measuredPairWeight = 0;
  let exactPairWeight = 0;
  let partialPairWeight = 0;
  const warnings: string[] = [];

  for (let leftIndex = 0; leftIndex < profiles.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < profiles.length; rightIndex += 1) {
      const left = profiles[leftIndex];
      const right = profiles[rightIndex];
      const pairWeight = weights[leftIndex] * weights[rightIndex];
      pairWeightTotal += pairWeight;
      const overlap = calculateHoldingOverlap(left, right);
      let overlapValue = overlap.overlapPercent;
      let confidence = overlap.confidence;

      if (left.strategyKey === right.strategyKey) {
        overlapValue = 100;
        confidence = "exact";
      } else if (overlapValue === null && left.assetClass === right.assetClass) {
        overlapValue = 35;
        confidence = "partial";
        warnings.push(`${left.name}와 ${right.name}은 구성종목 대신 자산 노출 유사도로 평가했습니다.`);
      }

      if (overlapValue !== null) {
        overlapWeightedTotal += pairWeight * overlapValue;
        measuredPairWeight += pairWeight;
        if (confidence === "exact") exactPairWeight += pairWeight;
        else partialPairWeight += pairWeight;
        if (confidence === "exact" && overlapValue > config.maxPairOverlapPercent) return null;
        if (confidence === "partial" && overlapValue > config.maxPairOverlapPercent) {
          warnings.push(
            `${left.name}와 ${right.name}의 부분 구성정보 중복도가 ${overlapValue.toFixed(1)}%입니다.`,
          );
        }
      }
    }
  }

  const weightedOverlap = measuredPairWeight > 0 ? overlapWeightedTotal / measuredPairWeight : null;
  const overlapConfidence: PortfolioCandidate["overlapConfidence"] =
    measuredPairWeight === 0
      ? "exposure-only"
      : exactPairWeight >= pairWeightTotal * 0.8
        ? "exact"
        : partialPairWeight > 0
          ? "partial"
          : "exposure-only";

  let weightedExpense = 0;
  let expenseWeight = 0;
  let weightedQuality = 0;
  let reliability = 0;
  const totalEtfWeight = weights.reduce((sum, value) => sum + value, 0);
  for (let index = 0; index < profiles.length; index += 1) {
    const profile = profiles[index];
    const normalizedWeight = totalEtfWeight > 0 ? weights[index] / totalEtfWeight : 0;
    weightedQuality += (qualityScores.get(profile.ticker)?.total ?? 0) * normalizedWeight;
    reliability +=
      (profile.dataGrade === "A" ? 100 : profile.dataGrade === "B" ? 70 : 35) * normalizedWeight;
    if (finite(profile.expenseRatioPercent)) {
      weightedExpense += profile.expenseRatioPercent * normalizedWeight;
      expenseWeight += normalizedWeight;
    }
  }
  const normalizedExpense = expenseWeight >= 0.8 ? weightedExpense / expenseWeight : null;
  const diversification = weightedOverlap === null ? 50 : Math.max(0, 100 - weightedOverlap);
  const balancedScore = weightedQuality * 0.45 + diversification * 0.35 + reliability * 0.2;
  return {
    profiles,
    balancedScore,
    weightedExpense: normalizedExpense,
    weightedOverlap,
    overlapConfidence,
    dataReliability: reliability,
    warnings: [...new Set(warnings)],
  };
}

function allocationItems(
  evaluation: CombinationEvaluation,
  config: PortfolioGeneratorConfig,
  qualityScores: ReturnType<typeof scoreEtfQuality>,
) {
  const items: PortfolioCandidateItem[] = evaluation.profiles.map((profile) => {
    const sleeve = config.sleeves.find((candidate) => candidate.strategyKey === profile.strategyKey)!;
    const targetAmount =
      config.investmentAmountKrw > 0
        ? (config.investmentAmountKrw * sleeve.targetWeightPercent) / 100
        : null;
    const quantity =
      targetAmount !== null && finite(profile.metrics.latestPrice) && profile.metrics.latestPrice > 0
        ? Math.floor(targetAmount / profile.metrics.latestPrice)
        : null;
    const score = qualityScores.get(profile.ticker);
    const reasons: string[] = [];
    if ((score?.parts.liquidity ?? 0) >= 70) reasons.push("동일 노출군에서 유동성이 높음");
    if ((score?.parts.cost ?? 0) >= 70) reasons.push("동일 노출군에서 비용이 낮음");
    if ((score?.parts.navStability ?? 0) >= 70) reasons.push("가격과 NAV의 괴리가 안정적임");
    if (reasons.length === 0) reasons.push("설정한 필터와 데이터 완성도 기준을 통과함");
    return {
      ticker: profile.ticker,
      name: profile.name,
      sleeveId: sleeve.id,
      sleeveLabel: sleeve.label,
      targetWeightPercent: sleeve.targetWeightPercent,
      qualityScore: score?.total ?? 0,
      expectedQuantity: quantity,
      expectedAmountKrw:
        quantity !== null && finite(profile.metrics.latestPrice)
          ? quantity * profile.metrics.latestPrice
          : null,
      reasons,
    };
  });

  let remainingCash: number | null = null;
  if (config.investmentAmountKrw > 0 && items.every((item) => item.expectedAmountKrw !== null)) {
    const etfBudget =
      (config.investmentAmountKrw *
        config.sleeves.reduce((sum, sleeve) => sum + sleeve.targetWeightPercent, 0)) /
      100;
    remainingCash = Math.max(
      0,
      etfBudget - items.reduce((sum, item) => sum + (item.expectedAmountKrw ?? 0), 0),
    );
  }
  return { items, remainingCash };
}

function toCandidate(
  kind: PortfolioCandidate["kind"],
  evaluation: CombinationEvaluation,
  config: PortfolioGeneratorConfig,
  qualityScores: ReturnType<typeof scoreEtfQuality>,
): PortfolioCandidate {
  const { items, remainingCash } = allocationItems(evaluation, config, qualityScores);
  const label =
    kind === "balanced" ? "균형 후보" : kind === "low-cost" ? "저비용 후보" : "저중복 후보";
  const topCompanyExposures = calculateLookthroughExposure(
    evaluation.profiles.map((profile) => ({
      profile,
      weightPercent: weightForSleeve(config.sleeves, profile.strategyKey),
    })),
    config.fixedStocks,
  );
  const warnings = [...evaluation.warnings];
  if (evaluation.overlapConfidence !== "exact") {
    warnings.push("전체 구성종목이 아닌 부분 구성정보 또는 자산 노출 기준이 포함되었습니다.");
  }
  if (evaluation.weightedExpense === null) {
    warnings.push("일부 ETF의 총보수 정보가 없어 가중평균 비용을 계산하지 못했습니다.");
  }
  return {
    kind,
    label,
    score: evaluation.balancedScore,
    items,
    weightedExpenseRatioPercent: evaluation.weightedExpense,
    weightedOverlapPercent: evaluation.weightedOverlap,
    overlapConfidence: evaluation.overlapConfidence,
    dataReliabilityScore: evaluation.dataReliability,
    remainingCashKrw: remainingCash,
    topCompanyExposures,
    warnings: [...new Set(warnings)],
  };
}

export function generatePortfolioCandidates(
  profiles: readonly EtfResearchProfile[],
  config: PortfolioGeneratorConfig,
): PortfolioGenerationResult {
  const errors: string[] = [];
  const exclusions: Array<{ ticker: string; reason: string }> = [];
  const totalSleeveWeight = config.sleeves.reduce(
    (sum, sleeve) => sum + sleeve.targetWeightPercent,
    0,
  );
  const fixedWeight = config.fixedStocks.reduce((sum, stock) => sum + stock.weightPercent, 0);
  if (config.sleeves.length === 0) errors.push("자산군을 하나 이상 선택해야 합니다.");
  if (Math.abs(totalSleeveWeight + fixedWeight - 100) > 0.01) {
    errors.push("ETF 자산군과 직접 보유 주식 비중의 합계가 100%여야 합니다.");
  }
  if (config.sleeves.length > config.maxEtfs) {
    errors.push("최대 ETF 개수는 선택한 자산군 수보다 작을 수 없습니다.");
  }
  if (new Set(config.sleeves.map((sleeve) => sleeve.strategyKey)).size !== config.sleeves.length) {
    errors.push("같은 자산군 노출이 두 번 선택되었습니다.");
  }
  if (errors.length > 0) {
    return { candidates: [], evaluatedCombinationCount: 0, rejectedCombinationCount: 0, errors, exclusions };
  }

  const qualityScores = scoreEtfQuality(profiles);
  const candidateGroups = config.sleeves.map((sleeve) =>
    profiles
      .filter((profile) => profile.strategyKey === sleeve.strategyKey)
      .filter((profile) => {
        const reasons: string[] = [];
        if (profile.usage !== "GENERATOR_ELIGIBLE") reasons.push(profile.exclusionReasons[0] ?? "생성 대상 아님");
        if (
          profile.metrics.averageTradingValue20dKrw !== null &&
          profile.metrics.averageTradingValue20dKrw < config.minimumTradingValue20dKrw
        ) {
          reasons.push("최소 거래대금 미달");
        }
        if (
          config.maximumExpenseRatioPercent !== null &&
          profile.expenseRatioPercent !== null &&
          profile.expenseRatioPercent > config.maximumExpenseRatioPercent
        ) {
          reasons.push("총보수 상한 초과");
        }
        if (
          config.hedgePreference !== "any" &&
          profile.hedgeType !== "not-applicable" &&
          profile.hedgeType !== config.hedgePreference
        ) {
          reasons.push("환헤지 조건 불일치");
        }
        for (const reason of reasons) exclusions.push({ ticker: profile.ticker, reason });
        return reasons.length === 0;
      })
      .sort(
        (left, right) =>
          (qualityScores.get(right.ticker)?.total ?? 0) -
          (qualityScores.get(left.ticker)?.total ?? 0),
      )
      .slice(0, 3),
  );

  candidateGroups.forEach((group, index) => {
    if (group.length === 0) errors.push(`${config.sleeves[index].label} 조건을 만족하는 ETF가 없습니다.`);
  });
  if (errors.length > 0) {
    return { candidates: [], evaluatedCombinationCount: 0, rejectedCombinationCount: 0, errors, exclusions };
  }

  const allCombinations = combinations(candidateGroups);
  const evaluations = allCombinations.flatMap((combination) => {
    const evaluation = evaluateCombination(combination, config, qualityScores);
    return evaluation ? [evaluation] : [];
  });
  if (evaluations.length === 0) {
    return {
      candidates: [],
      evaluatedCombinationCount: allCombinations.length,
      rejectedCombinationCount: allCombinations.length,
      errors: ["현재 조건을 모두 만족하는 ETF 조합이 없습니다. 중복도나 필터 조건을 완화해 주세요."],
      exclusions,
    };
  }

  const picked = new Set<string>();
  const choose = (
    kind: PortfolioCandidate["kind"],
    sorted: CombinationEvaluation[],
  ): PortfolioCandidate | null => {
    const selected = sorted.find((evaluation) => !picked.has(candidateKey(evaluation.profiles)));
    if (!selected) return null;
    picked.add(candidateKey(selected.profiles));
    return toCandidate(kind, selected, config, qualityScores);
  };
  const candidates: PortfolioCandidate[] = [];
  const balanced = choose(
    "balanced",
    [...evaluations].sort((a, b) => b.balancedScore - a.balancedScore),
  );
  if (balanced) candidates.push(balanced);
  const lowCost = choose(
    "low-cost",
    [...evaluations]
      .filter((evaluation) => evaluation.weightedExpense !== null)
      .sort(
        (a, b) =>
          (a.weightedExpense ?? Number.POSITIVE_INFINITY) -
            (b.weightedExpense ?? Number.POSITIVE_INFINITY) ||
          b.balancedScore - a.balancedScore,
      ),
  );
  if (lowCost) candidates.push(lowCost);
  else candidates.push(toCandidate("low-cost", evaluations[0], config, qualityScores));
  const lowOverlap = choose(
    "low-overlap",
    [...evaluations].sort(
      (a, b) =>
        (a.weightedOverlap ?? 100) - (b.weightedOverlap ?? 100) ||
        b.balancedScore - a.balancedScore,
    ),
  );
  if (lowOverlap) candidates.push(lowOverlap);
  else candidates.push(toCandidate("low-overlap", evaluations[0], config, qualityScores));

  return {
    candidates,
    evaluatedCombinationCount: allCombinations.length,
    rejectedCombinationCount: allCombinations.length - evaluations.length,
    errors: [],
    exclusions: [...new Map(exclusions.map((item) => [`${item.ticker}:${item.reason}`, item])).values()],
  };
}

export const PORTFOLIO_PRESETS: Record<
  "defensive" | "balanced" | "growth",
  { label: string; sleeves: EtfSleeve[] }
> = {
  defensive: {
    label: "방어형 예시",
    sleeves: [
      { id: "kr", label: "국내 대형주", strategyKey: "KR_LARGE", targetWeightPercent: 10 },
      { id: "us", label: "미국 대형주", strategyKey: "US_LARGE", targetWeightPercent: 20 },
      { id: "gov3", label: "국고채 3년", strategyKey: "KR_GOV_3Y", targetWeightPercent: 30 },
      { id: "gov10", label: "국고채 10년", strategyKey: "KR_GOV_10Y", targetWeightPercent: 15 },
      { id: "corp", label: "우량 회사채", strategyKey: "KR_CORP", targetWeightPercent: 15 },
      { id: "cash", label: "단기채·현금성", strategyKey: "KR_CASH", targetWeightPercent: 5 },
      { id: "gold", label: "금", strategyKey: "GOLD", targetWeightPercent: 5 },
    ],
  },
  balanced: {
    label: "균형형 예시",
    sleeves: [
      { id: "kr", label: "국내 대형주", strategyKey: "KR_LARGE", targetWeightPercent: 15 },
      { id: "us", label: "미국 대형주", strategyKey: "US_LARGE", targetWeightPercent: 35 },
      { id: "developed", label: "선진국 주식", strategyKey: "DEVELOPED", targetWeightPercent: 10 },
      { id: "gov3", label: "국고채 3년", strategyKey: "KR_GOV_3Y", targetWeightPercent: 20 },
      { id: "corp", label: "우량 회사채", strategyKey: "KR_CORP", targetWeightPercent: 15 },
      { id: "gold", label: "금", strategyKey: "GOLD", targetWeightPercent: 5 },
    ],
  },
  growth: {
    label: "성장형 예시",
    sleeves: [
      { id: "kr", label: "국내 대형주", strategyKey: "KR_LARGE", targetWeightPercent: 15 },
      { id: "us", label: "미국 대형주", strategyKey: "US_LARGE", targetWeightPercent: 45 },
      { id: "nasdaq", label: "미국 기술주", strategyKey: "US_NASDAQ", targetWeightPercent: 20 },
      { id: "emerging", label: "신흥국 주식", strategyKey: "EMERGING", targetWeightPercent: 10 },
      { id: "gov3", label: "국고채 3년", strategyKey: "KR_GOV_3Y", targetWeightPercent: 5 },
      { id: "gold", label: "금", strategyKey: "GOLD", targetWeightPercent: 5 },
    ],
  },
};
