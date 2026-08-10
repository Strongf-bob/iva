type HandoffState = {
  chatId: string | number;
  userId: string | number;
};

type HandoffContext<State extends HandoffState> = {
  tr: (english: string, russian: string) => string;
  flows: { end: (state: State, text: string) => Promise<void> };
  deps: {
    deliver: (update: Record<string, unknown>) => unknown;
    reply: (chatId: number, text: string) => unknown;
  };
};

export async function handoffText<State extends HandoffState>(
  state: State,
  context: HandoffContext<State>,
  text: string,
): Promise<void> {
  const chatId = Number(state.chatId);
  const userId = Number(state.userId);
  const message = {
    message_id: Date.now(),
    date: Math.floor(Date.now() / 1000),
    chat: {
      id: chatId,
      type: chatId > 0 ? "private" : "supergroup",
    },
    from: { id: userId, is_bot: false },
    text,
  };
  try {
    const delivered = await context.deps.deliver({ update_id: 0, message });
    if (delivered === false) throw new Error("handoff rejected");
    await context.flows.end(
      state,
      context.tr(
        "Passed to Iva — working on it.",
        "Передал Иве — она уже работает.",
      ),
    );
  } catch {
    await context.deps.reply(
      chatId,
      context.tr(
        "Couldn't pass the action to Iva. Try the command again in chat.",
        "Не удалось передать действие Иве. Повтори команду в чате.",
      ),
    );
  }
}
