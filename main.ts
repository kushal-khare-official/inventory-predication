/**
 * Inventory stockout-risk and weekly reorder planner.
 *
 * WHAT THIS PROGRAM ANSWERS
 * -------------------------
 * For a D2C brand selling the same products on several channels, ops needs two answers every week:
 *   1. Which SKUs will run out of stock before a purchase order placed TODAY could arrive?
 *   2. The weekly budget cannot cover every such SKU, so which ones get a purchase order, and for how many units?
 *
 * HOW THE FILE IS ORGANISED (read top to bottom)
 * ----------------------------------------------
 *   1. Fixed business inputs      - SKU catalog, lead time, budget.
 *   2. Reading the event log      - `validateEvents` drops malformed rows instead of crashing.
 *   3. Working out stock + demand - `replaySkuHistory` walks one SKU's events in time order.
 *   4. Deciding who is at risk    - `assessSkuStockRisk` turns that history into days of stock left.
 *   5. Spending the budget        - `allocateReorderBudget` decides who is funded and by how much.
 *   6. Putting it together        - `buildReorderPlan` is the single entry point used by tests and the CLI.
 *   7. Command line               - argument parsing and printing (only runs when started directly).
 *
 * RUN IT
 * ------
 *   npx tsx main.ts inventory_events.json [--format table|json] [--budget N] [--lead-time N]
 *                                              [--cover-days N] [--as-of ISO_DATE]
 */

import { readFileSync } from "node:fs";

// ============================================================================================================
// 1. FIXED BUSINESS INPUTS
// ============================================================================================================

/** The product catalog given in the brief. Only these SKUs are planned; events for any other SKU are rejected. */
export const SKU_CATALOG = {
  "SKU-101": { primaryChannel: "shopify", unitCostInRupees: 200 },
  "SKU-102": { primaryChannel: "amazon", unitCostInRupees: 150 },
  "SKU-103": { primaryChannel: "flipkart", unitCostInRupees: 80 },
  "SKU-104": { primaryChannel: "shopify", unitCostInRupees: 500 },
} as const;

/** One of the SKU identifiers in the catalog, e.g. "SKU-101". */
export type SkuId = keyof typeof SKU_CATALOG;

/** Every kind of event that can appear in the log. */
const EVENT_TYPES = ["sale", "return", "restock", "stock_snapshot"] as const;
export type EventType = (typeof EVENT_TYPES)[number];

/** The knobs of the planner. Defaults come from the brief; the command line can override them. */
export interface PlannerSettings {
  /** How many days a new purchase order takes to arrive once placed. A SKU that runs out sooner than this is "at risk". */
  supplierLeadTimeDays: number;
  /** Total rupees available for purchase orders this week, across all SKUs. */
  weeklyBudgetInRupees: number;
  /**
   * How many days of demand a purchase order should cover. Defaults to the lead time, which is the smallest order
   * that avoids a stockout until delivery. Raise it to build in a safety cushion.
   */
  orderCoverageDays: number;
  /** The date to treat as "today". When omitted, the timestamp of the newest valid event is used. */
  asOfDate?: Date;
}

export const DEFAULT_SETTINGS: PlannerSettings = {
  supplierLeadTimeDays: 14,
  weeklyBudgetInRupees: 20_000,
  orderCoverageDays: 14,
};

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Demand is "units sold per day the product was actually on the shelf". If a SKU was in stock for less than one day,
 * the division would blow up (or give absurd rates), so the shelf time is never counted as less than this.
 */
const MINIMUM_DAYS_ON_SHELF = 1;

// ============================================================================================================
// 2. READING THE EVENT LOG
// ============================================================================================================

/** A cleaned, trustworthy event: every field has been checked and the timestamp is a real Date. */
export interface InventoryEvent {
  sku: SkuId;
  channel: string;
  type: EventType;
  /**
   * For `sale`, `return` and `restock` this is a number of units that changed hands.
   * For `stock_snapshot` it is the stock level itself, not a change.
   */
  quantity: number;
  timestamp: Date;
}

/** A row of the log that was dropped, with enough information for a human to go and fix it. */
export interface RejectedEvent {
  /** Position of the row in the input array (0 is the first row). -1 means the whole input was unusable. */
  rowIndex: number;
  reason: string;
}

export interface ValidationResult {
  validEvents: InventoryEvent[];
  rejectedEvents: RejectedEvent[];
}

function isKnownSku(value: unknown): value is SkuId {
  return typeof value === "string" && Object.hasOwn(SKU_CATALOG, value);
}

function isKnownEventType(value: unknown): value is EventType {
  return typeof value === "string" && (EVENT_TYPES as readonly string[]).includes(value);
}

/**
 * Checks one raw row from the log.
 *
 * Returns the cleaned event, or a short human-readable reason why the row cannot be trusted. Nothing here throws,
 * so one bad row can never stop the rest of the log from being processed.
 */
function validateOneEvent(row: unknown): InventoryEvent | string {
  if (typeof row !== "object" || row === null || Array.isArray(row)) return "event: not an object";
  const fields = row as Record<string, unknown>;

  if (!isKnownSku(fields.sku)) return "sku: missing or not in the catalog";
  if (typeof fields.channel !== "string" || fields.channel === "") return "channel: missing";
  if (!isKnownEventType(fields.type)) return "type: missing or not one of sale/return/restock/stock_snapshot";

  const quantity = fields.quantity;
  if (typeof quantity !== "number" || !Number.isFinite(quantity) || quantity < 0) {
    return "quantity: must be a number that is 0 or more";
  }

  if (fields.timestamp === undefined) return "timestamp: missing";
  const timestamp = typeof fields.timestamp === "string" ? new Date(fields.timestamp) : undefined;
  if (timestamp === undefined || Number.isNaN(timestamp.getTime())) return "timestamp: not a valid date";

  return { sku: fields.sku, channel: fields.channel, type: fields.type, quantity, timestamp };
}

/**
 * Splits the raw log into rows we can use and rows we have to skip.
 *
 * The brief warns that some events are malformed (missing fields, bad timestamps), so every row is checked and bad
 * ones are reported rather than causing a crash.
 */
export function validateEvents(rawLog: unknown): ValidationResult {
  const validEvents: InventoryEvent[] = [];
  const rejectedEvents: RejectedEvent[] = [];

  if (!Array.isArray(rawLog)) {
    return { validEvents, rejectedEvents: [{ rowIndex: -1, reason: "input is not a JSON array" }] };
  }

  rawLog.forEach((row, rowIndex) => {
    const result = validateOneEvent(row);
    if (typeof result === "string") rejectedEvents.push({ rowIndex, reason: result });
    else validEvents.push(result);
  });

  return { validEvents, rejectedEvents };
}

// ============================================================================================================
// 3. WORKING OUT CURRENT STOCK AND DEMAND (one SKU at a time)
// ============================================================================================================

/**
 * Everything we learn about one SKU while walking through its events from oldest to newest.
 * The walk keeps this small state and updates it per event, so memory use does not grow with the log size.
 */
interface SkuReplayState {
  /** Units on hand right now. `null` until the first snapshot or restock tells us a starting point. */
  unitsOnHand: number | null;
  /** Time of the first event we saw for this SKU: the start of its observation window. */
  firstEventTimeMs: number | null;
  /** Time of the most recent event, used to measure how long each stretch between events lasted. */
  previousEventTimeMs: number | null;
  /** Sales minus returns so far. Returned items are not demand, so they cancel out earlier sales. */
  netUnitsSold: number;
  /** Total time the shelf was empty. Needed because sales cannot happen while the shelf is empty. */
  millisecondsOutOfStock: number;
}

function newReplayState(): SkuReplayState {
  return {
    unitsOnHand: null,
    firstEventTimeMs: null,
    previousEventTimeMs: null,
    netUnitsSold: 0,
    millisecondsOutOfStock: 0,
  };
}

/**
 * Moves the clock forward to `newTimeMs`. If the shelf was empty during the gap since the previous event, that time
 * is added to the out-of-stock total.
 */
function advanceClock(state: SkuReplayState, newTimeMs: number): void {
  const shelfWasEmpty = state.unitsOnHand !== null && state.unitsOnHand <= 0;
  if (shelfWasEmpty && state.previousEventTimeMs !== null) {
    state.millisecondsOutOfStock += Math.max(0, newTimeMs - state.previousEventTimeMs);
  }
  state.previousEventTimeMs = newTimeMs;
}

/**
 * Applies one event to the running state. Events must be fed in time order.
 *
 *  - `stock_snapshot`: a stock COUNT, not a change. It replaces our running figure, which also corrects any drift
 *    caused by events missing from the log.
 *  - `sale`:           units leave the shelf (never below zero) and count as demand.
 *  - `return`:         units come back to the shelf and cancel earlier demand.
 *  - `restock`:        units arrive from the supplier.
 */
function applyEventToState(state: SkuReplayState, event: InventoryEvent): void {
  const eventTimeMs = event.timestamp.getTime();
  state.firstEventTimeMs ??= eventTimeMs;
  advanceClock(state, eventTimeMs);

  const unitsBefore = state.unitsOnHand ?? 0;
  switch (event.type) {
    case "stock_snapshot":
      state.unitsOnHand = event.quantity;
      break;
    case "sale":
      state.netUnitsSold += event.quantity;
      state.unitsOnHand = Math.max(0, unitsBefore - event.quantity);
      break;
    case "return":
      state.netUnitsSold -= event.quantity;
      state.unitsOnHand = unitsBefore + event.quantity;
      break;
    case "restock":
      state.unitsOnHand = unitsBefore + event.quantity;
      break;
  }
}

/**
 * Walks one SKU's events (oldest first, up to and including `asOfDate`) and returns the final state, with the clock
 * run forward to `asOfDate` so a trailing empty-shelf period is counted too.
 */
function replaySkuHistory(sku: SkuId, allEvents: InventoryEvent[], asOfDate: Date): SkuReplayState {
  const state = newReplayState();
  const skuEventsOldestFirst = allEvents
    .filter((event) => event.sku === sku && event.timestamp <= asOfDate)
    .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

  for (const event of skuEventsOldestFirst) applyEventToState(state, event);
  advanceClock(state, asOfDate.getTime());
  return state;
}

// ============================================================================================================
// 4. DECIDING WHO IS AT RISK OF A STOCKOUT
// ============================================================================================================

/** Our verdict on one SKU, before any budget has been applied. */
export interface SkuRiskAssessment {
  sku: SkuId;
  primaryChannel: string;
  unitCostInRupees: number;
  /** Units on hand as of the "today" date. */
  unitsOnHand: number;
  /** Average units sold per day while the product was actually in stock. */
  averageDailyDemand: number;
  /** How long current stock lasts at the current demand. `Infinity` if nothing is selling. */
  daysOfStockLeft: number;
  /** True when stock runs out before a purchase order placed today could arrive. */
  isAtRisk: boolean;
  /**
   * Units to order so that demand is covered until the order arrives. Zero for SKUs that are not at risk.
   * This is the "full" order; the budget step may fund less of it.
   */
  unitsNeeded: number;
}

/**
 * Decides whether one SKU is at risk of stocking out, and how many units a full reorder would take.
 *
 * DEMAND IS MEASURED OVER IN-STOCK TIME ONLY. Imagine a SKU that sold 240 units over 30 days, but sat at zero stock
 * for 15 of those days. Dividing by 30 days gives 8 per day, which hides the fact that when the product WAS available
 * it sold at about 16 per day. Sales are capped by availability, so the in-stock rate is the honest demand figure.
 * Using the calendar-day rate would make this SKU look comfortably stocked when it is not.
 *
 * AT RISK means: units on hand / daily demand < supplier lead time. In words, "we will be out of stock before
 * a new order could possibly arrive".
 *
 * ORDER SIZE is `daily demand x coverage days - units on hand`, rounded up: just enough extra stock to keep selling
 * until the order lands.
 */
export function assessSkuStockRisk(
  sku: SkuId,
  allEvents: InventoryEvent[],
  asOfDate: Date,
  settings: PlannerSettings,
): SkuRiskAssessment {
  const history = replaySkuHistory(sku, allEvents, asOfDate);
  const { primaryChannel, unitCostInRupees } = SKU_CATALOG[sku];
  const unitsOnHand = history.unitsOnHand ?? 0;

  const observationWindowMs = history.firstEventTimeMs === null ? 0 : asOfDate.getTime() - history.firstEventTimeMs;
  const daysOnShelf = Math.max(
    MINIMUM_DAYS_ON_SHELF,
    (observationWindowMs - history.millisecondsOutOfStock) / MILLISECONDS_PER_DAY,
  );
  const averageDailyDemand = Math.max(0, history.netUnitsSold) / daysOnShelf;

  const daysOfStockLeft = averageDailyDemand > 0 ? unitsOnHand / averageDailyDemand : Infinity;
  const isAtRisk = daysOfStockLeft < settings.supplierLeadTimeDays;

  // The small 1e-9 keeps floating-point noise (e.g. 60.00000000001) from rounding a whole number up by one.
  const unitsToCoverDemand = averageDailyDemand * settings.orderCoverageDays - unitsOnHand - 1e-9;
  const unitsNeeded = isAtRisk ? Math.max(0, Math.ceil(unitsToCoverDemand)) : 0;

  return {
    sku,
    primaryChannel,
    unitCostInRupees,
    unitsOnHand,
    averageDailyDemand,
    daysOfStockLeft,
    isAtRisk,
    unitsNeeded,
  };
}

// ============================================================================================================
// 5. SPENDING THE WEEKLY BUDGET
// ============================================================================================================

/** The final answer for one SKU: what we found, and what ops should do about it. Field names match the brief. */
export interface ReorderRecommendation {
  sku: SkuId;
  channel: string;
  at_risk: boolean;
  current_stock: number;
  daily_demand: number;
  /** `null` means "no sales, so stock never runs out" (JSON cannot represent Infinity). */
  days_of_stock_remaining: number | null;
  recommend_reorder: boolean;
  reorder_quantity: number;
  reorder_cost: number;
  /** True when we can only fund part of what the SKU needs because the budget ran out. */
  partial: boolean;
  /** One plain-English sentence explaining the decision, for the ops team. */
  reason: string;
}

function roundTo2Decimals(value: number): number {
  return Math.round(value * 100) / 100;
}

const fullOrderCost = (a: SkuRiskAssessment) => a.unitsNeeded * a.unitCostInRupees;

/**
 * Picks WHICH at-risk SKUs we will actually order, using the fewest purchase orders that can use up the budget.
 *
 * Starting from the SKU with the largest full-order cost, keep adding SKUs until their combined cost reaches the
 * budget. Fewer purchase orders means less work for ops and fewer supplier negotiations.
 */
function chooseSkusToOrder(atRiskSkus: SkuRiskAssessment[], budgetInRupees: number): Set<SkuId> {
  const largestOrderFirst = [...atRiskSkus].sort((a, b) => fullOrderCost(b) - fullOrderCost(a));
  const chosen = new Set<SkuId>();
  let costOfChosenSoFar = 0;

  for (const candidate of largestOrderFirst) {
    if (costOfChosenSoFar >= budgetInRupees) break;
    chosen.add(candidate.sku);
    costOfChosenSoFar += fullOrderCost(candidate);
  }
  return chosen;
}

/**
 * Splits the weekly budget between the at-risk SKUs.
 *
 * ASSUMPTION: the profit margin % is the same for every SKU. Under that assumption a rupee spent on any SKU protects
 * the same amount of profit, so the profit-maximising move is simply to spend as much of the budget as we usefully
 * can (never more than a SKU needs). If margins differ, SKUs should be ranked by profit protected per rupee instead.
 *
 * The decision has three steps, in order of importance:
 *   1. PROFIT:  use as much of the budget as possible, capped at what each SKU needs.
 *   2. OPS EFFORT: among plans that spend the same, place the fewest purchase orders (see `chooseSkusToOrder`), and
 *      order as much of one SKU as possible before moving on to the next.
 *   3. URGENCY: within the chosen SKUs, fund the one that runs out soonest first, in full. The last SKU gets whatever
 *      money is left, rounded down to whole units, and is marked `partial`.
 *
 * If the budget covers every at-risk SKU, they are all simply funded in full.
 */
export function allocateReorderBudget(
  assessments: SkuRiskAssessment[],
  budgetInRupees: number,
): ReorderRecommendation[] {
  const atRiskSkus = assessments.filter((a) => a.isAtRisk && a.unitsNeeded > 0);
  const skusWeWillOrder = chooseSkusToOrder(atRiskSkus, budgetInRupees);

  const soonestStockoutFirst = atRiskSkus
    .filter((a) => skusWeWillOrder.has(a.sku))
    .sort((a, b) => a.daysOfStockLeft - b.daysOfStockLeft);

  const unitsToOrder = new Map<SkuId, number>();
  let rupeesLeft = budgetInRupees;
  for (const assessment of soonestStockoutFirst) {
    const unitsWeCanAfford = Math.floor(rupeesLeft / assessment.unitCostInRupees);
    const units = Math.min(assessment.unitsNeeded, unitsWeCanAfford);
    if (units > 0) {
      unitsToOrder.set(assessment.sku, units);
      rupeesLeft -= units * assessment.unitCostInRupees;
    }
  }

  return assessments.map((assessment) => {
    const units = unitsToOrder.get(assessment.sku) ?? 0;
    const isPartialOrder = units > 0 && units < assessment.unitsNeeded;
    const wasChosen = skusWeWillOrder.has(assessment.sku);

    let reason: string;
    if (!assessment.isAtRisk) {
      reason = "Enough stock to last past the supplier lead time.";
    } else if (units === 0 && wasChosen) {
      reason = "At risk, but the budget ran out before this SKU.";
    } else if (units === 0) {
      reason = "At risk, deferred: higher-value orders use the budget with fewer POs.";
    } else if (isPartialOrder) {
      reason = `Partially funded: ${units} of ${assessment.unitsNeeded} units needed; budget exhausted.`;
    } else {
      reason = "Funded in full.";
    }

    return {
      sku: assessment.sku,
      channel: assessment.primaryChannel,
      at_risk: assessment.isAtRisk,
      current_stock: assessment.unitsOnHand,
      daily_demand: roundTo2Decimals(assessment.averageDailyDemand),
      days_of_stock_remaining: Number.isFinite(assessment.daysOfStockLeft)
        ? roundTo2Decimals(assessment.daysOfStockLeft)
        : null,
      recommend_reorder: units > 0,
      reorder_quantity: units,
      reorder_cost: units * assessment.unitCostInRupees,
      partial: isPartialOrder,
      reason,
    };
  });
}

// ============================================================================================================
// 6. PUTTING IT TOGETHER
// ============================================================================================================

/** Everything the planner produces for one run. */
export interface ReorderPlan {
  /** The date treated as "today". */
  asOfDate: Date;
  weeklyBudgetInRupees: number;
  /** One entry per catalog SKU, whether or not it needs a reorder. */
  recommendations: ReorderRecommendation[];
  /** Log rows that were skipped because they were malformed. */
  rejectedEvents: RejectedEvent[];
}

/**
 * The single entry point: raw event log in, recommendations out.
 *
 * "Today" defaults to the timestamp of the newest valid event rather than the computer's clock. The log is a snapshot
 * of the past, so measuring "days of stock left" from the real current date would be meaningless and would make the
 * results change from day to day.
 *
 * Time complexity: sorting the events is O(n log n) for n events; replaying them is O(n); ranking the k SKUs is
 * O(k log k) (k is 4 here). Memory use is O(n).
 */
export function buildReorderPlan(rawLog: unknown, overrides: Partial<PlannerSettings> = {}): ReorderPlan {
  const settings: PlannerSettings = { ...DEFAULT_SETTINGS, ...overrides };
  const { validEvents, rejectedEvents } = validateEvents(rawLog);

  const newestEventTimeMs = validEvents.reduce((newest, event) => Math.max(newest, event.timestamp.getTime()), -Infinity);
  const asOfDate = settings.asOfDate ?? new Date(Number.isFinite(newestEventTimeMs) ? newestEventTimeMs : Date.now());

  const assessments = (Object.keys(SKU_CATALOG) as SkuId[]).map((sku) =>
    assessSkuStockRisk(sku, validEvents, asOfDate, settings),
  );
  const recommendations = allocateReorderBudget(assessments, settings.weeklyBudgetInRupees);

  return { asOfDate, weeklyBudgetInRupees: settings.weeklyBudgetInRupees, recommendations, rejectedEvents };
}

// ============================================================================================================
// 7. COMMAND LINE
// ============================================================================================================

interface CommandLineOptions {
  inputFilePath: string;
  outputFormat: "table" | "json";
  settingsOverrides: Partial<PlannerSettings>;
}

const USAGE =
  "usage: tsx main.ts <inventory_events.json> [--format table|json] [--budget N] [--lead-time N] [--cover-days N] [--as-of ISO_DATE]";

function exitWithError(message: string): never {
  console.error(message);
  process.exit(1);
}

/** Reads `process.argv` style arguments into typed options. Unknown flags are an error rather than silently ignored. */
function parseCommandLine(args: string[]): CommandLineOptions {
  let inputFilePath: string | undefined;
  let outputFormat: "table" | "json" = "table";
  const settingsOverrides: Partial<PlannerSettings> = {};

  for (let position = 0; position < args.length; position++) {
    const flag = args[position]!;
    const readValue = () => args[++position] ?? exitWithError(`missing value for ${flag}\n${USAGE}`);

    switch (flag) {
      case "--format":
        outputFormat = readValue() === "json" ? "json" : "table";
        break;
      case "--budget":
        settingsOverrides.weeklyBudgetInRupees = Number(readValue());
        break;
      case "--lead-time":
        settingsOverrides.supplierLeadTimeDays = Number(readValue());
        break;
      case "--cover-days":
        settingsOverrides.orderCoverageDays = Number(readValue());
        break;
      case "--as-of":
        settingsOverrides.asOfDate = new Date(readValue());
        break;
      default:
        if (flag.startsWith("--")) exitWithError(`unknown option ${flag}\n${USAGE}`);
        inputFilePath = flag;
    }
  }

  if (inputFilePath === undefined) exitWithError(USAGE);

  // A longer lead time normally means the order should cover that longer wait, unless the user said otherwise.
  if (settingsOverrides.supplierLeadTimeDays !== undefined && settingsOverrides.orderCoverageDays === undefined) {
    settingsOverrides.orderCoverageDays = settingsOverrides.supplierLeadTimeDays;
  }
  return { inputFilePath, outputFormat, settingsOverrides };
}

const formatRupees = (amount: number) => `₹${amount.toLocaleString("en-IN")}`;

/** Lays the plan out as an aligned text table with a budget summary, for people reading it in a terminal. */
function formatPlanAsTable(plan: ReorderPlan): string {
  const header = ["SKU", "Channel", "At risk", "Stock", "Units/day", "Days left", "Order qty", "Cost", "Note"];
  const rows = plan.recommendations.map((r) => [
    r.sku,
    r.channel,
    r.at_risk ? "YES" : "no",
    String(r.current_stock),
    String(r.daily_demand),
    r.days_of_stock_remaining === null ? "∞" : String(r.days_of_stock_remaining),
    r.recommend_reorder ? `${r.reorder_quantity}${r.partial ? " (partial)" : ""}` : "-",
    r.recommend_reorder ? formatRupees(r.reorder_cost) : "-",
    r.reason,
  ]);

  const columnWidths = header.map((title, column) => Math.max(title.length, ...rows.map((row) => row[column]!.length)));
  const formatRow = (cells: string[]) => cells.map((cell, column) => cell.padEnd(columnWidths[column]!)).join("  ");

  const rupeesSpent = plan.recommendations.reduce((total, r) => total + r.reorder_cost, 0);
  const rejectedLines = plan.rejectedEvents.map((e) => `\n  row ${e.rowIndex}: ${e.reason}`).join("");

  return [
    `Stock position as of ${plan.asOfDate.toISOString()}`,
    "",
    formatRow(header),
    formatRow(columnWidths.map((width) => "-".repeat(width))),
    ...rows.map(formatRow),
    "",
    `Budget: ${formatRupees(rupeesSpent)} of ${formatRupees(plan.weeklyBudgetInRupees)} used ` +
      `(${formatRupees(plan.weeklyBudgetInRupees - rupeesSpent)} left)`,
    `Skipped ${plan.rejectedEvents.length} malformed event(s)${rejectedLines}`,
  ].join("\n");
}

function runCommandLine(): void {
  const options = parseCommandLine(process.argv.slice(2));

  let rawLog: unknown;
  try {
    rawLog = JSON.parse(readFileSync(options.inputFilePath, "utf8"));
  } catch (error) {
    exitWithError(`could not read ${options.inputFilePath}: ${(error as Error).message}`);
  }

  const plan = buildReorderPlan(rawLog, options.settingsOverrides);
  console.log(
    options.outputFormat === "json" ? JSON.stringify(plan.recommendations, null, 2) : formatPlanAsTable(plan),
  );
}

// Only run the command line when this file is started directly (`tsx main.ts ...`), not when tests import it.
if (require.main === module) runCommandLine();
