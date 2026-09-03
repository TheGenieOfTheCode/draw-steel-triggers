import { parseTrigger, generateDSID, SPECIAL_CASES } from "./parser/trigger-parser.mjs";

export const MODULE_ID = "draw-steel-triggers";

export function getSetting(key) {
  return game.settings.get(MODULE_ID, key);
}

Hooks.once("init", () => {
  game.settings.register(MODULE_ID, "debugMode", {
    name: "DS_TRIGGERS.Settings.DebugMode.Name",
    hint: "DS_TRIGGERS.Settings.DebugMode.Hint",
    scope: "world",
    config: true,
    type: Boolean,
    default: false
  });

  const module = game.modules.get(MODULE_ID);
  module.api = { parseTrigger, generateDSID, SPECIAL_CASES };
});

Hooks.once("ready", () => {
  console.log(`${MODULE_ID} | ready (v${game.modules.get(MODULE_ID).version})`);
});
