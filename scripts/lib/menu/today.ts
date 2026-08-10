import { openTaskCount } from "./crons.ts";
import { handoffText } from "./handoff.ts";
import { personalDataDir } from "./personal-data.ts";

type Button = { text: string; callback_data: string };
type State = {
  chatId: string | number;
  userId: string | number;
  personalRoot?: string;
};
type Context = {
  deps: {
    dataDir: string;
    deliver: (update: Record<string, unknown>) => Promise<unknown> | unknown;
    reply: (chatId: number, text: string) => Promise<unknown> | unknown;
  };
  flows: { end: (state: State, text: string) => Promise<void> };
  tr: (english: string, russian: string) => string;
  btn: (text: string, callbackData: string) => Button;
  backRow: (screen: string) => Button[];
};

export default {
  parent: "r",
  render(state: State, context: Context) {
    const count = openTaskCount(personalDataDir(state, context.deps.dataDir));
    const T = context.tr;
    return {
      text: T(
        `✨ Today\n\nOpen tasks: ${count}\n\nChoose a fresh evidence-backed review.`,
        `✨ Сегодня\n\nОткрытых задач: ${count}\n\nВыбери свежий обзор с источниками.`,
      ),
      rows: [
        [
          context.btn(T("Daily brief", "Бриф дня"), "iva_menu:td:brief"),
          context.btn(T("Weekly review", "Обзор недели"), "iva_menu:td:weekly"),
        ],
        context.backRow("r"),
      ],
    };
  },
  async on(verb: string, _args: string[], state: State, context: Context) {
    if (verb === "brief") return handoffText(state, context, "/brief");
    if (verb === "weekly") return handoffText(state, context, "/weekly");
  },
};
