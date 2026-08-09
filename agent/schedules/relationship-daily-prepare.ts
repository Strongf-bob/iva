import { defineSchedule } from "eve/schedules";
import { resolvePaths } from "../lib/schedule-paths.js";
import { runScheduledJob } from "../../scripts/lib/schedule-runner.ts";
export default defineSchedule({
  cron: "45 7 * * *",
  run({ waitUntil }) {
    if (process.env.ASSISTANT_ROLE !== "owner") return;
    const { root, statusPath } = resolvePaths();
    waitUntil(
      runScheduledJob({
        name: "relationship-daily-prepare",
        argv: ["scripts/relationship-report.ts", "prepare", "daily"],
        root,
        statusPath,
      }),
    );
  },
});
