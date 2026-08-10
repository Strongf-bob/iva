type Button = { text: string; callback_data: string };
type State = { role?: "owner" | "user"; personalRoot?: string };
type Context = {
  tr: (english: string, russian: string) => string;
  btn: (text: string, callbackData: string) => Button;
  backRow: (screen: string) => Button[];
};

export default {
  parent: "r",
  render(state: State, ctx: Context) {
    const T = ctx.tr;
    const b = ctx.btn;
    const rows: Button[][] = [];
    if (state.role !== "user") {
      rows.push([
        b(T("🧠 AI", "🧠 ИИ"), "iva_menu:sai:o"),
        b(T("🔗 Connections", "🔗 Подключения"), "iva_menu:scon:o"),
      ]);
      if (!state.personalRoot) {
        rows.push([
          b(T("🎭 Personalization", "🎭 Персонализация"), "iva_menu:sper:o"),
          b(T("🛠 System", "🛠 Система"), "iva_menu:ssys:o"),
        ]);
      } else {
        rows.push([b(T("🛠 System", "🛠 Система"), "iva_menu:ssys:o")]);
      }
    } else {
      rows.push([
        b(T("🔗 Connections", "🔗 Подключения"), "iva_menu:scon:o"),
        b(T("🛠 System", "🛠 Система"), "iva_menu:ssys:o"),
      ]);
    }
    rows.push(ctx.backRow("r"));
    return {
      text: T(
        "⚙️ Settings\n\nChoose a group.",
        "⚙️ Настройки\n\nВыбери группу.",
      ),
      rows,
    };
  },
  on() {},
};
