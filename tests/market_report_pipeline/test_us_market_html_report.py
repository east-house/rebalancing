from __future__ import annotations

from html.parser import HTMLParser

import pandas as pd

from market_report_pipeline.us_market_html_report import (
    _confirmation,
    build_macro_axes,
    build_news_clusters,
    render_market_html,
)


def test_macro_axes_cover_growth_inflation_liquidity_and_risk() -> None:
    macro = pd.DataFrame(
        [
            {"series": "RSAFS", "value": 3.0, "change": 0.4},
            {"series": "INDPRO", "value": 1.2, "change": 0.2},
            {"series": "UNRATE", "value": 4.1, "change": -0.1},
            {"series": "CPIAUCSL", "value": 2.6, "change": -0.1},
            {"series": "CPILFESL", "value": 2.8, "change": -0.1},
            {"series": "PCEPI", "value": 2.5, "change": -0.1},
            {"series": "DGS10", "value": 4.0, "change": -0.05},
            {"series": "DGS2", "value": 3.8, "change": -0.04},
            {"series": "BAMLH0A0HYM2", "value": 2.8, "change": -0.05},
        ]
    )
    risks = pd.DataFrame(
        [{"name": "US Dollar ETF proxy", "return_5d": -0.01}]
    )

    result = build_macro_axes(
        macro,
        risks,
        {"breadth_above_ma50": 0.65, "vix": 15.0},
    )

    assert result["axis"].tolist() == ["성장", "물가", "금리·유동성", "위험선호"]
    assert result["status"].tolist() == ["개선", "완화", "완화 방향", "위험선호"]


def test_transmission_confirmation_distinguishes_missing_and_flat_price_data() -> None:
    assert _confirmation(expected_positive=True, observed=float("nan")) == "자료 부족"
    assert _confirmation(expected_positive=True, observed=0.0009) == "가격 반응 미약"
    assert _confirmation(expected_positive=True, observed=0.002) == "일치"
    assert _confirmation(expected_positive=True, observed=-0.002) == "반대 반응"


def test_news_clusters_prefer_trusted_source_and_add_price_confirmation() -> None:
    news = pd.DataFrame(
        [
            {
                "topic": "AI·반도체",
                "title": "Unverified chip story",
                "url": "https://example.test/other",
                "source": "Unknown Blog",
                "tone": "긍정 가능",
                "affected_assets": "정보기술",
                "interpretation": "가격 확산 확인",
                "relevance_score": 9,
            },
            {
                "topic": "AI·반도체",
                "title": "Reuters chip story",
                "url": "https://example.test/reuters",
                "source": "Reuters",
                "tone": "긍정 가능",
                "affected_assets": "정보기술",
                "interpretation": "가격 확산 확인",
                "relevance_score": 5,
            },
        ]
    )
    themes = pd.DataFrame(
        [{"theme": "AI 반도체", "return_1d": 0.02, "relative_20d": 0.04}]
    )
    indices = pd.DataFrame(
        [{"name": "S&P 500", "return_1d": 0.01}]
    )

    result = build_news_clusters(news, themes, indices)

    assert len(result) == 1
    assert result.iloc[0]["headline"] == "Reuters chip story"
    assert result.iloc[0]["source_tier"] == "주요 금융매체"
    assert result.iloc[0]["item_count"] == 2
    assert str(result.iloc[0]["price_confirmation"]).startswith("확인:")


def test_rendered_html_is_parseable_and_escapes_dynamic_text() -> None:
    indices = pd.DataFrame(
        [
            {
                "name": "S&P 500",
                "ticker": "^GSPC",
                "return_1d": 0.01,
                "return_5d": 0.02,
                "return_20d": 0.03,
                "ma200_gap": 0.08,
                "chart_phase": "상승 추세",
            }
        ]
    )
    risks = pd.DataFrame(columns=indices.columns)
    sectors = pd.DataFrame(
        [
            {
                "rank": 1,
                "sector_display": "정보기술 (Information Technology)",
                "leader": "Example Corp (EXM)",
                "rank_change_1d": 1,
                "rank_change_5d": 2,
                "sector_score": 88.0,
                "relative_5d": 0.01,
                "relative_20d": 0.03,
                "relative_60d": 0.05,
                "above_ma50_breadth": 0.7,
                "leader_phase": "추세 진행",
            }
        ]
    )
    themes = pd.DataFrame(
        [
            {
                "rank": 1,
                "theme": "AI 반도체",
                "proxy": "SMH",
                "leader": "Example Corp (EXM)",
                "rank_change_1d": 0,
                "rank_change_5d": 1,
                "theme_score": 84.0,
                "relative_5d": 0.01,
                "relative_20d": 0.03,
                "relative_60d": 0.05,
                "above_ma50_breadth": 0.7,
                "leader_phase": "추세 진행",
            }
        ]
    )
    leaders = pd.DataFrame(
        [
            {
                "scope": "sector",
                "group_display": "정보기술",
                "company_ticker": "Example Corp (EXM)",
                "return_20d": 0.08,
                "return_60d": 0.2,
                "chart_phase": "상승 추세",
                "risk_note": "과열 확인",
                "leader_score": 90,
            }
        ]
    )
    macro = pd.DataFrame(
        [
            {
                "indicator": "CPI",
                "series": "CPIAUCSL",
                "value": 2.6,
                "change": -0.1,
                "unit": "%",
                "observation_date": "2026-07-01",
                "interpretation": "물가 압력",
            }
        ]
    )
    macro_axes = pd.DataFrame(
        [{"axis": "성장", "status": "개선", "tone": "positive", "evidence": "근거", "market_read": "확인"}]
    )
    transmissions = pd.DataFrame(
        [{"driver": "장기금리", "confirmation": "일치", "change": "하락", "expected": "성장주 우호", "observed": "상대수익률 상승"}]
    )
    news_clusters = pd.DataFrame(
        [{"topic": "AI·반도체", "source_tier": "주요 금융매체", "item_count": 2, "sources": "Reuters", "url": "https://example.test", "headline": "Chip <script>alert(1)</script>", "tone": "혼합·중립", "interpretation": "가격 확인", "price_confirmation": "확인"}]
    )
    empty_events = pd.DataFrame(
        columns=["event_time", "event", "url", "latest_value", "consensus", "interpretation", "source"]
    )

    rendered = render_market_html(
        as_of=pd.Timestamp("2026-08-16"),
        market_state={
            "market_date": pd.Timestamp("2026-08-14"),
            "interpretation": "상승 <확인>",
            "state": "상승 확산",
            "risk_level": "낮음",
            "sp500_return_20d": 0.03,
            "breadth_above_ma50": 0.65,
            "vix": 15.0,
        },
        indices=indices,
        risks=risks,
        sectors=sectors,
        themes=themes,
        leaders=leaders,
        macro=macro,
        macro_axes=macro_axes,
        today_events=empty_events,
        upcoming_events=empty_events,
        news_clusters=news_clusters,
        transmissions=transmissions,
        quality={
            "prices": {"successful": 620, "requested": 620},
            "stock_snapshot_rows": 503,
            "validation": {"passed": True},
        },
    )

    parser = HTMLParser()
    parser.feed(rendered)
    parser.close()
    assert "미국 시장 변화 리포트 · 2026-08-16" in rendered
    assert "미국 거래일 2026-08-14" in rendered
    assert "TODAY'S CONCLUSION" in rendered
    assert "어제와 달라진 핵심" in rendered
    assert "거시 변화의 가격 반영" in rendered
    assert "다음 거래일에 확인할 것" in rendered
    assert "가장 강한 섹터 · 독립 순위" in rendered
    assert "가장 강한 테마 · 독립 순위" in rendered
    assert "최근 50거래일 평균가격보다 높은 종목" in rendered
    assert "50일선 상회" not in rendered
    assert "대장주 위치 지도 · 전체 8단계" in rendered
    assert "6/8단계 · 추세 진행" in rendered
    assert "섹터 1위 대장" in rendered
    assert "테마 1위 대장" in rendered
    assert 'src="market_dashboard.png"' in rendered
    assert rendered.count("<details>") == 4
    assert "Chip &lt;script&gt;alert(1)&lt;/script&gt;" in rendered
    assert "Chip <script>" not in rendered
