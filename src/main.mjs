import { parseTrigger, generateDSID, SPECIAL_CASES } from "./parser/trigger-parser.mjs";
import { MODULE_ID, getSetting, dbg } from "./util.mjs";
import {
  isTriggeredAbility,
  getParsedTrigger,
  getTriggeredAbilities,
  clearParseCache,
  registerSpecialCase,
  scanWorld,
} from "./triggers/registry.mjs";

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
  module.api = {
    parseTrigger,
    generateDSID,
    SPECIAL_CASES,
    isTriggeredAbility,
    getParsedTrigger,
    getTriggeredAbilities,
    clearParseCache,
    registerSpecialCase,
    scanWorld,
  };
});

Hooks.once("ready", () => {
  console.log(`${MODULE_ID} | ready (v${game.modules.get(MODULE_ID).version})`);
  if (getSetting("debugMode")) scanWorld();
});
