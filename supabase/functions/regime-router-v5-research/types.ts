export const V5_REVISION = "REGIME_ROUTER_V5_STRUCTURAL_TACTICAL_RANGE_EXIT_V2_15M_120D_RSWF";
// Deployment replaces these two exact placeholders in its ephemeral build
// artifact.  A checkout is deliberately not runnable with the default runtime
// identity, so an unstamped or partially stamped deployment fails closed.
export const V5_BUILD_SOURCE_SHA = "__V5_BUILD_SOURCE_SHA__";
export const V5_IMPLEMENTATION_SHA256 = "__V5_IMPLEMENTATION_SHA256__";
export const BAR_MS = 15 * 60_000;
export const FIVE_MINUTE_MS = 5 * 60_000;
export const BASE_COST_BPS = 14;
export const STRESS_COST_BPS = 23;

export type Side = "LONG" | "SHORT";
export type StructuralRegime = "BULL" | "RANGE" | "BEAR" | "UNKNOWN";
export type TacticalPhase =
  | "ACCELERATING"
  | "EXTENDED"
  | "DECELERATING"
  | "PULLBACK"
  | "UP_CYCLE"
  | "REBOUND"
  | "ROLL_OVER"
  | "REBREAK"
  | "NEUTRAL";
export type RouterState =
  | "BULL_TREND"
  | "BULL_DECELERATING"
  | "RANGE_UP_CYCLE"
  | "BEAR_REBOUND"
  | "BEAR_REBREAK"
  | "NO_TRADE";
export type FoldSplit = "TRAIN" | "VALIDATION" | "TEST" | "EMBARGO" | "OUTSIDE";

export interface Bar {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  quoteVolume: number;
}

export interface UniverseMarket {
  symbol: string;
  quoteAsset: string;
  marginAsset: string;
  onboardDate: number | null;
}

export interface PreparedBar extends Bar {
  atr: number;
  atrPct: number;
  atrPercentile7d: number;
  rsi: number;
  rsiSlope2: number;
  rsiPercentile7d: number;
  ema20: number;
  ema50: number;
  ema20SlopeAtr: number;
  stochK: number;
  stochD: number;
  stochPercentile7d: number;
  adx: number;
  vwap96: number;
  dayOpen: number;
  vwapDeviationAtr: number;
  dayOpenDeviationAtr: number;
  qv24: number;
  volumeRatio: number;
  ret2: number;
  ret4: number;
  ret6h: number;
  ret24h: number;
  high20Prev: number;
  low20Prev: number;
  high8Prev: number;
  low8Prev: number;
  rangeMid20Prev: number;
  bbMid: number;
  bbUpper: number;
  bbLower: number;
  bbCompressionPercentile7d: number;
}

export interface FiveMinutePoint {
  time: number;
  ret3Atr: number;
  rsiSlope: number;
  stochK: number;
  stochD: number;
  ema20SlopeAtr: number;
  volumeRatio: number;
  breakout: boolean;
  rebreak: boolean;
}

export interface StructuralPoint {
  time: number;
  regime: StructuralRegime;
  positiveBreadth6h: number;
  negativeBreadth6h: number;
  positiveBreadth24h: number;
  negativeBreadth24h: number;
  meanReturn6h: number;
  meanReturn24h: number;
  medianReturn6h: number;
  medianReturn24h: number;
  emaBullShare: number;
  emaBearShare: number;
  trendPersistence: number;
  lowAdxShare: number;
  meanReversionShare: number;
  volatilityPercentile: number;
  extremeMoverShare: number;
  breadthVelocity: number;
  breadthAcceleration: number;
  btc6h: number;
  btc24h: number;
  eth6h: number;
  eth24h: number;
  sol6h: number;
  sol24h: number;
  bullScore: number;
  bearScore: number;
  rangeScore: number;
  validMarkets: number;
}

export interface TacticalContext {
  phase: TacticalPhase;
  state: RouterState;
  structural: StructuralRegime;
  localBreadth: number;
  breadthVelocity: number;
  fiveMinuteConfirmed: boolean;
  reasons: string[];
}

export interface Candidate {
  name: string;
  family:
    | "DONCHIAN_BREAKOUT"
    | "MOMENTUM_ACCELERATION"
    | "COMPRESSION_BREAKOUT"
    | "RANGE_CYCLE"
    | "BEAR_REBREAK";
  side: Side;
  state: RouterState;
  neighborGroup: string;
  parameters: Record<string, number>;
}

export interface SignalDecision {
  ok: boolean;
  state: RouterState;
  phase: TacticalPhase;
  targetHint?: number;
  stopHint?: number;
  reasons: string[];
}

export interface FoldDefinition {
  id: number;
  trainStart: number;
  trainEnd: number;
  validationStart: number;
  validationEnd: number;
  testStart: number;
  testEnd: number;
  embargoBars: number;
}

export interface V5Trade {
  market: string;
  candidate: string;
  family: Candidate["family"];
  state: RouterState;
  fold: number;
  split: Exclude<FoldSplit, "EMBARGO" | "OUTSIDE">;
  side: Side;
  signalTime: number;
  entryTime: number;
  exitTime: number;
  grossBps: number;
  netBps: number;
  stressNetBps: number;
  mfeBps: number;
  maeBps: number;
  mfeCapture: number | null;
  givebackBps: number;
  holdBars: number;
  exitReason: string;
}

export interface MetricSummary {
  trades: number;
  wins: number;
  losses: number;
  winRate: number;
  grossPnlBps: number;
  netPnlBps: number;
  stressNetPnlBps: number;
  profitFactor: number | null;
  averageReturnBps: number;
  maxDrawdownBps: number;
  averageMfeBps: number;
  averageMaeBps: number;
  mfeCaptureRatio: number | null;
  profitGivebackBps: number;
  averageHoldBars: number;
  stopHitRate: number;
  targetHitRate: number;
  timeStopRate: number;
  regimeFrequency: number;
}
