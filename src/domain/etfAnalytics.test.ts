import { describe, expect, it } from "vitest";

import { calculateHoldingOverlap, calculateLookthroughExposure, calculateReturnCorrelation } from "./etfAnalytics";
import { makeResearchProfile, makeReturnSeries } from "./etfResearchTestUtils";

describe("ETF 분석", () => {
  it("두 ETF 공통 구성종목의 작은 비중을 합산한다", () => {
    const left = makeResearchProfile("A", "S", {
      holdings: [
        { key: "SAMSUNG", name: "삼성전자", weightPercent: 30 },
        { key: "SK", name: "SK하이닉스", weightPercent: 20 },
      ],
      holdingsCoveragePercent: 95,
    });
    const right = makeResearchProfile("B", "T", {
      holdings: [
        { key: "SAMSUNG", name: "삼성전자", weightPercent: 25 },
        { key: "NAVER", name: "NAVER", weightPercent: 15 },
      ],
      holdingsCoveragePercent: 92,
    });
    expect(calculateHoldingOverlap(left, right)).toMatchObject({
      overlapPercent: 25,
      commonHoldingCount: 1,
      coveragePercent: 92,
      confidence: "exact",
    });
  });

  it("ETF와 직접 보유 주식을 합친 실질 종목 노출을 계산한다", () => {
    const profile = makeResearchProfile("A", "S", {
      holdings: [{ key: "SAMSUNG", name: "삼성전자", weightPercent: 50 }],
    });
    const result = calculateLookthroughExposure(
      [{ profile, weightPercent: 40 }],
      [{ name: "삼성전자", weightPercent: 10 }],
    );
    expect(result[0]).toEqual({ name: "삼성전자", weightPercent: 30 });
  });

  it("같은 방향의 가격 흐름은 높은 상관계수를 반환한다", () => {
    const left = makeReturnSeries("A", [100, 102, 101, 105]);
    const right = makeReturnSeries("B", [200, 204, 202, 210]);
    expect(calculateReturnCorrelation(left.points, right.points)).toBeCloseTo(1, 8);
  });
});
