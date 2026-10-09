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

1. **Assumption: the margin % is the same for every SKU.** The brief gives only unit cost, not selling price or
   margin, so this is an assumption I made, not something in the data. It implies that profit lost per unit short is
   proportional to unit cost, so every rupee spent on a reorder protects the same profit whichever SKU it goes to.
   The budget rule below rests on this. If margins differ, SKUs should instead be ranked by profit protected per
   rupee (see the strategy table).
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
  arrives. It matches the brief's example (SKU-101: 60 units, ₹12,000).

Order-quantity alternatives, from most to least preferred (SKU-101: 80 on hand, 10/day). `--cover-days` switches
between the first three.

| # | Target | SKU-101 order | Pros | Cons |
|---|---|---|---|---|
| 1 | **Lead-time cover (chosen):** `demand × 14 − stock` | 60 units / ₹12,000 | Matches the brief's example; smallest order; fits the budget best | No cushion: a demand spike causes a stockout, and next week's order is urgent again |
| 2 | Lead time + 3-day buffer (17 days) | 90 units / ₹18,000 | Small cushion for modest extra cost | The buffer size is arbitrary and needs ops input |
| 3 | Lead time + 7-day review cycle (21 days) | 130 units / ₹26,000 | Lasts until the next weekly order can arrive | About twice the cost; SKU-101 alone (₹26,000) exceeds the ₹20,000 budget |
| 4 | Statistical safety stock (z·σ·√lead time) | Needs the variance of daily sales | The textbook method | Too little data and near-constant demand, so extra complexity for no benefit |

### How the budget is split when it doesn't cover everyone
**Assumption: the margin % is the same for every SKU** (assumption 1), so profit protected per rupee is equal across SKUs.

The three at-risk SKUs need ₹26,360 in total, against a ₹20,000 budget. The rule, in priority order:

1. **Profit.** Because of the equal-margin assumption, profit protected per rupee is the same for every SKU, so
   profit is maximised by spending as much of the budget as possible, never more than a SKU needs.
2. **Ops effort.** Among plans that spend the same, use the fewest purchase orders: take SKUs by largest order value
   until the budget is covered, and buy one SKU as fully as possible before starting the next.
3. **Urgency.** Within those SKUs, fund the soonest stockout first, in full. The last one gets what remains, rounded
   down to whole units and flagged `partial`.

Result on the sample data: SKU-104 in full (22 units, ₹11,000) and SKU-101 partly (45 of 60 units, ₹9,000). SKU-103 is
still flagged at risk but deferred.

Alternatives, from most to least preferred. Each row shows what the strategy does to the ₹20,000 budget and what
the unfunded part of the orders costs us in lost sales:

| # | Strategy | Spent / unspent | Stockout loss | Pros | Cons |
|---|---|---|---|---|---|
| 1 | **Chosen: spend the most, fewest POs, then urgency** | ₹20,000 / ₹0 | **₹6,360**: SKU-101 15 units (₹3,000) + SKU-103 42 units (₹3,360) | Uses the whole budget with 2 POs; easy to explain | Depends on equal margins and partial orders; leaves SKU-103 about 2.5 days short |
| 2 | Weight by margin or price | Not computable | Not computable | The right answer when margins differ (would become #1 once we have them) | Needs selling price per SKU, which we don't have |
| 3 | Stockout-days avoided per rupee | ₹19,960 / ₹40 | ₹6,400: SKU-101 32 units | Covers the most SKUs (103 and 104 in full, 101 gets 28 units) | Leaves the highest-volume SKU short |
| 4 | Knapsack on whole orders | ₹15,360 / ₹4,640 | ₹11,000: SKU-104 22 units | Best spend if partial orders are not allowed (SKU-101 + SKU-103) | Skips SKU-104, the soonest stockout; hard to explain |
| 5 | Urgency order, whole orders only | ₹14,360 / ₹5,640 | ₹12,000: SKU-101 60 units | Realistic order sizes | Skips SKU-101, the largest, and leaves ₹5,640 idle |
| 6 | Proportional scale-down (about 76% of each need) | ₹19,480 / ₹520 | ₹6,880: SKU-104 6 + SKU-101 15 + SKU-103 11 units | Looks fair | Every SKU still stocks out |

How the stockout loss is calculated: an order that arrives on day 14 can only cover demand until then. Units not
ordered are demand we can't serve between the stockout and delivery (for SKU-101: 10 units/day × 6 days = 60 units).
So `loss = (units needed − units ordered) × unit cost`, using the same order quantities as above (SKU-101 60,
SKU-104 22, SKU-103 42). It is valued **at cost** because selling price isn't given, so it understates lost revenue.
It covers this order cycle only.

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
