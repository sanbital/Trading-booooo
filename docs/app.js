(() => {
  "use strict";

  const $ = id => document.getElementById(id);
  const config = window.TRADING_SCANNER_CONFIG || {};
  let latestResult = null;
  let progressTimers = [];

  const elements = {
    configError: $("config-error"),
    accessError: $("access-error"),
    scanButton: $("scan-button"),
    scanButtonLabel: $("scan-button-label"),
    scanSpinner: $("scan-spinner"),
    scanStatus: $("scan-status"),
    capitalInput: $("capital-input"),
    riskInput: $("risk-input"),
    results: $("results"),
    headline: $("headline"),
    resultSubline: $("result-subline"),
    totalMarkets: $("total-markets"),
    eligibleMarkets: $("eligible-markets"),
    deepMarkets: $("deep-markets"),
    elapsed: $("elapsed"),
    noBuyBanner: $("no-buy-banner"),
    primarySection: $("primary-section"),
    primaryName: $("primary-name"),
    primaryMarket: $("primary-market"),
    primaryDecision: $("primary-decision"),
    primaryScore: $("primary-score"),
    primaryConfidence: $("primary-confidence"),
    primaryPrice: $("primary-price"),
    primaryChange: $("primary-change"),
    primaryEntry: $("primary-entry"),
    primaryShortTarget: $("primary-short-target"),
    primaryShortReturn: $("primary-short-return"),
    primaryMediumTarget: $("primary-medium-target"),
    primaryMediumReturn: $("primary-medium-return"),
    primaryStop: $("primary-stop"),
    primaryStopLoss: $("primary-stop-loss"),
    primaryInvestment: $("primary-investment"),
    primaryRiskBudget: $("primary-risk-budget"),
    primaryHorizon: $("primary-horizon"),
    persistenceMeter: $("persistence-meter"),
    persistenceScore: $("persistence-score"),
    primaryHorizonNote: $("primary-horizon-note"),
    primaryPositives: $("primary-positives"),
    primaryWarnings: $("primary-warnings"),
    recommendationsGrid: $("recommendations-grid"),
    rankingBody: $("ranking-body"),
    coverageExclusions: $("coverage-exclusions"),
    copyReportBtn: $("copy-report-btn"),
    copyStatus: $("copy-status"),
    footerMeta: $("footer-meta")
  };

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function setHidden(element, hidden) {
    if (element) element.classList.toggle("hidden", hidden);
  }

  function accessToken() {
    const raw = window.location.hash.replace(/^#/, "").trim();
    if (!raw) return "";
    const params = new URLSearchParams(raw);
    return (params.get("access") || params.get("token") || (!raw.includes("=") ? raw : "")).trim();
  }

  function validateConfiguration() {
    const problems = [];
    if (!/^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(String(config.supabaseUrl || ""))) {
      problems.push("config.js의 supabaseUrl을 실제 프로젝트 URL로 바꾸세요.");
    }
    if (!config.supabasePublishableKey || String(config.supabasePublishableKey).includes("YOUR_")) {
      problems.push("config.js의 Publishable 또는 Anon Key를 입력하세요.");
    }
    if (problems.length) {
      elements.configError.textContent = problems.join(" ");
      setHidden(elements.configError, false);
    }
    const token = accessToken();
    if (!token || token.length < 24) {
      elements.accessError.innerHTML = "개인 접속 토큰이 URL에 없습니다. 배포 가이드대로 <code>#access=개인토큰</code>이 포함된 주소로 접속하세요.";
      setHidden(elements.accessError, false);
    }
    const valid = problems.length === 0 && token.length >= 24;
    elements.scanButton.disabled = !valid;
    return valid;
  }

  function price(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return "—";
    const digits = number >= 1000 ? 0 : number >= 100 ? 1 : number >= 1 ? 3 : number >= 0.01 ? 5 : 8;
    return `${number.toLocaleString("ko-KR", { maximumFractionDigits: digits })}원`;
  }

  function krw(value) {
    const number = Number(value);
    return Number.isFinite(number) ? `${Math.round(number).toLocaleString("ko-KR")}원` : "—";
  }

  function percent(value, digits = 2, signed = false) {
    const number = Number(value);
    if (!Number.isFinite(number)) return "—";
    return `${signed && number > 0 ? "+" : ""}${number.toFixed(digits)}%`;
  }

  function turnover(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return "—";
    if (number >= 1_000_000_000_000) return `${(number / 1_000_000_000_000).toFixed(2)}조`;
    if (number >= 100_000_000) return `${(number / 100_000_000).toFixed(1)}억`;
    return `${Math.round(number / 10_000).toLocaleString("ko-KR")}만`;
  }

  function kst(iso) {
    const date = new Date(iso);
    return Number.isNaN(date.getTime())
      ? "—"
      : new Intl.DateTimeFormat("ko-KR", {
          timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit",
          hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false
        }).format(date) + " KST";
  }

  function trendLabel(signal) {
    const value = Number(signal);
    if (value >= 0.35) return ["상승", "up"];
    if (value <= -0.25) return ["하락", "down"];
    return ["중립", "flat"];
  }

  function listItems(items, fallback) {
    const rows = items?.length ? items : [fallback];
    return rows.map(item => `<li>${escapeHtml(item)}</li>`).join("");
  }

  function renderPrimary(candidate) {
    setHidden(elements.primarySection, !candidate);
    if (!candidate) return;
    const plan = candidate.trade_plan;
    const horizon = candidate.horizon;
    elements.primaryName.textContent = candidate.korean_name;
    elements.primaryMarket.textContent = candidate.market;
    elements.primaryDecision.textContent = candidate.decision_label;
    elements.primaryScore.textContent = Math.round(candidate.score);
    elements.primaryConfidence.textContent = percent(candidate.confidence, 1);
    elements.primaryPrice.textContent = price(candidate.current_price);
    elements.primaryChange.textContent = `24시간 ${percent(candidate.change_24h_pct, 2, true)}`;
    elements.primaryChange.className = candidate.change_24h_pct >= 0 ? "positive-text" : "negative-text";
    elements.primaryEntry.textContent = `${price(plan.entry_low)} ~ ${price(plan.entry_high)}`;
    elements.primaryShortTarget.textContent = price(plan.short_target);
    elements.primaryShortReturn.textContent = `비용 반영 ${percent(plan.short_net_return_pct, 2, true)}`;
    elements.primaryMediumTarget.textContent = price(plan.medium_target);
    elements.primaryMediumReturn.textContent = `비용 반영 ${percent(plan.medium_net_return_pct, 2, true)}`;
    elements.primaryStop.textContent = price(plan.stop_price);
    elements.primaryStopLoss.textContent = `예상 손실 ${percent(plan.net_stop_pct)} · ${krw(plan.estimated_loss_krw)}`;
    elements.primaryInvestment.textContent = krw(plan.recommended_investment_krw);
    elements.primaryRiskBudget.textContent = `위험예산 ${krw(plan.risk_budget_krw)} · R:R ${plan.net_rr.toFixed(2)}`;
    elements.primaryHorizon.textContent = `${horizon.label} · ${horizon.expected_window}`;
    elements.persistenceMeter.style.width = `${Math.max(0, Math.min(100, horizon.persistence_score))}%`;
    elements.persistenceScore.textContent = `${Math.round(horizon.persistence_score)}점`;
    elements.primaryHorizonNote.textContent = horizon.estimate;
    elements.primaryPositives.innerHTML = listItems(candidate.positives, "강한 추가 근거가 없습니다.");
    elements.primaryWarnings.innerHTML = listItems(
      [...horizon.invalidation, ...(candidate.warnings || []).slice(0, 3)],
      "별도 경고가 없습니다."
    );
  }

  function candidateCard(candidate) {
    const actionable = candidate.decision === "BUY" && candidate.trade_plan?.actionable;
    const plan = candidate.trade_plan || {};
    const watch = candidate.watch_entry_plan || {};
    const dynamic = candidate.microstructure?.dynamic || {};
    const tone = candidate.decision.toLowerCase();
    const dynamicRisk = ["SPOOF_LIKE_RISK", "ASK_ABSORPTION_RISK", "SUPPORT_BREAKDOWN_RISK"].includes(dynamic.status);
    const dynamicTone = dynamicRisk
      ? "risk"
      : dynamic.status === "BREAKOUT_CONFIRMED"
      ? "pass"
      : dynamic.status === "INSUFFICIENT" || !dynamic.status
      ? "muted"
      : "neutral";
    const blockingLabels = (candidate.gates || []).filter(gate => !gate.passed).map(gate => gate.label).slice(0, 2);
    const planRows = actionable
      ? `<div class="candidate-plan">
          <span><small>매수 구간</small><b>${escapeHtml(price(plan.entry_low))} ~ ${escapeHtml(price(plan.entry_high))}</b></span>
          <span><small>단기 / 중기 목표</small><b>${escapeHtml(price(plan.short_target))} / ${escapeHtml(price(plan.medium_target))}</b></span>
          <span><small>손절가격</small><b class="negative-text">${escapeHtml(price(plan.stop_price))}</b></span>
          <span><small>예상 보유</small><b>${escapeHtml(candidate.horizon.expected_window)}</b></span>
        </div>`
      : watch.available
      ? `<div class="candidate-plan watch-plan">
          <span><small>조건부 대기 매수가</small><b>${escapeHtml(price(watch.zone_low))} ~ ${escapeHtml(price(watch.zone_high))}</b></span>
          <span><small>최대 허용 매수가</small><b>${escapeHtml(price(watch.max_price))}</b></span>
          <span><small>무효화 가격</small><b class="negative-text">${escapeHtml(price(watch.invalidation_price))}</b></span>
          <span><small>상태</small><b>${escapeHtml(watch.label)}</b></span>
        </div><p class="watch-note">가격 도달 시 자동매수 금지 · 15분봉 마감 후 재스캔</p>`
      : `<div class="candidate-plan muted-plan"><span><small>대기 매수가</small><b>미제시 · ${escapeHtml(blockingLabels.join("·") || "안전조건 미충족")}</b></span><span><small>관찰 분류</small><b>${escapeHtml(candidate.horizon.label)}</b></span></div>`;
    const failed = (candidate.gates || []).filter(gate => !gate.passed).slice(0, 3);
    return `<article class="candidate-card panel ${tone}">
      <div class="candidate-head">
        <div><span class="rank">#${candidate.rank || "—"}</span><h3>${escapeHtml(candidate.korean_name)}</h3><small>${escapeHtml(candidate.market)}</small></div>
        <span class="verdict ${tone}">${escapeHtml(candidate.decision_label)}</span>
      </div>
      <div class="candidate-score"><strong>${Number(candidate.score).toFixed(1)}</strong><span>점</span><i></i><small>신뢰도 ${percent(candidate.confidence, 1)}</small></div>
      <div class="candidate-market"><span>현재가 <b>${escapeHtml(price(candidate.current_price))}</b></span><span class="${candidate.change_24h_pct >= 0 ? "positive-text" : "negative-text"}">${percent(candidate.change_24h_pct, 2, true)}</span></div>
      ${planRows}
      <div class="dynamic-strip ${dynamicTone}">
        <span>동적 호가</span><b>${escapeHtml(dynamic.label || "이전 결과·재스캔 필요")}</b>
        <small>${Number(dynamic.observation_ms || 0) / 1000}s · 호가 ${Number(dynamic.distinct_book_updates || 0)} · 동시간 체결 ${Number(dynamic.aligned_trade_count || 0)}</small>
      </div>
      <ul class="failed-list">${failed.length ? failed.map(item => `<li>${escapeHtml(item.label)}</li>`).join("") : "<li class=\"passed\">모든 강제조건 통과</li>"}</ul>
      <button class="card-copy" type="button" data-copy-market="${escapeHtml(candidate.market)}">이 후보 리포트 복사</button>
    </article>`;
  }

  function renderCandidates(result) {
    const finalists = result.finalists || [];
    elements.recommendationsGrid.innerHTML = finalists.length
      ? finalists.map(candidateCard).join("")
      : `<div class="empty panel">최종 정밀분석 결과가 없습니다.</div>`;
    elements.recommendationsGrid.querySelectorAll("[data-copy-market]").forEach(button => {
      button.addEventListener("click", async () => {
        const candidate = finalists.find(item => item.market === button.dataset.copyMarket);
        if (!candidate) return;
        await copyText(buildCandidateReport(candidate, result));
        button.textContent = "복사 완료";
        window.setTimeout(() => button.textContent = "이 후보 리포트 복사", 1500);
      });
    });
  }

  function renderRanking(rows) {
    elements.rankingBody.innerHTML = (rows || []).map(row => {
      const cells = [row.trend?.m5, row.trend?.m15, row.trend?.h4, row.trend?.day]
        .map(value => {
          const [label, className] = trendLabel(value);
          return `<td><span class="trend ${className}">${label}</span></td>`;
        }).join("");
      return `<tr>
        <td><b>${row.rank}</b></td><td><strong>${escapeHtml(row.korean_name)}</strong><small>${escapeHtml(row.market)}</small></td>
        <td>${escapeHtml(price(row.current_price))}</td><td class="${row.change_24h_pct >= 0 ? "positive-text" : "negative-text"}">${percent(row.change_24h_pct, 2, true)}</td>
        <td>${turnover(row.turnover_24h_krw)}</td><td><b>${Number(row.period_score).toFixed(1)}</b></td>${cells}
      </tr>`;
    }).join("");
  }

  function renderResult(result) {
    latestResult = result;
    setHidden(elements.results, false);
    elements.headline.textContent = result.headline || "분석 완료";
    elements.resultSubline.textContent = `${kst(result.meta?.generated_at)} · 엔진 ${result.meta?.engine_version || "—"} · ${result.cached ? "최근 결과 재사용" : "신규 조회"}`;
    elements.totalMarkets.textContent = Number(result.coverage?.listed_krw_markets || 0).toLocaleString("ko-KR");
    elements.eligibleMarkets.textContent = Number(result.coverage?.eligible_after_safety_filter || 0).toLocaleString("ko-KR");
    elements.deepMarkets.textContent = Number(result.coverage?.deep_period_analyzed || 0).toLocaleString("ko-KR");
    elements.elapsed.textContent = `${Number(result.meta?.elapsed_seconds || 0).toFixed(1)}초`;
    setHidden(elements.noBuyBanner, result.status !== "NO_BUY");
    renderPrimary(result.primary);
    renderCandidates(result);
    renderRanking(result.ranking || []);
    elements.coverageExclusions.innerHTML = (result.coverage?.excluded_summary || []).length
      ? result.coverage.excluded_summary.map(item => `<li><span>${escapeHtml(item.reason)}</span><b>${item.count}개</b></li>`).join("")
      : "<li><span>1차 제외 없음</span><b>0개</b></li>";
    elements.footerMeta.textContent = `엔진 ${result.meta?.engine_version || "—"} · ${kst(result.meta?.generated_at)}`;
    try { localStorage.setItem("trading-booooo-last-scan", JSON.stringify(result)); } catch (_) {}
    window.setTimeout(() => elements.results.scrollIntoView({ behavior: "smooth", block: "start" }), 100);
  }

  function timeframeLine(label, metric) {
    if (!metric) return `- ${label}: 데이터 없음`;
    return `- ${label}: 추세 ${Number(metric.trend_signal).toFixed(3)}, RSI14 ${metric.rsi14 == null ? "N/A" : Number(metric.rsi14).toFixed(1)}, EMA9/21/50 ${price(metric.ema9)} / ${price(metric.ema21)} / ${price(metric.ema50)}, ATR ${percent(metric.atr_pct)}, 3봉수익률 ${percent(metric.return_3_pct, 2, true)}, 12봉수익률 ${percent(metric.return_12_pct, 2, true)}, 거래대금비 ${Number(metric.volume_ratio).toFixed(2)}배`;
  }

  function buildCandidateReport(candidate, result) {
    const actionable = candidate.decision === "BUY" && candidate.trade_plan?.actionable;
    const plan = candidate.trade_plan || {};
    const watch = candidate.watch_entry_plan || {};
    const watchAvailable = !actionable && Boolean(watch.available);
    const watchLines = watchAvailable
      ? [
          `- 조건부 대기 매수구간: ${price(watch.zone_low)} ~ ${price(watch.zone_high)}`,
          `- 최대 허용 매수가: ${price(watch.max_price)} / 현재가 대비 ${percent(-Number(watch.discount_from_current_pct || 0), 2, true)}`,
          `- 대기 계획 무효화: ${price(watch.invalidation_price)} 이탈`,
          watch.reference_target
            ? `- 현재 데이터 기준 참고 목표가: ${price(watch.reference_target)}${watch.estimated_net_rr == null ? " / 손익비 재산정 필요" : ` / 예상 순손익비 ${Number(watch.estimated_net_rr).toFixed(2)}`}`
            : "- 현재 데이터 기준 참고 목표가: 미제시(가격 도달 후 재산정)",
          `- 예약매수 상태: ${watch.label}`,
          `- 주의: ${watch.note}`,
        ]
      : [];
    const lines = [
      `## ${candidate.korean_name} (${candidate.market})`,
      `- 판정: ${candidate.decision_label}`,
      `- 현재가: ${price(candidate.current_price)} / 24시간: ${percent(candidate.change_24h_pct, 2, true)}`,
      `- 종합점수: ${Number(candidate.score).toFixed(2)} / 신뢰도: ${percent(candidate.confidence, 1)}`,
      `- 24시간 거래대금: ${turnover(candidate.turnover_24h_krw)}원`,
      actionable ? `- 매수 검토 구간: ${price(plan.entry_low)} ~ ${price(plan.entry_high)}` : "- 현재가 매수 검토 구간: 미제시(강제조건 미통과)",
      ...watchLines,
      actionable ? `- 단기 목표가: ${price(plan.short_target)} (비용 반영 ${percent(plan.short_net_return_pct, 2, true)})` : "- 단기 목표가: 미제시",
      actionable ? `- 중기 목표가: ${price(plan.medium_target)} (비용 반영 ${percent(plan.medium_net_return_pct, 2, true)})` : "- 중기 목표가: 미제시",
      actionable ? `- 손절가격: ${price(plan.stop_price)} (비용 반영 예상손실 ${percent(plan.net_stop_pct)})` : "- 손절가격: 미제시",
      actionable ? `- 추천 투입금: ${krw(plan.recommended_investment_krw)} / 위험예산 ${krw(plan.risk_budget_krw)} / R:R ${Number(plan.net_rr).toFixed(2)}` : "- 투입금·손익비: 미제시",
      `- 추세 유지 추정: ${candidate.horizon.label}, ${candidate.horizon.expected_window}, 지속성 ${Number(candidate.horizon.persistence_score).toFixed(1)}점`,
      `- 추정 설명: ${candidate.horizon.estimate}`,
      ...(watchAvailable
        ? [
            "",
            "### 조건부 대기 매수 전 확인",
            ...(watch.conditions || []).map(item => `- ${item}`),
          ]
        : []),
      "",
      "### 시간축 지표",
      timeframeLine("5분", candidate.timeframes?.m5),
      timeframeLine("15분", candidate.timeframes?.m15),
      timeframeLine("4시간", candidate.timeframes?.h4),
      timeframeLine("일봉", candidate.timeframes?.day),
      "",
      "### 최신 호가·체결",
      `- 평균 스프레드: ${candidate.microstructure?.spread_bps == null ? "N/A" : Number(candidate.microstructure.spread_bps).toFixed(2) + "bp"}`,
      `- 정적 호가 불균형(단독 긍정점수 미사용): ${Number(candidate.microstructure?.book_imbalance || 0).toFixed(3)}`,
      `- 최근 체결 압력: ${Number(candidate.microstructure?.trade_pressure || 0).toFixed(3)} / 체결 표본 ${candidate.microstructure?.trade_count || 0}건`,
      `- 동적 판정: ${candidate.microstructure?.dynamic?.label || "데이터 없음"}`,
      `- 동적 표본: 관찰 ${Number(candidate.microstructure?.dynamic?.observation_ms || 0) / 1000}초 / 서로 다른 호가 ${candidate.microstructure?.dynamic?.distinct_book_updates || 0}회 / 동시간대 체결 ${candidate.microstructure?.dynamic?.aligned_trade_count || 0}건 / 품질 ${percent(Number(candidate.microstructure?.dynamic?.data_quality || 0) * 100, 1)}`,
      `- 의심 점수: 가짜 매수벽 ${Number(candidate.microstructure?.dynamic?.spoof_like_score || 0).toFixed(3)} / 매도 재보충·흡수 ${Number(candidate.microstructure?.dynamic?.ask_absorption_score || 0).toFixed(3)} / 돌파·지지전환 ${Number(candidate.microstructure?.dynamic?.breakout_score || 0).toFixed(3)}`,
      ...(candidate.microstructure?.dynamic?.evidence || []).map(item => `- 동적 근거: ${item}`),
      ...(candidate.microstructure?.dynamic?.warnings || []).map(item => `- 동적 경고: ${item}`),
      "",
      "### 긍정 근거",
      ...(candidate.positives?.length ? candidate.positives.map(item => `- ${item}`) : ["- 뚜렷한 추가 근거 없음"]),
      "",
      "### 위험·무효화 조건",
      ...candidate.horizon.invalidation.map(item => `- ${item}`),
      ...(candidate.warnings?.length ? candidate.warnings.map(item => `- ${item}`) : []),
      "",
      "### 강제 게이트",
      ...candidate.gates.map(gate => `- ${gate.passed ? "PASS" : "FAIL"} · ${gate.label}: ${gate.detail}`),
    ];
    if (result?.meta) lines.unshift(`- 분석시각: ${kst(result.meta.generated_at)} / 엔진 ${result.meta.engine_version}`, "");
    return lines.join("\n");
  }

  function buildFullReport(result) {
    const recommendations = result.recommendations || [];
    const report = [
      "# 업비트 KRW 전 종목 자동 스캔 리포트",
      "",
      `- 분석시각: ${kst(result.meta?.generated_at)}`,
      `- 엔진: ${result.meta?.engine_version}`,
      `- 최종 결론: ${result.headline}`,
      `- 분석 소요: ${Number(result.meta?.elapsed_seconds || 0).toFixed(2)}초`,
      `- 자동 주문: 없음`,
      "",
      "## 데이터 범위",
      `- 업비트 KRW 상장 ${result.coverage?.listed_krw_markets}개 전수 1차 점검`,
      `- 안전필터 통과 ${result.coverage?.eligible_after_safety_filter}개`,
      `- 안전필터 통과 종목 15분봉 기간점검: ${result.coverage?.period_screened_complete}/${result.coverage?.period_screened_markets}개`,
      `- 기간 정밀분석 ${result.coverage?.deep_period_analyzed}개`,
      `- 최신 호가·체결 검증 ${result.coverage?.microstructure_finalists}개`,
      `- 동적 WebSocket 관찰 ${result.coverage?.dynamic_orderflow?.websocket_markets || 0}개 / 충분한 동적 표본 ${result.coverage?.dynamic_orderflow?.sufficient_markets || 0}개 / 요청 관찰창 ${result.coverage?.dynamic_orderflow?.requested_observation_seconds || 0}초`,
      "- 조회창: 5분봉 약 6시간 / 15분봉 약 24시간 / 4시간봉 약 15일 / 일봉 약 60일",
      "",
      "## 최종 매수 결론",
      recommendations.length
        ? `- 현재 매수 강제조건 통과: ${recommendations.map(item => `${item.korean_name}(${item.market})`).join(", ")}`
        : "- 현재 매수 강제조건을 통과한 종목 없음. 관심 후보는 진입 추천이 아님.",
      "",
      ...(result.finalists || []).flatMap(candidate => [buildCandidateReport(candidate), "", "---", ""]),
      "## 기간분석 상위 순위",
      "|순위|종목|현재가|24H|거래대금|기간점수|5분|15분|4시간|일봉|",
      "|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|",
      ...(result.ranking || []).map(row => `|${row.rank}|${row.korean_name} (${row.market})|${price(row.current_price)}|${percent(row.change_24h_pct, 2, true)}|${turnover(row.turnover_24h_krw)}|${Number(row.period_score).toFixed(1)}|${Number(row.trend?.m5).toFixed(2)}|${Number(row.trend?.m15).toFixed(2)}|${Number(row.trend?.h4).toFixed(2)}|${Number(row.trend?.day).toFixed(2)}|`),
      "",
      "## GPT/Claude 심층분석 요청",
      "위 리포트의 생성시각 이후 데이터는 임의로 가정하지 말고, 제공된 수치만 근거로 다음을 검증해 주세요.",
      "1. 현재 매수 후보가 실제로 단기·중기 추세 정렬과 호가·체결 조건을 동시에 충족하는지 반론 중심으로 검토",
      "2. 단기·중기 목표가와 손절가격의 구조적 근거 및 수수료·슬리피지 반영 손익비 재계산",
      "3. 추세 유지기간 분류가 과도하지 않은지, 더 보수적인 보유기간과 무효화 조건 제시",
      "4. 조건부 대기 매수구간이 지지선 위에 있고 가격 도달 후에도 목표가·순손익비가 유효한지 재검증",
      "5. 동적 호가 로그에서 비체결성 대형벽 취소·매도벽 재보충/흡수·지지 붕괴가 실제 체결량과 정합적인지 재검증",
      "6. 시장경보·저유동·추격매수·데이터 부족·뉴스 미반영 위험 점검",
      "7. 추천 근거가 약하면 억지 대안을 만들지 말고 '매수 보류'로 결론",
      "",
      "> 주의: 본 리포트는 공개 시세 기반 조건부 분석이며 미래 가격이나 수익을 보장하지 않습니다. 동적 호가 판정은 개별 주문 ID와 숨은 잔량을 볼 수 없어 스푸핑·아이스버그의 확정 판정이 아닙니다."
    ];
    return report.join("\n");
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
    } catch (_) {
      const textarea = document.createElement("textarea");
      textarea.value = text;
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand("copy");
      textarea.remove();
    }
  }

  function beginProgress() {
    progressTimers.forEach(clearTimeout);
    progressTimers = [];
    const steps = [
      [0, "1/5 · 업비트 원화마켓 전체 현재가·경보·거래대금을 점검 중입니다."],
      [4500, "2/5 · 안전필터 통과 전 종목의 15분봉 24시간 구간을 점검 중입니다."],
      [20000, "3/5 · 상위 30종목의 5분·4시간·일봉을 추가 분석 중입니다."],
      [39000, "4/5 · 최종 후보의 실시간 호가·체결을 동시 관찰 중입니다."],
      [52000, "5/5 · 가짜 벽 취소·매도 재보충·돌파 지지전환과 손익비를 교차검증 중입니다."],
      [75000, "API 응답이 평소보다 느립니다. 중단하지 말고 조금만 기다려 주세요."]
    ];
    for (const [delay, message] of steps) progressTimers.push(setTimeout(() => elements.scanStatus.textContent = message, delay));
  }

  function endProgress() {
    progressTimers.forEach(clearTimeout);
    progressTimers = [];
  }

  async function scan() {
    if (!validateConfiguration()) return;
    elements.scanButton.disabled = true;
    elements.scanButtonLabel.textContent = "전체 시장 분석 중";
    setHidden(elements.scanSpinner, false);
    elements.copyStatus.textContent = "";
    beginProgress();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Number(config.requestTimeoutMs || 140000));
    try {
      const endpoint = `${String(config.supabaseUrl).replace(/\/$/, "")}/functions/v1/${config.functionName || "market-scanner"}`;
      const response = await fetch(endpoint, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          "apikey": config.supabasePublishableKey,
          "x-scan-token": accessToken(),
          "x-client-info": "trading-booooo-web/2.1"
        },
        body: JSON.stringify({
          action: "scan",
          capital_krw: Number(elements.capitalInput.value || config.defaultCapitalKrw || 500000),
          risk_pct: Number(elements.riskInput.value || config.defaultRiskPct || 1),
          fee_per_side_pct: Number(config.defaultFeePerSidePct || 0.05),
          min_net_rr: Number(config.defaultMinNetRR || 1.5),
          max_stop_pct: Number(config.defaultMaxStopPct || 5)
        })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
      renderResult(data);
      elements.scanStatus.textContent = data.status === "NO_BUY"
        ? "스캔 완료 · 현재는 강제조건을 통과한 매수 후보가 없습니다."
        : `스캔 완료 · 현재 매수 후보 ${data.recommendations?.length || 0}개를 탐지했습니다.`;
    } catch (error) {
      const message = error?.name === "AbortError"
        ? "분석 요청 시간이 초과됐습니다. 잠시 후 다시 실행해 주세요."
        : `분석 실패: ${error?.message || error}`;
      elements.scanStatus.textContent = message;
      elements.scanStatus.classList.add("error-text");
    } finally {
      clearTimeout(timeout);
      endProgress();
      elements.scanButton.disabled = false;
      elements.scanButtonLabel.textContent = "원화마켓 전체 재스캔";
      setHidden(elements.scanSpinner, true);
    }
  }

  function boot() {
    elements.capitalInput.value = config.defaultCapitalKrw || 500000;
    elements.riskInput.value = config.defaultRiskPct || 1;
    validateConfiguration();
    elements.scanButton.addEventListener("click", scan);
    elements.copyReportBtn.addEventListener("click", async () => {
      if (!latestResult) return;
      await copyText(buildFullReport(latestResult));
      elements.copyStatus.textContent = "클립보드에 복사했습니다.";
      setTimeout(() => elements.copyStatus.textContent = "", 2200);
    });
    try {
      const stored = localStorage.getItem("trading-booooo-last-scan");
      if (stored) renderResult(JSON.parse(stored));
    } catch (_) {}
  }

  boot();
})();
