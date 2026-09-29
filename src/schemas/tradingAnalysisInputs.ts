import { z } from "zod";

const finite = z.number().finite();
const positive = finite.positive();
const nonNegative = finite.nonnegative();
const text = (max: number) => z.string().trim().min(1).max(max);
const timestamp = z.union([z.string().datetime({ offset: true }), finite]);

export const tradeRecord = z.strictObject({
  tradeId: text(200).optional(), symbol: text(100), strategy: text(100).optional(),
  assetClass: text(100).optional(), direction: z.enum(["long", "short"]).optional(),
  timeframe: text(30).optional(), source: text(80).optional(), marketRegime: text(40).optional(),
  confidence: z.number().finite().min(0).max(100).optional(),
  entryTime: timestamp.optional(), exitTime: timestamp.optional(),
  entryPrice: positive.optional(), exitPrice: positive.optional(), quantity: positive.optional(),
  fees: nonNegative.optional(), realizedPnl: finite.optional(),
  stopLoss: positive.optional(), takeProfit: positive.optional(),
  takeProfits: z.array(positive).max(20).optional(),
  status: z.enum(["open", "closed", "cancelled", "rejected"]).optional(),
  session: text(40).optional(), executionStatus: text(40).optional(), exitReason: text(80).optional(),
  leverage: positive.optional(), margin: nonNegative.optional(),
  rMultiple: finite.optional(), maxFavorableExcursion: finite.optional(), maxAdverseExcursion: finite.optional()
});

export const positionRecord = z.strictObject({
  positionId: text(200).optional(), symbol: text(100), strategy: text(100).optional(), assetClass: text(100).optional(),
  direction: z.enum(["long", "short"]), quantity: positive, entryPrice: positive,
  currentPrice: positive.optional(), marketValue: nonNegative.optional(),
  stopLoss: positive.optional(), fees: nonNegative.optional(), leverage: positive.optional(), margin: nonNegative.optional()
});

export const accountContext = z.strictObject({
  accountBalance: finite.optional(), accountEquity: finite.optional(), availableMargin: nonNegative.optional(),
  marginUsed: nonNegative.optional(), maxPositionPct: z.number().finite().nonnegative().max(1).optional(),
  maxPortfolioRiskPct: z.number().finite().nonnegative().max(1).optional(), maxDailyLossPct: z.number().finite().nonnegative().max(1).optional(),
  maxConcurrentPositions: z.number().int().positive().optional()
});

export const strategyPerformanceAnalysisInput = z.strictObject({
  trades: z.array(tradeRecord).max(100_000), initialEquity: nonNegative.optional(), accountEquity: nonNegative.optional(),
  riskPerTrade: positive.optional(), period: z.strictObject({ from: timestamp.optional(), to: timestamp.optional() }).optional()
});
export type StrategyPerformanceAnalysisInput = z.infer<typeof strategyPerformanceAnalysisInput>;

export const tradeRiskScoreInput = z.strictObject({
  trade: z.strictObject({ symbol: text(100).optional(), direction: z.enum(["long", "short"]), entryPrice: positive, stopLoss: positive.optional(), takeProfit: positive.optional(), takeProfits: z.array(positive).max(20).optional(), quantity: positive, volatilityPct: nonNegative.optional(), liquidityScore: z.number().finite().min(0).max(1).optional(), strategy: text(100).optional(), timeframe: text(30).optional(), leverage: positive.optional() }),
  account: accountContext.optional(), existingPositions: z.array(positionRecord).max(10_000).optional(), historicalRisk: z.strictObject({ lossRate: z.number().finite().min(0).max(1).optional(), maxDrawdownPct: finite.optional(), averageRMultiple: finite.optional() }).optional()
});
export type TradeRiskScoreInput = z.infer<typeof tradeRiskScoreInput>;

export const portfolioExposureCheckInput = z.strictObject({
  positions: z.array(positionRecord).max(10_000), account: accountContext.optional(),
  proposedPosition: positionRecord.optional(), correlations: z.array(z.strictObject({ symbolA: text(100), symbolB: text(100), correlation: z.number().finite().min(-1).max(1) })).max(100_000).optional()
});
export type PortfolioExposureCheckInput = z.infer<typeof portfolioExposureCheckInput>;

export const tradeLogAnalysisInput = z.strictObject({
  records: z.array(z.unknown()).max(100_000), accountEquity: nonNegative.optional(), duplicateTradeIdPolicy: z.enum(["flag", "deduplicate"]).optional()
});
export type TradeLogAnalysisInput = z.infer<typeof tradeLogAnalysisInput>;
