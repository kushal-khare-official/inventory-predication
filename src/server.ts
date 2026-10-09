import express from "express";
import { planReorders } from "./inventory";

/** POST /recommendations with a JSON array of events -> the same recommendations as main.ts. */
export function createApp() {
  const app = express();
  app.use(express.json({ limit: "10mb" }));

  app.post("/recommendations", (req, res) => {
    const plan = planReorders(req.body);
    res.json({
      as_of: plan.asOf.toISOString(),
      budget: plan.budget,
      recommendations: plan.recommendations,
      skipped_events: plan.skipped,
    });
  });
  return app;
}

if (require.main === module) {
  const port = Number(process.env.PORT ?? 3000);
  createApp().listen(port, () => console.log(`Listening on http://localhost:${port}`));
}
