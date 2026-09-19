export const MODULE_ID = "draw-steel-triggers";

export function getSetting(key) {
  return game.settings.get(MODULE_ID, key);
}

export function dbg(...args) {
  if (getSetting("debugMode")) console.log("DS Triggers |", ...args);
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
