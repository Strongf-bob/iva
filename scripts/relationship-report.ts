import { sendTelegramHtml } from "./lib/telegram-send.ts";
import {
  deliverRelationshipReport,
  prepareRelationshipReport,
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
  await prepareRelationshipReport({ paths, period });
} else {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN is required");
  await deliverRelationshipReport({
    paths,
    period,
    role: process.env.ASSISTANT_ROLE,
    ownerUserId: process.env.ASSISTANT_USER_ID,
    destination: process.env.TELEGRAM_DIGEST_CHAT_ID,
    send: async (chatId, text) => {
      const result = await sendTelegramHtml(token, chatId, text);
      if (!result.ok) throw new Error("relationship report delivery failed");
    },
  });
}
