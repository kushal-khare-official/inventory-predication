import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { allocateReorderBudget, buildReorderPlan, type ReorderRecommendation } from "./main";

const day = (n: number) => new Date(Date.UTC(2026, 7, 1 + n)).toISOString();
const ev = (sku: string, type: string, quantity: unknown, timestamp: unknown) => ({
  sku,
  channel: "shopify",
  type,
  quantity,
  timestamp,
});

/** 30 days of steady sales (`perDay`), then a snapshot of `stock` on day 30. */
function steady(sku: string, perDay: number, stock: number) {
  const events = [ev(sku, "stock_snapshot", 10_000, day(0))];
  for (let d = 1; d <= 30; d++) events.push(ev(sku, "sale", perDay, day(d)));
  events.push(ev(sku, "stock_snapshot", stock, day(30)));
  return events;
}

const find = (recs: ReorderRecommendation[], sku: string) => recs.find((r) => r.sku === sku)!;

describe("required cases", () => {
  it("does not flag a SKU with plenty of stock for its sales rate", () => {
    const { recommendations } = buildReorderPlan(steady("SKU-102", 2, 500));
    const r = find(recommendations, "SKU-102");
    assert.equal(r.at_risk, false);
    assert.equal(r.recommend_reorder, false);
    assert.equal(r.reorder_quantity, 0);
  });

  it("flags a SKU with low stock and steady sales (the brief's example)", () => {
    const { recommendations } = buildReorderPlan(steady("SKU-101", 10, 80));
    const r = find(recommendations, "SKU-101");
    assert.equal(r.at_risk, true);
    assert.equal(r.daily_demand, 10);
    assert.equal(r.days_of_stock_remaining, 8);
    assert.equal(r.recommend_reorder, true);
    assert.equal(r.reorder_quantity, 60);
    assert.equal(r.reorder_cost, 12_000);
  });

  it("skips malformed events without crashing", () => {
    const bad = [
      { sku: "SKU-101", channel: "shopify", type: "sale", quantity: 5 }, // no timestamp
      ev("SKU-101", "sale", "N/A", day(3)), // bad quantity
      ev("SKU-101", "sale", 5, "not-a-date"), // bad timestamp
      ev("SKU-999", "sale", 5, day(3)), // unknown SKU
      ev("SKU-101", "teleport", 5, day(3)), // unknown type
      ev("SKU-101", "sale", -5, day(3)), // negative quantity
      null,
      "garbage",
    ];
    const plan = buildReorderPlan([...steady("SKU-101", 10, 80), ...bad]);
    assert.equal(plan.rejectedEvents.length, bad.length);
    const r = find(plan.recommendations, "SKU-101");
    assert.equal(r.reorder_quantity, 60); // bad rows had no effect
  });

  it("does not crash when the input is not an array or is empty", () => {
    assert.equal(buildReorderPlan({ nope: true }).rejectedEvents.length, 1);
    const plan = buildReorderPlan([]);
    assert.ok(plan.recommendations.every((r) => !r.at_risk));
  });
});

describe("less clear-cut situations", () => {
  it("measures demand only over in-stock time (stockout-censored sales)", () => {
    // 100 units on day 0, sold out on day 5, out of stock until a restock on day 20.
    // Demand while on the shelf is 6.67/day, double the 3.33/day a naive 30-day average gives.
    const events = [
      ev("SKU-103", "stock_snapshot", 100, day(0)),
      ev("SKU-103", "sale", 100, day(5)),
      ev("SKU-103", "restock", 200, day(20)),
      ev("SKU-103", "stock_snapshot", 200, day(30)),
    ];
    const r = find(buildReorderPlan(events).recommendations, "SKU-103");
    assert.equal(r.daily_demand, 6.67); // 100 units over 15 in-stock days
    assert.equal(r.at_risk, false); // 200 / 6.67 = 30 days
    const naive = 100 / 30;
    assert.ok(r.daily_demand > naive);
  });

  it("rolls events after the last snapshot into the stock level", () => {
    const events = [
      ...steady("SKU-101", 10, 200),
      ev("SKU-101", "sale", 100, day(31)),
      ev("SKU-101", "return", 5, day(32)),
      ev("SKU-101", "restock", 50, day(33)),
    ];
    const r = find(buildReorderPlan(events).recommendations, "SKU-101");
    assert.equal(r.current_stock, 155);
  });

  it("treats a SKU with no sales as not at risk", () => {
    const r = find(buildReorderPlan([ev("SKU-102", "stock_snapshot", 5, day(0))]).recommendations, "SKU-102");
    assert.equal(r.at_risk, false);
    assert.equal(r.days_of_stock_remaining, null);
  });
});

describe("budget allocation", () => {
  const analysis = (sku: "SKU-101" | "SKU-103" | "SKU-104", unitCost: number, days: number, qty: number) => ({
    sku,
    primaryChannel: "x",
    unitCostInRupees: unitCost,
    unitsOnHand: 0,
    averageDailyDemand: 1,
    daysOfStockLeft: days,
    isAtRisk: true,
    unitsNeeded: qty,
  });

  it("funds the soonest stockout in full and partially fills the last SKU", () => {
    const recs = allocateReorderBudget(
      [analysis("SKU-101", 200, 8, 60), analysis("SKU-104", 500, 6.67, 22), analysis("SKU-103", 80, 11.5, 42)],
      20_000,
    );
    const r104 = find(recs, "SKU-104");
    const r101 = find(recs, "SKU-101");
    const r103 = find(recs, "SKU-103");
    assert.deepEqual([r104.reorder_quantity, r104.partial], [22, false]);
    assert.deepEqual([r101.reorder_quantity, r101.partial], [45, true]);
    assert.equal(r103.reorder_quantity, 0); // deferred: fewer POs preferred
    assert.ok(recs.reduce((s, r) => s + r.reorder_cost, 0) <= 20_000);
  });

  it("funds everything in full when the budget is enough", () => {
    const recs = allocateReorderBudget([analysis("SKU-101", 200, 8, 60), analysis("SKU-103", 80, 11.5, 42)], 100_000);
    assert.ok(recs.every((r) => r.reorder_quantity > 0 && !r.partial));
  });
});

describe("sample data", () => {
  const raw = JSON.parse(readFileSync("inventory_events.json", "utf8"));

  it("produces the expected plan end to end", () => {
    const plan = buildReorderPlan(raw);
    assert.equal(plan.rejectedEvents.length, 3);
    const by = (sku: string) => find(plan.recommendations, sku);
    assert.equal(by("SKU-102").at_risk, false);
    assert.ok(["SKU-101", "SKU-103", "SKU-104"].every((s) => by(s).at_risk));
    // SKU-103 only looks safe if stockout days are counted as selling days.
    assert.ok(by("SKU-103").days_of_stock_remaining! < 14);
    assert.deepEqual([by("SKU-104").reorder_quantity, by("SKU-104").reorder_cost], [22, 11_000]);
    assert.deepEqual([by("SKU-101").reorder_quantity, by("SKU-101").reorder_cost], [45, 9_000]);
    assert.equal(plan.recommendations.reduce((s, r) => s + r.reorder_cost, 0), 20_000);
  });
});
