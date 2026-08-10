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
      [ctx.btn(T("📊 Status", "📊 Статус"), "iva_menu:st:o")],
    ];
    if (state.role !== "user") {
      rows[0].push(ctx.btn(T("🧩 Skills", "🧩 Скиллы"), "iva_menu:sk:o"));
      rows.push([
        ctx.btn(T("🛠 Maintenance", "🛠 Обслуживание"), "iva_menu:svc:o"),
      ]);
    }
    rows.push(ctx.backRow("set"));
    return { text: T("🛠 System", "🛠 Система"), rows };
  },
  on() {},
};
