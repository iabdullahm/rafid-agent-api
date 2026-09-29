import assert from "node:assert/strict";
import test from "node:test";
import { analyzeStrategyPerformance, scoreTradeRisk, checkPortfolioExposure, analyzeTradeLog } from "../src/trading-analysis/index.js";

const closed = (p: number, id: string, extra: Record<string, unknown> = {}) => ({ tradeId: id, symbol: "BTCUSD", direction: p >= 0 ? "long" : "short", entryPrice: 100, exitPrice: p >= 0 ? 110 : 105, quantity: 1, fees: 0, realizedPnl: p, status: "closed", ...extra });

test("strategy performance is deterministic and fee-aware", () => {
  const input = { trades: [closed(10, "a", { fees: 2 }), closed(-5, "b", { fees: 1 }), closed(0, "c")], initialEquity: 1000 };
  const a = analyzeStrategyPerformance(input); const b = analyzeStrategyPerformance(input);
  assert.deepEqual(a, b); assert.equal(a.metrics.netPnl, 2); assert.equal(a.metrics.winningTrades, 1); assert.equal(a.metrics.breakevenTrades, 1);
});
test("performance handles zero trades, all winners, all losers and invalid price inputs", () => {
  assert.equal(analyzeStrategyPerformance({ trades: [] }).metrics.totalTrades, 0);
  assert.equal(analyzeStrategyPerformance({ trades: [closed(2, "a"), closed(3, "b")] }).metrics.profitFactor, null);
  assert.equal(analyzeStrategyPerformance({ trades: [closed(-2, "a"), closed(-3, "b")] }).metrics.profitFactor, 0);
  assert.throws(() => analyzeStrategyPerformance({ trades: [{ symbol: "BTCUSD", entryPrice: 0, quantity: 1 }] }));
});
test("risk score exposes deterministic limits and zero-equity failure", () => {
  const result = scoreTradeRisk({ trade: { direction: "long", entryPrice: 100, stopLoss: 95, takeProfit: 115, quantity: 1 }, account: { accountEquity: 1000 } });
  assert.equal(result.riskAmount, 5); assert.equal(result.riskRewardRatio, 3); assert.ok(result.riskScore >= 0 && result.riskScore <= 100);
  const zero = scoreTradeRisk({ trade: { direction: "long", entryPrice: 100, quantity: 1 }, account: { accountEquity: 0 } });
  assert.equal(zero.riskScore, 100); assert.equal(zero.riskLevel, "critical");
});
test("portfolio exposure reports concentrated and balanced portfolios", () => {
  const concentrated = checkPortfolioExposure({ positions: [{ symbol: "BTC", direction: "long", quantity: 8, entryPrice: 100 }], account: { accountEquity: 1000 } });
  assert.equal(concentrated.grossExposure, 800); assert.ok(concentrated.concentrationFlags.length > 0);
  const balanced = checkPortfolioExposure({ positions: [{ symbol: "BTC", direction: "long", quantity: 1, entryPrice: 100 }, { symbol: "ETH", direction: "short", quantity: 1, entryPrice: 100 }], account: { accountEquity: 1000 } });
  assert.equal(balanced.netExposure, 0);
  assert.equal(checkPortfolioExposure({ positions: [], account: { accountEquity: 1000 } }).grossExposure, 0);
});
test("trade log analysis flags malformed, duplicate and out-of-order records", () => {
  const result = analyzeTradeLog({ records: [closed(10, "dup", { entryTime: "2026-01-02T00:00:00Z", exitTime: "2026-01-02T01:00:00Z" }), closed(-2, "dup", { entryTime: "2026-01-01T00:00:00Z", exitTime: "2026-01-01T01:00:00Z" }), { nonsense: true }] });
  assert.equal(result.executionMetrics.malformedRecords, 1); assert.deepEqual(result.executionMetrics.duplicateTradeIds, ["dup"]); assert.equal(result.executionMetrics.outOfOrderTimestamps, 1); assert.ok(result.anomalies.length > 0);
});
