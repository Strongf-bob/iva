import { openTaskCount } from "./crons.ts";
import { handoffText } from "./handoff.ts";
import { personalDataDir } from "./personal-data.ts";

type Button = { text: string; callback_data: string };
type State = {
  chatId: string | number;
  userId: string | number;
  personalRoot?: string;
  awaitText: unknown;
};
type Context = {
  deps: {
    dataDir: string;
    deliver: (update: Record<string, unknown>) => unknown;
    reply: (chatId: number, text: string) => unknown;
  };
  flows: {
    end: (state: State, text: string) => Promise<void>;
    screen: (state: State, text: string, rows: Button[][]) => Promise<void>;
  };
  tr: (english: string, russian: string) => string;
  btn: (text: string, callbackData: string) => Button;
  backRow: (screen: string) => Button[];
};

function taskPrompt(state: State, context: Context, error = false) {
  state.awaitText = { kind: "task_add", secret: false };
  return context.flows.screen(
    state,
    context.tr(
      error
        ? "Task text must be between 1 and 500 characters. Try again."
        : "Send the task text in one message.",
      error
        ? "Текст задачи должен быть от 1 до 500 символов. Попробуй ещё раз."
        : "Пришли текст задачи одним сообщением.",
    ),
    [context.backRow("tsk")],
  );
}

export default {
  parent: "r",
  render(state: State, context: Context) {
    const count = openTaskCount(personalDataDir(state, context.deps.dataDir));
    const T = context.tr;
    return {
      text: T(
        `✅ Tasks\n\nOpen tasks: ${count}`,
        `✅ Задачи\n\nОткрытых задач: ${count}`,
      ),
      rows: [
        [
          context.btn(T("Show tasks", "Показать задачи"), "iva_menu:tsk:list"),
          context.btn(T("Add task", "Добавить задачу"), "iva_menu:tsk:add"),
        ],
        context.backRow("r"),
      ],
    };
  },
  async on(verb: string, _args: string[], state: State, context: Context) {
    if (verb === "list") return handoffText(state, context, "/tasks");
    if (verb === "add") return taskPrompt(state, context);
  },
  texts: {
    async task_add(
      text: string,
      _message: unknown,
      state: State,
      context: Context,
    ) {
      const value = text.trim();
      if ([...value].length < 1 || [...value].length > 500) {
        return taskPrompt(state, context, true);
      }
      state.awaitText = null;
      return handoffText(state, context, `/task ${value}`);
    },
  },
};
