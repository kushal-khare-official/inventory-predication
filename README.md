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

### Assumptions
These are assumptions, not facts from the data. If one is wrong, the output can change.

1. **Every SKU has the same margin %.** The brief gives only unit cost, not selling price or margin. Under this
   assumption the profit lost per unit short is proportional to unit cost, so every rupee spent on a reorder protects
   the same profit whichever SKU it goes to. The budget rule below depends on this. If margins differ, rank SKUs by
   profit protected per rupee instead (see the allocation table).
2. **"Today" is the latest valid event timestamp** (2026-08-26 in the sample), so results are reproducible. Override
   with `--as-of`.
3. **Stock is pooled across channels** for each SKU. The catalog's primary channel is shown for context only.
4. **Demand is steady**, so a historical average is a fair forecast. There is no trend or seasonality model.
5. **Lead time is exactly 14 days**, and the supplier accepts any quantity, including a partial order (no minimum
   order quantity or pack size).
6. **Malformed events are dropped, not repaired.** They are reported with their index and reason.

### How "at risk of stockout" is defined
A SKU is **at risk if `current_stock / daily_demand` is less than the 14-day lead time**. In other words, it would run
out before an order placed today could arrive.

- **Current stock** comes from replaying the SKU's events in time order. A `stock_snapshot` is a level, so it resets
  the stock; sales subtract; returns and restocks add. Events after the last snapshot are therefore counted.
- **Daily demand** is net units sold (sales minus returns) divided by the days the SKU was actually **in stock**.
  Sales can't happen at zero stock, so dividing by calendar days understates demand for any SKU that stocked out.
  SKU-103 shows why. It sold 240 units in 30 days, which looks like 8/day and 24 days of cover. But it sat at zero
  for about 15.6 of those days, so its real rate is about 16.65/day and 192 units last only about 11.5 days. A
  calendar-day average would have wrongly marked it safe.
- **Reorder quantity** is `ceil(daily_demand × 14 − current_stock)`: the least that avoids a stockout until the order
  arrives. It matches the brief's example (SKU-101: 60 units, ₹12,000). It carries no safety stock; `--cover-days`
  raises the target (for SKU-101, 21 days is 130 units / ₹26,000).

### How the budget is split when it doesn't cover everyone
The three at-risk SKUs need ₹26,360 in total, against a ₹20,000 budget. The rule, in priority order:

1. **Profit.** Under assumption 1, profit protected per rupee is the same for every SKU, so profit is maximised by
   spending as much of the budget as possible, never more than a SKU needs.
2. **Ops effort.** Among plans that spend the same, use the fewest purchase orders: take SKUs by largest order value
   until the budget is covered, and buy one SKU as fully as possible before starting the next.
3. **Urgency.** Within those SKUs, fund the soonest stockout first, in full. The last one gets what remains, rounded
   down to whole units and flagged `partial`.

Result on the sample data: SKU-104 in full (22 units, ₹11,000) and SKU-101 partly (45 of 60 units, ₹9,000). SKU-103 is
still flagged at risk but deferred.

| Alternative | Pros | Cons |
|---|---|---|
| **Chosen: spend the most, fewest POs, then urgency** | Uses the whole budget, 2 POs, easy to explain | Depends on equal margins and partial orders; leaves SKU-103 about 2.5 days short |
| Urgency order, whole orders only | Realistic order sizes | Skips SKU-101, the largest, and leaves ₹5,640 idle |
| Knapsack on whole orders | Best spend with whole orders only | Picks SKU-101 + SKU-103 and skips SKU-104, the soonest stockout; hard to explain |
| Proportional scale-down | Looks fair | Every SKU still stocks out |
| Stockout-days avoided per rupee | Covers the most SKUs (103 and 104 in full, 101 gets 28 units) | Leaves the highest-volume SKU short |
| Weight by margin or price | Right answer when margins differ | Needs selling price per SKU, which we don't have |

### Time complexity
With `n` events and `k` SKUs (4 here): sorting events by time is O(n log n), replaying them is O(n), and ranking
at-risk SKUs is O(k log k). Overall **O(n log n + k log k)** time and O(n) memory.

### Questions I'd ask the PM / ops team
The main one: **do suppliers have minimum order quantities or pack sizes, and can we place partial orders?** The
"45 of 60 units" recommendation is only valid if they can. If not, we should fully fund fewer SKUs instead.

Follow-ups:
- Is stock pooled across channels or held per channel (for example, Flipkart-fulfilled)? Snapshots are per channel.
- Can we get selling price or margin per SKU? It would replace assumption 1 and change the ranking.

## Layout

```
main.ts                  entry point: reads the file, prints table/JSON
src/inventory.ts         parsing/validation, per-SKU reducer, risk analysis, budget allocation
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
- A weekly job reads reducer state and runs the allocation, and the result is published to ops.

Built with AI-assisted coding (Claude Code) and checked with the test suite above.
