(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
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
      title: "업비트와 바이낸스를 동시에 점검하고<br>현재 가장 뜨거운 호가창을 추립니다.",
      description:
        "양 거래소 현물 전체에서 거래대금·체결속도·호가 갱신률을 먼저 비교하고, 최종 후보의 흡수·소진·스윕·OFI·재충전 패턴을 실시간 검증합니다. 추세는 보조 정보일 뿐 주문 권한이 없습니다.",
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
      description:
        "원화마켓 전체의 현재 거래대금과 유동성을 점검한 뒤, 가장 활발한 후보의 실시간 호가 갱신·체결 도착·공격적 체결대금과 LOB 패턴을 집중 관찰합니다.",
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
      description:
        "바이낸스 USDT 현물 전체에서 현재 가장 뜨거운 호가창을 선별하고, 비용 차감 순EV가 양수인 LOB 패턴만 주문 직전 재검사합니다. 업비트와 자금·수수료·유동성 기준은 분리합니다.",
    },
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
    primaryForecastUpside: $("primary-forecast-upside"),
    primaryForecastProbability: $("primary-forecast-probability"),
    primaryForecastRange: $("primary-forecast-range"),
    primaryForecastCalibration: $("primary-forecast-calibration"),
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
    footerMeta: $("footer-meta"),
  };

  function updateBrandVersion(engineVersion = "") {
    const version = String(engineVersion || config.uiVersion || "5.2.0").replace(/^v/i, "");
    if (elements.brandSubtitle) {
      elements.brandSubtitle.textContent = `UPBIT KRW + BINANCE USDT SPOT · v${version}`;
    }
  }

  updateBrandVersion();

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
      elements.accessError.innerHTML =
        "개인 접속 토큰이 URL에 없습니다. 배포 가이드대로 <code>#access=개인토큰</code>이 포함된 주소로 접속하세요.";
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
      : number >= 1000
      ? 2
      : number >= 1
      ? 4
      : number >= 0.01
      ? 6
      : 8;
    return `${number.toLocaleString("ko-KR", { maximumFractionDigits: digits })}${
      quote === "KRW" ? "원" : " USDT"
    }`;
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
    return Number.isNaN(date.getTime()) ? "—" : new Intl.DateTimeFormat("ko-KR", {
      timeZone: "Asia/Seoul",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
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
    return rows.map((item) => `<li>${escapeHtml(item)}</li>`).join("");
  }

  function renderPrimary(candidate) {
    setHidden(elements.primarySection, !candidate);
    if (!candidate) return;
    const plan = candidate.trade_plan;
    const horizon = candidate.horizon;
    const quote = candidateQuote(candidate);
    elements.primaryName.textContent = candidate.korean_name;
    elements.primaryMarket.textContent = `${
      candidate.source_exchange_label ? candidate.source_exchange_label + " · " : ""
    }${candidate.market}`;
    elements.primaryDecision.textContent = candidate.decision_label;
    elements.primaryScore.textContent = Math.round(candidate.combined_score ?? candidate.score);
    elements.primaryConfidence.textContent = percent(candidate.confidence, 1);
    elements.primaryPrice.textContent = price(candidate.current_price, quote);
    elements.primaryChange.textContent = `24시간 ${percent(candidate.change_24h_pct, 2, true)}`;
    elements.primaryChange.className = candidate.change_24h_pct >= 0
      ? "positive-text"
      : "negative-text";
    elements.primaryEntry.textContent = `${price(plan.entry_low, quote)} ~ ${
      price(plan.entry_high, quote)
    }`;
    elements.primaryShortTarget.textContent = price(
      plan.expected_exit_price ?? plan.short_target,
      quote,
    );
    elements.primaryShortReturn.textContent = `수수료·슬리피지 반영 ${
      percent(plan.expected_exit_net_return_pct ?? plan.short_net_return_pct, 2, true)
    }`;
    elements.primaryMediumTarget.textContent = price(plan.medium_target, quote);
    elements.primaryMediumReturn.textContent = `${
      plan.target_strategy_label || "중기 추세 관찰"
    } · ${percent(plan.medium_net_return_pct, 2, true)}`;
    const forecast = candidate.forecast || {};
    elements.primaryForecastUpside.textContent = percent(forecast.expected_upside_pct, 2, true);
    elements.primaryForecastProbability.textContent = `목표 선도달 추정 ${
      percent(forecast.target_hit_probability_pct, 1)
    } · 순수익 ${percent(forecast.expected_net_return_pct, 2, true)}`;
    elements.primaryForecastRange.textContent = `${price(forecast.conservative_price, quote)} ~ ${
      price(forecast.optimistic_price, quote)
    }`;
    elements.primaryForecastCalibration.textContent = forecast.calibrated
      ? `워크포워드 교정 ${Number(forecast.calibration_samples || 0)}건`
      : "교정 표본 부족 · 보수적 사전값";
    elements.primaryStop.textContent = price(plan.stop_price, quote);
    elements.primaryStopLoss.textContent = `예상 손실 ${percent(plan.net_stop_pct)} · ${
      krw(plan.estimated_loss_krw, quote)
    }`;
    elements.primaryInvestment.textContent = krw(
      plan.recommended_investment_quote ?? plan.recommended_investment_krw,
      quote,
    );
    elements.primaryRiskBudget.textContent = `위험예산 ${krw(plan.risk_budget_krw, quote)} · R:R ${
      plan.net_rr.toFixed(2)
    }`;
    elements.primaryHorizon.textContent = `${horizon.label} · ${horizon.expected_window}`;
    elements.persistenceMeter.style.width = `${
      Math.max(0, Math.min(100, horizon.persistence_score))
    }%`;
    elements.persistenceScore.textContent = `${Math.round(horizon.persistence_score)}점`;
    const execution = candidate.execution_plan || {};
    elements.primaryHorizonNote.textContent = `${horizon.estimate}${
      execution.next_review_after_hours
        ? ` · 다음 확인 약 ${execution.next_review_after_hours}시간 후 · 최대 ${execution.max_holding_hours}시간 보유`
        : ""
    }`;
    elements.primaryPositives.innerHTML = listItems(
      candidate.positives,
      "강한 추가 근거가 없습니다.",
    );
    elements.primaryWarnings.innerHTML = listItems(
      [...horizon.invalidation, ...(candidate.warnings || []).slice(0, 3)],
      "별도 경고가 없습니다.",
    );
  }

  function candidateCard(candidate) {
    const actionable = candidate.decision === "BUY" && candidate.trade_plan?.actionable;
    const plan = candidate.trade_plan || {};
    const watch = candidate.watch_entry_plan || {};
    const dynamic = candidate.microstructure?.dynamic || {};
    const quote = candidateQuote(candidate);
    const cross = candidate.cross_exchange;
    const forecast = candidate.forecast || {};
    const execution = candidate.execution_plan || {};
    const tone = candidate.decision.toLowerCase();
    const dynamicRisk = ["SPOOF_LIKE_RISK", "ASK_ABSORPTION_RISK", "SUPPORT_BREAKDOWN_RISK"]
      .includes(dynamic.status);
    const dynamicTone = dynamicRisk
      ? "risk"
      : dynamic.status === "BREAKOUT_CONFIRMED"
      ? "pass"
      : dynamic.status === "INSUFFICIENT" || !dynamic.status
      ? "muted"
      : "neutral";
    const blockingLabels = (candidate.gates || []).filter((gate) => !gate.passed).map((gate) =>
      gate.label
    ).slice(0, 2);
    const planRows = actionable
      ? `<div class="candidate-plan">
          <span><small>매수 구간</small><b>${escapeHtml(price(plan.entry_low, quote))} ~ ${
        escapeHtml(price(plan.entry_high, quote))
      }</b></span>
          <span><small>진입 시 예상 매도가</small><b class="positive-text">${
        escapeHtml(price(plan.expected_exit_price ?? plan.short_target, quote))
      }</b></span>
          <span><small>손절가격</small><b class="negative-text">${
        escapeHtml(price(plan.stop_price, quote))
      }</b></span>
          <span><small>LOB 목표 / 최대 보유</small><b>${
        escapeHtml(price(plan.medium_target, quote))
      } · ${escapeHtml(candidate.horizon.expected_window)}</b></span>
        </div>`
      : watch.available
      ? `<div class="candidate-plan watch-plan">
          <span><small>조건부 대기 매수가</small><b>${escapeHtml(price(watch.zone_low, quote))} ~ ${
        escapeHtml(price(watch.zone_high, quote))
      }</b></span>
          <span><small>진입 시 예상 매도가</small><b class="positive-text">${
        escapeHtml(price(watch.expected_exit_price ?? watch.reference_target, quote))
      }</b></span>
          <span><small>무효화 가격</small><b class="negative-text">${
        escapeHtml(price(watch.invalidation_price, quote))
      }</b></span>
          <span><small>예상 순수익 / 손익비</small><b>${
        escapeHtml(percent(watch.expected_net_return_pct, 2, true))
      } · ${Number(watch.estimated_net_rr).toFixed(2)}</b></span>
        </div><p class="watch-scenario"><b>진입</b> ${
        escapeHtml(watch.entry_trigger)
      }<br><b>매도</b> ${escapeHtml(watch.exit_trigger)}<br><b>예상 보유</b> ${
        escapeHtml(candidate.horizon.expected_window)
      } · 추세 무효화 시 목표가 전이라도 종료</p><p class="watch-note">가격 도달 시 자동매수 금지 · 15분봉 마감 후 재스캔</p>`
      : `<div class="candidate-plan muted-plan"><span><small>현재가 진단 R:R</small><b>${
        Number(plan.net_rr || 0).toFixed(2)
      } · ${
        escapeHtml(plan.structure_complete ? "구조 확인" : "지지·저항 미완성")
      }</b></span><span><small>실패 조건</small><b>${
        escapeHtml(blockingLabels.join("·") || "안전조건 미충족")
      }</b></span><span><small>지지 / 저항</small><b>${
        escapeHtml(price(plan.structural_support, quote))
      } / ${
        escapeHtml(price(plan.structural_resistance, quote))
      }</b></span><span><small>관찰 분류</small><b>${
        escapeHtml(candidate.horizon.label)
      }</b></span></div>`;
    const lowTouchStrip = execution.mode
      ? `<p class="watch-scenario"><b>추천 유효</b> ${
        escapeHtml(execution.valid_until || "재스캔 전까지")
      }<br><b>다음 확인</b> 약 ${Number(execution.next_review_after_hours || 0)}시간 후 · 최대 ${
        Number(execution.max_holding_hours || 0)
      }시간 보유<br><b>매수</b> ${escapeHtml(execution.buy_instruction || "")}<br><b>매도</b> ${
        escapeHtml(execution.exit_instruction || "")
      }</p>`
      : "";
    const failed = (candidate.gates || []).filter((gate) => !gate.passed).slice(0, 3);
    const crossRows =
      cross?.venues?.map((venue) =>
        `<span><b>${escapeHtml(venue.exchange_label)}</b> ${escapeHtml(venue.decision_label)} · ${
          Number(venue.score).toFixed(1)
        }점 · ${escapeHtml(venue.dynamic_label)}</span>`
      ).join("") || "";
    const crossStrip = cross
      ? `<div class="cross-venue-strip ${
        cross.conflict ? "conflict" : cross.both_buy ? "confirmed" : ""
      }">
          <strong>${escapeHtml(cross.label)}</strong>${crossRows}
        </div>`
      : "";
    return `<article class="candidate-card panel ${tone}">
      <div class="candidate-head">
        <div><span class="rank">#${candidate.rank || "—"}</span><h3>${
      escapeHtml(candidate.korean_name)
    }</h3><small>${
      escapeHtml(candidate.source_exchange_label ? candidate.source_exchange_label + " · " : "")
    }${escapeHtml(candidate.market)}</small></div>
        <span class="verdict ${tone}">${escapeHtml(candidate.decision_label)}</span>
      </div>
      <div class="candidate-score"><strong>${
      Number(candidate.combined_score ?? candidate.score).toFixed(1)
    }</strong><span>점</span><i></i><small>${cross ? "통합점수 · " : ""}${
      forecast.calibrated ? `검증 신뢰도 ${percent(candidate.confidence, 1)}` : "신뢰도 미교정"
    }</small></div>
      <div class="candidate-market"><span>실패 게이트 <b>${
      (candidate.failed_gates || []).length
    }개</b></span><span>현재가 <b>${
      escapeHtml(price(candidate.current_price, quote))
    }</b></span><span class="${
      candidate.change_24h_pct >= 0 ? "positive-text" : "negative-text"
    }">${percent(candidate.change_24h_pct, 2, true)}</span></div>
      ${crossStrip}
      ${planRows}
      ${lowTouchStrip}
      <div class="forecast-strip">
        <span><small>${
      forecast.calibrated ? "교정 예상 상승률" : "사전 조건부 MFE"
    }</small><b class="positive-text">${
      escapeHtml(percent(forecast.expected_upside_pct, 2, true))
    }</b></span>
        <span><small>목표 선도달 추정</small><b>${
      escapeHtml(percent(forecast.target_hit_probability_pct, 1))
    }</b></span>
        <span><small>조건부 최대우호가격 범위</small><b>${
      escapeHtml(price(forecast.conservative_price, quote))
    } ~ ${escapeHtml(price(forecast.optimistic_price, quote))}</b></span>
        <span><small>교정 상태</small><b>${
      forecast.calibrated
        ? `검증표본 ${Number(forecast.calibration_samples || 0)}건`
        : "사전값·재교정 대기"
    }</b></span>
      </div>
      <div class="dynamic-strip ${dynamicTone}">
        <span>동적 호가</span><b>${escapeHtml(dynamic.label || "이전 결과·재스캔 필요")}</b>
        <small>${Number(dynamic.observation_ms || 0) / 1000}s · 호가 ${
      Number(dynamic.distinct_book_updates || 0)
    } · 체결 ${Number(dynamic.aligned_trade_count || 0)} · 구간 ${
      Number(dynamic.covered_phases || 0)
    }/3</small>
      </div>
      <ul class="failed-list">${
      failed.length
        ? failed.map((item) => `<li>${escapeHtml(item.label)}</li>`).join("")
        : '<li class="passed">모든 강제조건 통과</li>'
    }</ul>
      <button class="card-copy" type="button" data-copy-market="${
      escapeHtml(candidate.market)
    }">이 후보 리포트 복사</button>
    </article>`;
  }

  function renderCandidates(result) {
    const finalists = result.finalists || [];
    elements.recommendationsGrid.innerHTML = finalists.length
      ? finalists.map(candidateCard).join("")
      : `<div class="empty panel">최종 정밀분석 결과가 없습니다.</div>`;
    elements.recommendationsGrid.querySelectorAll("[data-copy-market]").forEach((button) => {
      button.addEventListener("click", async () => {
        const candidate = finalists.find((item) => item.market === button.dataset.copyMarket);
        if (!candidate) return;
        await copyText(buildCandidateReport(candidate, result));
        button.textContent = "복사 완료";
        window.setTimeout(() => button.textContent = "이 후보 리포트 복사", 1500);
      });
    });
  }

  function renderRanking(rows) {
    elements.rankingBody.innerHTML = (rows || []).map((row) => {
      const quote = row.quote_currency === "USDT" ? "USDT" : activeQuote();
      const cells = [row.trend?.m5, row.trend?.m15, row.trend?.h4, row.trend?.day]
        .map((value) => {
          const [label, className] = trendLabel(value);
          return `<td><span class="trend ${className}">${label}</span></td>`;
        }).join("");
      return `<tr>
        <td><b>${row.rank}</b></td><td><span class="venue-badge ${
        escapeHtml(row.exchange || activeExchange)
      }">${
        escapeHtml(row.exchange_label || (activeExchange === "binance" ? "바이낸스" : "업비트"))
      }</span></td><td><strong>${escapeHtml(row.korean_name)}</strong><small>${
        escapeHtml(row.market)
      }</small></td>
        <td>${escapeHtml(price(row.current_price, quote))}</td><td class="${
        row.change_24h_pct >= 0 ? "positive-text" : "negative-text"
      }">${percent(row.change_24h_pct, 2, true)}</td>
        <td>${turnover(row.turnover_24h_quote ?? row.turnover_24h_krw, quote)}</td><td><b>${
        Number(row.period_score).toFixed(1)
      }</b></td>${cells}
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
    updateBrandVersion(result.meta?.engine_version);
    elements.headline.textContent = result.headline || "분석 완료";
    elements.resultSubline.textContent = `${kst(result.meta?.generated_at)} · 엔진 ${
      result.meta?.engine_version || "—"
    } · ${result.cached ? "최근 결과 재사용" : "신규 조회"}`;
    elements.totalMarkets.textContent = Number(
      result.coverage?.listed_markets ?? result.coverage?.listed_krw_markets ?? 0,
    ).toLocaleString("ko-KR");
    elements.eligibleMarkets.textContent = Number(
      result.coverage?.eligible_after_safety_filter || 0,
    ).toLocaleString("ko-KR");
    elements.deepMarkets.textContent = Number(result.coverage?.deep_period_analyzed || 0)
      .toLocaleString("ko-KR");
    elements.elapsed.textContent = `${Number(result.meta?.elapsed_seconds || 0).toFixed(1)}초`;
    const combined = exchange === "combined";
    const exchangeErrors = result.exchange_errors || [];
    setHidden(elements.exchangeWarning, !exchangeErrors.length);
    elements.exchangeWarning.textContent = exchangeErrors.length
      ? `부분 결과입니다. ${
        exchangeErrors.map((item) =>
          `${item.exchange === "upbit" ? "업비트" : "바이낸스"}: ${item.message}`
        ).join(" / ")
      }`
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
      ? result.coverage.excluded_summary.map((item) =>
        `<li><span>${escapeHtml(item.reason)}</span><b>${item.count}개</b></li>`
      ).join("")
      : "<li><span>1차 제외 없음</span><b>0개</b></li>";
    elements.footerMeta.textContent = `엔진 ${result.meta?.engine_version || "—"} · ${
      kst(result.meta?.generated_at)
    }`;
    try {
      localStorage.setItem(`trading-booooo-last-scan-${exchange}`, JSON.stringify(result));
    } catch (_) {}
    if (combined && result.exchanges) {
      for (const venue of ["upbit", "binance"]) {
        if (!result.exchanges[venue]) continue;
        try {
          localStorage.setItem(
            `trading-booooo-last-scan-${venue}`,
            JSON.stringify(result.exchanges[venue]),
          );
        } catch (_) {}
      }
    }
    if (scroll) {
      window.setTimeout(
        () => elements.results.scrollIntoView({ behavior: "smooth", block: "start" }),
        100,
      );
    }
  }

  function timeframeLine(label, metric, quote = activeQuote()) {
    if (!metric) return `- ${label}: 데이터 없음`;
    const states = {
      FULL_BULL: "완전상승",
      BULL_PULLBACK: "상승눌림",
      RECOVERY: "회복",
      MIXED: "혼조",
      BEAR: "하락",
    };
    return `- ${label}: 구조 ${states[metric.trend_state] || "미분류"}, 추세 ${
      Number(metric.trend_signal).toFixed(3)
    }, 과열 ${Number(metric.overheat_score || 0).toFixed(2)}, RSI14 ${
      metric.rsi14 == null ? "N/A" : Number(metric.rsi14).toFixed(1)
    }, EMA9/21/50 ${price(metric.ema9, quote)} / ${price(metric.ema21, quote)} / ${
      price(metric.ema50, quote)
    }, ATR ${percent(metric.atr_pct)}, 3봉수익률 ${
      percent(metric.return_3_pct, 2, true)
    }, 12봉수익률 ${percent(metric.return_12_pct, 2, true)}, 거래대금비 ${
      Number(metric.volume_ratio).toFixed(2)
    }배`;
  }

  function buildCandidateReport(candidate, result) {
    const actionable = candidate.decision === "BUY" && candidate.trade_plan?.actionable;
    const plan = candidate.trade_plan || {};
    const watch = candidate.watch_entry_plan || {};
    const quote = candidateQuote(candidate);
    const cross = candidate.cross_exchange;
    const forecast = candidate.forecast || {};
    const watchAvailable = !actionable && Boolean(watch.available);
    const watchLines = watchAvailable
      ? [
        `- 조건부 대기 매수구간: ${price(watch.zone_low, quote)} ~ ${
          price(watch.zone_high, quote)
        }`,
        `- 최대 허용 매수가: ${price(watch.max_price, quote)} / 현재가 대비 ${
          percent(-Number(watch.discount_from_current_pct || 0), 2, true)
        }`,
        `- 진입 시 예상 매도가: ${
          price(watch.expected_exit_price ?? watch.reference_target, quote)
        } / 예상 순수익 ${percent(watch.expected_net_return_pct, 2, true)} / R:R ${
          Number(watch.estimated_net_rr).toFixed(2)
        }`,
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
      `- 현재가: ${price(candidate.current_price, quote)} / 24시간: ${
        percent(candidate.change_24h_pct, 2, true)
      }`,
      `- 가격 기준: ${
        candidate.price_context?.reference_source || plan.reference_source || "N/A"
      } / 초기 티커 ${price(candidate.price_context?.ticker_price, quote)} / 실시간 괴리 ${
        candidate.price_context?.ticker_live_deviation_bps == null
          ? "N/A"
          : Number(candidate.price_context.ticker_live_deviation_bps).toFixed(1) + "bp"
      }`,
      `- 종합점수: ${Number(candidate.score).toFixed(2)}${
        candidate.combined_score != null
          ? ` / 통합점수: ${Number(candidate.combined_score).toFixed(2)}`
          : ""
      } / 신뢰도: ${forecast.calibrated ? percent(candidate.confidence, 1) : "미교정"}`,
      `- 24시간 거래대금: ${
        turnover(candidate.turnover_24h_quote ?? candidate.turnover_24h_krw, quote)
      }`,
      `- ${forecast.calibrated ? "교정 예상 상승률" : "사전 조건부 MFE"}: ${
        percent(forecast.expected_upside_pct, 2, true)
      } / 보수 ${percent(forecast.conservative_upside_pct, 2, true)} / 낙관 ${
        percent(forecast.optimistic_upside_pct, 2, true)
      }`,
      `- 조건부 최대우호가격 범위: ${price(forecast.conservative_price, quote)} ~ ${
        price(forecast.optimistic_price, quote)
      } / 중심 ${price(forecast.expected_price, quote)} (현재가 포함 확률구간이 아님)`,
      `- 목표 선도달 추정: ${percent(forecast.target_hit_probability_pct, 1)}${
        forecast.wait_entry_probability_pct == null
          ? ""
          : ` / WAIT 진입 추정 ${percent(forecast.wait_entry_probability_pct, 1)}`
      }`,
      `- 예측 교정상태: ${
        forecast.calibrated
          ? `워크포워드 검증표본 ${Number(forecast.calibration_samples || 0)}건`
          : "표본 부족·보수적 사전값"
      } / 모델 ${forecast.model_version || "N/A"}`,
      ...(cross
        ? [
          `- 교차거래소 판정: ${cross.label}`,
          ...cross.venues.map((venue) =>
            `- ${venue.exchange_label}: ${venue.market} / ${venue.decision_label} / ${
              Number(venue.score).toFixed(2)
            }점 / ${venue.dynamic_label}`
          ),
        ]
        : []),
      `- 현재가 기준 진입 계산: ${price(plan.entry_low, quote)} ~ ${
        price(plan.entry_high, quote)
      } / 실행추정 ${price(plan.entry_execution_estimate, quote)} / 기준 ${
        plan.reference_source || "N/A"
      }`,
      `- 구조적 지지: ${price(plan.structural_support, quote)} (${plan.support_basis || "미확인"})`,
      `- 구조적 저항: ${price(plan.structural_resistance, quote)} (${
        plan.target_basis || "미확인"
      })`,
      `- 현재가 기준 예상 매도가: ${
        price(plan.expected_exit_price ?? plan.short_target, quote)
      } / 예상 순수익 ${
        percent(plan.expected_exit_net_return_pct ?? plan.short_net_return_pct, 2, true)
      }`,
      `- 현재가 기준 단기 목표가: ${price(plan.short_target, quote)} / 중기 목표가 ${
        price(plan.medium_target, quote)
      }`,
      `- 현재가 기준 손절가격: ${price(plan.stop_price, quote)} / 예상 체결 ${
        price(plan.stop_execution_estimate, quote)
      } / 비용 반영 손실 ${percent(plan.net_stop_pct)}`,
      `- 현재가 기준 비용 포함 손익비: ${Number(plan.net_rr || 0).toFixed(2)} / 구조 완성 ${
        plan.structure_complete ? "예" : "아니오"
      } / 실행 가능 ${actionable ? "예" : "아니오"}`,
      `- 호가 깊이 검증: 가정 투입금 ${
        turnover(plan.assumed_order_notional_quote || 0, quote)
      } / 양방향 커버리지 ${
        Number(plan.depth_coverage_ratio || 0).toFixed(2)
      }배 / 예상 진입 슬리피지 ${
        plan.estimated_entry_slippage_bps == null
          ? "N/A"
          : Number(plan.estimated_entry_slippage_bps).toFixed(1) + "bp"
      } / 매도·매수 가시잔량 ${turnover(plan.visible_bid_depth_quote || 0, quote)} / ${
        turnover(plan.visible_ask_depth_quote || 0, quote)
      }`,
      `- 비용·구조 여유: 추정 왕복비용 ${
        percent(plan.estimated_round_trip_cost_pct, 2)
      } / 첫 저항까지 비용 차감 순여유 ${percent(plan.structural_headroom_net_pct, 2, true)}`,
      ...(actionable
        ? [
          `- 추천 투입금: ${
            krw(plan.recommended_investment_quote ?? plan.recommended_investment_krw, quote)
          } / 위험예산 ${krw(plan.risk_budget_krw, quote)}`,
        ]
        : []),
      ...watchLines,
      `- 추세 유지 추정: ${candidate.horizon.label}, ${candidate.horizon.expected_window}, 지속성 ${
        Number(candidate.horizon.persistence_score).toFixed(1)
      }점`,
      `- 저빈도 운용 적합성: ${
        candidate.execution_plan?.low_touch_compatible ? "적합" : "부적합"
      } / 추천 유효 ${
        candidate.execution_plan?.recommendation_valid_minutes ?? "N/A"
      }분 / 다음 확인 ${
        candidate.execution_plan?.next_review_after_hours ?? "N/A"
      }시간 후 / 최대 보유 ${candidate.execution_plan?.max_holding_hours ?? "N/A"}시간`,
      `- 매수 실행: ${candidate.execution_plan?.buy_instruction || "N/A"}`,
      `- 매도 실행: ${candidate.execution_plan?.exit_instruction || "N/A"}`,
      `- 유효시간 경과: ${candidate.execution_plan?.stale_instruction || "재스캔"}`,
      `- 추정 설명: ${candidate.horizon.estimate}`,
      ...(watchAvailable
        ? [
          "",
          "### 관찰·눌림대기 실행 시나리오",
          `- 예상 보유 범위: ${candidate.horizon.expected_window} (추세 무효화 시 목표가 전 조기 종료)`,
          ...(watch.scenario || []).map((item) => `- ${item}`),
          "",
          "### 조건부 대기 매수 전 확인",
          ...(watch.conditions || []).map((item) => `- ${item}`),
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
      `- 실시간 기준가격: ${
        price(candidate.microstructure?.reference_price, quote)
      } / 호가 최신성 ${
        candidate.microstructure?.live_book_age_ms == null
          ? "N/A"
          : (Number(candidate.microstructure.live_book_age_ms) / 1000).toFixed(1) + "초"
      }`,
      `- 평균 스프레드: ${
        candidate.microstructure?.spread_bps == null
          ? "N/A"
          : Number(candidate.microstructure.spread_bps).toFixed(2) + "bp"
      }`,
      `- 정적 호가 불균형(단독 긍정점수 미사용): ${
        Number(candidate.microstructure?.book_imbalance || 0).toFixed(3)
      }`,
      `- 최근 체결 압력: ${
        Number(candidate.microstructure?.trade_pressure || 0).toFixed(3)
      } / 체결 표본 ${candidate.microstructure?.trade_count || 0}건 / 평균 체결규모 ${
        candidate.microstructure?.average_trade_notional == null
          ? "N/A"
          : turnover(candidate.microstructure.average_trade_notional, quote)
      }`,
      `- 동적 판정: ${candidate.microstructure?.dynamic?.label || "데이터 없음"}`,
      `- 동적 표본: 관찰 ${
        Number(candidate.microstructure?.dynamic?.observation_ms || 0) / 1000
      }초 / 서로 다른 호가 ${
        candidate.microstructure?.dynamic?.distinct_book_updates || 0
      }회 / 동시간대 체결 ${candidate.microstructure?.dynamic?.aligned_trade_count || 0}건 / 품질 ${
        percent(Number(candidate.microstructure?.dynamic?.data_quality || 0) * 100, 1)
      }`,
      `- 구간 분산: 초반·중반·확인 ${
        candidate.microstructure?.dynamic?.covered_phases || 0
      }/3개 유효 / 호가 ${
        (candidate.microstructure?.dynamic?.phase_book_updates || []).join("/") || "—"
      }회 / 체결 ${
        (candidate.microstructure?.dynamic?.phase_trade_counts || []).join("/") || "—"
      }건`,
      `- 의심 점수: ${
        candidate.microstructure?.dynamic?.score_status === "VALID"
          ? `가짜 매수벽 ${
            Number(candidate.microstructure.dynamic.spoof_like_score || 0).toFixed(3)
          } / 매도 재보충·흡수 ${
            Number(candidate.microstructure.dynamic.ask_absorption_score || 0).toFixed(3)
          } / 돌파·지지전환 ${
            Number(candidate.microstructure.dynamic.breakout_score || 0).toFixed(3)
          }`
          : "UNKNOWN (동시간대 체결·구간 표본 부족)"
      }`,
      `- 외부 이벤트 판정: ${candidate.event_risk?.label || "데이터 없음"} / 상태 ${
        candidate.event_risk?.status || "UNKNOWN"
      } / 거래대금 이상 ${candidate.event_risk?.volume_anomaly ? "YES" : "NO"}`,
      `- 이벤트 공급자: ${
        Object.entries(candidate.event_risk?.provider_status || {}).map(([key, value]) =>
          `${key}=${value}`
        ).join(" / ") || "미설정"
      }`,
      ...(candidate.event_risk?.evidence || []).map((item) =>
        `- 이벤트 근거: [${item.severity}] ${item.category} / ${item.title} / ${
          item.displayed_date || item.event_date || item.published_at || "시점 미상"
        } / ${item.source}`
      ),
      ...(candidate.microstructure?.dynamic?.evidence || []).map((item) => `- 동적 근거: ${item}`),
      ...(candidate.microstructure?.dynamic?.warnings || []).map((item) => `- 동적 경고: ${item}`),
      "",
      "### 긍정 근거",
      ...(candidate.positives?.length
        ? candidate.positives.map((item) => `- ${item}`)
        : ["- 뚜렷한 추가 근거 없음"]),
      "",
      "### 위험·무효화 조건",
      ...candidate.horizon.invalidation.map((item) => `- ${item}`),
      ...(candidate.warnings?.length ? candidate.warnings.map((item) => `- ${item}`) : []),
      "",
      "### 강제 게이트",
      ...candidate.gates.map((gate) =>
        `- ${gate.passed ? "PASS" : "FAIL"} · ${gate.label}: ${gate.detail}`
      ),
    ];
    if (result?.meta) {
      lines.unshift(
        `- 분석시각: ${kst(result.meta.generated_at)} / 엔진 ${result.meta.engine_version}`,
        "",
      );
    }
    return lines.join("\n");
  }

  function buildFullReport(result) {
    const recommendations = result.recommendations || [];
    const combined = result.meta?.exchange === "combined";
    const exchangeLabel = result.coverage?.exchange_label ||
      (result.meta?.exchange === "binance" ? "바이낸스 현물" : "업비트 현물");
    const quote = result.meta?.quote_currency || "KRW";
    const report = [
      `# ${
        combined ? "업비트·바이낸스 통합 Top 4" : `${exchangeLabel} ${quote} 전 종목`
      } 자동 스캔 리포트`,
      "",
      `- 분석시각: ${kst(result.meta?.generated_at)}`,
      `- 엔진: ${result.meta?.engine_version}`,
      `- 예측 교정: ${
        result.assumptions?.calibration_profile?.promoted
          ? "워크포워드 승격 프로필"
          : "보수적 사전 프로필"
      } / 표본 ${Number(result.assumptions?.calibration_profile?.samples || 0)}건`,
      `- 최종 결론: ${result.headline}`,
      `- 분석 소요: ${Number(result.meta?.elapsed_seconds || 0).toFixed(2)}초`,
      `- 자동 주문: 없음`,
      "",
      "## 데이터 범위",
      `- ${exchangeLabel}${combined ? "" : ` ${quote}`} 거래 가능 ${
        result.coverage?.listed_markets ?? result.coverage?.listed_krw_markets
      }개 전수 1차 점검`,
      `- 안전필터 통과 ${result.coverage?.eligible_after_safety_filter}개`,
      `- 안전필터 통과 종목 15분봉 기간점검: ${result.coverage?.period_screened_complete}/${result.coverage?.period_screened_markets}개`,
      `- 기간 정밀분석 ${result.coverage?.deep_period_analyzed}개`,
      `- 최신 호가·체결 검증 ${result.coverage?.microstructure_finalists}개`,
      `- 동적 WebSocket 관찰 ${
        result.coverage?.dynamic_orderflow?.websocket_markets || 0
      }개 / 충분한 동적 표본 ${
        result.coverage?.dynamic_orderflow?.sufficient_markets || 0
      }개 / 요청 관찰창 ${
        result.coverage?.dynamic_orderflow?.requested_observation_seconds || 0
      }초`,
      ...(combined
        ? [
          `- 통합 후보: 중복 기초자산 제거 후 ${result.finalists?.length || 0}개`,
          "- 교차 규칙: 다른 거래소에서 AVOID 또는 동적 호가 위험이 나오면 현재 BUY를 WAIT로 강등",
          ...((result.exchange_errors || []).map((item) =>
            `- 부분 실패: ${item.exchange === "upbit" ? "업비트" : "바이낸스"} · ${item.message}`
          )),
        ]
        : []),
      "- 조회창: 5분봉 약 12시간 / 15분봉 약 48시간 / 4시간봉 약 30일 / 일봉 약 200일",
      "",
      "## 최종 매수 결론",
      recommendations.length
        ? `- 현재 매수 강제조건 통과: ${
          recommendations.map((item) => `${item.korean_name}(${item.market})`).join(", ")
        }`
        : "- 현재 매수 강제조건을 통과한 종목 없음. 관심 후보는 진입 추천이 아님.",
      "",
      ...(result.finalists || []).flatMap(
        (candidate) => [buildCandidateReport(candidate), "", "---", ""],
      ),
      "## 기간분석 상위 순위",
      "|순위|종목|현재가|24H|거래대금|기간점수|5분|15분|4시간|일봉|",
      "|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|",
      ...(result.ranking || []).map((row) => {
        const rowQuote = row.quote_currency === "USDT" ? "USDT" : combined ? "KRW" : activeQuote();
        return `|${row.rank}|${
          row.exchange_label ? row.exchange_label + " · " : ""
        }${row.korean_name} (${row.market})|${price(row.current_price, rowQuote)}|${
          percent(row.change_24h_pct, 2, true)
        }|${turnover(row.turnover_24h_quote ?? row.turnover_24h_krw, rowQuote)}|${
          Number(row.period_score).toFixed(1)
        }|${Number(row.trend?.m5).toFixed(2)}|${Number(row.trend?.m15).toFixed(2)}|${
          Number(row.trend?.h4).toFixed(2)
        }|${Number(row.trend?.day).toFixed(2)}|`;
      }),
      "",
      "## GPT/Claude 심층분석 요청",
      "위 리포트의 생성시각 이후 데이터는 임의로 가정하지 말고, 제공된 수치만 근거로 다음을 검증해 주세요.",
      "1. 현재 매수 후보가 실제로 단기·중기 추세 정렬과 호가·체결 조건을 동시에 충족하는지 반론 중심으로 검토",
      "2. 단기·중기 목표가와 손절가격의 구조적 근거 및 수수료·슬리피지 반영 손익비 재계산",
      "3. 추세 유지기간 분류가 과도하지 않은지, 더 보수적인 보유기간과 무효화 조건 제시",
      "4. 조건부 대기 매수구간·예상 매도가·손절가로 구성된 눌림 시나리오가 실제 지지선과 비용 포함 손익비를 충족하는지 재검증",
      "5. 동적 호가 로그에서 비체결성 대형벽 취소·매도벽 재보충/흡수·지지 붕괴가 실제 체결량과 정합적인지 재검증",
      "6. 교정 예상 상승률이 구조적 목표가와 실제 변동성에 비해 과장됐는지, 보수·중심·낙관 범위를 각각 검증",
      "7. 시장경보·저유동·추격매수·데이터 부족·뉴스 미반영 위험 점검",
      "8. 추천 근거가 약하면 억지 대안을 만들지 말고 '매수 보류'로 결론",
      "",
      "> 주의: 본 리포트는 공개 시세 기반 조건부 분석이며 미래 가격이나 수익을 보장하지 않습니다. 동적 호가 판정은 개별 주문 ID와 숨은 잔량을 볼 수 없어 스푸핑·아이스버그의 확정 판정이 아닙니다.",
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
      exchangeSettings.binance.capital = Number(
        elements.capitalInput.value || exchangeSettings.binance.capital,
      );
      elements.capitalUsdtInput.value = exchangeSettings.binance.capital;
    } else if (activeExchange === "combined") {
      exchangeSettings.upbit.capital = Number(
        elements.capitalInput.value || exchangeSettings.upbit.capital,
      );
      exchangeSettings.binance.capital = Number(
        elements.capitalUsdtInput.value || exchangeSettings.binance.capital,
      );
    } else {
      exchangeSettings.upbit.capital = Number(
        elements.capitalInput.value || exchangeSettings.upbit.capital,
      );
    }
    activeExchange = exchange;
    const settings = exchangeSettings[exchange];
    elements.exchangeTabs.forEach((button) =>
      button.classList.toggle("active", button.dataset.exchange === exchange)
    );
    elements.heroTitle.innerHTML = settings.title;
    elements.heroDescription.textContent = settings.description;
    const combined = exchange === "combined";
    const capitalSettings = exchange === "binance"
      ? exchangeSettings.binance
      : exchangeSettings.upbit;
    elements.capitalInput.value = capitalSettings.capital;
    elements.capitalInput.min = capitalSettings.min;
    elements.capitalInput.step = capitalSettings.step;
    elements.capitalUnit.textContent = capitalSettings.unit;
    elements.capitalLabel.textContent = combined ? "업비트 기준 자본" : "기준 자본";
    setHidden(elements.secondaryCapitalSetting, !combined);
    elements.capitalUsdtInput.value = exchangeSettings.binance.capital;
    elements.listedMarketLabel.textContent = combined
      ? "양 거래소 상장 종목"
      : `${settings.quote} 상장 종목`;
    elements.dataSourceLabel.textContent = combined
      ? "두 거래소 공개시세"
      : `${settings.label} 공개시세`;
    elements.scanButtonLabel.textContent = latestResults[exchange]
      ? settings.button.replace("스캔", "재스캔")
      : settings.button;
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
      [
        39000,
        `4/5 · ${
          activeExchange === "combined" ? "양 거래소 " : ""
        }최종 후보의 실시간 호가·체결을 60~90초 동안 동시 관찰 중입니다.`,
      ],
      [70000, "4/5 · 중반 구간에서 벽 취소·재보충·실체결 소진의 반복 여부를 확인 중입니다."],
      [
        100000,
        `5/5 · 마지막 확인 구간의 지지 전환·손익비${
          activeExchange === "combined" ? "·교차거래소 일치" : ""
        }를 검증 중입니다.`,
      ],
      [145000, "저유동 후보의 연장 관찰 또는 API 응답이 진행 중입니다. 조금만 기다려 주세요."],
    ];
    for (const [delay, message] of steps) {
      progressTimers.push(setTimeout(() => elements.scanStatus.textContent = message, delay));
    }
  }

  function endProgress() {
    progressTimers.forEach(clearTimeout);
    progressTimers = [];
  }

  async function scan() {
    if (!validateConfiguration()) return;
    scanning = true;
    elements.scanButton.disabled = true;
    elements.exchangeTabs.forEach((button) => button.disabled = true);
    elements.scanButtonLabel.textContent = "전체 시장 분석 중";
    setHidden(elements.scanSpinner, false);
    elements.copyStatus.textContent = "";
    beginProgress();
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      Math.max(
        activeExchange === "combined" ? 260000 : 220000,
        Number(config.requestTimeoutMs || 0),
      ),
    );
    try {
      const endpoint = `${String(config.supabaseUrl).replace(/\/$/, "")}/functions/v1/${
        config.functionName || "market-scanner"
      }`;
      const response = await fetch(endpoint, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          "apikey": config.supabasePublishableKey,
          "x-scan-token": accessToken(),
          "x-client-info": "trading-booooo-web/2.4",
        },
        body: JSON.stringify({
          action: "scan",
          exchange: activeExchange,
          capital_krw: activeExchange === "binance"
            ? undefined
            : Number(elements.capitalInput.value || exchangeSettings.upbit.capital),
          capital_usdt: activeExchange === "combined"
            ? Number(elements.capitalUsdtInput.value || exchangeSettings.binance.capital)
            : activeExchange === "binance"
            ? Number(elements.capitalInput.value || exchangeSettings.binance.capital)
            : undefined,
          risk_pct: Number(elements.riskInput.value || config.defaultRiskPct || 1),
          fee_per_side_pct: activeExchange === "combined"
            ? undefined
            : exchangeSettings[activeExchange].fee,
          upbit_fee_per_side_pct: exchangeSettings.upbit.fee,
          binance_fee_per_side_pct: exchangeSettings.binance.fee,
          min_net_rr: Number(config.defaultMinNetRR || 1.5),
          max_stop_pct: Number(config.defaultMaxStopPct || 5),
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
      renderResult(data);
      elements.scanStatus.textContent = data.status === "NO_BUY"
        ? `스캔 완료 · 현재가 매수 후보는 없으며 안전한 통합 후보 ${
          data.finalists?.length || 0
        }개를 표시했습니다.`
        : `스캔 완료 · 통합 Top ${data.finalists?.length || 0} 중 현재 매수 후보 ${
          data.recommendations?.length || 0
        }개를 탐지했습니다.`;
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
      elements.exchangeTabs.forEach((button) => button.disabled = false);
      elements.scanButtonLabel.textContent = exchangeSettings[activeExchange].button.replace(
        "스캔",
        "재스캔",
      );
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
    elements.exchangeTabs.forEach((button) =>
      button.addEventListener("click", () => applyExchangeUI(button.dataset.exchange, true))
    );
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

(() => {
  "use strict";

  const config = window.TRADING_SCANNER_CONFIG || {};
  const $ = (id) => document.getElementById(id);
  const viewButtons = [...document.querySelectorAll("[data-view]")];
  const scannerView = $("scanner-view");
  const traderView = $("trader-view");
  const login = $("trader-login");
  const consoleView = $("trader-console");
  const tokenInput = $("trader-token");
  const loginStatus = $("trader-login-status");
  const controlStatus = $("control-status");
  const allocationStatus = $("allocation-status");
  const traderAlert = $("trader-alert");
  let token = "";
  let pollTimer = null;
  let currentStatus = null;
  let allocationDirty = false;
  let traderVisible = false;

  const fmt = (value, digits = 2) =>
    Number.isFinite(Number(value))
      ? Number(value).toLocaleString("ko-KR", { maximumFractionDigits: digits })
      : "—";
  const money = (value, quote) => quote === "KRW" ? `${fmt(value, 0)}원` : `${fmt(value, 4)} USDT`;
  const dateTime = (value) => value ? new Date(value).toLocaleString("ko-KR") : "—";
  const escapeHtml = (value) =>
    String(value ?? "")
      .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;").replaceAll("'", "&#039;");
  const setHidden = (element, hidden) => element?.classList.toggle("hidden", hidden);

  function endpoint() {
    return `${String(config.supabaseUrl || "").replace(/\/$/, "")}/functions/v1/${
      config.autotraderFunctionName || "market-autotrader"
    }`;
  }

  async function request(body, timeoutMs = 60000) {
    if (!token || token.length < 32) {
      throw new Error("32자 이상의 DASHBOARD_ACCESS_TOKEN을 입력하세요.");
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(endpoint(), {
        method: "POST",
        signal: controller.signal,
        headers: {
          "content-type": "application/json",
          "x-autotrade-token": token,
          ...(config.supabasePublishableKey ? { apikey: config.supabasePublishableKey } : {}),
        },
        body: JSON.stringify(body),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.ok === false) {
        if (response.status === 401) lockDashboard("토큰이 올바르지 않습니다.");
        throw new Error(data.error || `HTTP ${response.status}`);
      }
      return data;
    } finally {
      clearTimeout(timer);
    }
  }

  function setView(view) {
    traderVisible = view === "trader";
    viewButtons.forEach((button) =>
      button.classList.toggle("active", button.dataset.view === view)
    );
    setHidden(scannerView, traderVisible);
    setHidden(traderView, !traderVisible);
    if (traderVisible && token && !currentStatus) unlockDashboard();
    managePolling();
  }

  function managePolling() {
    clearInterval(pollTimer);
    pollTimer = null;
    if (traderVisible && token && !consoleView?.classList.contains("hidden")) {
      pollTimer = setInterval(() => loadStatus(true), 15000);
    }
  }

  function lockDashboard(message = "") {
    token = "";
    if (tokenInput) tokenInput.value = "";
    currentStatus = null;
    setHidden(login, false);
    setHidden(consoleView, true);
    loginStatus.textContent = message;
    clearInterval(pollTimer);
  }

  async function unlockDashboard() {
    const entered = String(tokenInput?.value || token || "").trim();
    if (entered.length < 32) {
      loginStatus.textContent = "32자 이상의 토큰을 입력하세요.";
      return;
    }
    token = entered;
    loginStatus.textContent = "계좌와 엔진 상태를 확인하는 중입니다.";
    try {
      await loadStatus(false);
      setHidden(login, true);
      setHidden(consoleView, false);
      loginStatus.textContent = "";
      managePolling();
    } catch (error) {
      loginStatus.textContent = `접속 실패: ${error.message || error}`;
    }
  }

  function accountFor(data, exchange) {
    const row = data?.accounts?.[exchange] || {};
    return { row, managed: row.managed || {}, quote: exchange === "upbit" ? "KRW" : "USDT" };
  }

  function renderAccount(data, exchange) {
    const { row, managed, quote } = accountFor(data, exchange);
    $(`${exchange}-equity`).textContent = row.error
      ? "연결 오류"
      : money(row.total_equity_quote, quote);
    $(`${exchange}-available`).textContent = row.error ? "—" : money(row.available_quote, quote);
    $(`${exchange}-managed`).textContent = row.error
      ? "—"
      : money(managed.managedCapitalQuote, quote);
    $(`${exchange}-managed-available`).textContent = row.error
      ? "—"
      : money(managed.managedAvailableQuote, quote);
  }

  function renderAllocations(settings) {
    if (allocationDirty) return;
    $("upbit-enabled").checked = Boolean(settings.upbit_enabled);
    $("binance-enabled").checked = Boolean(settings.binance_enabled);
    $("upbit-allocation-mode").value = settings.upbit_allocation_mode || "ALL";
    $("binance-allocation-mode").value = settings.binance_allocation_mode || "ALL";
    $("upbit-allocation-value").value = Number(settings.upbit_allocation_krw || 0);
    $("upbit-reserve-value").value = Number(settings.upbit_reserve_krw || 0);
    $("binance-allocation-value").value = Number(settings.binance_allocation_usdt || 0);
    $("binance-reserve-value").value = Number(settings.binance_reserve_usdt || 0);
    toggleAllocationInputs();
  }

  function toggleAllocationInputs() {
    $("upbit-allocation-value").disabled = $("upbit-allocation-mode").value !== "FIXED";
    $("binance-allocation-value").disabled = $("binance-allocation-mode").value !== "FIXED";
  }

  function renderPositions(data) {
    const rows = Array.isArray(data.positions) ? data.positions : [];
    $("open-position-count").textContent = String(rows.length);
    $("open-position-note").textContent = rows.length
      ? `${rows.filter((row) => !row.is_paper).length}개 실거래`
      : "현재 보유 없음";
    $("positions-body").innerHTML = rows.length
      ? rows.map((row) => `
      <tr>
        <td>${row.exchange === "upbit" ? "UPBIT" : "BINANCE"}</td>
        <td><strong>${escapeHtml(row.market)}</strong></td>
        <td>${escapeHtml(row.state)}</td>
        <td>${row.is_paper ? "PAPER" : "LIVE"}</td>
        <td>${fmt(Math.max(finite(row.remaining_quantity), finite(row.reserved_quantity)), 8)}</td>
        <td>${fmt(row.average_entry_price || row.planned_entry_price, 8)}</td>
        <td>${fmt(row.stop_price, 8)}</td>
        <td>${fmt(row.target_1, 8)}</td>
        <td>${dateTime(row.max_holding_at)}</td>
      </tr>`).join("")
      : '<tr><td colspan="9" class="muted">열린 포지션이 없습니다.</td></tr>';
  }

  function renderLearning(data) {
    const lob = data?.learning?.lob;
    if (data?.settings?.strategy === "LOB_SCALP" && lob) {
      const governance = lob.governance || null;
      const champion = governance?.champion || null;
      const alternate = governance?.alternate || null;
      const phaseLabel = governance?.phase === "CHALLENGE"
        ? "도전자 실거래 검증"
        : governance?.phase === "CONFIRMATION"
        ? "승격 후 재확인"
        : "검증된 챔피언 운용";
      const rows = [
        [
          "활성 모델",
          champion
            ? `CHAMPION P${fmt(champion.version, 0)}${
              champion.confirmed ? " · 검증 완료" : " · 잠정 승격"
            }`
            : `LEGACY ONLINE #${fmt(lob.profile_version, 0)}`,
        ],
        ["운용 상태", champion ? phaseLabel : "정책 거버넌스 배포 대기"],
        [
          "대체 모델",
          alternate
            ? `${alternate.status} P${fmt(alternate.version, 0)} · ${
              fmt((alternate.traffic_fraction || 0) * 100, 0)
            }% 교차검증`
            : "없음",
        ],
        ["데이터 갱신", "실거래 종료 즉시 · 정책은 검증 후 적용"],
        [
          "전체 원장 승률",
          lob.profitable_rate != null ? `${fmt(lob.profitable_rate * 100, 1)}%` : "표본 대기",
        ],
        [
          "전체 원장 순손익",
          lob.mean_net_bps != null ? `${fmt(lob.mean_net_bps, 2)} bp` : "표본 대기",
        ],
        [
          "원시 학습 범위",
          `${fmt(lob.samples, 0)}건 / ${fmt(lob.profiled_markets, 0)}코인`,
        ],
        ["승격 조건", "승률↑ · 순익↑ · 거래·회전 유지"],
        ["최근 데이터", lob.last_updated_at ? dateTime(lob.last_updated_at) : "표본 대기"],
      ];
      $("learning-status").innerHTML = rows.map(([label, value]) =>
        `<div class="detail-row"><span>${escapeHtml(label)}</span><strong>${
          escapeHtml(value)
        }</strong></div>`
      ).join("");
      return;
    }
    const active = data?.learning?.active_profile;
    const metrics = active?.evidence?.metrics || active?.evidence || {};
    const profile = active?.parameters || {};
    $("learning-status").innerHTML = [
      ["활성 프로필", active ? `v${active.version}` : "기본 안전 프로필"],
      ["프로필 출처", active?.source || "WEEKLY BASELINE"],
      ["Profit Factor", metrics.profit_factor ?? metrics.pf ?? "—"],
      ["기대수익", metrics.expectancy_pct != null ? `${fmt(metrics.expectancy_pct, 3)}%` : "—"],
      ["진입 최소점수", profile.min_score ?? profile.minScore ?? "—"],
      [
        "학습 표본",
        active ? `${fmt(active.samples, 0)} / 검증 ${fmt(active.validation_samples, 0)}` : "—",
      ],
      ["목표함수", active?.objective != null ? fmt(active.objective, 4) : "—"],
      ["최근 승격", active?.promoted_at ? dateTime(active.promoted_at) : "—"],
    ].map(([label, value]) =>
      `<div class="detail-row"><span>${escapeHtml(label)}</span><strong>${
        escapeHtml(value)
      }</strong></div>`
    ).join("");
  }

  function renderEvents(data) {
    const events = Array.isArray(data.recent_events) ? data.recent_events.slice(0, 12) : [];
    $("events-list").innerHTML = events.length
      ? events.map((row) => `
      <div class="event-item ${String(row.level || "").toLowerCase()}">
        <strong>${escapeHtml(row.code)}</strong>
        <p>${escapeHtml(row.message)}</p>
        <small>${dateTime(row.created_at)}</small>
      </div>`).join("")
      : '<p class="muted">기록된 이벤트가 없습니다.</p>';
    const flows = Array.isArray(data.cash_flows) ? data.cash_flows.slice(0, 10) : [];
    $("cashflow-list").innerHTML = flows.length
      ? flows.map((row) => `
      <div class="event-item warning">
        <strong>${
        escapeHtml(
          ({
            EXTERNAL_INCREASE: "잔고 증가 감지",
            EXTERNAL_DECREASE: "잔고 감소 감지",
            MANUAL_POSITION_REDUCTION: "포지션 수량 불일치",
          })[row.flow_type] || row.flow_type,
        )
      } · ${row.exchange === "upbit" ? "UPBIT" : "BINANCE"}</strong>
        <p>${money(row.amount_quote, row.quote_currency)}</p>
        <small>${dateTime(row.detected_at)}</small>
      </div>`).join("")
      : '<p class="muted">기록된 잔고 변동이 없습니다.</p>';
  }

  function renderStatus(data) {
    currentStatus = data;
    const settings = data.settings || {};
    const mode = settings.mode || "—";
    $("trader-mode").textContent = mode;
    $("trader-mode").className = mode === "LIVE_LIMITED" ? "mode-live" : "mode-paper";
    $("trader-mode-note").textContent = mode === "LIVE_LIMITED"
      ? "실제 주문 허용"
      : mode === "PAPER"
      ? "가상 체결·학습"
      : "운용 정지";
    const strategy = String(settings.strategy || "TREND").toUpperCase();
    $("trader-strategy").textContent = strategy;
    const scalpActive = strategy === "SCALP" || strategy === "LOB_SCALP";
    $("trader-strategy").className = scalpActive ? "state-running" : "mode-paper";
    const scalpProfile = String(
      settings.scalp_strategy_profile || (strategy === "LOB_SCALP" ? "LOB_SCALP" : "HF_SCALP"),
    );
    $("trader-strategy-note").textContent = strategy === "LOB_SCALP"
      ? `호가창·체결 중심 · 기본 ${fmt(settings.lob_max_holding_seconds || 180, 0)}초 / 절대 ${
        fmt(settings.lob_absolute_max_holding_seconds || 300, 0)
      }초`
      : strategy === "SCALP"
      ? `${scalpProfile} · 최대 ${
        fmt(settings.scalp_safety_ttl_minutes || settings.scalp_max_holding_minutes, 0)
      }분 TIMEOUT`
      : "상위 추세 중심";
    $("scalp-risk").textContent = scalpActive
      ? `1회 -${fmt(settings.scalp_max_single_loss_pct, 1)}% · 1일 -${
        fmt(settings.scalp_daily_loss_pct, 1)
      }%`
      : "—";
    $("scalp-risk-note").textContent = strategy === "LOB_SCALP"
      ? "거래횟수 상한 없음 · 비용 차감 순EV 양수만"
      : strategy === "SCALP"
      ? "운용금 설정 기준"
      : "스캘핑 비활성";
    const paused = Boolean(
      settings.pause_new_entries || settings.withdrawal_mode ||
        settings.manual_intervention_required || mode === "PAUSED",
    );
    $("entry-state").textContent = paused ? "중지" : "운용 중";
    $("entry-state").className = paused ? "state-paused" : "state-running";
    $("entry-state-note").textContent = settings.withdrawal_mode
      ? "출금 모드"
      : settings.manual_intervention_required
      ? "수동 변경 확인 필요"
      : settings.pause_new_entries
      ? "사용자 중지"
      : "신규 후보 자동 실행";
    $("gateway-state").textContent = data.gateway?.ok ? "정상" : "오류";
    $("gateway-state").className = data.gateway?.ok ? "state-running" : "state-paused";
    $("gateway-heartbeat").textContent = settings.last_gateway_heartbeat_at
      ? `마지막 ${dateTime(settings.last_gateway_heartbeat_at)}`
      : "하트비트 없음";
    $("operator-updated").textContent = `설정 rev.${data.version ?? "—"} · ${
      new Date().toLocaleString("ko-KR")
    } 갱신`;
    renderAccount(data, "upbit");
    renderAccount(data, "binance");
    renderAllocations(settings);
    renderPositions(data);
    renderLearning(data);
    renderEvents(data);
    const alerts = [];
    if (settings.withdrawal_mode) {
      alerts.push(
        "출금 모드입니다. 신규 매수는 중지되어 있으며 출금 완료 후 ‘즉시 재개 + 지금 스캔’을 누르세요.",
      );
    }
    if (
      (settings.strategy === "SCALP" || settings.strategy === "LOB_SCALP") &&
      settings.scalp_kill_switch
    ) alerts.push("스캘핑 킬스위치가 켜져 있어 모든 신규 진입이 차단됩니다.");
    if (
      (settings.strategy === "SCALP" || settings.strategy === "LOB_SCALP") &&
      (Number(settings.scalp_daily_loss_pct) < 1 || Number(settings.scalp_max_single_loss_pct) < 1)
    ) alerts.push("스캘핑 손실 제한 설정이 비정상적으로 낮습니다. 설정 복구가 필요합니다.");
    if (settings.manual_intervention_required) {
      alerts.push(
        `수동 거래가 감지되었습니다: ${
          settings.manual_event_reason || "계좌 잔고 변경"
        }. 장부는 실제 잔고로 조정되며 학습 표본에서 제외됩니다.`,
      );
    }
    if (!data.gateway?.ok) {
      alerts.push(`주문 게이트웨이 오류: ${data.gateway?.error || "상태 확인 실패"}`);
    }
    const activeLocks = Array.isArray(data.asset_locks) ? data.asset_locks.filter((row) => row.state === "LOCKED") : [];
    if (activeLocks.length) {
      alerts.push(`자산 잠금 ${activeLocks.length}건: ${activeLocks.slice(0, 5).map((row) => `${row.exchange}:${row.asset}`).join(", ")}`);
    }
    const residuals = Array.isArray(data.residual_inventory)
      ? data.residual_inventory.filter((row) => finite(row.remaining_quantity) > 0)
      : [];
    if (residuals.length) {
      alerts.push(`잔량 원장 ${residuals.length}건 · 재진입 합산 또는 조건부 sweep 대기`);
    }
    traderAlert.textContent = alerts.join(" ");
    setHidden(traderAlert, alerts.length === 0);
  }

  async function loadStatus(silent = false) {
    if (!silent) $("operator-updated").textContent = "상태 불러오는 중";
    const data = await request({ action: "status" }, 45000);
    renderStatus(data);
    return data;
  }

  async function runAction(label, body, options = {}) {
    const target = options.statusTarget || controlStatus;
    target.textContent = `${label} 처리 중입니다.`;
    try {
      const result = await request(body, options.timeoutMs || 120000);
      target.textContent = `${label} 완료`;
      await loadStatus(true);
      return result;
    } catch (error) {
      target.textContent = `${label} 실패: ${error.message || error}`;
      throw error;
    }
  }

  async function resumeNow() {
    const button = $("resume-now");
    button.disabled = true;
    controlStatus.textContent = "계좌를 실제 잔고로 맞춘 뒤 즉시 재개합니다.";
    try {
      await request({ action: "resume" }, 120000);
      controlStatus.textContent = "재개 완료. 대기시간 없이 지금 통합 스캔을 시작했습니다.";
      await loadStatus(true);
      try {
        const scan = await request({ action: "scan" }, 330000);
        controlStatus.textContent = scan.status === "SKIPPED"
          ? `즉시 재개 완료 · 스캔은 ${scan.reason || "다른 작업 실행 중"}`
          : "즉시 재개 및 통합 스캔 완료";
      } catch (scanError) {
        controlStatus.textContent = `운용은 즉시 재개됐지만 첫 스캔이 실패했습니다: ${
          scanError.message || scanError
        }`;
      }
      await loadStatus(true);
    } catch (error) {
      controlStatus.textContent = `즉시 재개 실패: ${error.message || error}`;
    } finally {
      button.disabled = false;
    }
  }

  async function saveAllocation() {
    const upbitMode = $("upbit-allocation-mode").value;
    const binanceMode = $("binance-allocation-mode").value;
    const upbitFixed = Number($("upbit-allocation-value").value || 0);
    const binanceFixed = Number($("binance-allocation-value").value || 0);
    const upbitReserve = Number($("upbit-reserve-value").value || 0);
    const binanceReserve = Number($("binance-reserve-value").value || 0);
    if (
      ![upbitFixed, binanceFixed, upbitReserve, binanceReserve].every((value) =>
        Number.isFinite(value) && value >= 0
      )
    ) {
      throw new Error("운용금과 보호금에는 0 이상의 숫자만 입력하세요.");
    }
    if (upbitMode === "FIXED" && upbitFixed < 5000) {
      throw new Error("업비트 선택 운용금은 최소 5,000 KRW입니다.");
    }
    if (binanceMode === "FIXED" && binanceFixed < 5) {
      throw new Error("바이낸스 선택 운용금은 최소 5 USDT입니다.");
    }
    allocationStatus.textContent = "저장 중";
    await request({
      action: "control",
      upbit_enabled: $("upbit-enabled").checked,
      binance_enabled: $("binance-enabled").checked,
      upbit_allocation_mode: upbitMode,
      upbit_allocation_krw: upbitFixed,
      upbit_reserve_krw: upbitReserve,
      binance_allocation_mode: binanceMode,
      binance_allocation_usdt: binanceFixed,
      binance_reserve_usdt: binanceReserve,
    });
    allocationDirty = false;
    allocationStatus.textContent = "저장 완료";
    await loadStatus(true);
    setTimeout(() => allocationStatus.textContent = "", 2500);
  }

  viewButtons.forEach((button) =>
    button.addEventListener("click", () => setView(button.dataset.view))
  );
  $("unlock-trader")?.addEventListener("click", unlockDashboard);
  tokenInput?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") unlockDashboard();
  });
  $("lock-trader")?.addEventListener("click", () => lockDashboard("대시보드를 잠갔습니다."));
  $("refresh-trader")?.addEventListener(
    "click",
    () => loadStatus(false).catch((error) => controlStatus.textContent = error.message),
  );
  $("pause-entries")?.addEventListener("click", async () => {
    const confirmation = prompt("신규 매수를 중지하려면 PAUSE_NOW를 입력하세요.");
    if (confirmation !== "PAUSE_NOW") return;
    await runAction("신규 매수 중지", {
      action: "control",
      pause_new_entries: true,
      pause_confirmation: confirmation,
      control_source: "DASHBOARD_OPERATOR",
      control_reason: "OPERATOR_REQUEST",
    });
  });
  $("resume-now")?.addEventListener("click", resumeNow);
  $("withdrawal-mode")?.addEventListener("click", async () => {
    if (!confirm("출금 모드를 시작하면 신규 매수가 즉시 중지됩니다. 계속할까요?")) return;
    await runAction("출금 모드", { action: "withdrawal_mode" });
  });
  $("reconcile-now")?.addEventListener(
    "click",
    () => runAction("계좌 대조", { action: "reconcile" }, { timeoutMs: 120000 }),
  );
  $("set-paper-mode")?.addEventListener(
    "click",
    () => runAction("PAPER 전환", { action: "control", mode: "PAPER", pause_new_entries: false }),
  );
  $("set-live-mode")?.addEventListener("click", async () => {
    const confirmation = prompt("실제 주문을 허용하려면 ENABLE_LIVE를 입력하세요.");
    if (confirmation !== "ENABLE_LIVE") return;
    await runAction("LIVE_LIMITED 전환", {
      action: "control",
      mode: "LIVE_LIMITED",
      pause_new_entries: false,
      confirmation,
    });
  });
  $("emergency-liquidate")?.addEventListener("click", async () => {
    const confirmation = prompt("모든 봇 포지션을 시장가로 청산하려면 LIQUIDATE_NOW를 입력하세요.");
    if (confirmation !== "LIQUIDATE_NOW") return;
    await runAction("비상 청산 설정", {
      action: "control",
      pause_new_entries: true,
      emergency_liquidation: true,
      confirmation,
    });
    await runAction("비상 청산 실행", { action: "monitor" }, { timeoutMs: 120000 });
  });
  $("save-allocation")?.addEventListener(
    "click",
    () =>
      saveAllocation().catch((error) =>
        allocationStatus.textContent = `저장 실패: ${error.message || error}`
      ),
  );
  ["upbit-allocation-mode", "binance-allocation-mode"].forEach((id) =>
    $(id)?.addEventListener("change", () => {
      allocationDirty = true;
      toggleAllocationInputs();
    })
  );
  [
    "upbit-enabled",
    "binance-enabled",
    "upbit-allocation-value",
    "upbit-reserve-value",
    "binance-allocation-value",
    "binance-reserve-value",
  ].forEach((id) => $(id)?.addEventListener("input", () => allocationDirty = true));

  setView("scanner");
})();
