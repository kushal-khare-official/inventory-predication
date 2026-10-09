import { readFileSync } from "node:fs";
import { planReorders, type Plan, type PlannerConfig } from "./src/inventory";

function parseArgs(argv: string[]) {
  const opts: { file?: string; format: "table" | "json"; config: Partial<PlannerConfig> } = {
    format: "table",
    config: {},
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const next = () => argv[++i] ?? fail(`missing value for ${arg}`);
    if (arg === "--format") opts.format = next() === "json" ? "json" : "table";
    else if (arg === "--budget") opts.config.weeklyReorderBudget = Number(next());
    else if (arg === "--lead-time") opts.config.reorderLeadTimeDays = Number(next());
    else if (arg === "--cover-days") opts.config.coverDays = Number(next());
    else if (arg === "--as-of") opts.config.asOf = new Date(next());
    else if (!arg.startsWith("--")) opts.file = arg;
    else fail(`unknown option ${arg}`);
  }
  if (!opts.file) fail("usage: tsx main.ts <inventory_events.json> [--format table|json] [--budget N] [--lead-time N] [--cover-days N] [--as-of ISO]");
  if (opts.config.reorderLeadTimeDays !== undefined && opts.config.coverDays === undefined) {
    opts.config.coverDays = opts.config.reorderLeadTimeDays;
  }
  return opts as Required<Pick<typeof opts, "file">> & typeof opts;
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function renderTable(plan: Plan): string {
  const rupees = (n: number) => `₹${n.toLocaleString("en-IN")}`;
  const rows = plan.recommendations.map((r) => [
    r.sku,
    r.channel,
    r.at_risk ? "YES" : "no",
    String(r.current_stock),
    String(r.daily_demand),
    r.days_of_stock_remaining === null ? "∞" : String(r.days_of_stock_remaining),
    r.recommend_reorder ? `${r.reorder_quantity}${r.partial ? " (partial)" : ""}` : "-",
    r.recommend_reorder ? rupees(r.reorder_cost) : "-",
    r.reason,
  ]);
  const head = ["SKU", "Channel", "At risk", "Stock", "Units/day", "Days left", "Order qty", "Cost", "Note"];
  const widths = head.map((h, c) => Math.max(h.length, ...rows.map((r) => r[c]!.length)));
  const line = (cells: string[]) => cells.map((cell, c) => cell.padEnd(widths[c]!)).join("  ");
  const spent = plan.recommendations.reduce((s, r) => s + r.reorder_cost, 0);
  return [
    `Stock position as of ${plan.asOf.toISOString()}`,
    "",
    line(head),
    line(widths.map((w) => "-".repeat(w))),
    ...rows.map(line),
    "",
    `Budget: ${rupees(spent)} of ${rupees(plan.budget)} used (${rupees(plan.budget - spent)} left)`,
    `Skipped ${plan.skipped.length} malformed event(s)` +
      plan.skipped.map((s) => `\n  #${s.index}: ${s.reason}`).join(""),
  ].join("\n");
}

const opts = parseArgs(process.argv.slice(2));
let raw: unknown;
try {
  raw = JSON.parse(readFileSync(opts.file, "utf8"));
} catch (err) {
  fail(`could not read ${opts.file}: ${(err as Error).message}`);
}
const plan = planReorders(raw, opts.config);
console.log(
  opts.format === "json" ? JSON.stringify(plan.recommendations, null, 2) : renderTable(plan),
);
