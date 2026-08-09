import { ProactiveStore } from "./store.ts";

const PREFIX = "iva_commitment:";
const CALLBACK_PATTERN = /^iva_commitment:([cd]):([A-Za-z0-9_-]{43})$/u;

interface ProactiveCallback {
  readonly id: string;
  readonly data: string;
  readonly from?: { readonly id?: number | string };
  readonly message?: {
    readonly chat?: { readonly id?: number | string; readonly type?: string };
  };
}

interface ProactiveTenant {
  readonly user: { readonly id: string; readonly role: "owner" | "user" };
  readonly dataDir: string;
}

export interface ProactiveCallbackInput {
  readonly callback: ProactiveCallback;
  readonly tenant: ProactiveTenant | null | undefined;
  readonly answer: (text: string) => Promise<unknown>;
  readonly openStore?: (dataDir: string) => ProactiveStore;
  readonly now?: () => number;
}

export async function handleProactiveCommitmentCallback({
  callback,
  tenant,
  answer,
  openStore = (dataDir) => ProactiveStore.open(dataDir),
  now = Date.now,
}: ProactiveCallbackInput): Promise<boolean> {
  if (!callback.data.startsWith(PREFIX)) return false;
  const match = CALLBACK_PATTERN.exec(callback.data);
  if (!match) {
    await answer("Action unavailable / Действие недоступно");
    return true;
  }
  const senderId = String(callback.from?.id ?? "");
  const chatId = String(callback.message?.chat?.id ?? "");
  const authorized =
    tenant?.user.role === "owner" &&
    tenant.user.id === senderId &&
    tenant.user.id === chatId &&
    callback.message?.chat?.type === "private";
  if (!authorized || !tenant) {
    await answer("Owner only / Только для владельца");
    return true;
  }
  let store: ProactiveStore | null = null;
  try {
    store = openStore(tenant.dataDir);
    const decision = match[1] === "c" ? "confirmed" : "dismissed";
    const result = store.decideCommitment({
      token: match[2],
      ownerId: tenant.user.id,
      decision,
      nowMs: now(),
    });
    if (result.status === "accepted") {
      await answer(
        decision === "confirmed"
          ? "Confirmed / Подтверждено"
          : "Dismissed / Отклонено",
      );
    } else if (result.status === "already-decided") {
      await answer("Already decided / Уже обработано");
    } else {
      await answer("Action unavailable / Действие недоступно");
    }
  } catch {
    await answer("Action unavailable / Действие недоступно");
  } finally {
    store?.close();
  }
  return true;
}
