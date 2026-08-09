import { defineSchedule } from "eve/schedules";

import { contactAnalysisJob } from "../lib/schedule-paths.js";
import { runScheduledJob } from "../../scripts/lib/schedule-runner.ts";

export default defineSchedule({
  cron: "*/15 * * * *",
  run({ waitUntil }) {
    waitUntil(runScheduledJob(contactAnalysisJob()));
  },
});
