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
