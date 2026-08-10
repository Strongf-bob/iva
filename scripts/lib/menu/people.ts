import { handoffText } from "./handoff.ts";

type Button = { text: string; callback_data: string };
type AwaitText = { kind: string; secret: boolean };
type State = {
  chatId: string | number;
  userId: string | number;
  role?: "owner" | "user";
  awaitText: AwaitText | null;
  data: Record<string, unknown>;
};
type Context = {
  deps: {
    deliver: (update: Record<string, unknown>) => Promise<unknown> | unknown;
    reply: (chatId: number, text: string) => Promise<unknown> | unknown;
  };
  flows: {
    end: (state: State, text: string) => Promise<void>;
    screen: (state: State, text: string, rows: Button[][]) => Promise<void>;
  };
  tr: (english: string, russian: string) => string;
  btn: (text: string, callbackData: string) => Button;
  backRow: (screen: string) => Button[];
};

type NameAction = "person_lookup" | "person_brief" | "person_add_name";

const codePointLength = (value: string): number => [...value].length;
const normalizeName = (value: string): string =>
  value.trim().replace(/\s+/gu, " ");
const validName = (value: string): boolean => {
  const length = codePointLength(value);
  return length >= 1 && length <= 160;
};

function ownerOnly(state: State): boolean {
  return state.role !== "user";
}

function namePrompt(
  state: State,
  context: Context,
  kind: NameAction,
  error = false,
): Promise<void> {
  state.awaitText = { kind, secret: false };
  return context.flows.screen(
    state,
    context.tr(
      error
        ? "The name must be between 1 and 160 characters. Try again."
        : "Send the person's name in one message.",
      error
        ? "Имя должно быть от 1 до 160 символов. Попробуй ещё раз."
        : "Пришли имя человека одним сообщением.",
    ),
    [context.backRow("ppl")],
  );
}

function notePrompt(
  state: State,
  context: Context,
  error = false,
): Promise<void> {
  state.awaitText = { kind: "person_add_note", secret: false };
  return context.flows.screen(
    state,
    context.tr(
      error
        ? "The note must be between 1 and 2000 characters. Try again."
        : "What should Iva add or correct? Send one factual note. Existing information will be preserved unless you explicitly correct it.",
      error
        ? "Заметка должна быть от 1 до 2000 символов. Попробуй ещё раз."
        : "Что Иве добавить или исправить? Пришли один факт. Существующая информация сохранится, если ты явно её не исправляешь.",
    ),
    [context.backRow("ppl")],
  );
}

function unavailable(state: State, context: Context): Promise<void> {
  state.awaitText = null;
  delete state.data.personName;
  return context.flows.screen(
    state,
    context.tr(
      "People memory is available only to the owner.",
      "Память о людях доступна только владельцу.",
    ),
    [context.backRow("r")],
  );
}

async function handleName(
  text: string,
  state: State,
  context: Context,
  kind: NameAction,
): Promise<void> {
  if (!ownerOnly(state)) return unavailable(state, context);
  const name = normalizeName(text);
  if (!validName(name)) return namePrompt(state, context, kind, true);
  if (kind === "person_add_name") {
    state.data.personName = name;
    return notePrompt(state, context);
  }
  state.awaitText = null;
  return handoffText(
    state,
    context,
    kind === "person_lookup" ? `/person ${name}` : `/brief ${name}`,
  );
}

export default {
  parent: "r",
  render(state: State, context: Context) {
    const T = context.tr;
    if (!ownerOnly(state)) {
      return {
        text: T(
          "People memory is available only to the owner.",
          "Память о людях доступна только владельцу.",
        ),
        rows: [context.backRow("r")],
      };
    }
    return {
      text: T(
        "👥 People\n\nView what Iva knows, prepare a relationship brief, or add a verified detail to one person's card.",
        "👥 Люди\n\nПосмотри, что знает Ива, подготовь сводку по отношениям или добавь проверенный факт в карточку человека.",
      ),
      rows: [
        [
          context.btn(
            T("What do we know?", "Что мы знаем?"),
            "iva_menu:ppl:know",
          ),
          context.btn(T("Add a detail", "Дополнить"), "iva_menu:ppl:add"),
        ],
        [
          context.btn(
            T("Relationship brief", "Сводка по отношениям"),
            "iva_menu:ppl:brief",
          ),
        ],
        context.backRow("r"),
      ],
    };
  },
  async on(verb: string, _args: string[], state: State, context: Context) {
    if (!ownerOnly(state)) return unavailable(state, context);
    if (verb === "know") return namePrompt(state, context, "person_lookup");
    if (verb === "brief") return namePrompt(state, context, "person_brief");
    if (verb === "add") return namePrompt(state, context, "person_add_name");
  },
  texts: {
    person_lookup(
      text: string,
      _message: unknown,
      state: State,
      context: Context,
    ) {
      return handleName(text, state, context, "person_lookup");
    },
    person_brief(
      text: string,
      _message: unknown,
      state: State,
      context: Context,
    ) {
      return handleName(text, state, context, "person_brief");
    },
    person_add_name(
      text: string,
      _message: unknown,
      state: State,
      context: Context,
    ) {
      return handleName(text, state, context, "person_add_name");
    },
    async person_add_note(
      text: string,
      _message: unknown,
      state: State,
      context: Context,
    ) {
      if (!ownerOnly(state)) return unavailable(state, context);
      const name = state.data.personName;
      if (typeof name !== "string" || !validName(name)) {
        delete state.data.personName;
        return namePrompt(state, context, "person_add_name");
      }
      const note = text.trim();
      const length = codePointLength(note);
      if (length < 1 || length > 2000) return notePrompt(state, context, true);
      state.awaitText = null;
      delete state.data.personName;
      return handoffText(
        state,
        context,
        `/person_update ${JSON.stringify({ name, note })}`,
      );
    },
  },
};
