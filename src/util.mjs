export const MODULE_ID = "draw-steel-triggers";

export function getSetting(key) {
  return game.settings.get(MODULE_ID, key);
}

export function dbg(...args) {
  if (getSetting("debugMode")) console.log("DS Triggers |", ...args);
}

const _notices = new Map();
const NOTICE_GATHER_MS = 400;
const NOTICE_MAX_WAIT_MS = 2000;

export function batchedNotice(key, name, { level = "info" } = {}) {
  let batch = _notices.get(key);
  if (!batch) {
    batch = { names: [], level, since: Date.now() };
    _notices.set(key, batch);
  }
  batch.names.push(name);
  clearTimeout(batch.timer);
  const wait = Date.now() - batch.since >= NOTICE_MAX_WAIT_MS ? 0 : NOTICE_GATHER_MS;
  batch.timer = setTimeout(() => {
    _notices.delete(key);
    if (batch.names.length === 1) {
      ui.notifications[batch.level](game.i18n.format(`DS_TRIGGERS.Queue.${key}`, { name: batch.names[0] }));
      return;
    }
    const counts = new Map();
    for (const n of batch.names) counts.set(n, (counts.get(n) ?? 0) + 1);
    const parts = [...counts].map(([n, c]) => (c > 1 ? `${n} ×${c}` : n));
    const names = new Intl.ListFormat(game.i18n.lang, { type: "conjunction" }).format(parts);
    ui.notifications[batch.level](game.i18n.format(`DS_TRIGGERS.Queue.${key}Many`, { names }));
  }, wait);
}

const ctlib = () => game.modules.get("draw-steel-ctlib")?.api;

export const primaryGM = () => ctlib()?.primaryGM?.() ?? game.users.activeGM ?? null;

export const isPrimaryGM = () => !!primaryGM()?.isSelf;

export const executeAsDirector = (socket, handler, ...args) => ctlib()?.executeAsDirector
  ? ctlib().executeAsDirector(socket, handler, ...args)
  : (socket ? socket.executeAsGM(handler, ...args) : Promise.resolve(undefined));
