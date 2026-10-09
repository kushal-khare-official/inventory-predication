# Inventory stockout-risk & weekly reorder planner

Reads an inventory event log (`sale`, `return`, `restock`, `stock_snapshot`), flags SKUs that will stock out before a
reorder placed today could arrive (14-day lead time), and recommends what to reorder this week within a ₹20,000 budget.

TypeScript, Node 20+.

## Run

```bash
npm install
npm start                                  # table view of data/inventory_events.json
npx tsx main.ts data/inventory_events.json --format json   # machine-readable
npm test                                   # unit + end-to-end tests
npm run typecheck
npm run serve                              # optional: POST /recommendations (JSON array of events)
```

Options: `--budget N`, `--lead-time N`, `--cover-days N` (days of demand a reorder should cover, default = lead time),
`--as-of ISO_DATE`.

### Sample output (`data/inventory_events.json`)

| SKU | At risk | Stock | Units/day | Days left | Order | Cost |
|---|---|---|---|---|---|---|
| SKU-101 | yes | 80 | 10 | 8 | 45 of 60 (partial) | ₹9,000 |
| SKU-102 | no | 500 | 2 | 250 | – | – |
| SKU-103 | yes | 192 | 16.65 | 11.5 | deferred | – |
| SKU-104 | yes | 20 | 3 | 6.7 | 22 | ₹11,000 |

Total ₹20,000 of ₹20,000. Three malformed events are skipped and listed (no timestamp, `"N/A"` quantity, bad date).

## Assumptions & Design Decisions

### How "at risk of stockout" is defined
`days_of_stock_remaining = current_stock / daily_demand`; a SKU is **at risk if that is less than the 14-day lead
time**, i.e. stock runs out before an order placed today could arrive.

- **Current stock:** the SKU's events are replayed in time order. A `stock_snapshot` resets the level (it is a level,
  not a change); sales subtract; returns and restocks add. Events after the last snapshot are therefore included.
- **"Today":** the latest valid timestamp in the log (the sample ends 2026-08-26), not the wall clock, so results are
  reproducible. Override with `--as-of`.
- **Demand rate is measured over in-stock time only.** Sales cannot happen while a SKU is at zero, so dividing by
  calendar days under-states demand. SKU-103 sold 240 units in 30 days (8/day, which looks like 24 days of cover) but
  was out of stock for about 15.6 of those days. Its real rate is about 16.65/day, so 192 units last only about
  11.5 days and it is correctly flagged. Net demand is sales minus returns.
- **Reorder quantity:** `ceil(daily_demand × 14 − stock)`, the minimum that covers demand until the order arrives
  (this reproduces the brief's example: 60 units, ₹12,000). It deliberately carries no safety stock.
- **Malformed events** (missing or bad timestamp, non-numeric or negative quantity, unknown SKU or type) are skipped and
  reported with their index, never thrown.
- Stock is pooled across channels per SKU; the catalog's primary channel is shown in the output.

### How at-risk SKUs are funded when the budget is short
At-risk SKUs here need ₹26,360 against a ₹20,000 budget. The rule, in priority order:

1. **Profit.** With the same margin % on every SKU, profit protected per rupee spent is identical (profit per unit
   scales with unit cost), so profit is maximised by **spending as much of the budget as possible**, never more than
   a SKU needs.
2. **Ops effort.** Among equally good plans, use the **fewest purchase orders**: take SKUs by largest order value until
   the budget is covered, and order one SKU as fully as possible before touching the next.
3. **Urgency.** Within the chosen SKUs, the soonest stockout is funded in full first; the last one gets what is left
   (floor to whole units, flagged `partial`).

Result: SKU-104 in full (₹11,000), SKU-101 partial (45 of 60 units, ₹9,000), SKU-103 deferred (still flagged at risk).

Alternatives considered:

| Strategy | Pros | Cons |
|---|---|---|
| **Chosen: profit → fewest POs → urgency** | Spends the full budget, fewest POs, easy to explain | Needs partial orders to be allowed; leaves the cheap SKU-103 about 2.5 days short |
| Urgency, whole orders only | Realistic order sizes | Skips SKU-101 (the biggest) and leaves ₹5,640 idle |
| Whole-order knapsack (max spend) | Optimal spend with whole orders | Funds 101 + 103 (₹15,360) and skips SKU-104, the soonest stockout; hard to explain |
| Proportional scale-down | Looks fair | Every SKU still stocks out |
| Stockout-days avoided per rupee | Covers the most SKUs (103 and 104 full, 101 gets 28 units) | Leaves the highest-volume SKU short; needs an assumption that days matter more than rupees |
| Margin- or price-weighted | Best in real life | Needs selling price or margin per SKU, which we don't have |

Order-quantity alternatives (SKU-101 example): lead time only = 60 units / ₹12,000 (chosen); lead time + 7-day review
cycle = 130 units / ₹26,000 (safer, about 2.3× cost); lead time + 3-day buffer = 90 units / ₹18,000; statistical
safety stock (z·σ·√L) is overkill for near-constant demand. Use `--cover-days` to try them.

### Time complexity
For `n` events and `k` SKUs (`k` = 4 here): grouping and sorting by time is **O(n log n)**; the replay is **O(n)**;
ranking at-risk SKUs for funding is **O(k log k)**. Overall **O(n log n + k log k)**, with O(n) memory.

### Questions I'd ask the PM / ops team
1. **Are there supplier MOQs or pack sizes, and can we place partial orders?** This decides whether the "45 of 60
   units" recommendation is valid or whether we should fund fewer SKUs fully.
2. Is stock pooled across channels or held per channel (e.g. Flipkart-fulfilled)? Snapshots are per channel.
3. Can we get selling price or margin per SKU? The equal-margin assumption drives the allocation.

## Layout

```
main.ts                  entry point: reads the file, prints table/JSON
src/inventory.ts         parsing/validation, per-SKU reducer, risk analysis, budget allocation
src/server.ts            optional thin Express endpoint reusing the same core
tests/inventory.test.ts  node:test suite
data/inventory_events.json
```

## Scaling to production (1M+ events/day)
Not built here; this is how the same core would grow:

- Ingest through a queue (BullMQ, SQS or Kafka) partitioned by SKU so per-SKU ordering holds. `applyEvent` is already
  an incremental reducer, so a worker can fold events one at a time with no locking.
- Persist per-SKU reducer state in MongoDB (one document per SKU, upserted), with an event id as idempotency key for
  at-least-once delivery. A late or out-of-order event would trigger a replay of that SKU.
- Route malformed events to a dead-letter queue and alert, instead of silently skipping.
- A weekly job reads reducer state and runs the allocation, and the API serves the result.

Built with AI-assisted coding (Claude Code) and checked with the test suite above.
