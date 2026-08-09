import { defineTool } from "eve/tools";
import { z } from "zod";

import { prepareTaskConfirmation } from "../../scripts/relationship-intelligence/google.ts";
import {
  loadRegistry,
  mutateRegistry,
  relationshipPaths,
} from "../../scripts/relationship-intelligence/store.ts";

const IdSchema = z.string().regex(/^RI-[a-f0-9]{16}$/u);

export async function dismissCommitment({
  paths,
  id,
  role,
  now = new Date().toISOString(),
}: {
  paths: ReturnType<typeof relationshipPaths>;
  id: string;
  role: string | undefined;
  now?: string;
}): Promise<void> {
  if (role !== "owner")
    throw new Error("only the owner may dismiss commitments");
  await mutateRegistry(paths, (registry) => {
    const item = registry.commitments.find((candidate) => candidate.id === id);
    if (!item) throw new Error(`commitment ${id} not found`);
    if (item.status !== "pending_suggestion")
      throw new Error("only pending commitments can be dismissed");
    item.status = "dismissed";
    item.confirmation = null;
    item.updatedAt = now;
  });
}

export default defineTool({
  description:
    "Читать внутренний реестр обязательств, подготовить точное подтверждение Google Task, подтвердить его только дословной фразой владельца или отклонить внутреннее предложение.",
  inputSchema: z.strictObject({
    action: z.enum(["list", "get", "prepare_google_task", "dismiss"]),
    id: IdSchema.optional(),
    status: z
      .enum(["pending_suggestion", "confirmed_task", "completed", "dismissed"])
      .optional(),
  }),
  async execute({ action, id, status }) {
    try {
      const paths = relationshipPaths();
      const role =
        process.env.ASSISTANT_MULTI_USER === "1"
          ? process.env.ASSISTANT_ROLE
          : "owner";
      if (action === "list") {
        const registry = await loadRegistry(paths);
        const items = registry.commitments
          .filter((item) => status === undefined || item.status === status)
          .slice(0, 100);
        return { ok: true, revision: registry.revision, items };
      }
      if (!id) return { ok: false, error: `${action} requires id` };
      if (action === "get") {
        const item = (await loadRegistry(paths)).commitments.find(
          (candidate) => candidate.id === id,
        );
        return item
          ? { ok: true, item }
          : { ok: false, error: `commitment ${id} not found` };
      }
      if (action === "prepare_google_task") {
        return {
          ok: true,
          ...(await prepareTaskConfirmation({ paths, id, role })),
        };
      }
      await dismissCommitment({ paths, id, role });
      return { ok: true, id, status: "dismissed" };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  },
});
