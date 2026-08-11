// Корневой экран /menu: одно сообщение, кнопки по две в ряд (паттерн hermes). Все кнопки
// несут либо навигацию (o-верб к под-экрану), либо хендофф (mdl/thk), либо закрытие (r:x) —
// их целиком обрабатывает движок, поэтому on() тут пустой.
//
// Правило репо: ни одной module-level const с переведённой строкой — все подписи собираются
// в render() через ctx.tr, иначе язык замёрзнет до рестарта.
interface MenuButton {
  text: string;
  callback_data: string;
}

interface RootContext {
  btn: (text: string, callbackData: string) => MenuButton;
  tr: (english: string, russian: string) => string;
}

type RootState = {
  role?: "owner" | "user";
  personalRoot?: string;
} & Record<string, unknown>;

export default {
  parent: null,
  render(state: RootState, ctx: RootContext) {
    const b = ctx.btn;
    const T = ctx.tr;
    const rows =
      state.role === "user"
        ? [
            [
              b(T("✨ Today", "✨ Сегодня"), "iva_menu:td:o"),
              b(T("✅ Tasks", "✅ Задачи"), "iva_menu:tsk:o"),
            ],
            [
              b(T("🔔 Automation", "🔔 Автоматизация"), "iva_menu:auto:o"),
              b(T("⚙️ Settings", "⚙️ Настройки"), "iva_menu:set:o"),
            ],
            [b(T("✖ Close", "✖ Закрыть"), "iva_menu:r:x")],
          ]
        : [
            [
              b(T("✨ Today", "✨ Сегодня"), "iva_menu:td:o"),
              b(T("📥 Inbox", "📥 Входящие"), "iva_menu:in:o"),
            ],
            [
              b(T("👥 People", "👥 Люди"), "iva_menu:ppl:o"),
              b(T("✅ Tasks", "✅ Задачи"), "iva_menu:tsk:o"),
            ],
            [
              b(T("🔔 Automation", "🔔 Автоматизация"), "iva_menu:auto:o"),
              b(T("⚙️ Settings", "⚙️ Настройки"), "iva_menu:set:o"),
            ],
            [b(T("✖ Close", "✖ Закрыть"), "iva_menu:r:x")],
          ];
    return {
      text: T(
        "Iva\n\nChoose what you want to do.",
        "Ива\n\nЧто хочешь сделать?",
      ),
      rows,
    };
  },
  on(...args: unknown[]) {
    void args;
  },
};
