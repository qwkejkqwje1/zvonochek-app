// ZVONochek v36 — схлопывание повторных вызовов асинхронной перерисовки.
//
// Досинхронизация сотни сообщений раньше запускала сотню полных перерисовок
// ленты и списка комнат (каждая читает всё хранилище) — O(N²) и подвисания
// на слабых телефонах. coalesced(fn) гарантирует:
//   • одновременно выполняется не больше одного fn;
//   • вызовы до старта fn сливаются с ним, вызовы во время fn — в ОДИН
//     следующий запуск;
//   • промис любого вызова резолвится, когда отработал запуск, который
//     уже видел состояние на момент этого вызова.

/**
 * @param {() => Promise<any>|any} fn
 * @param {number} [delayMs=0] пауза перед стартом (0 — следующий микротик)
 * @returns {() => Promise<any>}
 */
export function coalesced(fn, delayMs = 0) {
  let current = null;
  let started = false;
  let pending = null;
  const kick = () => new Promise((resolve) => (delayMs ? setTimeout(resolve, delayMs) : resolve()));
  const run = () => {
    if (current && !started) return current;
    if (current) {
      if (!pending) {
        pending = current
          .catch(() => {})
          .then(() => {
            pending = null;
            return run();
          });
      }
      return pending;
    }
    started = false;
    current = kick()
      .then(() => {
        started = true;
        return fn();
      })
      .finally(() => {
        current = null;
        started = false;
      });
    return current;
  };
  return run;
}
