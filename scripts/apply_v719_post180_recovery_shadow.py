from pathlib import Path


PATH = Path("supabase/functions/market-autotrader/index.ts")
text = PATH.read_text(encoding="utf-8")


def replace_once(old: str, new: str, label: str) -> None:
    global text
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected exactly one match, found {count}")
    text = text.replace(old, new, 1)


NEW_VERSION = "7.1.9-POST180-RECOVERY-SHADOW"
if f'const VERSION = "{NEW_VERSION}";' in text:
    print("v7.1.9 post-180 recovery shadow already applied")
    raise SystemExit(0)

replace_once(
    'const VERSION = "7.1.8-PRE180-TARGET-REVERSAL";',
    f'const VERSION = "{NEW_VERSION}";',
    "engine version",
)

# The post-180 recovery classifier is deliberately shadow-only. It never changes
# the executable decision. The canonical ordering remains:
#   1) guarded executable net > 0 -> sell all immediately
#   2) guarded return <= -3% -> hard stop
#   3) otherwise hold while recording whether a conservative two-reclaim failure
#      would have reduced the eventual loss or merely sold normal crypto volatility.
insert_after = '''        const rawSoftReason = exit.nextSoftReason;
        const nowMs = Date.now();
'''
shadow_state = '''        const priorPost180Shadow = position.metadata?.lob_post180_recovery_shadow || {};
        const post180ShadowEligible = heldSeconds >= 180;
        const post180PriceAt180 = post180ShadowEligible
          ? Math.max(0, finite(priorPost180Shadow.price_at_180, current))
          : 0;
        const post180NoiseBandBps = clamp(
          Math.max(
            60,
            finite(position.metadata?.lob_signal?.features?.noiseBandBps, 0) * 4,
            finite(pinnedCoinPolicy.learned_stop_floor_bps, 0) * 2,
            Math.max(0, spread) * 3,
          ),
          60,
          220,
        );
        const priorPost180History = Array.isArray(position.metadata?.lob_post180_shadow_history)
          ? position.metadata.lob_post180_shadow_history
          : [];
        let post180ShadowHistory = priorPost180History
          .map((sample: any) => ({
            at: finite(sample?.at),
            reason: sample?.reason === "SIGNAL_REVERSAL" || sample?.reason === "LOB_INVALIDATION"
              ? sample.reason
              : null,
            price: finite(sample?.price),
            adverse_bps: finite(sample?.adverse_bps),
          }))
          .filter((sample: any) => sample.at >= nowMs - 180_000 && sample.at <= nowMs);
        if (post180ShadowEligible) {
          const adverseBps = post180PriceAt180 > 0
            ? (current / post180PriceAt180 - 1) * 10000
            : 0;
          post180ShadowHistory.push({
            at: nowMs,
            reason: rawSoftReason,
            price: current,
            adverse_bps: adverseBps,
          });
          post180ShadowHistory = post180ShadowHistory.slice(-120);
        } else {
          post180ShadowHistory = [];
        }
        const coveredPost180AdverseMs = (windowStartMs: number): number => {
          const samples = [...post180ShadowHistory]
            .filter((sample: any) => sample.at <= nowMs)
            .sort((left: any, right: any) => left.at - right.at);
          let activeReason: "SIGNAL_REVERSAL" | "LOB_INVALIDATION" | null = null;
          let cursorMs = windowStartMs;
          let coveredMs = 0;
          for (const sample of samples) {
            if (sample.at <= windowStartMs) {
              activeReason = sample.reason;
              continue;
            }
            const sampleAtMs = Math.min(nowMs, sample.at);
            if (activeReason !== null) coveredMs += Math.max(0, sampleAtMs - cursorMs);
            cursorMs = Math.max(cursorMs, sampleAtMs);
            activeReason = sample.reason;
          }
          if (activeReason !== null) coveredMs += Math.max(0, nowMs - cursorMs);
          return coveredMs;
        };
        const post180LatestReason = post180ShadowHistory.length
          ? post180ShadowHistory[post180ShadowHistory.length - 1].reason
          : null;
        const post180AdversePersistent = post180ShadowEligible && post180LatestReason !== null &&
          coveredPost180AdverseMs(nowMs - 60_000) >= 45_000 &&
          coveredPost180AdverseMs(nowMs - 20_000) >= 18_000;
        let post180Phase = post180ShadowEligible
          ? String(priorPost180Shadow.phase || "POST180_RECOVERY_HOLD")
          : "INACTIVE";
        let post180FailedReclaims = post180ShadowEligible
          ? Math.max(0, Math.floor(finite(priorPost180Shadow.failed_reclaims)))
          : 0;
        let post180LowestPrice = post180ShadowEligible
          ? Math.min(current, finite(priorPost180Shadow.lowest_price, current))
          : current;
        let post180ReclaimHigh = post180ShadowEligible
          ? Math.max(current, finite(priorPost180Shadow.reclaim_high, current))
          : current;
        const post180AdverseFromStartBps = post180PriceAt180 > 0
          ? (current / post180PriceAt180 - 1) * 10000
          : 0;
        const post180ReboundFromLowBps = post180LowestPrice > 0
          ? (current / post180LowestPrice - 1) * 10000
          : 0;
        const post180ReclaimThresholdBps = clamp(post180NoiseBandBps * 0.35, 24, 80);
        if (post180ShadowEligible) {
          if (
            post180Phase === "POST180_RECOVERY_HOLD" &&
            post180AdverseFromStartBps <= -post180NoiseBandBps
          ) {
            post180Phase = "POST180_BREACH_WATCH";
            post180LowestPrice = current;
            post180ReclaimHigh = current;
          } else if (
            (post180Phase === "POST180_BREACH_WATCH" ||
              post180Phase === "POST180_FAILED_RECLAIM_1") &&
            post180ReboundFromLowBps >= post180ReclaimThresholdBps
          ) {
            post180Phase = "POST180_RECLAIM_TEST";
            post180ReclaimHigh = current;
          } else if (post180Phase === "POST180_RECLAIM_TEST") {
            post180ReclaimHigh = Math.max(post180ReclaimHigh, current);
            const retestedLow = current <= post180LowestPrice * 1.0005;
            const hadMeaningfulRebound = post180ReclaimHigh >=
              post180LowestPrice * (1 + post180ReclaimThresholdBps / 10000);
            if (retestedLow && hadMeaningfulRebound && post180AdversePersistent) {
              post180FailedReclaims += 1;
              post180Phase = post180FailedReclaims >= 2
                ? "POST180_FAILED_RECLAIM_2"
                : "POST180_FAILED_RECLAIM_1";
              post180LowestPrice = current;
              post180ReclaimHigh = current;
            }
          }
          if (
            post180Phase !== "POST180_RECLAIM_TEST" &&
            post180Phase !== "POST180_FAILED_RECLAIM_2"
          ) {
            post180LowestPrice = Math.min(post180LowestPrice, current);
          }
        }
        const priorPost180ShadowQualified = Boolean(priorPost180Shadow.shadow_exit_qualified);
        const post180ShadowQualified = post180ShadowEligible &&
          post180FailedReclaims >= 2 &&
          post180Phase === "POST180_FAILED_RECLAIM_2" &&
          post180AdversePersistent &&
          post180AdverseFromStartBps <= -post180NoiseBandBps;
'''
replace_once(insert_after, insert_after + shadow_state, "post-180 recovery shadow state")

metadata_marker = '''                lob_soft_exit_history: softHistory,
                lob_soft_exit_recovery_started_at: Number.isFinite(recoveryStartedAtMs)
                  ? new Date(recoveryStartedAtMs).toISOString()
                  : null,
'''
metadata_replacement = metadata_marker + '''                lob_post180_shadow_history: post180ShadowHistory,
                lob_post180_recovery_shadow: post180ShadowEligible
                  ? {
                    revision: NEW_VERSION,
                    mode: "SHADOW_ONLY",
                    started_at: priorPost180Shadow.started_at || new Date(nowMs).toISOString(),
                    price_at_180: post180PriceAt180,
                    phase: post180Phase,
                    failed_reclaims: post180FailedReclaims,
                    lowest_price: post180LowestPrice,
                    reclaim_high: post180ReclaimHigh,
                    adverse_band_bps: post180NoiseBandBps,
                    reclaim_threshold_bps: post180ReclaimThresholdBps,
                    adverse_from_180_bps: post180AdverseFromStartBps,
                    adverse_persistent: post180AdversePersistent,
                    latest_reason: post180LatestReason,
                    shadow_exit_qualified: post180ShadowQualified,
                    qualified_at: post180ShadowQualified
                      ? priorPost180Shadow.qualified_at || new Date(nowMs).toISOString()
                      : null,
                    checked_at: new Date(nowMs).toISOString(),
                  }
                  : null,
'''
replace_once(metadata_marker, metadata_replacement, "post-180 recovery metadata")

post_patch_marker = '''        const lobExitSafetyReason = exit.reason === "RISK_EMERGENCY" ||
'''
post_patch_event = '''        if (post180ShadowQualified && !priorPost180ShadowQualified) {
          await event(
            "LOB_POST180_SHADOW_SOFT_EXIT",
            `${exchange}:${position.market} second reclaim failure qualified in shadow mode`,
            {
              mode: "SHADOW_ONLY",
              held_seconds: heldSeconds,
              price_at_180: post180PriceAt180,
              current_price: current,
              adverse_from_180_bps: post180AdverseFromStartBps,
              adverse_band_bps: post180NoiseBandBps,
              reclaim_threshold_bps: post180ReclaimThresholdBps,
              failed_reclaims: post180FailedReclaims,
              latest_reason: post180LatestReason,
              adverse_persistent: post180AdversePersistent,
              executable_action: "HOLD",
              canonical_positive_exit_preserved: true,
              canonical_hard_stop_preserved: true,
            },
            { cycleId, positionId: position.id, level: "INFO" },
          );
        }
'''
replace_once(post_patch_marker, post_patch_event + post_patch_marker, "post-180 shadow event")

text = text.replace("7.1.8-PRE180-TARGET-REVERSAL", NEW_VERSION)
PATH.write_text(text, encoding="utf-8")

required = [
    f'const VERSION = "{NEW_VERSION}";',
    "LOB_POST180_SHADOW_SOFT_EXIT",
    'mode: "SHADOW_ONLY"',
    "lob_post180_recovery_shadow",
    "post180FailedReclaims >= 2",
    "canonical_positive_exit_preserved: true",
    "POSITIVE_NET_AFTER_180S",
    "HARD_STOP_MINUS_3_AFTER_180S",
    "guardedNetReturnPct <= -3",
]
missing = [item for item in required if item not in text]
if missing:
    raise SystemExit("v7.1.9 validation failed: " + ", ".join(missing))
for item in required:
    print("PASS:", item)
