type Button = { text: string; callback_data: string };
type State = { role?: "owner" | "user" };
type Context = {
  tr: (english: string, russian: string) => string;
  btn: (text: string, callbackData: string) => Button;
  backRow: (screen: string) => Button[];
};

export default {
  parent: "set",
  render(state: State, ctx: Context) {
    const T = ctx.tr;
    const rows: Button[][] = [
      [ctx.btn(T("🔗 Google", "🔗 Google"), "iva_menu:gws:o")],
    ];
    if (state.role !== "user") {
      rows[0].push(ctx.btn(T("📡 Userbot", "📡 Userbot"), "iva_menu:ub:o"));
    }
    rows.push(ctx.backRow("set"));
    return {
      text: T("🔗 Connections", "🔗 Подключения"),
      rows,
    };
  },
  on() {},
};
