// Eve отдаёт continuationToken в двух видах, и различие ловится только на реальном
// сбросе. В data события session.waiting токен channel-local ("<chatId>:<thread>:<conv>"),
// а на `channel.continuationToken` в обработчиках событий — тот же токен С ИМЕНЕМ КАНАЛА
// впереди ("telegram:<chatId>:<thread>:<conv>"). Route-хелпер reset клеит имя канала сам,
// поэтому namespaced-токен, дошедший до /eve/v1/telegram/reset, превращается в
// "telegram:telegram:…", ничего не находит и возвращает идемпотентный no_active_session —
// сессия живёт дальше, а пользователю уже сказали «контекст очищен» (issue #110).
// Всё, что iva хранит в data/run-status.d и шлёт в reset, должно быть channel-local.

// Имя канала иве известно точно (agent/channels/telegram.ts), поэтому срезаем ровно его.
// Гадать по первому сегменту нельзя: у групп chatId отрицательный, а форма токена — это
// контракт eve, а не наша эвристика.
const NAMESPACE = "telegram:";

/**
 * Приводит continuationToken к channel-local виду: срезает префикс канала, если он есть.
 * Идемпотентна — на уже локальном токене ("123::", "-1001:7:42") это no-op.
 */
export function toChannelLocalToken(token) {
  if (typeof token !== "string" || !token.startsWith(NAMESPACE)) return token;
  return token.slice(NAMESPACE.length);
}
