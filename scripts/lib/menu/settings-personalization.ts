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
      text: T("🎭 Personalization", "🎭 Персонализация"),
      rows: [
        [
          ctx.btn(T("🌐 Language", "🌐 Язык"), "iva_menu:lang:o"),
          ctx.btn(T("🎭 Character", "🎭 Характер"), "iva_menu:chr:o"),
        ],
        [ctx.btn(T("💾 Memory", "💾 Память"), "iva_menu:core:o")],
        ctx.backRow("set"),
      ],
    };
  },
  on() {},
};
