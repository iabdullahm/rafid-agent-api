# Trading analysis capabilities

These four read-only, deterministic tools analyze caller-supplied trading data. They do not query a broker, place orders, predict returns, or guarantee outcomes.

| Tool | Route | Price |
| --- | --- | --- |
| `strategy_performance_analysis` | `/api/v1/trading/strategy-performance-analysis` | $0.35 |
| `trade_risk_score` | `/api/v1/trading/trade-risk-score` | $0.25 |
| `portfolio_exposure_check` | `/api/v1/trading/portfolio-exposure-check` | $0.25 |
| `trade_log_analysis` | `/api/v1/trading/trade-log-analysis` | $0.30 |

The same names are exposed through the registry-derived REST, x402/L402/MPP, MCP, OpenAPI, discovery and Free Preview surfaces. Inputs reject unknown fields. Unsupported metrics are returned as `null` and explained in warnings or assumptions.

The implementation adapts the source project conventions from `C:\Projects\grok-trading-desk`: net realized P&L is gross price P&L less fees, unknown prices are not guessed, position exposure is USD size/value, and risk limits default to the source desk's 30% single-position, 50% portfolio and 6% daily-loss thresholds. The source project had no unified analytics service, so aggregate performance, scoring, exposure grouping and malformed-log handling are new deterministic code in `src/trading-analysis/service.ts`.

## Source comparison and provenance

The implementation was compared against both `C:\Projects\grok-trading-desk` and `C:\Projects\SignalFlow`.

- GROK is authoritative for fee-aware realized P&L, append-only outcome/log semantics, portfolio exposure, open risk, margin, the 30% position cap, the 50% portfolio cap and the 6% daily-loss circuit breaker.
- SIGNALFLOW is authoritative for R-multiple outcomes, direction-aware stop/target geometry, 1% risk-per-trade sizing, timeframe-dependent stop-distance limits, safe-leverage bands, and grouping by timeframe/source/regime/confidence where those fields are supplied.
- MERGED logic is used for strategy performance, trade risk and trade-log analysis. `rMultiple` takes precedence for outcome classification when supplied, while dollar P&L remains fee-aware. Portfolio exposure remains GROK-led because SignalFlow does not contain an equivalent unified portfolio ledger.
- NEW logic is limited to deterministic aggregation, strict input validation, score orchestration, provenance reporting, and malformed/duplicate/out-of-order log detection.

Every returned analysis includes `sourceTraceability` (when executing the current service) and explains these source boundaries in `calculationAssumptions` or `methodology`. SignalFlow's full candle-by-candle simulator, walk-forward engine, calibration bands and live provider state are intentionally not fabricated by these input-only capabilities.

## Ranked future capability opportunities

1. `walk_forward_strategy_validation`: reuse SignalFlow's no-lookahead simulator, same-bar stop precedence, multi-take-profit handling, timeout semantics and max drawdown in R.
2. `confidence_calibration_report`: reuse SignalFlow confidence bands and minimum-sample safeguards to compare predicted confidence with realized win rate.
3. `portfolio_correlation_risk`: add validated covariance/correlation aggregation and correlated-symbol stress scenarios on top of the GROK exposure ledger.
4. `execution_cost_and_slippage_audit`: join GROK fills/fees with SignalFlow's signal entry/exit and quantify slippage, funding, spread and latency.
5. `global_market_risk_snapshot`: expose SignalFlow's degraded-aware macro/market shock score as a separate sourced capability rather than mixing it into trade risk heuristics.

Example MCP call shape:

```json
{
  "name": "trade_risk_score",
  "arguments": {
    "trade": { "direction": "long", "entryPrice": 100, "stopLoss": 95, "takeProfit": 115, "quantity": 1 },
    "account": { "accountEquity": 1000 }
  }
}
```
