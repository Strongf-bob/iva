// Eve отдаёт continuationToken в двух видах, и различие ловится только на реальном
// сбросе. В data события session.waiting токен channel-local ("<chatId>:<thread>:<conv>"),
// а на `channel.continuationToken` в обработчиках событий — тот же токен С ИМЕНЕМ КАНАЛА
// впереди ("telegram:<chatId>:<thread>:<conv>"). Route-хелпер reset клеит имя канала сам,
// поэтому namespaced-токен, дошедший до /eve/v1/telegram/reset, превращается в
// "telegram:telegram:…", ничего не находит и возвращает идемпотентный no_active_session —
// сессия живёт дальше, а пользователю уже сказали «контекст очищен» (issue #110).
// Всё, что iva хранит и шлёт в reset, должно быть channel-local.

// Первый сегмент telegram-токена — chat id: целое, у групп со знаком минус.
const CHAT_ID_SEGMENT = /^-?\d+$/;

/**
 * Приводит continuationToken к channel-local виду: срезает ведущий сегмент с именем
 * канала, если он есть. Идемпотентна — уже channel-local токен возвращается как есть.
 */
export function channelLocalContinuationToken(token) {
  if (typeof token !== "string" || token.length === 0) return token;
  const separator = token.indexOf(":");
  if (separator <= 0) return token;
  const head = token.slice(0, separator);
  return CHAT_ID_SEGMENT.test(head) ? token : token.slice(separator + 1);
}
