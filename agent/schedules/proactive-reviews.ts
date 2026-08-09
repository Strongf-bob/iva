import { defineSchedule } from "eve/schedules";

import { readSettings } from "../lib/settings.js";
import {
  proactiveReviewsEnabled,
  proactiveReviewsJob,
} from "../lib/schedule-paths.js";
import { runScheduledJob } from "../../scripts/lib/schedule-runner.ts";

export default defineSchedule({
  cron: "*/5 * * * *",
  run({ waitUntil }) {
    const settings = readSettings();
    if (!proactiveReviewsEnabled(settings)) return;
    waitUntil(runScheduledJob(proactiveReviewsJob()));
  },
});
