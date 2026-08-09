import { defineSchedule } from "eve/schedules";
import { resolvePaths } from "../lib/schedule-paths.js";
import { runScheduledJob } from "../../scripts/lib/schedule-runner.ts";
export default defineSchedule({
  cron: "0 8 * * 1",
  run({ waitUntil }) {
    if (
      process.env.ASSISTANT_MULTI_USER === "1" &&
      process.env.ASSISTANT_ROLE !== "owner"
    )
      return;
    const { root, statusPath } = resolvePaths();
    waitUntil(
      runScheduledJob({
        name: "relationship-weekly-deliver",
        argv: ["scripts/relationship-report.ts", "deliver", "weekly"],
        root,
        statusPath,
      }),
    );
  },
});
