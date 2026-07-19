(() => {
  "use strict";

  const $ = id => document.getElementById(id);
  const config = window.TRADING_SCANNER_CONFIG || {};
  let latestResult = null;
  const latestResults = { combined: null, upbit: null, binance: null };
  let activeExchange = "combined";
  let scanning = false;
  let progressTimers = [];

  const exchangeSettings = {
    combined: {
      label: "업비트 + 바이낸스",
      quote: "MIXED",
      button: "두 거래소 동시 스캔",
      title: "업비트와 바이낸스를 동시에 점검하고<br>통합 Top 4만 추립니다.",
      description: "양 거래소 현물 전체를 병렬 분석하고 동일 코인은 한 자리로 합칩니다. 한쪽은 긍정이어도 다른 거래소에서 회피·스푸핑성 취소·매도흡수·지지붕괴가 확인되면 현재가 매수를 보류합니다."
    },
    upbit: {
      label: "업비트 현물",
      quote: "KRW",
      capital: Number(config.defaultCapitalKrw || 500000),
      min: 10000,
      step: 10000,
      unit: "원",
      fee: Number(config.defaultFeePerSidePct || 0.05),
      button: "원화마켓 전체 스캔",
      title: "업비트 원화마켓을 전수 점검하고<br>현재의 매수 후보만 추립니다.",
      description: "전체 상장 종목의 현재가·거래대금을 1차 점검하고, 안전필터 통과 종목 전부의 15분봉을 확인한 뒤 상위 후보의 5분·4시간·일봉과 최신 호가·체결을 교차검증합니다. 조건 미달이면 추천하지 않습니다."
    },
    binance: {
      label: "바이낸스 현물",
      quote: "USDT",
      capital: Number(config.defaultCapitalUsdt || 500),
      min: 10,
      step: 10,
      unit: "USDT",
      fee: Number(config.defaultBinanceFeePerSidePct || 0.1),
      button: "USDT 현물 전체 스캔",
      title: "바이낸스 USDT 현물을 전수 점검하고<br>현재의 매수 후보만 추립니다.",
      description: "바이낸스에서 거래 가능한 USDT 현물 전체를 기간 분석하고, 최종 후보의 실시간 호가와 체결을 교차검증합니다. 업비트 결과와 점수·자금·거래대금은 서로 섞지 않습니다."
    }
  };

  const elements = {
    configError: $("config-error"),
    exchangeTabs: [...document.querySelectorAll("[data-exchange]")],
    brandSubtitle: $("brand-subtitle"),
    heroTitle: $("hero-title"),
    heroDescription: $("hero-description"),
    capitalLabel: $("capital-label"),
    capitalUnit: $("capital-unit"),
    accessError: $("access-error"),
    scanButton: $("scan-button"),
    scanButtonLabel: $("scan-button-label"),
    scanSpinner: $("scan-spinner"),
    scanStatus: $("scan-status"),
    capitalInput: $("capital-input"),
    capitalUsdtInput: $("capital-usdt-input"),
    secondaryCapitalSetting: $("secondary-capital-setting"),
    riskInput: $("risk-input"),
    results: $("results"),
    exchangeWarning: $("exchange-warning"),
    headline: $("headline"),
    resultSubline: $("result-subline"),
    totalMarkets: $("total-markets"),
    eligibleMarkets: $("eligible-markets"),
    deepMarkets: $("deep-markets"),
    elapsed: $("elapsed"),
    listedMarketLabel: $("listed-market-label"),
    dataSourceLabel: $("data-source-label"),
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
    finalistsTitle: $("finalists-title"),
    finalistsDescription: $("finalists-description"),
    rankingTitle: $("ranking-title"),
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

  function activeQuote() {
    const quote = latestResult?.meta?.quote_currency || exchangeSettings[activeExchange].quote;
    return quote === "USDT" ? "USDT" : "KRW";
  }

  function candidateQuote(candidate) {
    return candidate?.quote_currency === "USDT" ? "USDT" : "KRW";
  }

  function price(value, quote = activeQuote()) {
    const number = Number(value);
    if (!Number.isFinite(number)) return "—";
    const digits = quote === "KRW"
      ? number >= 1000 ? 0 : number >= 100 ? 1 : number >= 1 ? 3 : number >= 0.01 ? 5 : 8
      : number >= 1000 ? 2 : number >= 1 ? 4 : number >= 0.01 ? 6 : 8;
    return `${number.toLocaleString("ko-KR", { maximumFractionDigits: digits })}${quote === "KRW" ? "원" : " USDT"}`;
  }

  function krw(value, quote = activeQuote()) {
    const number = Number(value);
    if (!Number.isFinite(number)) return "—";
    return quote === "KRW"
      ? `${Math.round(number).toLocaleString("ko-KR")}원`
      : `${number.toLocaleString("ko-KR", { maximumFractionDigits: 2 })} USDT`;
  }

  function percent(value, digits = 2, signed = false) {
    const number = Number(value);
    if (!Number.isFinite(number)) return "—";
    return `${signed && number > 0 ? "+" : ""}${number.toFixed(digits)}%`;
  }

  function turnover(value, quote = activeQuote()) {
    const number = Number(value);
    if (!Number.isFinite(number)) return "—";
    if (quote === "USDT") {
      if (number >= 1_000_000_000) return `${(number / 1_000_000_000).toFixed(2)}B USDT`;
      if (number >= 1_000_000) return `${(number / 1_000_000).toFixed(1)}M USDT`;
      if (number >= 1_000) return `${(number / 1_000).toFixed(1)}K USDT`;
      return `${number.toFixed(0)} USDT`;
    }
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
    const quote = candidateQuote(candidate);
    elements.primaryName.textContent = candidate.korean_name;
    elements.primaryMarket.textContent = `${candidate.source_exchange_label ? candidate.source_exchange_label + " · " : ""}${candidate.market}`;
    elements.primaryDecision.textContent = candidate.decision_label;
    elements.primaryScore.textContent = Math.round(candidate.combined_score ?? candidate.score);
    elements.primaryConfidence.textContent = percent(candidate.confidence, 1);
    elements.primaryPrice.textContent = price(candidate.current_price, quote);
    elements.primaryChange.textContent = `24시간 ${percent(candidate.change_24h_pct, 2, true)}`;
    elements.primaryChange.className = candidate.change_24h_pct >= 0 ? "positive-text" : "negative-text";
    elements.primaryEntry.textContent = `${price(plan.entry_low, quote)} ~ ${price(plan.entry_high, quote)}`;
    elements.primaryShortTarget.textContent = price(plan.expected_exit_price ?? plan.short_target, quote);
    elements.primaryShortReturn.textContent = `수수료·슬리피지 반영 ${percent(plan.expected_exit_net_return_pct ?? plan.short_net_return_pct, 2, true)}`;
    elements.primaryMediumTarget.textContent = price(plan.medium_target, quote);
    elements.primaryMediumReturn.textContent = `비용 반영 ${percent(plan.medium_net_return_pct, 2, true)}`;
    elements.primaryStop.textContent = price(plan.stop_price, quote);
    elements.primaryStopLoss.textContent = `예상 손실 ${percent(plan.net_stop_pct)} · ${krw(plan.estimated_loss_krw, quote)}`;
    elements.primaryInvestment.textContent = krw(plan.recommended_investment_quote ?? plan.recommended_investment_krw, quote);
    elements.primaryRiskBudget.textContent = `위험예산 ${krw(plan.risk_budget_krw, quote)} · R:R ${plan.net_rr.toFixed(2)}`;
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
    const quote = candidateQuote(candidate);
    const cross = candidate.cross_exchange;
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
          <span><small>매수 구간</small><b>${escapeHtml(price(plan.entry_low, quote))} ~ ${escapeHtml(price(plan.entry_high, quote))}</b></span>
          <span><small>진입 시 예상 매도가</small><b class="positive-text">${escapeHtml(price(plan.expected_exit_price ?? plan.short_target, quote))}</b></span>
          <span><small>손절가격</small><b class="negative-text">${escapeHtml(price(plan.stop_price, quote))}</b></span>
          <span><small>중기 목표 / 예상 보유</small><b>${escapeHtml(price(plan.medium_target, quote))} · ${escapeHtml(candidate.horizon.expected_window)}</b></span>
        </div>`
      : watch.available
      ? `<div class="candidate-plan watch-plan">
          <span><small>조건부 대기 매수가</small><b>${escapeHtml(price(watch.zone_low, quote))} ~ ${escapeHtml(price(watch.zone_high, quote))}</b></span>
          <span><small>진입 시 예상 매도가</small><b class="positive-text">${escapeHtml(price(watch.expected_exit_price ?? watch.reference_target, quote))}</b></span>
          <span><small>무효화 가격</small><b class="negative-text">${escapeHtml(price(watch.invalidation_price, quote))}</b></span>
          <span><small>예상 순수익 / 손익비</small><b>${escapeHtml(percent(watch.expected_net_return_pct, 2, true))} · ${Number(watch.estimated_net_rr).toFixed(2)}</b></span>
        </div><p class="watch-scenario"><b>진입</b> ${escapeHtml(watch.entry_trigger)}<br><b>매도</b> ${escapeHtml(watch.exit_trigger)}<br><b>예상 보유</b> ${escapeHtml(candidate.horizon.expected_window)} · 추세 무효화 시 목표가 전이라도 종료</p><p class="watch-note">가격 도달 시 자동매수 금지 · 15분봉 마감 후 재스캔</p>`
      : `<div class="candidate-plan muted-plan"><span><small>대기 매수가</small><b>미제시 · ${escapeHtml(blockingLabels.join("·") || "안전조건 미충족")}</b></span><span><small>관찰 분류</small><b>${escapeHtml(candidate.horizon.label)}</b></span></div>`;
    const failed = (candidate.gates || []).filter(gate => !gate.passed).slice(0, 3);
    const crossRows = cross?.venues?.map(venue =>
      `<span><b>${escapeHtml(venue.exchange_label)}</b> ${escapeHtml(venue.decision_label)} · ${Number(venue.score).toFixed(1)}점 · ${escapeHtml(venue.dynamic_label)}</span>`
    ).join("") || "";
    const crossStrip = cross
      ? `<div class="cross-venue-strip ${cross.conflict ? "conflict" : cross.both_buy ? "confirmed" : ""}">
          <strong>${escapeHtml(cross.label)}</strong>${crossRows}
        </div>`
      : "";
    return `<article class="candidate-card panel ${tone}">
      <div class="candidate-head">
        <div><span class="rank">#${candidate.rank || "—"}</span><h3>${escapeHtml(candidate.korean_name)}</h3><small>${escapeHtml(candidate.source_exchange_label ? candidate.source_exchange_label + " · " : "")}${escapeHtml(candidate.market)}</small></div>
        <span class="verdict ${tone}">${escapeHtml(candidate.decision_label)}</span>
      </div>
      <div class="candidate-score"><strong>${Number(candidate.combined_score ?? candidate.score).toFixed(1)}</strong><span>점</span><i></i><small>${cross ? "통합점수 · " : ""}신뢰도 ${percent(candidate.confidence, 1)}</small></div>
      <div class="candidate-market"><span>현재가 <b>${escapeHtml(price(candidate.current_price, quote))}</b></span><span class="${candidate.change_24h_pct >= 0 ? "positive-text" : "negative-text"}">${percent(candidate.change_24h_pct, 2, true)}</span></div>
      ${crossStrip}
      ${planRows}
      <div class="dynamic-strip ${dynamicTone}">
        <span>동적 호가</span><b>${escapeHtml(dynamic.label || "이전 결과·재스캔 필요")}</b>
        <small>${Number(dynamic.observation_ms || 0) / 1000}s · 호가 ${Number(dynamic.distinct_book_updates || 0)} · 체결 ${Number(dynamic.aligned_trade_count || 0)} · 구간 ${Number(dynamic.covered_phases || 0)}/3</small>
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
      const quote = row.quote_currency === "USDT" ? "USDT" : activeQuote();
      const cells = [row.trend?.m5, row.trend?.m15, row.trend?.h4, row.trend?.day]
        .map(value => {
          const [label, className] = trendLabel(value);
          return `<td><span class="trend ${className}">${label}</span></td>`;
        }).join("");
      return `<tr>
        <td><b>${row.rank}</b></td><td><span class="venue-badge ${escapeHtml(row.exchange || activeExchange)}">${escapeHtml(row.exchange_label || (activeExchange === "binance" ? "바이낸스" : "업비트"))}</span></td><td><strong>${escapeHtml(row.korean_name)}</strong><small>${escapeHtml(row.market)}</small></td>
        <td>${escapeHtml(price(row.current_price, quote))}</td><td class="${row.change_24h_pct >= 0 ? "positive-text" : "negative-text"}">${percent(row.change_24h_pct, 2, true)}</td>
        <td>${turnover(row.turnover_24h_quote ?? row.turnover_24h_krw, quote)}</td><td><b>${Number(row.period_score).toFixed(1)}</b></td>${cells}
      </tr>`;
    }).join("");
  }

  function renderResult(result, scroll = true) {
    latestResult = result;
    const exchange = result.meta?.exchange || activeExchange;
    latestResults[exchange] = result;
    if (exchange === "combined" && result.exchanges) {
      if (result.exchanges.upbit) latestResults.upbit = result.exchanges.upbit;
      if (result.exchanges.binance) latestResults.binance = result.exchanges.binance;
    }
    setHidden(elements.results, false);
    elements.headline.textContent = result.headline || "분석 완료";
    elements.resultSubline.textContent = `${kst(result.meta?.generated_at)} · 엔진 ${result.meta?.engine_version || "—"} · ${result.cached ? "최근 결과 재사용" : "신규 조회"}`;
    elements.totalMarkets.textContent = Number(result.coverage?.listed_markets ?? result.coverage?.listed_krw_markets ?? 0).toLocaleString("ko-KR");
    elements.eligibleMarkets.textContent = Number(result.coverage?.eligible_after_safety_filter || 0).toLocaleString("ko-KR");
    elements.deepMarkets.textContent = Number(result.coverage?.deep_period_analyzed || 0).toLocaleString("ko-KR");
    elements.elapsed.textContent = `${Number(result.meta?.elapsed_seconds || 0).toFixed(1)}초`;
    const combined = exchange === "combined";
    const exchangeErrors = result.exchange_errors || [];
    setHidden(elements.exchangeWarning, !exchangeErrors.length);
    elements.exchangeWarning.textContent = exchangeErrors.length
      ? `부분 결과입니다. ${exchangeErrors.map(item => `${item.exchange === "upbit" ? "업비트" : "바이낸스"}: ${item.message}`).join(" / ")}`
      : "";
    elements.finalistsTitle.textContent = combined ? "통합 Top 4" : "최종 정밀분석 후보";
    elements.finalistsDescription.textContent = combined
      ? "동일 기초자산을 한 자리로 합치고 양 거래소의 기간·호가·체결 신호를 교차검증한 결과입니다. 위험 신호가 충돌하면 BUY를 보류합니다."
      : "기간분석 상위 종목에 실시간 체결-호가 동적 교차검증을 추가한 결과입니다.";
    elements.rankingTitle.textContent = combined
      ? "양 거래소 기간분석 상위 20종목"
      : `${result.coverage?.exchange_label || "거래소"} 기간분석 상위 20종목`;
    setHidden(elements.noBuyBanner, result.status !== "NO_BUY");
    renderPrimary(result.primary);
    renderCandidates(result);
    renderRanking(result.ranking || []);
    elements.coverageExclusions.innerHTML = (result.coverage?.excluded_summary || []).length
      ? result.coverage.excluded_summary.map(item => `<li><span>${escapeHtml(item.reason)}</span><b>${item.count}개</b></li>`).join("")
      : "<li><span>1차 제외 없음</span><b>0개</b></li>";
    elements.footerMeta.textContent = `엔진 ${result.meta?.engine_version || "—"} · ${kst(result.meta?.generated_at)}`;
    try { localStorage.setItem(`trading-booooo-last-scan-${exchange}`, JSON.stringify(result)); } catch (_) {}
    if (combined && result.exchanges) {
      for (const venue of ["upbit", "binance"]) {
        if (!result.exchanges[venue]) continue;
        try { localStorage.setItem(`trading-booooo-last-scan-${venue}`, JSON.stringify(result.exchanges[venue])); } catch (_) {}
      }
    }
    if (scroll) window.setTimeout(() => elements.results.scrollIntoView({ behavior: "smooth", block: "start" }), 100);
  }

  function timeframeLine(label, metric, quote = activeQuote()) {
    if (!metric) return `- ${label}: 데이터 없음`;
    return `- ${label}: 추세 ${Number(metric.trend_signal).toFixed(3)}, RSI14 ${metric.rsi14 == null ? "N/A" : Number(metric.rsi14).toFixed(1)}, EMA9/21/50 ${price(metric.ema9, quote)} / ${price(metric.ema21, quote)} / ${price(metric.ema50, quote)}, ATR ${percent(metric.atr_pct)}, 3봉수익률 ${percent(metric.return_3_pct, 2, true)}, 12봉수익률 ${percent(metric.return_12_pct, 2, true)}, 거래대금비 ${Number(metric.volume_ratio).toFixed(2)}배`;
  }

  function buildCandidateReport(candidate, result) {
    const actionable = candidate.decision === "BUY" && candidate.trade_plan?.actionable;
    const plan = candidate.trade_plan || {};
    const watch = candidate.watch_entry_plan || {};
    const quote = candidateQuote(candidate);
    const cross = candidate.cross_exchange;
    const watchAvailable = !actionable && Boolean(watch.available);
    const watchLines = watchAvailable
      ? [
          `- 조건부 대기 매수구간: ${price(watch.zone_low, quote)} ~ ${price(watch.zone_high, quote)}`,
          `- 최대 허용 매수가: ${price(watch.max_price, quote)} / 현재가 대비 ${percent(-Number(watch.discount_from_current_pct || 0), 2, true)}`,
          `- 진입 시 예상 매도가: ${price(watch.expected_exit_price ?? watch.reference_target, quote)} / 예상 순수익 ${percent(watch.expected_net_return_pct, 2, true)} / R:R ${Number(watch.estimated_net_rr).toFixed(2)}`,
          `- 대기 계획 무효화: ${price(watch.invalidation_price, quote)} 이탈`,
          `- 진입 조건: ${watch.entry_trigger}`,
          `- 매도 조건: ${watch.exit_trigger}`,
          `- 예약매수 상태: ${watch.label}`,
          `- 주의: ${watch.note}`,
        ]
      : [];
    const lines = [
      `## ${candidate.korean_name} (${candidate.market})`,
      `- 거래소: ${candidate.source_exchange_label || (quote === "KRW" ? "업비트" : "바이낸스")}`,
      `- 판정: ${candidate.decision_label}`,
      `- 현재가: ${price(candidate.current_price, quote)} / 24시간: ${percent(candidate.change_24h_pct, 2, true)}`,
      `- 종합점수: ${Number(candidate.score).toFixed(2)}${candidate.combined_score != null ? ` / 통합점수: ${Number(candidate.combined_score).toFixed(2)}` : ""} / 신뢰도: ${percent(candidate.confidence, 1)}`,
      `- 24시간 거래대금: ${turnover(candidate.turnover_24h_quote ?? candidate.turnover_24h_krw, quote)}`,
      ...(cross
        ? [
            `- 교차거래소 판정: ${cross.label}`,
            ...cross.venues.map(venue => `- ${venue.exchange_label}: ${venue.market} / ${venue.decision_label} / ${Number(venue.score).toFixed(2)}점 / ${venue.dynamic_label}`),
          ]
        : []),
      actionable ? `- 매수 검토 구간: ${price(plan.entry_low, quote)} ~ ${price(plan.entry_high, quote)}` : "- 현재가 매수 검토 구간: 미제시(강제조건 미통과)",
      ...watchLines,
      actionable ? `- 진입 시 예상 매도가: ${price(plan.expected_exit_price ?? plan.short_target, quote)} (수수료·슬리피지 반영 ${percent(plan.expected_exit_net_return_pct ?? plan.short_net_return_pct, 2, true)})` : watchAvailable ? "- 현재가 진입 예상 매도가: 해당 없음(눌림 시나리오 참조)" : "- 진입 시 예상 매도가: 미제시",
      actionable ? `- 단기 목표가: ${price(plan.short_target, quote)}` : "- 현재가 기준 단기 목표가: 미제시",
      actionable ? `- 중기 목표가: ${price(plan.medium_target, quote)} (비용 반영 ${percent(plan.medium_net_return_pct, 2, true)})` : "- 중기 목표가: 미제시",
      actionable ? `- 손절가격: ${price(plan.stop_price, quote)} (비용 반영 예상손실 ${percent(plan.net_stop_pct)})` : "- 손절가격: 미제시",
      actionable ? `- 추천 투입금: ${krw(plan.recommended_investment_quote ?? plan.recommended_investment_krw, quote)} / 위험예산 ${krw(plan.risk_budget_krw, quote)} / R:R ${Number(plan.net_rr).toFixed(2)}` : "- 투입금·손익비: 미제시",
      `- 추세 유지 추정: ${candidate.horizon.label}, ${candidate.horizon.expected_window}, 지속성 ${Number(candidate.horizon.persistence_score).toFixed(1)}점`,
      `- 추정 설명: ${candidate.horizon.estimate}`,
      ...(watchAvailable
        ? [
            "",
            "### 관찰·눌림대기 실행 시나리오",
            `- 예상 보유 범위: ${candidate.horizon.expected_window} (추세 무효화 시 목표가 전 조기 종료)`,
            ...(watch.scenario || []).map(item => `- ${item}`),
            "",
            "### 조건부 대기 매수 전 확인",
            ...(watch.conditions || []).map(item => `- ${item}`),
          ]
        : []),
      "",
      "### 시간축 지표",
      timeframeLine("5분", candidate.timeframes?.m5, quote),
      timeframeLine("15분", candidate.timeframes?.m15, quote),
      timeframeLine("4시간", candidate.timeframes?.h4, quote),
      timeframeLine("일봉", candidate.timeframes?.day, quote),
      "",
      "### 최신 호가·체결",
      `- 평균 스프레드: ${candidate.microstructure?.spread_bps == null ? "N/A" : Number(candidate.microstructure.spread_bps).toFixed(2) + "bp"}`,
      `- 정적 호가 불균형(단독 긍정점수 미사용): ${Number(candidate.microstructure?.book_imbalance || 0).toFixed(3)}`,
      `- 최근 체결 압력: ${Number(candidate.microstructure?.trade_pressure || 0).toFixed(3)} / 체결 표본 ${candidate.microstructure?.trade_count || 0}건`,
      `- 동적 판정: ${candidate.microstructure?.dynamic?.label || "데이터 없음"}`,
      `- 동적 표본: 관찰 ${Number(candidate.microstructure?.dynamic?.observation_ms || 0) / 1000}초 / 서로 다른 호가 ${candidate.microstructure?.dynamic?.distinct_book_updates || 0}회 / 동시간대 체결 ${candidate.microstructure?.dynamic?.aligned_trade_count || 0}건 / 품질 ${percent(Number(candidate.microstructure?.dynamic?.data_quality || 0) * 100, 1)}`,
      `- 구간 분산: 초반·중반·확인 ${candidate.microstructure?.dynamic?.covered_phases || 0}/3개 유효 / 호가 ${(candidate.microstructure?.dynamic?.phase_book_updates || []).join("/") || "—"}회 / 체결 ${(candidate.microstructure?.dynamic?.phase_trade_counts || []).join("/") || "—"}건`,
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
    const combined = result.meta?.exchange === "combined";
    const exchangeLabel = result.coverage?.exchange_label || (result.meta?.exchange === "binance" ? "바이낸스 현물" : "업비트 현물");
    const quote = result.meta?.quote_currency || "KRW";
    const report = [
      `# ${combined ? "업비트·바이낸스 통합 Top 4" : `${exchangeLabel} ${quote} 전 종목`} 자동 스캔 리포트`,
      "",
      `- 분석시각: ${kst(result.meta?.generated_at)}`,
      `- 엔진: ${result.meta?.engine_version}`,
      `- 최종 결론: ${result.headline}`,
      `- 분석 소요: ${Number(result.meta?.elapsed_seconds || 0).toFixed(2)}초`,
      `- 자동 주문: 없음`,
      "",
      "## 데이터 범위",
      `- ${exchangeLabel}${combined ? "" : ` ${quote}`} 거래 가능 ${result.coverage?.listed_markets ?? result.coverage?.listed_krw_markets}개 전수 1차 점검`,
      `- 안전필터 통과 ${result.coverage?.eligible_after_safety_filter}개`,
      `- 안전필터 통과 종목 15분봉 기간점검: ${result.coverage?.period_screened_complete}/${result.coverage?.period_screened_markets}개`,
      `- 기간 정밀분석 ${result.coverage?.deep_period_analyzed}개`,
      `- 최신 호가·체결 검증 ${result.coverage?.microstructure_finalists}개`,
      `- 동적 WebSocket 관찰 ${result.coverage?.dynamic_orderflow?.websocket_markets || 0}개 / 충분한 동적 표본 ${result.coverage?.dynamic_orderflow?.sufficient_markets || 0}개 / 요청 관찰창 ${result.coverage?.dynamic_orderflow?.requested_observation_seconds || 0}초`,
      ...(combined
        ? [
            `- 통합 후보: 중복 기초자산 제거 후 ${result.finalists?.length || 0}개`,
            "- 교차 규칙: 다른 거래소에서 AVOID 또는 동적 호가 위험이 나오면 현재 BUY를 WAIT로 강등",
            ...((result.exchange_errors || []).map(item => `- 부분 실패: ${item.exchange === "upbit" ? "업비트" : "바이낸스"} · ${item.message}`)),
          ]
        : []),
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
      ...(result.ranking || []).map(row => {
        const rowQuote = row.quote_currency === "USDT" ? "USDT" : combined ? "KRW" : activeQuote();
        return `|${row.rank}|${row.exchange_label ? row.exchange_label + " · " : ""}${row.korean_name} (${row.market})|${price(row.current_price, rowQuote)}|${percent(row.change_24h_pct, 2, true)}|${turnover(row.turnover_24h_quote ?? row.turnover_24h_krw, rowQuote)}|${Number(row.period_score).toFixed(1)}|${Number(row.trend?.m5).toFixed(2)}|${Number(row.trend?.m15).toFixed(2)}|${Number(row.trend?.h4).toFixed(2)}|${Number(row.trend?.day).toFixed(2)}|`;
      }),
      "",
      "## GPT/Claude 심층분석 요청",
      "위 리포트의 생성시각 이후 데이터는 임의로 가정하지 말고, 제공된 수치만 근거로 다음을 검증해 주세요.",
      "1. 현재 매수 후보가 실제로 단기·중기 추세 정렬과 호가·체결 조건을 동시에 충족하는지 반론 중심으로 검토",
      "2. 단기·중기 목표가와 손절가격의 구조적 근거 및 수수료·슬리피지 반영 손익비 재계산",
      "3. 추세 유지기간 분류가 과도하지 않은지, 더 보수적인 보유기간과 무효화 조건 제시",
      "4. 조건부 대기 매수구간·예상 매도가·손절가로 구성된 눌림 시나리오가 실제 지지선과 비용 포함 손익비를 충족하는지 재검증",
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

  function applyExchangeUI(exchange, renderStored = true) {
    if (scanning || !exchangeSettings[exchange]) return;
    if (activeExchange === "binance") {
      exchangeSettings.binance.capital = Number(elements.capitalInput.value || exchangeSettings.binance.capital);
      elements.capitalUsdtInput.value = exchangeSettings.binance.capital;
    } else if (activeExchange === "combined") {
      exchangeSettings.upbit.capital = Number(elements.capitalInput.value || exchangeSettings.upbit.capital);
      exchangeSettings.binance.capital = Number(elements.capitalUsdtInput.value || exchangeSettings.binance.capital);
    } else {
      exchangeSettings.upbit.capital = Number(elements.capitalInput.value || exchangeSettings.upbit.capital);
    }
    activeExchange = exchange;
    const settings = exchangeSettings[exchange];
    elements.exchangeTabs.forEach(button => button.classList.toggle("active", button.dataset.exchange === exchange));
    elements.heroTitle.innerHTML = settings.title;
    elements.heroDescription.textContent = settings.description;
    const combined = exchange === "combined";
    const capitalSettings = exchange === "binance" ? exchangeSettings.binance : exchangeSettings.upbit;
    elements.capitalInput.value = capitalSettings.capital;
    elements.capitalInput.min = capitalSettings.min;
    elements.capitalInput.step = capitalSettings.step;
    elements.capitalUnit.textContent = capitalSettings.unit;
    elements.capitalLabel.textContent = combined ? "업비트 기준 자본" : "기준 자본";
    setHidden(elements.secondaryCapitalSetting, !combined);
    elements.capitalUsdtInput.value = exchangeSettings.binance.capital;
    elements.listedMarketLabel.textContent = combined ? "양 거래소 상장 종목" : `${settings.quote} 상장 종목`;
    elements.dataSourceLabel.textContent = combined ? "두 거래소 공개시세" : `${settings.label} 공개시세`;
    elements.scanButtonLabel.textContent = latestResults[exchange] ? settings.button.replace("스캔", "재스캔") : settings.button;
    elements.scanStatus.classList.remove("error-text");
    elements.scanStatus.textContent = combined
      ? "버튼을 누르면 업비트 KRW와 바이낸스 USDT 현물을 병렬 분석합니다. 약 70~260초가 걸릴 수 있습니다."
      : `버튼을 누르면 ${settings.label} ${settings.quote} 전체를 분석합니다. 약 70~180초가 걸릴 수 있습니다.`;
    if (renderStored && latestResults[exchange]) {
      renderResult(latestResults[exchange], false);
    } else if (renderStored) {
      latestResult = null;
      setHidden(elements.results, true);
    }
  }

  function beginProgress() {
    progressTimers.forEach(clearTimeout);
    progressTimers = [];
    const marketName = activeExchange === "combined"
      ? "업비트 KRW + 바이낸스 USDT 현물"
      : activeExchange === "binance"
      ? "바이낸스 USDT 현물"
      : "업비트 원화마켓";
    const steps = [
      [0, `1/5 · ${marketName} 전체 현재가·거래대금을 점검 중입니다.`],
      [4500, "2/5 · 안전필터 통과 전 종목의 15분봉 24시간 구간을 점검 중입니다."],
      [20000, "3/5 · 상위 30종목의 5분·4시간·일봉을 추가 분석 중입니다."],
      [39000, `4/5 · ${activeExchange === "combined" ? "양 거래소 " : ""}최종 후보의 실시간 호가·체결을 60~90초 동안 동시 관찰 중입니다.`],
      [70000, "4/5 · 중반 구간에서 벽 취소·재보충·실체결 소진의 반복 여부를 확인 중입니다."],
      [100000, `5/5 · 마지막 확인 구간의 지지 전환·손익비${activeExchange === "combined" ? "·교차거래소 일치" : ""}를 검증 중입니다.`],
      [145000, "저유동 후보의 연장 관찰 또는 API 응답이 진행 중입니다. 조금만 기다려 주세요."]
    ];
    for (const [delay, message] of steps) progressTimers.push(setTimeout(() => elements.scanStatus.textContent = message, delay));
  }

  function endProgress() {
    progressTimers.forEach(clearTimeout);
    progressTimers = [];
  }

  async function scan() {
    if (!validateConfiguration()) return;
    scanning = true;
    elements.scanButton.disabled = true;
    elements.exchangeTabs.forEach(button => button.disabled = true);
    elements.scanButtonLabel.textContent = "전체 시장 분석 중";
    setHidden(elements.scanSpinner, false);
    elements.copyStatus.textContent = "";
    beginProgress();
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      Math.max(activeExchange === "combined" ? 260000 : 220000, Number(config.requestTimeoutMs || 0))
    );
    try {
      const endpoint = `${String(config.supabaseUrl).replace(/\/$/, "")}/functions/v1/${config.functionName || "market-scanner"}`;
      const response = await fetch(endpoint, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          "apikey": config.supabasePublishableKey,
          "x-scan-token": accessToken(),
          "x-client-info": "trading-booooo-web/2.4"
        },
        body: JSON.stringify({
          action: "scan",
          exchange: activeExchange,
          capital_krw: activeExchange === "binance" ? undefined : Number(elements.capitalInput.value || exchangeSettings.upbit.capital),
          capital_usdt: activeExchange === "combined"
            ? Number(elements.capitalUsdtInput.value || exchangeSettings.binance.capital)
            : activeExchange === "binance"
            ? Number(elements.capitalInput.value || exchangeSettings.binance.capital)
            : undefined,
          risk_pct: Number(elements.riskInput.value || config.defaultRiskPct || 1),
          fee_per_side_pct: activeExchange === "combined" ? undefined : exchangeSettings[activeExchange].fee,
          upbit_fee_per_side_pct: exchangeSettings.upbit.fee,
          binance_fee_per_side_pct: exchangeSettings.binance.fee,
          min_net_rr: Number(config.defaultMinNetRR || 1.5),
          max_stop_pct: Number(config.defaultMaxStopPct || 5)
        })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
      renderResult(data);
      elements.scanStatus.textContent = data.status === "NO_BUY"
        ? `스캔 완료 · 현재가 매수 후보는 없으며 안전한 통합 후보 ${data.finalists?.length || 0}개를 표시했습니다.`
        : `스캔 완료 · 통합 Top ${data.finalists?.length || 0} 중 현재 매수 후보 ${data.recommendations?.length || 0}개를 탐지했습니다.`;
    } catch (error) {
      const message = error?.name === "AbortError"
        ? "분석 요청 시간이 초과됐습니다. 잠시 후 다시 실행해 주세요."
        : `분석 실패: ${error?.message || error}`;
      elements.scanStatus.textContent = message;
      elements.scanStatus.classList.add("error-text");
    } finally {
      clearTimeout(timeout);
      endProgress();
      scanning = false;
      elements.scanButton.disabled = false;
      elements.exchangeTabs.forEach(button => button.disabled = false);
      elements.scanButtonLabel.textContent = exchangeSettings[activeExchange].button.replace("스캔", "재스캔");
      setHidden(elements.scanSpinner, true);
    }
  }

  function boot() {
    elements.riskInput.value = config.defaultRiskPct || 1;
    for (const exchange of ["combined", "upbit", "binance"]) {
      try {
        const stored = localStorage.getItem(`trading-booooo-last-scan-${exchange}`);
        if (stored) latestResults[exchange] = JSON.parse(stored);
      } catch (_) {}
    }
    applyExchangeUI("combined", true);
    validateConfiguration();
    elements.exchangeTabs.forEach(button => button.addEventListener("click", () => applyExchangeUI(button.dataset.exchange, true)));
    elements.scanButton.addEventListener("click", scan);
    elements.copyReportBtn.addEventListener("click", async () => {
      if (!latestResult) return;
      await copyText(buildFullReport(latestResult));
      elements.copyStatus.textContent = "클립보드에 복사했습니다.";
      setTimeout(() => elements.copyStatus.textContent = "", 2200);
    });
  }

  boot();
})();
