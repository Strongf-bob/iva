import { Client } from "eve/client";

import { sendTelegramHtml } from "./lib/telegram-send.ts";
import { notificationChat } from "./lib/notification-chat.ts";
import {
  deliverRelationshipReport,
  prepareRelationshipReport,
  relationshipReportPrompt,
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
  const port = process.env.IVA_PORT ?? "8723";
  const host = process.env.ASSISTANT_HOST ?? `http://127.0.0.1:${port}`;
  const bearer = process.env.ASSISTANT_BEARER;
  const client = new Client({
    host,
    ...(bearer ? { auth: { bearer: () => Promise.resolve(bearer) } } : {}),
  });
  const response = await client
    .session()
    .send(relationshipReportPrompt(period));
  const result = await response.result();
  if (result.status === "failed" || !result.message)
    throw new Error("agent did not prepare a relationship report");
  await prepareRelationshipReport({ paths, period, text: result.message });
} else {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN is required");
  await deliverRelationshipReport({
    paths,
    period,
    role:
      process.env.ASSISTANT_MULTI_USER === "1"
        ? process.env.ASSISTANT_ROLE
        : "owner",
    ownerUserId:
      process.env.ASSISTANT_MULTI_USER === "1"
        ? process.env.ASSISTANT_USER_ID
        : notificationChat(),
    destination: notificationChat(),
    send: async (chatId, text) => {
      const result = await sendTelegramHtml(token, chatId, text);
      if (!result.ok) throw new Error("relationship report delivery failed");
    },
  });
}
