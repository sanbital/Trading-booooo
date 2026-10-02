/** Reproducible empirical bands. See ops/deterministic/calibrate.mjs. */
export const PROFILE=Object.freeze({
  "version": "DETERMINISTIC_DYNAMIC_STATE_1",
  "training_count": 47,
  "training_end": "2026-10-01T20:00:00Z",
  "dataset_sha256": "3734065a05209a018830bb5d401ec50f0c032834a671524863ffd33e80af5e2b",
  "selection": "chronological pre-cutoff trades; held-out later incidents excluded; pooled bands with matched feature units; no PnL or symbol optimization",
  "bands": {
    "ema9_distance": {
      "normal": 0.002178776535562754,
      "caution": 0.00843945713705785,
      "block": 0.017034800243569716,
      "samples": 35,
      "quantiles": [
        0.5,
        0.9,
        0.99
      ],
      "basis": "FIRST_RECORDED_ENTRY_FACT:ema9_distance"
    },
    "bb_position": {
      "normal": 0.6856608253066108,
      "caution": 1.0653944029727391,
      "block": 1.2334298401615567,
      "samples": 35,
      "quantiles": [
        0.5,
        0.9,
        0.99
      ],
      "basis": "FIRST_RECORDED_ENTRY_FACT:bb_position"
    },
    "rsi_1m_14": {
      "normal": 58.25615493276041,
      "caution": 74.2928548600833,
      "block": 83.15448868772535,
      "samples": 35,
      "quantiles": [
        0.5,
        0.9,
        0.99
      ],
      "basis": "FIRST_RECORDED_ENTRY_FACT:rsi_1m_14"
    },
    "rsi_5m_14": {
      "normal": 60.48888879199226,
      "caution": 72.62488796988227,
      "block": 87.2518424154395,
      "samples": 35,
      "quantiles": [
        0.5,
        0.9,
        0.99
      ],
      "basis": "FIRST_RECORDED_ENTRY_FACT:rsi_5m_14"
    },
    "stoch_k_1m": {
      "normal": 67.30769230769256,
      "caution": 92.40240802946121,
      "block": 94.17891043217149,
      "samples": 35,
      "quantiles": [
        0.5,
        0.9,
        0.99
      ],
      "basis": "FIRST_RECORDED_ENTRY_FACT:stoch_k_1m"
    },
    "atr_1m_14_normalized": {
      "normal": 0.005248101757810874,
      "caution": 0.013217199338699363,
      "block": 0.018216407496747807,
      "samples": 35,
      "quantiles": [
        0.5,
        0.9,
        0.99
      ],
      "basis": "FIRST_RECORDED_ENTRY_FACT:atr_1m_14_normalized"
    },
    "spread_bps": {
      "normal": 2.9099374363447983,
      "caution": 6.30980470214883,
      "block": 8.113949009243614,
      "samples": 47,
      "quantiles": [
        0.5,
        0.9,
        0.99
      ],
      "basis": "FIRST_RECORDED_ENTRY_FACT:spread_bps"
    },
    "day_return": {
      "normal": 0.139545665275846,
      "caution": 0.32452480296708386,
      "block": 0.3796012980992117,
      "samples": 9,
      "quantiles": [
        0.5,
        0.9,
        0.99
      ],
      "basis": "FIRST_RECORDED_ENTRY_FACT:day_return"
    },
    "volume": {
      "normal": 0.9012249350554932,
      "caution": 2.4315353925937706,
      "block": 10.062543472937488,
      "samples": 47,
      "quantiles": [
        0.5,
        0.9,
        0.99
      ],
      "basis": "LAST_5M_MEAN_QUOTE_VOLUME/PRECEDING_55M_MEAN"
    },
    "roundtrip_impact_bps": {
      "normal": 5.758883523657721,
      "caution": 8.919356865435102,
      "block": 13.37171124158311,
      "samples": 35,
      "quantiles": [
        0.5,
        0.9,
        0.99
      ],
      "basis": "RECORDED_ENTRY_BOOK_450_USDT_BUY_AND_EXIT_IMPACT_EXCLUDING_FEES"
    },
    "entry_drift": {
      "normal": 0.0008524706085939471,
      "caution": 0.007149814085162776,
      "block": 0.01710339301341521,
      "samples": 39,
      "quantiles": [
        0.5,
        0.9,
        0.99
      ],
      "basis": "EXECUTED_ENTRY_PRICE/LAST_RECORDED_DECISION_CAPTURE_MID-1"
    },
    "mfe": {
      "normal": 0.0076891676501043005,
      "caution": 0.003919315646857213,
      "block": 0.039919895472612536,
      "samples": 47,
      "quantiles": [
        0.5,
        0.25,
        0.9
      ],
      "basis": "HISTORICAL_SAMPLED_PEAK/ENTRY-1;CAUTION_IS_PROTECTION_ARM_QUARTILE"
    }
  }
});
