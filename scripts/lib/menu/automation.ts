type Button = { text: string; callback_data: string };
type Context = {
  tr: (english: string, russian: string) => string;
  btn: (text: string, callbackData: string) => Button;
  backRow: (screen: string) => Button[];
};

export default {
  parent: "r",
  render(_state: unknown, context: Context) {
    const T = context.tr;
    return {
      text: T(
        "🔔 Automation\n\nPersonal reminders, reviews and Iva schedules.",
        "🔔 Автоматизация\n\nЛичные напоминания, обзоры и расписания Ивы.",
      ),
      rows: [
        [
          context.btn(
            T("Timers & schedules", "Напоминания и расписания"),
            "iva_menu:cron:o",
          ),
        ],
        context.backRow("r"),
      ],
    };
  },
  on() {},
};
