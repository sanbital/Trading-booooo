(() => {
  "use strict";

  const config = window.TRADING_SCANNER_CONFIG || {};
  const $ = (id) => document.getElementById(id);
  let pending = false;
  let timer = null;

  function accessToken() {
    const raw = window.location.hash.replace(/^#/, "").trim();
    if (!raw) return "";
    const params = new URLSearchParams(raw);
    return (params.get("access") || params.get("token") || (!raw.includes("=") ? raw : "")).trim();
  }

  function endpoint() {
    return `${String(config.supabaseUrl || "").replace(/\/$/, "")}/functions/v1/v15-range-live-control`;
  }

  function ensureStyle() {
    if ($("v15-range-control-style")) return;
    const style = document.createElement("style");
    style.id = "v15-range-control-style";
    style.textContent = `
      #v15-range-control-section .v15-control-panel{padding:18px;display:grid;gap:14px}
      #v15-range-control-section .v15-control-head{display:flex;gap:14px;align-items:flex-start;justify-content:space-between;flex-wrap:wrap}
      #v15-range-control-section .v15-control-state{font-weight:800;font-size:1.02rem}
      #v15-range-control-section .v15-state-ready{color:#0a7d43}
      #v15-range-control-section .v15-state-live{color:#b94700}
      #v15-range-control-section .v15-state-blocked{color:#b42318}
      #v15-range-control-section .v15-control-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px}
      #v15-range-control-section .v15-control-grid>div{padding:10px 12px;border:1px solid rgba(127,127,127,.2);border-radius:10px;display:grid;gap:4px}
      #v15-range-control-section .v15-control-grid span{font-size:.78rem;opacity:.72}
      #v15-range-control-section .v15-control-actions{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
      #v15-range-control-section .v15-control-note{font-size:.84rem;line-height:1.55;opacity:.78}
      #v15-range-control-section .v15-control-blockers{font-size:.84rem;line-height:1.55;color:#b42318}
      #v15-range-control-action.v15-live-stop{background:#fff;border-color:#b42318;color:#b42318}
      @media(max-width:760px){#v15-range-control-section .v15-control-grid{grid-template-columns:repeat(2,minmax(0,1fr))}#v15-range-control-action{width:100%}}
    `;
    document.head.appendChild(style);
  }

  function ensureCard() {
    ensureStyle();
    let section = $("v15-range-control-section");
    if (section) return section;
    section = document.createElement("section");
    section.id = "v15-range-control-section";
    section.className = "section-block";
    section.innerHTML = `
      <div class="section-heading performance-heading">
        <div><p class="eyebrow">V15 RANGE LIVE CONTROL</p><h2>V15 RANGE 실거래</h2></div>
        <p>V15 R7 전용 신규 진입 스위치입니다. BULL·V14 BEAR 운용과 분리되어 있습니다.</p>
      </div>
      <article class="panel v15-control-panel">
        <div class="v15-control-head">
          <div>
            <div id="v15-range-control-state" class="v15-control-state">상태 확인 중</div>
            <div id="v15-range-control-message" class="muted">프리플라이트를 확인하고 있습니다.</div>
          </div>
          <button id="v15-range-control-refresh" class="button-secondary" type="button">상태 새로고침</button>
        </div>
        <div class="v15-control-grid">
          <div><span>현재 레짐</span><b id="v15-range-control-regime">—</b></div>
          <div><span>가용 자금</span><b id="v15-range-control-available">—</b></div>
          <div><span>현재 지원 슬롯</span><b id="v15-range-control-slots">—</b></div>
          <div><span>주문 실행회로</span><b id="v15-range-control-compiled">—</b></div>
        </div>
        <div id="v15-range-control-blockers" class="v15-control-blockers"></div>
        <div class="v15-control-actions">
          <button id="v15-range-control-action" class="button-primary" type="button" disabled>상태 확인 중</button>
          <span id="v15-range-control-updated" class="muted"></span>
        </div>
        <div class="v15-control-note">활성화 시 Binance USDⓈ-M Futures · LONG · 증거금 40 USDT · 3배 레버리지로, R7 조건을 충족할 때만 신규 주문을 제출합니다. 최대 10슬롯은 상한이며 실제 슬롯은 가용자금과 기존 포지션에 따라 자동 축소됩니다. 신규 진입을 중지해도 열린 V15 포지션의 guardian은 계속 청산을 관리합니다.</div>
      </article>`;
    const anchor = $("trader-notice") || $("trader-alert") || document.querySelector("#trader-console .operator-header");
    const positions = $("positions-body")?.closest(".section-block");
    if (anchor) anchor.after(section);
    else if (positions) positions.before(section);
    else $("trader-console")?.prepend(section);
    $("v15-range-control-refresh")?.addEventListener("click", () => load(true));
    $("v15-range-control-action")?.addEventListener("click", toggleLive);
    return section;
  }

  function fmtUsdt(value) {
    const n = Number(value);
    return Number.isFinite(n) ? `${n.toLocaleString("ko-KR", { maximumFractionDigits: 2 })} USDT` : "—";
  }

  function render(data) {
    ensureCard();
    const runtime = data?.runtime || {};
    const pf = data?.preflight || {};
    const live = runtime.liveEnabled === true;
    const ready = data?.activationReady === true;
    const state = $("v15-range-control-state");
    state.className = `v15-control-state ${live ? "v15-state-live" : ready ? "v15-state-ready" : "v15-state-blocked"}`;
    state.textContent = live ? "실거래 활성" : ready ? "활성화 준비 완료" : "활성화 차단";
    $("v15-range-control-message").textContent = live
      ? "R7 조건 충족 시 V15 RANGE 신규 주문이 제출될 수 있습니다."
      : ready
      ? "프리플라이트 정상 · 사용자 승인 시에만 실거래를 시작합니다."
      : "안전 조건이 충족되지 않아 활성화할 수 없습니다.";
    $("v15-range-control-regime").textContent = pf.regime ? `${pf.regime} · ${(Number(pf.confidence || 0) * 100).toFixed(1)}%` : "—";
    $("v15-range-control-available").textContent = fmtUsdt(pf.availableUsdt);
    $("v15-range-control-slots").textContent = Number.isFinite(Number(pf.equitySupportedSlots)) ? `${pf.equitySupportedSlots} / ${runtime.maxSlots || 10}` : "—";
    $("v15-range-control-compiled").textContent = runtime.orderRoutingCompiled ? "READY" : "NOT READY";
    const blockers = Array.isArray(data?.blockers) ? data.blockers : [];
    $("v15-range-control-blockers").textContent = blockers.length ? `차단 사유: ${blockers.join(" · ")}` : "";
    const action = $("v15-range-control-action");
    action.disabled = pending || (!live && !ready);
    action.textContent = live ? "V15 RANGE 신규 진입 중지" : "V15 RANGE 실거래 활성화";
    action.classList.toggle("v15-live-stop", live);
    action.dataset.live = live ? "true" : "false";
    $("v15-range-control-updated").textContent = pf.checkedAt ? `검증 ${new Date(pf.checkedAt).toLocaleString("ko-KR")}` : "";
  }

  async function call(action, refresh = false) {
    const token = accessToken();
    if (!token || token.length < 24) throw new Error("대시보드 접속 토큰이 없습니다.");
    const response = await fetch(endpoint(), {
      method: "POST",
      cache: "no-store",
      headers: { "content-type": "application/json", "x-autotrade-token": token },
      body: JSON.stringify({ action, refresh }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const reason = Array.isArray(data?.blockers) && data.blockers.length ? data.blockers.join(" · ") : data?.error || `HTTP ${response.status}`;
      throw new Error(reason);
    }
    return data;
  }

  async function load(refresh = false) {
    if (pending) return;
    pending = true;
    ensureCard();
    try {
      const data = await call("status", refresh);
      render(data);
    } catch (error) {
      const state = $("v15-range-control-state");
      state.className = "v15-control-state v15-state-blocked";
      state.textContent = "상태 확인 실패";
      $("v15-range-control-message").textContent = error instanceof Error ? error.message : String(error);
      $("v15-range-control-action").disabled = true;
    } finally {
      pending = false;
    }
  }

  async function toggleLive() {
    if (pending) return;
    const button = $("v15-range-control-action");
    const live = button?.dataset.live === "true";
    const question = live
      ? "V15 RANGE 신규 진입을 중지하시겠습니까?\n\n이미 열린 V15 포지션은 guardian이 계속 관리합니다."
      : "V15 RANGE 실거래를 활성화하시겠습니까?\n\nBinance USDⓈ-M Futures · LONG · 증거금 40 USDT · 3배 레버리지입니다. R7 조건 충족 시 실제 주문이 제출될 수 있습니다.";
    if (!window.confirm(question)) return;
    pending = true;
    if (button) { button.disabled = true; button.textContent = live ? "중지 처리 중…" : "활성화 검증 중…"; }
    try {
      const data = await call(live ? "disable" : "enable", true);
      render(data?.state || data);
    } catch (error) {
      window.alert(`V15 RANGE 변경 실패: ${error instanceof Error ? error.message : String(error)}`);
      await load(true);
    } finally {
      pending = false;
    }
  }

  function boot() {
    ensureCard();
    load(true);
    if (timer) clearInterval(timer);
    timer = setInterval(() => load(false), 30_000);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot, { once: true });
  else boot();
  window.addEventListener("pageshow", () => setTimeout(() => load(false), 0));
})();
