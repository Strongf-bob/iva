type Button = { text: string; callback_data: string };
type Context = {
  tr: (english: string, russian: string) => string;
  btn: (text: string, callbackData: string) => Button;
  backRow: (screen: string) => Button[];
};

export default {
  parent: "set",
  render(_state: unknown, ctx: Context) {
    const T = ctx.tr;
    return {
      text: T("🧠 AI settings", "🧠 Настройки ИИ"),
      rows: [
        [
          ctx.btn(T("🧠 Model", "🧠 Модель"), "iva_menu:mdl"),
          ctx.btn(T("🤔 Thinking", "🤔 Размышления"), "iva_menu:thk"),
        ],
        [ctx.btn(T("🔍 Search", "🔍 Поиск"), "iva_menu:srch:o")],
        ctx.backRow("set"),
      ],
    };
  },
  on() {},
};
