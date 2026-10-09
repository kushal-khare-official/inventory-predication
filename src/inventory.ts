import { z } from "zod";

// ---------- Fixed inputs from the brief ----------

export const CATALOG = {
  "SKU-101": { primaryChannel: "shopify", unitCost: 200 },
  "SKU-102": { primaryChannel: "amazon", unitCost: 150 },
  "SKU-103": { primaryChannel: "flipkart", unitCost: 80 },
  "SKU-104": { primaryChannel: "shopify", unitCost: 500 },
} as const;
export type Sku = keyof typeof CATALOG;

export interface PlannerConfig {
  reorderLeadTimeDays: number;
  weeklyReorderBudget: number;
  /** Days of demand a reorder should cover. Defaults to the lead time. */
  coverDays: number;
  /** "Today". Defaults to the latest valid event timestamp. */
  asOf?: Date;
}

export const DEFAULT_CONFIG: PlannerConfig = {
  reorderLeadTimeDays: 14,
  weeklyReorderBudget: 20_000,
  coverDays: 14,
};

const DAY_MS = 86_400_000;
/** Guards against dividing by a tiny in-stock window. */
const MIN_IN_STOCK_DAYS = 1;

// ---------- Parsing & validation ----------

const eventSchema = z.object({
  sku: z.string().refine((s): s is Sku => s in CATALOG, "unknown sku"),
  channel: z.string().min(1, "missing channel"),
  type: z.enum(["sale", "return", "restock", "stock_snapshot"]),
  quantity: z.number().finite().nonnegative(),
  timestamp: z
    .string()
    .refine((s) => !Number.isNaN(Date.parse(s)), "bad timestamp")
    .transform((s) => new Date(s)),
});

export type InventoryEvent = z.output<typeof eventSchema> & { sku: Sku };

export interface SkippedEvent {
  index: number;
  reason: string;
}

export interface ParseResult {
  events: InventoryEvent[];
  skipped: SkippedEvent[];
}

/** Validates every raw event; malformed ones are reported, never thrown. */
export function parseEvents(raw: unknown): ParseResult {
  const events: InventoryEvent[] = [];
  const skipped: SkippedEvent[] = [];
  if (!Array.isArray(raw)) {
    return { events, skipped: [{ index: -1, reason: "input is not an array" }] };
  }
  raw.forEach((item, index) => {
    const parsed = eventSchema.safeParse(item);
    if (parsed.success) {
      events.push(parsed.data as InventoryEvent);
    } else {
      const issue = parsed.error.issues[0];
      const field = issue?.path.join(".") || "event";
      skipped.push({ index, reason: `${field}: ${issue?.message ?? "invalid"}` });
    }
  });
  return { events, skipped };
}

// ---------- Per-SKU replay (incremental reducer) ----------

export interface SkuState {
  /** Units on hand, or null until a snapshot/restock tells us the level. */
  level: number | null;
  lastTime: number | null;
  firstTime: number | null;
  netUnitsSold: number;
  outOfStockMs: number;
}

export const initialState = (): SkuState => ({
  level: null,
  lastTime: null,
  firstTime: null,
  netUnitsSold: 0,
  outOfStockMs: 0,
});

/** Adds the time since the last event to the out-of-stock total if we were at 0. */
function advanceClock(state: SkuState, time: number): void {
  if (state.lastTime !== null && state.level !== null && state.level <= 0) {
    state.outOfStockMs += Math.max(0, time - state.lastTime);
  }
  state.lastTime = time;
}

/** Folds one event into the SKU state. Events must arrive in time order. */
export function applyEvent(state: SkuState, event: InventoryEvent): SkuState {
  const time = event.timestamp.getTime();
  state.firstTime ??= time;
  advanceClock(state, time);

  const level = state.level ?? 0;
  switch (event.type) {
    case "stock_snapshot":
      state.level = event.quantity;
      break;
    case "sale":
      state.netUnitsSold += event.quantity;
      state.level = Math.max(0, level - event.quantity);
      break;
    case "return":
      state.netUnitsSold -= event.quantity;
      state.level = level + event.quantity;
      break;
    case "restock":
      state.level = level + event.quantity;
      break;
  }
  return state;
}

// ---------- Risk analysis ----------

export interface SkuAnalysis {
  sku: Sku;
  channel: string;
  unitCost: number;
  currentStock: number;
  dailyDemand: number;
  /** Infinity when there is no demand. */
  daysOfStockRemaining: number;
  atRisk: boolean;
  /** Units needed to cover demand until a new order arrives. 0 when not at risk. */
  neededQuantity: number;
}

export function analyzeSku(
  sku: Sku,
  events: InventoryEvent[],
  asOf: Date,
  config: PlannerConfig,
): SkuAnalysis {
  const state = initialState();
  const ordered = events
    .filter((e) => e.sku === sku && e.timestamp <= asOf)
    .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
  for (const e of ordered) applyEvent(state, e);
  advanceClock(state, asOf.getTime());

  const { unitCost, primaryChannel } = CATALOG[sku];
  const currentStock = state.level ?? 0;

  // Demand is measured only over time the SKU was actually on the shelf:
  // sales are censored while it sits at zero stock.
  const windowMs = state.firstTime === null ? 0 : asOf.getTime() - state.firstTime;
  const inStockDays = Math.max(MIN_IN_STOCK_DAYS, (windowMs - state.outOfStockMs) / DAY_MS);
  const dailyDemand = Math.max(0, state.netUnitsSold) / inStockDays;

  const daysOfStockRemaining = dailyDemand > 0 ? currentStock / dailyDemand : Infinity;
  const atRisk = daysOfStockRemaining < config.reorderLeadTimeDays;
  const neededQuantity = atRisk
    ? Math.max(0, Math.ceil(dailyDemand * config.coverDays - currentStock - 1e-9))
    : 0;

  return {
    sku,
    channel: primaryChannel,
    unitCost,
    currentStock,
    dailyDemand,
    daysOfStockRemaining,
    atRisk,
    neededQuantity,
  };
}

// ---------- Budget allocation ----------

export interface Recommendation {
  sku: Sku;
  channel: string;
  at_risk: boolean;
  current_stock: number;
  daily_demand: number;
  days_of_stock_remaining: number | null;
  recommend_reorder: boolean;
  reorder_quantity: number;
  reorder_cost: number;
  /** Units short of what is needed to cover the lead time (budget ran out). */
  partial: boolean;
  reason: string;
}

const round = (n: number, dp = 2) => Number(n.toFixed(dp));

/**
 * Profit first, then ops effort, then urgency:
 *  1. Assuming equal margin %, every rupee of reorder protects the same profit,
 *     so spend as much of the budget as possible (never more than a SKU needs).
 *  2. Use the fewest POs: take SKUs by largest order cost until the budget is covered.
 *  3. Within that set, soonest stockout is funded first, in full; the last gets what is left.
 */
export function allocateBudget(analyses: SkuAnalysis[], budget: number): Recommendation[] {
  const cost = (a: SkuAnalysis) => a.neededQuantity * a.unitCost;
  const candidates = analyses.filter((a) => a.atRisk && a.neededQuantity > 0);

  const chosen = new Set<Sku>();
  let covered = 0;
  for (const a of [...candidates].sort((x, y) => cost(y) - cost(x))) {
    if (covered >= budget) break;
    chosen.add(a.sku);
    covered += cost(a);
  }

  const funded = new Map<Sku, number>();
  let remaining = budget;
  const byUrgency = candidates
    .filter((a) => chosen.has(a.sku))
    .sort((x, y) => x.daysOfStockRemaining - y.daysOfStockRemaining);
  for (const a of byUrgency) {
    const qty = Math.min(a.neededQuantity, Math.floor(remaining / a.unitCost));
    if (qty > 0) {
      funded.set(a.sku, qty);
      remaining -= qty * a.unitCost;
    }
  }

  return analyses.map((a): Recommendation => {
    const qty = funded.get(a.sku) ?? 0;
    const partial = qty > 0 && qty < a.neededQuantity;
    let reason: string;
    if (!a.atRisk) {
      reason = "Enough stock to last past the supplier lead time.";
    } else if (qty === 0 && chosen.has(a.sku)) {
      reason = "At risk, but the budget ran out before this SKU.";
    } else if (qty === 0) {
      reason = "At risk, deferred: higher-value orders use the budget with fewer POs.";
    } else if (partial) {
      reason = `Partially funded: ${qty} of ${a.neededQuantity} units needed; budget exhausted.`;
    } else {
      reason = "Funded in full.";
    }
    return {
      sku: a.sku,
      channel: a.channel,
      at_risk: a.atRisk,
      current_stock: a.currentStock,
      daily_demand: round(a.dailyDemand),
      days_of_stock_remaining: Number.isFinite(a.daysOfStockRemaining)
        ? round(a.daysOfStockRemaining)
        : null,
      recommend_reorder: qty > 0,
      reorder_quantity: qty,
      reorder_cost: qty * a.unitCost,
      partial,
      reason,
    };
  });
}

// ---------- Entry point ----------

export interface Plan {
  asOf: Date;
  budget: number;
  recommendations: Recommendation[];
  skipped: SkippedEvent[];
}

export function planReorders(raw: unknown, overrides: Partial<PlannerConfig> = {}): Plan {
  const config = { ...DEFAULT_CONFIG, ...overrides };
  const { events, skipped } = parseEvents(raw);

  const latest = events.reduce((max, e) => Math.max(max, e.timestamp.getTime()), -Infinity);
  const asOf = config.asOf ?? new Date(Number.isFinite(latest) ? latest : Date.now());

  const analyses = (Object.keys(CATALOG) as Sku[]).map((sku) =>
    analyzeSku(sku, events, asOf, config),
  );
  const recommendations = allocateBudget(analyses, config.weeklyReorderBudget);
  return { asOf, budget: config.weeklyReorderBudget, recommendations, skipped };
}
