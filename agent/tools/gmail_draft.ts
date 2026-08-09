import { defineTool } from "eve/tools";
import { z } from "zod";

import {
  createGmailDraft,
  runGoogleCommand,
} from "../../scripts/relationship-intelligence/google.ts";

export default defineTool({
  description:
    "Создать только Gmail Draft. Инструмент не умеет отправлять или удалять почту.",
  inputSchema: z.strictObject({
    to: z.email().max(320),
    subject: z.string().min(1).max(998),
    body: z.string().min(1).max(100_000),
  }),
  async execute(input) {
    try {
      return { ok: true, ...(await createGmailDraft(input, runGoogleCommand)) };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  },
});
