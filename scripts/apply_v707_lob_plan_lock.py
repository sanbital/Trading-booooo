from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    file_path = Path(path)
    text = file_path.read_text(encoding="utf-8")
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{path}: expected exactly 1 match, found {count}")
    file_path.write_text(text.replace(old, new, 1), encoding="utf-8")


replace_once(
    "supabase/functions/_shared/lob/types.ts",
    """  maxHoldingSeconds: number;\n  absoluteMaxHoldingSeconds: number;\n  uncertaintyHaircut: number;""",
    """  maxHoldingSeconds: number;\n  absoluteMaxHoldingSeconds: number;\n  /** Immutable scanner-plan geometry used by the order-time live recheck. */\n  fixedTargetBps?: number;\n  fixedStopBps?: number;\n  fixedMaxHoldingSeconds?: number;\n  uncertaintyHaircut: number;""",
)

replace_once(
    "supabase/functions/_shared/lob/entry.ts",
    """  const cfg = { ...DEFAULT_LOB_ENTRY_CONFIG, ...overrides };\n  const reasons: string[] = [];\n  const warnings: string[] = [];""",
    """  const cfg = { ...DEFAULT_LOB_ENTRY_CONFIG, ...overrides };\n  const reasons: string[] = [];\n  const warnings: string[] = [];\n  const rawFixedTargetBps = Number(cfg.fixedTargetBps);\n  const rawFixedStopBps = Number(cfg.fixedStopBps);\n  const rawFixedMaxHoldingSeconds = Number(cfg.fixedMaxHoldingSeconds);\n  const fixedTargetBps =\n    Number.isFinite(rawFixedTargetBps) && rawFixedTargetBps > 0\n      ? rawFixedTargetBps\n      : null;\n  const fixedStopBps =\n    Number.isFinite(rawFixedStopBps) && rawFixedStopBps > 0\n      ? rawFixedStopBps\n      : null;\n  const fixedMaxHoldingSeconds =\n    Number.isFinite(rawFixedMaxHoldingSeconds) && rawFixedMaxHoldingSeconds > 0\n      ? Math.round(rawFixedMaxHoldingSeconds)\n      : null;\n  const hasFixedPlanGeometry =\n    fixedTargetBps !== null &&\n    fixedStopBps !== null &&\n    fixedMaxHoldingSeconds !== null;""",
)

replace_once(
    "supabase/functions/_shared/lob/entry.ts",
    """  const targetBps = clamp(\n    Math.max(cfg.minTargetBps, totalTargetCostBps + cfg.minNetProfitBps, movementBps),\n    cfg.minTargetBps,\n    targetCeilingBps,\n  );""",
    """  const targetBps = hasFixedPlanGeometry\n    ? fixedTargetBps as number\n    : clamp(\n      Math.max(cfg.minTargetBps, totalTargetCostBps + cfg.minNetProfitBps, movementBps),\n      cfg.minTargetBps,\n      targetCeilingBps,\n    );""",
)

replace_once(
    "supabase/functions/_shared/lob/entry.ts",
    """  const provisionalStopBps = clamp(\n    Math.max(cfg.minStopBps, targetBps * plannedStopRatio),\n    cfg.minStopBps,\n    cfg.maxStopBps,\n  );""",
    """  const provisionalStopBps = hasFixedPlanGeometry\n    ? fixedStopBps as number\n    : clamp(\n      Math.max(cfg.minStopBps, targetBps * plannedStopRatio),\n      cfg.minStopBps,\n      cfg.maxStopBps,\n    );""",
)

replace_once(
    "supabase/functions/_shared/lob/entry.ts",
    """  const stopBps = clamp(\n    Math.max(provisionalStopBps, traps.requiredStopBps, microstructureStopFloorBps),\n    cfg.minStopBps,\n    cfg.maxStopBps,\n  );""",
    """  const liveStopFloorBps = Math.max(\n    cfg.minStopBps,\n    traps.requiredStopBps,\n    microstructureStopFloorBps,\n  );\n  const stopBps = hasFixedPlanGeometry\n    ? fixedStopBps as number\n    : clamp(\n      Math.max(provisionalStopBps, liveStopFloorBps),\n      cfg.minStopBps,\n      cfg.maxStopBps,\n    );\n\n  if (hasFixedPlanGeometry) {\n    warnings.push(\"FIXED_SCAN_PLAN_GEOMETRY\");\n    if (stopBps < liveStopFloorBps) {\n      reasons.push(\"FIXED_PLAN_STOP_INVALIDATED\");\n    }\n  }""",
)

replace_once(
    "supabase/functions/_shared/lob/entry.ts",
    """    r.startsWith(\"TRAP_\") ||\n    r.startsWith(\"FLOW_\") ||""",
    """    r.startsWith(\"TRAP_\") ||\n    r.startsWith(\"FLOW_\") ||\n    r.startsWith(\"FIXED_PLAN_\") ||""",
)

replace_once(
    "supabase/functions/_shared/lob/entry.ts",
    """    maxHoldingSeconds: Math.min(\n      cfg.absoluteMaxHoldingSeconds,\n      Math.max(1, isMomentum ? Math.min(90, cfg.maxHoldingSeconds) : cfg.maxHoldingSeconds),\n    ),""",
    """    maxHoldingSeconds: hasFixedPlanGeometry\n      ? fixedMaxHoldingSeconds as number\n      : Math.min(\n        cfg.absoluteMaxHoldingSeconds,\n        Math.max(1, isMomentum ? Math.min(90, cfg.maxHoldingSeconds) : cfg.maxHoldingSeconds),\n      ),""",
)

replace_once(
    "supabase/functions/market-autotrader/index.ts",
    "// Trading-booooo v7.0.5-LOB-30S-MINIMUM — autonomous spot orchestrator.",
    "// Trading-booooo v7.0.7-LOB-SCAN-PLAN-LOCK — autonomous spot orchestrator.",
)

replace_once(
    "supabase/functions/market-autotrader/index.ts",
    'const VERSION = "7.0.5-LOB-30S-MINIMUM";',
    'const VERSION = "7.0.7-LOB-SCAN-PLAN-LOCK";',
)

replace_once(
    "supabase/functions/market-autotrader/index.ts",
    """    const lobSnapshot = (candidate as any).snapshot?.lob || {};\n    const features = liveLobFeatures(lobSnapshot, market);""",
    """    const lobSnapshot = (candidate as any).snapshot?.lob || {};\n    const fixedPlanTargetBps = finite(lobSnapshot.target_bps, 0);\n    const fixedPlanStopBps = finite(lobSnapshot.stop_bps, 0);\n    const fixedPlanMaxHoldingSeconds = Math.round(\n      finite(lobSnapshot.max_holding_seconds, 0),\n    );\n    if (\n      !(fixedPlanTargetBps > 0) ||\n      !(fixedPlanStopBps > 0) ||\n      !(fixedPlanMaxHoldingSeconds > 0)\n    ) {\n      return {\n        entered: false,\n        exchange,\n        market: candidate.market,\n        reason: \"scanner LOB plan geometry is missing or invalid\",\n      };\n    }\n    const features = liveLobFeatures(lobSnapshot, market);""",
)

replace_once(
    "supabase/functions/market-autotrader/index.ts",
    """      onlinePolicy,\n      evidenceSizing,\n    };""",
    """      onlinePolicy,\n      evidenceSizing,\n      fixedPlanTargetBps,\n      fixedPlanStopBps,\n      fixedPlanMaxHoldingSeconds,\n    };""",
)

replace_once(
    "supabase/functions/market-autotrader/index.ts",
    """      onlinePolicy,\n      evidenceSizing,\n    } = lobSizingContext;""",
    """      onlinePolicy,\n      evidenceSizing,\n      fixedPlanTargetBps,\n      fixedPlanStopBps,\n      fixedPlanMaxHoldingSeconds,\n    } = lobSizingContext;""",
)

replace_once(
    "supabase/functions/market-autotrader/index.ts",
    """      makerFillSamples: makerFill.rested,\n      learnedStopFloorBps: 0,\n    });""",
    """      makerFillSamples: makerFill.rested,\n      learnedStopFloorBps: 0,\n      overrides: {\n        fixedTargetBps: fixedPlanTargetBps,\n        fixedStopBps: fixedPlanStopBps,\n        fixedMaxHoldingSeconds: fixedPlanMaxHoldingSeconds,\n      },\n    });""",
)

replace_once(
    "supabase/functions/market-autotrader/index.ts",
    '      strategy_revision: "7.0.5-LOB-30S-MINIMUM",',
    '      strategy_revision: "7.0.7-LOB-SCAN-PLAN-LOCK",',
)

replace_once(
    "supabase/functions/market-autotrader/index.ts",
    """      features: decision.features,\n      scanned_lob: lobSnapshot,""",
    """      features: decision.features,\n      fixed_scan_plan_geometry: {\n        target_bps: fixedPlanTargetBps,\n        stop_bps: fixedPlanStopBps,\n        max_holding_seconds: fixedPlanMaxHoldingSeconds,\n      },\n      scanned_lob: lobSnapshot,""",
)

print("v7.0.7 LOB scanner-plan lock patch applied successfully")
