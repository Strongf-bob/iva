import { sendTelegramHtml } from "./lib/telegram-send.ts";
import { requireActiveTelegramOwner } from "./lib/owner-routing.ts";
import { runGoogleCommand } from "./relationship-intelligence/google.ts";
import {
  collectCalendarMeetings,
  deliverRelationshipReport,
  prepareRelationshipReport,
  resolveOwnerReportRoute,
  type ReportPeriod,
} from "./relationship-intelligence/report.ts";
import { relationshipPaths } from "./relationship-intelligence/store.ts";

const [action, rawPeriod] = process.argv.slice(2);
if (
  !new Set(["prepare", "deliver"]).has(action) ||
  !new Set(["daily", "weekly"]).has(rawPeriod)
)
  throw new Error(
    "usage: relationship-report.ts <prepare|deliver> <daily|weekly>",
  );
const period = rawPeriod as ReportPeriod;
const paths = relationshipPaths();
if (action === "prepare") {
  const calendarMeetings = await collectCalendarMeetings({
    period,
    now: new Date().toISOString(),
    run: runGoogleCommand,
  });
  await prepareRelationshipReport({ paths, period, calendarMeetings });
} else {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN is required");
  const multiUser = process.env.ASSISTANT_MULTI_USER === "1";
  const controlDir = process.env.IVA_USER_CONTROL_DIR;
  const routedOwnerId =
    !multiUser && controlDir
      ? (await requireActiveTelegramOwner(controlDir)).id
      : undefined;
  const route = resolveOwnerReportRoute({
    multiUser,
    role: process.env.ASSISTANT_ROLE,
    assignedUserId: process.env.ASSISTANT_USER_ID,
    routedOwnerId,
    allowedUserIds: process.env.TELEGRAM_ALLOWED_USER_IDS,
    digestChatId: process.env.TELEGRAM_DIGEST_CHAT_ID,
  });
  await deliverRelationshipReport({
    paths,
    period,
    ...route,
    send: async (chatId, text) => {
      const result = await sendTelegramHtml(token, chatId, text);
      if (!result.ok) throw new Error("relationship report delivery failed");
    },
  });
}
