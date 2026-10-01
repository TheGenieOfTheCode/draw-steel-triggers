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

export function emblemHTML() {
  return `<img class="dst-emblem-img" src="modules/${MODULE_ID}/icons/emblem.svg" alt="">`;
}

export function primaryGM() {
  const id = getSetting("primaryGamemaster");
  const chosen = id ? game.users.get(id) : null;
  
  if (chosen?.isGM && chosen.active) return chosen;
  return game.users.activeGM ?? null;
}

export const isPrimaryGM = () => !!primaryGM()?.isSelf;

export async function claimPrimaryGM() {
  if (!game.user.isGM) return;
  
  if (!game.users.activeGM?.isSelf) return;

  const id = getSetting("primaryGamemaster");
  const held = id ? game.users.get(id) : null;
  
  if (held?.isGM) return;

  await game.settings.set(MODULE_ID, "primaryGamemaster", game.user.id);
  dbg("claimed the primary gamemaster seat");
}

export function gmChoices() {
  const out = {};
  for (const user of game.users.filter((u) => u.isGM)) out[user.id] = user.name;
  return out;
}
