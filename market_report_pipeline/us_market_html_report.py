"""Improved standalone HTML view for the US market intelligence report."""

from __future__ import annotations

import html
from typing import Any

import numpy as np
import pandas as pd

from .us_market_html_layout import render_good_market_html


TRUSTED_NEWS = (
    "Reuters",
    "Bloomberg",
    "Associated Press",
    "AP News",
    "Wall Street Journal",
    "Financial Times",
    "CNBC",
    "Barron's",
)
SPECIALIST_NEWS = (
    "Investor's Business Daily",
    "MarketWatch",
    "Seeking Alpha",
)

CHART_PHASES = (
    ("하락 추세", "장기 흐름 약세"),
    ("기반 형성", "바닥·방향 탐색"),
    ("반등 시도", "장기 평균 회복 시도"),
    ("상승 전환", "중장기 흐름 개선"),
    ("돌파 초기", "이전 고점 돌파 시작"),
    ("추세 진행", "상승 흐름 유지"),
    ("상승 중 눌림", "상승 중 단기 조정"),
    ("과열 상승", "평균가격에서 과도한 이격"),
)


def _phase_position(value: Any) -> str:
    phase = str(value)
    for position, (name, _) in enumerate(CHART_PHASES, start=1):
        if phase == name:
            return f"{position}/{len(CHART_PHASES)}단계 · {phase}"
    return phase


def _safe(value: Any, fallback: str = "—") -> str:
    if value is None or pd.isna(value):
        return fallback
    return html.escape(str(value))


def _num(value: Any, digits: int = 2) -> str:
    if value is None or pd.isna(value):
        return "—"
    return f"{float(value):.{digits}f}"


def _pct(value: Any, digits: int = 1, signed: bool = True) -> str:
    if value is None or pd.isna(value):
        return "—"
    number = float(value) * 100
    prefix = "+" if signed and number > 0 else ""
    return f"{prefix}{number:.{digits}f}%"


def _macro_row(macro: pd.DataFrame, series: str) -> pd.Series | None:
    rows = macro.loc[macro["series"].eq(series)]
    return None if rows.empty else rows.iloc[0]


def _macro_number(macro: pd.DataFrame, series: str, column: str) -> float:
    row = _macro_row(macro, series)
    if row is None or pd.isna(row.get(column)):
        return np.nan
    return float(row[column])


def _signal(value: float, positive_when_high: bool = True, tolerance: float = 0.0) -> int:
    if pd.isna(value) or abs(value) <= tolerance:
        return 0
    positive = value > 0
    return 1 if positive == positive_when_high else -1


def _axis_status(score: int, positive: str, negative: str) -> tuple[str, str]:
    if score >= 2:
        return positive, "positive"
    if score <= -2:
        return negative, "caution"
    return "혼조·중립", "neutral"


def build_macro_axes(
    macro: pd.DataFrame,
    risks: pd.DataFrame,
    market_state: dict[str, Any],
) -> pd.DataFrame:
    retail = _macro_number(macro, "RSAFS", "value")
    retail_change = _macro_number(macro, "RSAFS", "change")
    industrial = _macro_number(macro, "INDPRO", "value")
    industrial_change = _macro_number(macro, "INDPRO", "change")
    unemployment_change = _macro_number(macro, "UNRATE", "change")
    payroll_change = _macro_number(macro, "PAYEMS", "change")
    growth_score = (
        _signal(retail_change, tolerance=0.05)
        + _signal(industrial_change, tolerance=0.05)
        + _signal(unemployment_change, positive_when_high=False, tolerance=0.05)
        + _signal(payroll_change, tolerance=10.0)
    )
    growth_status, growth_tone = _axis_status(growth_score, "개선", "둔화")

    inflation_changes = [
        _macro_number(macro, "CPIAUCSL", "change"),
        _macro_number(macro, "CPILFESL", "change"),
        _macro_number(macro, "PCEPI", "change"),
    ]
    inflation_score = sum(
        _signal(value, positive_when_high=False, tolerance=0.03)
        for value in inflation_changes
    )
    inflation_status, inflation_tone = _axis_status(
        inflation_score, "완화", "재가속",
    )

    ten_change = _macro_number(macro, "DGS10", "change")
    two_change = _macro_number(macro, "DGS2", "change")
    dollar_rows = risks.loc[risks["name"].eq("US Dollar ETF proxy")]
    dollar_5d = float(dollar_rows.iloc[0]["return_5d"]) if not dollar_rows.empty else np.nan
    liquidity_score = (
        _signal(ten_change, positive_when_high=False, tolerance=0.01)
        + _signal(two_change, positive_when_high=False, tolerance=0.01)
        + _signal(dollar_5d, positive_when_high=False, tolerance=0.002)
    )
    liquidity_status, liquidity_tone = _axis_status(
        liquidity_score, "완화 방향", "긴축 방향",
    )

    spread_change = _macro_number(macro, "BAMLH0A0HYM2", "change")
    breadth50 = float(market_state["breadth_above_ma50"])
    vix = float(market_state["vix"])
    risk_score = (
        (1 if breadth50 >= 0.55 else (-1 if breadth50 < 0.40 else 0))
        + (1 if vix < 18 else (-1 if vix >= 25 else 0))
        + _signal(spread_change, positive_when_high=False, tolerance=0.01)
    )
    risk_status, risk_tone = _axis_status(risk_score, "위험선호", "위험회피")

    rows = [
        {
            "axis": "성장",
            "status": growth_status,
            "tone": growth_tone,
            "score": growth_score,
            "evidence": f"소매판매 {_num(retail)}%(직전 대비 {_num(retail_change)}%p), 산업생산 {_num(industrial)}%({_num(industrial_change)}%p), 실업률 변화 {_num(unemployment_change)}%p, 고용 {_num(payroll_change, 0)}천명",
            "market_read": "경기민감 업종과 소형주가 같은 방향으로 움직이는지 확인",
        },
        {
            "axis": "물가",
            "status": inflation_status,
            "tone": inflation_tone,
            "score": inflation_score,
            "evidence": "CPI·근원 CPI·PCE 전년비의 직전 발표 대비 변화로 판정",
            "market_read": "2년물 금리와 달러가 물가 방향을 확인하는지 점검",
        },
        {
            "axis": "금리·유동성",
            "status": liquidity_status,
            "tone": liquidity_tone,
            "score": liquidity_score,
            "evidence": f"10년물 변화 {_num(ten_change)}%p, 2년물 {_num(two_change)}%p, 달러 5일 {_pct(dollar_5d)}",
            "market_read": "성장주·부동산 등 금리 민감 자산의 실제 반응 확인",
        },
        {
            "axis": "위험선호",
            "status": risk_status,
            "tone": risk_tone,
            "score": risk_score,
            "evidence": f"시장 불안지수(VIX) {_num(vix)}, 중기 상승 참여도 {_pct(breadth50, signed=False)}, 하이일드 스프레드 변화 {_num(spread_change)}%p",
            "market_read": "지수 상승에 소형주와 다수 종목이 함께 참여하는지 확인",
        },
    ]
    return pd.DataFrame(rows)


def news_source_tier(source: str) -> tuple[int, str]:
    lower = source.lower()
    if any(value in lower for value in ("federal reserve", "bureau of", "sec.gov")):
        return 0, "공식"
    if any(value.lower() in lower for value in TRUSTED_NEWS):
        return 1, "주요 금융매체"
    if any(value.lower() in lower for value in SPECIALIST_NEWS):
        return 2, "전문매체"
    return 3, "기타 출처"


def _topic_price_confirmation(
    topic: str,
    themes: pd.DataFrame,
    indices: pd.DataFrame,
) -> str:
    theme_map = {
        "AI·반도체": "AI 반도체",
        "사이버보안": "사이버보안",
        "우주·위성": "우주·위성",
        "원전·전력망": "원전·전력망",
        "지정학·방산": "방산",
    }
    theme = theme_map.get(topic)
    if theme:
        rows = themes.loc[themes["theme"].eq(theme)]
        if not rows.empty:
            row = rows.iloc[0]
            label = "확인" if row["return_1d"] > 0 and row["relative_20d"] > 0 else (
                "부분 확인" if row["return_1d"] > 0 or row["relative_20d"] > 0 else "미확인"
            )
            return f"{label}: {theme} 1일 {_pct(row['return_1d'])}, 20일 상대 {_pct(row['relative_20d'])}"
    spx = indices.loc[indices["name"].eq("S&P 500")]
    ndx = indices.loc[indices["name"].eq("Nasdaq 100")]
    if not spx.empty:
        spx_text = _pct(spx.iloc[0]["return_1d"])
        ndx_text = _pct(ndx.iloc[0]["return_1d"]) if not ndx.empty else "—"
        return f"시장 반응: S&P 500 {spx_text}, Nasdaq 100 {ndx_text}"
    return "가격 반응 확인 불가"


def build_news_clusters(
    news: pd.DataFrame,
    themes: pd.DataFrame,
    indices: pd.DataFrame,
) -> pd.DataFrame:
    if news.empty:
        return pd.DataFrame(
            columns=["topic", "headline", "url", "sources", "item_count", "source_tier", "tone", "affected_assets", "interpretation", "price_confirmation"]
        )
    work = news.copy()
    tiers = work["source"].astype(str).map(news_source_tier)
    work["_tier_rank"] = [item[0] for item in tiers]
    work["_tier_label"] = [item[1] for item in tiers]
    rows: list[dict[str, Any]] = []
    for topic, group in work.groupby("topic", sort=False):
        ordered = group.sort_values(["_tier_rank", "relevance_score"], ascending=[True, False])
        lead = ordered.iloc[0]
        tones = set(group["tone"].astype(str))
        rows.append(
            {
                "topic": topic,
                "headline": lead["title"],
                "url": lead["url"],
                "sources": ", ".join(dict.fromkeys(group["source"].astype(str)))[:180],
                "item_count": len(group),
                "source_tier": lead["_tier_label"],
                "tone": tones.pop() if len(tones) == 1 else "해석 혼재",
                "affected_assets": lead["affected_assets"],
                "interpretation": lead["interpretation"],
                "price_confirmation": _topic_price_confirmation(str(topic), themes, indices),
                "_sort": float(lead["_tier_rank"]) - min(len(group), 3) * 0.1,
            }
        )
    return pd.DataFrame(rows).sort_values(["_sort", "item_count"]).drop(columns="_sort").reset_index(drop=True)


def _confirmation(expected_positive: bool, observed: float) -> str:
    if pd.isna(observed) or abs(observed) < 0.001:
        return "미확인"
    return "일치" if (observed > 0) == expected_positive else "반대 반응"


def build_transmission_signals(
    macro: pd.DataFrame,
    risks: pd.DataFrame,
    sectors: pd.DataFrame,
    indices: pd.DataFrame,
    market_state: dict[str, Any],
) -> pd.DataFrame:
    sector_map = sectors.set_index("sector")
    ten_change = _macro_number(macro, "DGS10", "change")
    rate_observed = np.nanmean(
        [
            sector_map.loc[name, "relative_1d"]
            for name in ("Information Technology", "Real Estate")
            if name in sector_map.index
        ]
    )
    oil_rows = risks.loc[risks["name"].eq("WTI Crude Oil")]
    oil_move = float(oil_rows.iloc[0]["return_1d"]) if not oil_rows.empty else np.nan
    energy_move = float(sector_map.loc["Energy", "relative_1d"]) if "Energy" in sector_map.index else np.nan
    index_map = indices.set_index("name")
    small_gap = (
        float(index_map.loc["Russell 2000", "return_1d"] - index_map.loc["S&P 500", "return_1d"])
        if {"Russell 2000", "S&P 500"}.issubset(index_map.index)
        else np.nan
    )
    breadth = float(market_state["breadth_above_ma50"])
    return pd.DataFrame(
        [
            {
                "driver": "장기금리",
                "change": f"미 10년물 직전 변화 {_num(ten_change)}%p",
                "expected": "하락 시 성장주·부동산 우호, 상승 시 부담 가능",
                "observed": f"정보기술·부동산 평균 1일 상대 {_pct(rate_observed)}",
                "confirmation": _confirmation(ten_change < 0, rate_observed) if pd.notna(ten_change) else "자료 부족",
            },
            {
                "driver": "유가",
                "change": f"WTI 1일 {_pct(oil_move)}",
                "expected": "상승 시 에너지 우호, 운송·소비 비용 부담 가능",
                "observed": f"에너지 섹터 1일 상대 {_pct(energy_move)}",
                "confirmation": _confirmation(oil_move > 0, energy_move) if pd.notna(oil_move) else "자료 부족",
            },
            {
                "driver": "위험선호 확산",
                "change": f"시장 불안지수(VIX) {_num(market_state['vix'])}, 중기 상승 참여도 {_pct(breadth, signed=False)}",
                "expected": "상승에 참여하는 종목이 늘면 소형주·경기민감주도 동참",
                "observed": f"Russell 2000의 S&P 500 대비 1일 {_pct(small_gap)}",
                "confirmation": "일치" if breadth >= 0.55 and small_gap > 0 else ("부분 확인" if breadth >= 0.55 or small_gap > 0 else "미확인"),
            },
        ]
    )


def _rank_delta(value: Any) -> str:
    if value is None or pd.isna(value):
        return "비교 이력 없음"
    change = int(float(value))
    if change > 0:
        return f"↑ {change}"
    if change < 0:
        return f"↓ {abs(change)}"
    return "—"


def render_market_html(
    *,
    as_of: pd.Timestamp,
    market_state: dict[str, Any],
    indices: pd.DataFrame,
    risks: pd.DataFrame,
    sectors: pd.DataFrame,
    themes: pd.DataFrame,
    leaders: pd.DataFrame,
    macro: pd.DataFrame,
    macro_axes: pd.DataFrame,
    today_events: pd.DataFrame,
    upcoming_events: pd.DataFrame,
    news_clusters: pd.DataFrame,
    transmissions: pd.DataFrame,
    quality: dict[str, Any],
) -> str:
    market_date = pd.Timestamp(market_state["market_date"])
    top_sector = sectors.iloc[0]
    weak_sector = sectors.iloc[-1]
    top_theme = themes.iloc[0]
    weak_theme = themes.iloc[-1]
    sector_mover = sectors.sort_values("rank_change_1d", ascending=False, na_position="last").iloc[0]
    theme_mover = themes.sort_values("rank_change_1d", ascending=False, na_position="last").iloc[0]

    axis_rows = "".join(
        f"""<div class="axis-row {html.escape(str(row.tone))}"><div><span>{_safe(row.axis)}</span><strong>{_safe(row.status)}</strong></div><p>{_safe(row.evidence)}</p><small>{_safe(row.market_read)}</small></div>"""
        for _, row in macro_axes.iterrows()
    )
    transmission_cards = "".join(
        f"""<article class="transmission"><div class="transmission-head"><span>{_safe(row.driver)}</span><b>{_safe(row.confirmation)}</b></div><strong>{_safe(row.change)}</strong><div class="flow"><span>기본 가설</span><p>{_safe(row.expected)}</p><i>↓</i><span>실제 가격</span><p>{_safe(row.observed)}</p></div></article>"""
        for _, row in transmissions.iterrows()
    )
    market_rows = "".join(
        f"<tr><td><strong>{_safe(row['name'])}</strong><small>{_safe(row.ticker)}</small></td><td>{_pct(row.return_1d)}</td><td>{_pct(row.return_5d)}</td><td>{_pct(row.return_20d)}</td><td>{_pct(row.ma200_gap)}</td><td><span class='phase'>{_safe(row.chart_phase)}</span></td></tr>"
        for _, row in pd.concat([indices, risks], ignore_index=True).iterrows()
    )
    sector_rows = "".join(
        f"<tr><td class='rank'>{int(row['rank'])}</td><td><strong>{_safe(row.sector_display)}</strong><small>{_safe(row.leader)}</small></td><td>{_rank_delta(row.rank_change_1d)}</td><td>{_rank_delta(row.rank_change_5d)}</td><td>{_num(row.sector_score, 1)}</td><td>{_pct(row.relative_5d)}</td><td>{_pct(row.relative_20d)}</td><td>{_pct(row.relative_60d)}</td><td>{_pct(row.above_ma50_breadth, signed=False)}</td><td><span class='phase'>{_safe(row.leader_phase)}</span></td></tr>"
        for _, row in sectors.iterrows()
    )
    theme_rows = "".join(
        f"<tr><td class='rank'>{int(row['rank'])}</td><td><strong>{_safe(row.theme)}</strong><small>{_safe(row.proxy)} · {_safe(row.leader)}</small></td><td>{_rank_delta(row.rank_change_1d)}</td><td>{_rank_delta(row.rank_change_5d)}</td><td>{_num(row.theme_score, 1)}</td><td>{_pct(row.relative_5d)}</td><td>{_pct(row.relative_20d)}</td><td>{_pct(row.relative_60d)}</td><td>{_pct(row.above_ma50_breadth, signed=False)}</td><td><span class='phase'>{_safe(row.leader_phase)}</span></td></tr>"
        for _, row in themes.iterrows()
    )
    leader_rows = "".join(
        f"<tr><td>{'섹터' if row.scope == 'sector' else '테마'}</td><td>{_safe(row.group_display)}</td><td><strong>{_safe(row.company_ticker)}</strong></td><td>{_pct(row.return_20d)}</td><td>{_pct(row.return_60d)}</td><td><span class='phase'>{_safe(row.chart_phase)}</span></td><td>{_safe(row.risk_note)}</td></tr>"
        for _, row in leaders.sort_values("leader_score", ascending=False).head(14).iterrows()
    )
    macro_rows = "".join(
        f"<tr><td><strong>{_safe(row.indicator)}</strong><small>{_safe(row.series)}</small></td><td>{_num(row.value)}{_safe(row.unit, '')}</td><td>{_num(row.change)}{_safe(row.unit, '')}</td><td>{_safe(str(row.observation_date)[:10])}</td><td>{_safe(row.interpretation)}</td></tr>"
        for _, row in macro.iterrows() if pd.notna(row.value)
    )
    if today_events.empty:
        today_rows = '<tr><td colspan="5" class="empty">해당 미국 거래일의 BLS·BEA 정기 발표 없음</td></tr>'
    else:
        today_rows = "".join(
            f"<tr><td>{_safe(str(row.event_time)[:16])}</td><td><a href='{_safe(row.url)}'>{_safe(row.event)}</a></td><td>{_safe(row.latest_value)}</td><td>{_safe(row.consensus)}</td><td>{_safe(row.interpretation)}</td></tr>"
            for _, row in today_events.iterrows()
        )
    upcoming_rows = "".join(
        f"<tr><td>{_safe(str(row.event_time)[:16])}</td><td><a href='{_safe(row.url)}'>{_safe(row.event)}</a></td><td>{_safe(row.source)}</td><td>{_safe(row.interpretation)}</td></tr>"
        for _, row in upcoming_events.head(12).iterrows()
    ) or '<tr><td colspan="4" class="empty">향후 공식 일정 수집 결과 없음</td></tr>'
    news_cards = "".join(
        f"""<article class="news-card"><div class="news-meta"><span>{_safe(row.topic)}</span><b>{_safe(row.source_tier)}</b><small>{int(row.item_count)}건 묶음</small></div><p class="news-read">{_safe(row.interpretation)}</p><div class="price-check">가격 확인 · {_safe(row.price_confirmation)}</div><a href="{_safe(row.url)}" target="_blank" rel="noreferrer">{_safe(row.headline)}</a><small>{_safe(row.sources)}</small></article>"""
        for _, row in news_clusters.iterrows()
    ) or '<div class="empty">뉴스 사건 묶음 없음</div>'

    def leadership_cards(frame: pd.DataFrame, label: str, score: str) -> str:
        cards: list[str] = []
        for _, row in frame.head(5).iterrows():
            width = max(4.0, min(100.0, float(row[score])))
            cards.append(
                f"""<article class="lead-card"><div class="lead-rank"><b>{int(row['rank'])}</b><span>{_safe(row[label])}</span></div><div class="score"><i style="width:{width:.1f}%"></i></div><div class="lead-data"><strong>{_num(row[score], 1)}점</strong><span>최근 1개월 시장 대비 {_pct(row.relative_20d)}</span><span>순위 {_rank_delta(row.rank_change_1d)}</span></div><p>{_safe(row.leader)} · {_safe(_phase_position(row.leader_phase))}</p></article>"""
            )
        return "".join(cards)

    sector_cards = leadership_cards(sectors, "sector_display", "sector_score")
    theme_cards = leadership_cards(themes, "theme", "theme_score")
    phase_steps: list[str] = []
    for position, (phase, description) in enumerate(CHART_PHASES, start=1):
        markers: list[str] = []
        classes: list[str] = ["phase-step"]
        if str(top_sector.leader_phase) == phase:
            classes.append("sector-active")
            markers.append('<em class="sector-marker">섹터 1위 대장</em>')
        if str(top_theme.leader_phase) == phase:
            classes.append("theme-active")
            markers.append('<em class="theme-marker">테마 1위 대장</em>')
        phase_steps.append(
            f"""<div class="{' '.join(classes)}"><i>{position}</i><b>{_safe(phase)}</b><span>{_safe(description)}</span><div>{''.join(markers)}</div></div>"""
        )
    phase_guide = "".join(phase_steps)
    caution_axes = macro_axes.loc[macro_axes["tone"].eq("caution")]
    caution_text = (
        ", ".join(f"{row.axis} {row.status}" for _, row in caution_axes.iterrows())
        if not caution_axes.empty
        else "뚜렷한 경계 축 없음"
    )
    unconfirmed = transmissions.loc[~transmissions["confirmation"].isin(["일치"])]
    transmission_watch = (
        ", ".join(f"{row.driver} {row.confirmation}" for _, row in unconfirmed.iterrows())
        if not unconfirmed.empty
        else "주요 전파 신호 일치"
    )
    next_event = upcoming_events.iloc[0] if not upcoming_events.empty else None
    next_event_text = (
        f"{str(next_event.event_time)[:16]} {next_event.event}"
        if next_event is not None
        else "향후 10일 공식 일정 없음"
    )
    conclusion = (
        f"{market_state['state']} 국면이 유지되고 상승에 참여하는 종목도 많은 편이다. "
        f"다만 {caution_text} 신호가 있어 지수 강세만으로 판단하기보다 "
        f"섹터 중에서는 {top_sector.sector_display}, 별도로 계산한 테마 중에서는 {top_theme.theme}의 상대강도와 각 대장주 추세가 계속 확인되는지 보는 편이 핵심이다."
    )
    stock_count = int(quality["stock_snapshot_rows"])
    above_ma50_count = int(round(float(market_state["breadth_above_ma50"]) * stock_count))
    checklist = "".join(
        [
            f"<li><b>상승 참여도</b><span>S&amp;P 500 구성종목 {stock_count}개 중 약 {above_ma50_count}개가 최근 50거래일 평균가격보다 높은 상태인지 확인</span></li>",
            f"<li><b>주도 섹터</b><span>{_safe(top_sector.sector_display)}의 20일 상대수익률 {_pct(top_sector.relative_20d)}와 대장 {_safe(top_sector.leader)} 추세 확인</span></li>",
            f"<li><b>급부상 테마</b><span>{_safe(theme_mover.theme)}가 전일 순위 {_rank_delta(theme_mover.rank_change_1d)} 이후에도 확산되는지 확인</span></li>",
            f"<li><b>전파 예외</b><span>{_safe(transmission_watch)} — 예상과 가격이 다르면 원인 단정을 보류</span></li>",
            f"<li><b>다음 일정</b><span>{_safe(next_event_text)}</span></li>",
        ]
    )

    context = {
        "as_of": as_of.strftime("%Y-%m-%d"),
        "market_date": market_date.strftime("%Y-%m-%d"),
        "state": _safe(market_state["state"]),
        "interpretation": _safe(market_state["interpretation"]),
        "risk_level": _safe(market_state["risk_level"]),
        "conclusion": _safe(conclusion),
        "top_sector": _safe(top_sector.sector_display),
        "top_sector_leader": _safe(top_sector.leader),
        "top_sector_phase": _safe(_phase_position(top_sector.leader_phase)),
        "top_theme": _safe(top_theme.theme),
        "top_theme_leader": _safe(top_theme.leader),
        "top_theme_phase": _safe(_phase_position(top_theme.leader_phase)),
        "weak_sector": _safe(weak_sector.sector_display),
        "weak_sector_relative_20d": _pct(weak_sector.relative_20d),
        "weak_theme": _safe(weak_theme.theme),
        "weak_theme_relative_20d": _pct(weak_theme.relative_20d),
        "sp500_return_1d": _pct(market_state.get("sp500_return_1d")),
        "sp500_return_20d": _pct(market_state["sp500_return_20d"]),
        "breadth_positive_1d": _pct(market_state.get("breadth_positive_1d"), signed=False),
        "breadth_above_ma50": _pct(market_state["breadth_above_ma50"], signed=False),
        "breadth_plain": f"{stock_count}개 중 약 {above_ma50_count}개",
        "vix": _num(market_state["vix"]),
        "sector_mover": _safe(sector_mover.sector_display),
        "sector_mover_rank": str(int(sector_mover["rank"])),
        "sector_mover_delta": _rank_delta(sector_mover.rank_change_1d),
        "sector_mover_relative_20d": _pct(sector_mover.relative_20d),
        "sector_mover_leader": _safe(sector_mover.leader),
        "theme_mover": _safe(theme_mover.theme),
        "theme_mover_rank": str(int(theme_mover["rank"])),
        "theme_mover_delta": _rank_delta(theme_mover.rank_change_1d),
        "theme_mover_relative_20d": _pct(theme_mover.relative_20d),
        "theme_mover_leader": _safe(theme_mover.leader),
        "successful_symbols": str(quality["prices"]["successful"]),
        "requested_symbols": str(quality["prices"]["requested"]),
        "stock_snapshot_rows": str(quality["stock_snapshot_rows"]),
        "validation": "통과" if quality["validation"]["passed"] else "실패",
    }
    return render_good_market_html(
        context=context,
        axis_rows=axis_rows,
        transmission_cards=transmission_cards,
        sector_cards=sector_cards,
        theme_cards=theme_cards,
        phase_guide=phase_guide,
        checklist=checklist,
        news_cards=news_cards,
        today_rows=today_rows,
        upcoming_rows=upcoming_rows,
        market_rows=market_rows,
        sector_rows=sector_rows,
        theme_rows=theme_rows,
        leader_rows=leader_rows,
        macro_rows=macro_rows,
    )

    _legacy_layout = """<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>미국 시장 변화 리포트 · {as_of:%Y-%m-%d}</title>
<style>
:root{{--bg:#07100f;--panel:#0d1917;--panel2:#11211e;--line:#20352f;--text:#f2f7f4;--muted:#91a69f;--green:#75b38b;--amber:#d2ad68;--red:#d18372}}*{{box-sizing:border-box}}body{{margin:0;color:var(--text);font-family:Pretendard,"Noto Sans KR","Segoe UI",sans-serif;background:radial-gradient(circle at 78% -10%,#173b2d 0,transparent 32rem),var(--bg);line-height:1.55}}a{{color:inherit}}.wrap{{width:min(1440px,calc(100% - 40px));margin:auto}}header{{padding:70px 0 42px;border-bottom:1px solid var(--line)}}.eyebrow,.section-title span{{color:var(--green);font-size:10px;font-weight:800;letter-spacing:.16em}}h1{{max-width:900px;margin:12px 0 18px;font-size:clamp(38px,6vw,76px);line-height:1.03;letter-spacing:-.06em}}header p{{max-width:880px;color:#bacac4}}.meta{{display:flex;flex-wrap:wrap;gap:8px;margin-top:24px}}.meta b,.phase{{padding:6px 10px;border:1px solid var(--line);border-radius:999px;background:#10201d;font-size:11px}}main{{padding:34px 0 80px}}.changes,.axes,.transmissions{{display:grid;gap:14px}}.changes{{grid-template-columns:repeat(3,1fr)}}.change-card,.axis-card,.transmission,.section{{border:1px solid var(--line);background:linear-gradient(145deg,#10201d,#091411);box-shadow:0 20px 70px #0003}}.change-card{{min-height:160px;padding:22px;border-radius:18px}}.change-card span,.change-card small,.axis-card small,.transmission small{{color:var(--muted);font-size:11px}}.change-card b{{display:block;margin:12px 0 8px;font-size:24px}}.section{{margin-top:18px;border-radius:20px;overflow:hidden}}.section-title{{display:flex;justify-content:space-between;align-items:end;padding:22px 24px;border-bottom:1px solid var(--line)}}.section-title h2{{margin:5px 0 0;font-size:21px}}.section-title p{{max-width:640px;margin:0;color:var(--muted);font-size:11px;text-align:right}}.axes{{grid-template-columns:repeat(4,1fr);padding:18px}}.axis-card{{min-height:180px;padding:18px;border-radius:15px}}.axis-card>div,.transmission>div{{display:flex;justify-content:space-between;gap:12px}}.axis-card b{{font-size:15px}}.axis-card p,.transmission p{{color:#c4d1cc;font-size:12px}}.axis-card.positive b{{color:var(--green)}}.axis-card.caution b{{color:var(--amber)}}.transmissions{{grid-template-columns:repeat(3,1fr);padding:18px}}.transmission{{padding:18px;border-radius:15px}}.transmission>strong{{display:block;margin-top:13px}}.transmission b{{color:var(--green);font-size:11px}}.table-wrap{{overflow:auto}}table{{width:100%;border-collapse:collapse;font-size:11px}}th,td{{padding:12px 14px;border-bottom:1px solid var(--line);text-align:left;white-space:nowrap}}th{{position:sticky;top:0;color:var(--muted);background:#0a1513}}td small{{display:block;margin-top:3px;color:var(--muted)}}td.rank{{color:var(--green);font-weight:800}}.news-grid{{display:grid;grid-template-columns:repeat(2,1fr);gap:14px;padding:18px}}.news-card{{padding:19px;border:1px solid var(--line);border-radius:15px;background:#0b1714}}.news-meta{{display:flex;align-items:center;gap:8px;margin-bottom:12px}}.news-meta span{{padding:4px 7px;color:var(--green);font-size:9px;background:#173326;border-radius:6px}}.news-meta b,.news-meta small{{color:var(--muted);font-size:10px}}.news-card>a{{display:block;font-weight:750;text-decoration:none}}.news-card p{{color:#b8c8c2;font-size:11px}}.price-check{{padding:9px 10px;color:#cde0d5;font-size:10px;border-radius:8px;background:#10241d}}.empty{{padding:26px;color:var(--muted);text-align:center}}footer{{padding:28px 0;color:var(--muted);font-size:11px}}@media(max-width:1000px){{.axes{{grid-template-columns:repeat(2,1fr)}}.changes,.transmissions{{grid-template-columns:1fr}}}}@media(max-width:680px){{.wrap{{width:min(100% - 24px,1440px)}}header{{padding-top:45px}}.axes,.news-grid{{grid-template-columns:1fr}}.section-title{{display:block}}.section-title p{{margin-top:8px;text-align:left}}}}
</style></head><body><header><div class="wrap"><div class="eyebrow">US MARKET CHANGE REPORT</div><h1>무엇이 바뀌었고,<br>어디로 전파되는가.</h1><p>{_safe(market_state['interpretation'])} 단순 순위보다 거시 변화, 교차자산 반응, 섹터·테마 확산을 함께 읽는다.</p><div class="meta"><b>생성 기준 {as_of:%Y-%m-%d}</b><b>미국 거래일 {market_date:%Y-%m-%d}</b><b>시장 {_safe(market_state['state'])}</b><b>위험 {_safe(market_state['risk_level'])}</b><b>자동매매 없음</b></div></div></header>
<main class="wrap"><section class="changes"><article class="change-card"><span>시장 구조</span><b>{_safe(market_state['state'])}</b><small>S&P 20일 {_pct(market_state['sp500_return_20d'])} · 50일선 상회 {_pct(market_state['breadth_above_ma50'], signed=False)} · VIX {_num(market_state['vix'])}</small></article><article class="change-card"><span>섹터 순위 변화</span><b>{_safe(sector_mover.sector_display)}</b><small>전일 대비 {_rank_delta(sector_mover.rank_change_1d)} · 종합 1위 {_safe(top_sector.sector_display)} · 대장 {_safe(top_sector.leader)}</small></article><article class="change-card"><span>테마 순위 변화</span><b>{_safe(theme_mover.theme)}</b><small>전일 대비 {_rank_delta(theme_mover.rank_change_1d)} · 종합 1위 {_safe(top_theme.theme)} · 대장 {_safe(top_theme.leader)}</small></article></section>
<section class="section"><div class="section-title"><div><span>MACRO REGIME</span><h2>성장·물가·금리·위험선호</h2></div><p>수준보다 최근 변화 방향을 우선한다. 월간 지표는 발표 시차가 있다.</p></div><div class="axes">{axis_cards}</div></section>
<section class="section"><div class="section-title"><div><span>TRANSMISSION</span><h2>거시 변화가 가격으로 전달됐는가</h2></div><p>고정된 인과관계가 아니라 기본 가설과 실제 상대수익률의 일치 여부다.</p></div><div class="transmissions">{transmission_cards}</div></section>
<section class="section"><div class="section-title"><div><span>CROSS ASSET</span><h2>전체 시장과 교차자산</h2></div></div><div class="table-wrap"><table><thead><tr><th>지수·자산</th><th>1일</th><th>5일</th><th>20일</th><th>200일선 괴리</th><th>차트 단계</th></tr></thead><tbody>{market_rows}</tbody></table></div></section>
<section class="section"><div class="section-title"><div><span>SECTOR ROTATION</span><h2>섹터 순위와 변화</h2></div><p>순위 상승은 양수 화살표로 표시한다. 종합점수와 단기 상승폭은 같은 뜻이 아니다.</p></div><div class="table-wrap"><table><thead><tr><th>순위</th><th>섹터·대장주</th><th>전일</th><th>5일</th><th>점수</th><th>5일 상대</th><th>20일 상대</th><th>60일 상대</th><th>50일선 상회</th><th>단계</th></tr></thead><tbody>{sector_rows}</tbody></table></div></section>
<section class="section"><div class="section-title"><div><span>THEME ROTATION</span><h2>테마 순위와 변화</h2></div><p>단기 급부상과 장기 추세를 분리해 본다.</p></div><div class="table-wrap"><table><thead><tr><th>순위</th><th>테마·대장주</th><th>전일</th><th>5일</th><th>점수</th><th>5일 상대</th><th>20일 상대</th><th>60일 상대</th><th>50일선 상회</th><th>단계</th></tr></thead><tbody>{theme_rows}</tbody></table></div></section>
<section class="section"><div class="section-title"><div><span>LEADERS</span><h2>대장주와 과열 위험</h2></div></div><div class="table-wrap"><table><thead><tr><th>구분</th><th>그룹</th><th>회사명(티커)</th><th>20일</th><th>60일</th><th>차트 단계</th><th>확인할 위험</th></tr></thead><tbody>{leader_rows}</tbody></table></div></section>
<section class="section"><div class="section-title"><div><span>ECONOMIC CALENDAR</span><h2>발표 결과와 향후 일정</h2></div><p>공식 컨센서스가 없으면 임의로 생성하지 않는다.</p></div><div class="table-wrap"><table><thead><tr><th>시각(미 동부)</th><th>해당 거래일 발표</th><th>최근 정형값</th><th>컨센서스</th><th>반응 기준</th></tr></thead><tbody>{today_rows}</tbody></table><table><thead><tr><th>시각(미 동부)</th><th>향후 발표</th><th>출처</th><th>반응 기준</th></tr></thead><tbody>{upcoming_rows}</tbody></table></div></section>
<section class="section"><div class="section-title"><div><span>NEWS CLUSTERS</span><h2>기사 목록이 아닌 사건 단위 뉴스</h2></div><p>출처 등급·중복 건수·관련 가격 반응을 함께 표시한다.</p></div><div class="news-grid">{news_cards}</div></section>
<section class="section"><div class="section-title"><div><span>RAW MACRO</span><h2>금리·물가·경기 원자료</h2></div></div><div class="table-wrap"><table><thead><tr><th>지표</th><th>최신값</th><th>직전 변화</th><th>관측일</th><th>의미</th></tr></thead><tbody>{macro_rows}</tbody></table></div></section>
<footer>가격 심볼 {quality['prices']['successful']}/{quality['prices']['requested']} · S&P 500 스냅샷 {quality['stock_snapshot_rows']}개 · 런타임 검증 {'통과' if quality['validation']['passed'] else '실패'}<br>이 문서는 시장 관찰 자료이며 매수·매도·보유 또는 목표 비중을 자동으로 결정하지 않는다. 뉴스 해석과 거시 전파 규칙은 1차 가설이므로 원문과 실제 가격 반응을 함께 확인해야 한다.</footer></main></body></html>"""

