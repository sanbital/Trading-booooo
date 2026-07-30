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
    """  absoluteMaxHoldingSeconds?: number;\n  minFillProbability: number;""",
    """  absoluteMaxHoldingSeconds?: number;\n  fixedTargetBps?: number;\n  fixedStopBps?: number;\n  fixedMaxHoldingSeconds?: number;\n  minFillProbability: number;""",
)

replace_once(
    "supabase/functions/_shared/lob/entry.ts",
    """  const cfg = modeConfig(mode);\n  const reasons: string[] = [];\n  const warnings: string[] = [];""",
    """  const cfg = modeConfig(mode);\n  const reasons: string[] = [];\n  const warnings: string[] = [];\n  const rawFixedTargetBps = Number(cfg.fixedTargetBps);\n  const rawFixedStopBps = Number(cfg.fixedStopBps);\n  const rawFixedMaxHoldingSeconds = Number(cfg.fixedMaxHoldingSeconds);\n  const fixedTargetBps =\n    Number.isFinite(rawFixedTargetBps) && rawFixedTargetBps > 0\n      ? rawFixedTargetBps\n      : null;\n  const fixedStopBps =\n    Number.isFinite(rawFixedStopBps) && rawFixedStopBps > 0\n      ? rawFixedStopBps\n      : null;\n  const fixedMaxHoldingSeconds =\n    Number.isFinite(rawFixedMaxHoldingSeconds) && rawFixedMaxHoldingSeconds > 0\n      ? Math.round(rawFixedMaxHoldingSeconds)\n      : null;\n  const hasFixedPlanGeometry =\n    fixedTargetBps !== null &&\n    fixedStopBps !== null &&\n    fixedMaxHoldingSeconds !== null;""",
)

replace_once(
    "supabase/functions/_shared/lob/entry.ts",
    """  const targetBps = clamp(\n    regime === \"MICRO_MOMENTUM\" ? Math.max(targetNormal, momentumMove) : targetNormal,\n    cfg.minTargetBps,\n    targetCeilingBps,\n  );""",
    """  const targetBps = hasFixedPlanGeometry\n    ? fixedTargetBps as number\n    : clamp(\n      regime === \"MICRO_MOMENTUM\" ? Math.max(targetNormal, momentumMove) : targetNormal,\n      cfg.minTargetBps,\n      targetCeilingBps,\n    );""",
)

replace_once(
    "supabase/functions/_shared/lob/entry.ts",
    """  const provisionalStopBps = Math.min(\n    cfg.maxStopBps,\n    Math.max(\n      cfg.minTargetBps * 0.45,\n      totalCostsBps + 1.5,\n      features.spreadBps * 1.25,\n      microstructureStopFloorBps,\n    ),\n  );""",
    """  const provisionalStopBps = hasFixedPlanGeometry\n    ? fixedStopBps as number\n    : Math.min(\n      cfg.maxStopBps,\n      Math.max(\n        cfg.minTargetBps * 0.45,\n        totalCostsBps + 1.5,\n        features.spreadBps * 1.25,\n        microstructureStopFloorBps,\n      ),\n    );""",
)

replace_once(
    "supabase/functions/_shared/lob/entry.ts",
    """  const stopBps = Math.min(\n    cfg.maxStopBps,\n    Math.max(\n      provisionalStopBps,\n      traps.requiredStopBps,\n      totalCostsBps + 1.5,\n      microstructureStopFloorBps,\n    ),\n  );""",
    """  const liveStopFloorBps = Math.max(\n    traps.requiredStopBps,\n    totalCostsBps + 1.5,\n    microstructureStopFloorBps,\n  );\n  const stopBps = hasFixedPlanGeometry\n    ? fixedStopBps as number\n    : Math.min(\n      cfg.maxStopBps,\n      Math.max(provisionalStopBps, liveStopFloorBps),\n    );\n\n  if (hasFixedPlanGeometry) {\n    warnings.push(\"FIXED_SCAN_PLAN_GEOMETRY\");\n    if (stopBps < liveStopFloorBps) {\n      reasons.push(\"FIXED_PLAN_STOP_INVALIDATED\");\n    }\n  }""",
)

replace_once(
    "supabase/functions/_shared/lob/entry.ts",
    """    reason.startsWith(\"SIDE_\") ||\n    reason.startsWith(\"REVERSAL_\")""",
    """    reason.startsWith(\"SIDE_\") ||\n    reason.startsWith(\"FIXED_PLAN_\") ||\n    reason.startsWith(\"REVERSAL_\")""",
)

replace_once(
    "supabase/functions/_shared/lob/entry.ts",
    """    maxHoldingSeconds: adaptiveMaxHoldingSeconds({\n      side,\n      features,\n      targetBps,\n      stopBps,\n      minHoldingSeconds: cfg.minHoldingSeconds,\n      maxHoldingSeconds: cfg.maxHoldingSeconds,\n      absoluteMaxHoldingSeconds: cfg.absoluteMaxHoldingSeconds,\n    }),""",
    """    maxHoldingSeconds: hasFixedPlanGeometry\n      ? fixedMaxHoldingSeconds as number\n      : adaptiveMaxHoldingSeconds({\n        side,\n        features,\n        targetBps,\n        stopBps,\n        minHoldingSeconds: cfg.minHoldingSeconds,\n        maxHoldingSeconds: cfg.maxHoldingSeconds,\n        absoluteMaxHoldingSeconds: cfg.absoluteMaxHoldingSeconds,\n      }),""",
)

replace_once(
    "supabase/functions/market-autotrader/index.ts",
    'const AUTOTRADER_ENHANCEMENT_REVISION = "7.0.5-LOB-30S-MINIMUM";',
    'const AUTOTRADER_ENHANCEMENT_REVISION = "7.0.7-LOB-SCAN-PLAN-LOCK";',
)

replace_once(
    "supabase/functions/market-autotrader/index.ts",
    """  if (observationMs < minObservationMs) {\n    return {\n      ok: false,\n      reason: `Scanner observation ${observationMs}ms is below ${minObservationMs}ms`,\n    };\n  }""",
    """  if (observationMs < minObservationMs) {\n    return {\n      ok: false,\n      reason: `Scanner observation ${observationMs}ms is below ${minObservationMs}ms`,\n    };\n  }\n\n  const fixedPlanTargetBps = Number(lobSnapshot.target_bps);\n  const fixedPlanStopBps = Number(lobSnapshot.stop_bps);\n  const fixedPlanMaxHoldingSeconds = Number(lobSnapshot.max_holding_seconds);\n  const hasValidFixedPlanGeometry =\n    Number.isFinite(fixedPlanTargetBps) &&\n    fixedPlanTargetBps > 0 &&\n    Number.isFinite(fixedPlanStopBps) &&\n    fixedPlanStopBps > 0 &&\n    Number.isFinite(fixedPlanMaxHoldingSeconds) &&\n    fixedPlanMaxHoldingSeconds > 0;\n\n  if (!hasValidFixedPlanGeometry) {\n    return {\n      ok: false,\n      reason: \"Scanner LOB plan geometry is missing or invalid\",\n    };\n  }""",
)

replace_once(
    "supabase/functions/market-autotrader/index.ts",
    """        minHoldingSeconds: 30,\n        maxHoldingSeconds: 40,\n        absoluteMaxHoldingSeconds: 40,""",
    """        minHoldingSeconds: 30,\n        maxHoldingSeconds: 40,\n        absoluteMaxHoldingSeconds: 40,\n        fixedTargetBps: fixedPlanTargetBps,\n        fixedStopBps: fixedPlanStopBps,\n        fixedMaxHoldingSeconds: fixedPlanMaxHoldingSeconds,""",
)

replace_once(
    "supabase/functions/market-autotrader/index.ts",
    """        observation_ms: observationMs,\n        min_observation_ms: minObservationMs,""",
    """        observation_ms: observationMs,\n        min_observation_ms: minObservationMs,\n        fixed_scan_plan_geometry: {\n          target_bps: fixedPlanTargetBps,\n          stop_bps: fixedPlanStopBps,\n          max_holding_seconds: fixedPlanMaxHoldingSeconds,\n        },""",
)

print("v7.0.7 LOB scanner-plan lock patch applied successfully")
