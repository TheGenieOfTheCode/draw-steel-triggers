import { parseTrigger, generateDSID, SPECIAL_CASES } from "./parser/trigger-parser.mjs";
import { MODULE_ID, getSetting, dbg } from "./util.mjs";
import {
  isTriggeredAbility,
  isMaliceAbility,
  isImplicitMaliceTrigger,
  getParsedTrigger,
  getTriggeredAbilities,
  clearParseCache,
  registerSpecialCase,
  scanWorld,
} from "./triggers/registry.mjs";
import { dispatchTriggerEvent } from "./triggers/dispatch.mjs";
import { isTriggeredActionSpent, setTriggeredActionSpent } from "./triggers/spent-tracking.mjs";
import { computeAutomationLevel } from "./ui/badge.mjs";
import { TriggerEditor } from "./ui/trigger-editor.mjs";
import { StackWindow } from "./ui/stack-window.mjs";
import { getQueueMirror } from "./triggers/queue.mjs";
import "./triggers/detectors/combat.mjs";
import "./triggers/detectors/damage.mjs";
import "./triggers/detectors/roll-lock.mjs";

Hooks.once("init", () => {
  game.settings.register(MODULE_ID, "spentTracking", {
    name: "DS_TRIGGERS.Settings.SpentTracking.Name",
    hint: "DS_TRIGGERS.Settings.SpentTracking.Hint",
    scope: "world",
    config: true,
    type: Boolean,
    default: true
  });
  game.settings.register(MODULE_ID, "rollLock", {
    name: "DS_TRIGGERS.Settings.RollLock.Name",
    hint: "DS_TRIGGERS.Settings.RollLock.Hint",
    scope: "world",
    config: true,
    type: Boolean,
    default: true
  });
  game.settings.register(MODULE_ID, "damagePrompts", {
    name: "DS_TRIGGERS.Settings.DamagePrompts.Name",
    hint: "DS_TRIGGERS.Settings.DamagePrompts.Hint",
    scope: "world",
    config: true,
    type: Boolean,
    default: true
  });
  game.settings.register(MODULE_ID, "rollLockGrace", {
    name: "DS_TRIGGERS.Settings.RollLockGrace.Name",
    hint: "DS_TRIGGERS.Settings.RollLockGrace.Hint",
    scope: "world",
    config: true,
    type: Number,
    default: 15
  });
  game.settings.register(MODULE_ID, "chatReminders", {
    name: "DS_TRIGGERS.Settings.ChatReminders.Name",
    hint: "DS_TRIGGERS.Settings.ChatReminders.Hint",
    scope: "world",
    config: true,
    type: Boolean,
    default: true
  });
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
    dispatchTriggerEvent,
    isTriggeredActionSpent,
    setTriggeredActionSpent,
    computeAutomationLevel,
    TriggerEditor,
    StackWindow,
    getQueueMirror,
    parseTrigger,
    generateDSID,
    SPECIAL_CASES,
    isTriggeredAbility,
    isMaliceAbility,
    isImplicitMaliceTrigger,
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
