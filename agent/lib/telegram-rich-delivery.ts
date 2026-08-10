export type TelegramRichResponse = {
  ok: boolean;
  status: number;
  body: unknown;
};

export type TelegramRichDeliveryOutcome =
  | { kind: "delivered" }
  | { kind: "rejected"; status: number; body: unknown }
  | { kind: "ambiguous"; error: unknown };

/**
 * Classify a single rich-message attempt without retrying an ambiguous write.
 * A transport error can arrive after Telegram accepted the message, so callers
 * may fall back only after a definitive API rejection.
 */
export async function attemptTelegramRichDelivery(
  request: () => Promise<TelegramRichResponse>,
): Promise<TelegramRichDeliveryOutcome> {
  try {
    const response = await request();
    return response.ok
      ? { kind: "delivered" }
      : {
          kind: "rejected",
          status: response.status,
          body: response.body,
        };
  } catch (error) {
    return { kind: "ambiguous", error };
  }
}
