// Таймаут одного хода ночного роллапа.
//
// Зачем: на eve 0.27.13 резюм припаркованной сессии ПОСЛЕ рестарта сервера виснет молча
// (#104) — `session.send()` отвечает 200, а `await response.result()` не резолвится никогда.
// Обычный try/catch такое не ловит: ошибки нет, ход просто не заканчивается, и ночной
// юнит висит до утра, не написав ни строчки в журнал. Гонка с таймером превращает молчание
// в честную ошибку, по которой вызывающий может уйти на свежую сессию.
//
// Таймер обязательно гасится в finally: живой setTimeout держит event loop и не даёт
// процессу (и тесту) завершиться после успешного хода.

export const DEFAULT_TURN_TIMEOUT_MS = 10 * 60_000;

export class RollupTurnTimeoutError extends Error {
  constructor(label, timeoutMs) {
    super(`rollup turn "${label}" timed out after ${Math.round(timeoutMs / 1000)}s`);
    this.name = "RollupTurnTimeoutError";
    this.code = "ROLLUP_TURN_TIMEOUT";
    this.label = label;
  }
}

// Выполняет fn() и отклоняется RollupTurnTimeoutError, если тот не уложился в timeoutMs.
// Проигравшая сторона гонки не отменяется (у eve-хода нет abort) — она просто повисает
// в фоне; вызывающий должен считать сессию непригодной и завести новую.
export async function withTurnTimeout(fn, { timeoutMs = DEFAULT_TURN_TIMEOUT_MS, label = "turn" } = {}) {
  let timer;
  try {
    return await Promise.race([
      fn(),
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new RollupTurnTimeoutError(label, timeoutMs)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
