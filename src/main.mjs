import { parseTrigger, generateDSID, SPECIAL_CASES } from "./parser/trigger-parser.mjs";
import { MODULE_ID, getSetting, dbg, claimPrimaryGM, gmChoices } from "./util.mjs";
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
import { toggleSnooze, isActorSnoozed, isTriggerSnoozed, setSnooze, clearSnooze, listSnoozes, registerSnoozeHooks } from "./ui/snooze.mjs";
import { getQueueMirror, noteUseCancelled, setReaper } from "./triggers/queue.mjs";
import "./triggers/detectors/combat.mjs";
import "./triggers/detectors/damage.mjs";
import "./triggers/detectors/ability-use.mjs";
import "./triggers/detectors/conditions.mjs";
import "./triggers/detectors/turn-lock.mjs";
import "./triggers/villain-actions.mjs";
import { ownsResourceGain, canUndoResourceGain, undoResourceGain } from "./triggers/resource-gains.mjs";
import "./ui/line-widgets.mjs";
import "./ui/ignore-pills.mjs";
import { registerDamagePillBridge } from "./triggers/bespoke.mjs";
import "./triggers/detectors/roll-lock.mjs";
import "./triggers/detectors/resolution.mjs";
import "./triggers/detectors/fm-lock.mjs";
import "./triggers/detectors/movement.mjs";
import "./triggers/effect-lifetimes.mjs";
import "./ui/feature-card.mjs";
import { onDerivedSetting } from "./triggers/derived.mjs";
import "./compat/dstd-sync.mjs";

Hooks.once("init", () => {
  game.settings.register(MODULE_ID, "primaryGamemaster", {
    name: "DS_TRIGGERS.Settings.PrimaryGamemaster.Name",
    hint: "DS_TRIGGERS.Settings.PrimaryGamemaster.Hint",
    scope: "world",
    config: true,
    type: String,
    default: "",
    choices: {},
  });
  game.settings.register(MODULE_ID, "combatOnly", {
    name: "DS_TRIGGERS.Settings.CombatOnly.Name",
    hint: "DS_TRIGGERS.Settings.CombatOnly.Hint",
    scope: "world",
    config: true,
    type: Boolean,
    default: true
  });
  game.settings.register(MODULE_ID, "allSceneTokens", {
    name: "DS_TRIGGERS.Settings.AllSceneTokens.Name",
    hint: "DS_TRIGGERS.Settings.AllSceneTokens.Hint",
    scope: "world",
    config: true,
    type: Boolean,
    default: false
  });
  game.settings.register(MODULE_ID, "spentTracking", {
    name: "DS_TRIGGERS.Settings.SpentTracking.Name",
    hint: "DS_TRIGGERS.Settings.SpentTracking.Hint",
    scope: "world",
    config: true,
    type: Boolean,
    default: true
  });
  game.settings.register(MODULE_ID, "chatReminders", {
    name: "DS_TRIGGERS.Settings.ChatReminders.Name",
    hint: "DS_TRIGGERS.Settings.ChatReminders.Hint",
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
  game.settings.register(MODULE_ID, "conditionPrompts", {
    name: "DS_TRIGGERS.Settings.ConditionPrompts.Name",
    hint: "DS_TRIGGERS.Settings.ConditionPrompts.Hint",
    scope: "world",
    config: true,
    type: Boolean,
    default: true
  });
  game.settings.register(MODULE_ID, "stackDecisionTimer", {
    name: "DS_TRIGGERS.Settings.StackDecisionTimer.Name",
    hint: "DS_TRIGGERS.Settings.StackDecisionTimer.Hint",
    scope: "world",
    config: true,
    type: Boolean,
    default: false
  });
  game.settings.register(MODULE_ID, "rollLock", {
    name: "DS_TRIGGERS.Settings.RollLock.Name",
    hint: "DS_TRIGGERS.Settings.RollLock.Hint",
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
  game.settings.register(MODULE_ID, "resolutionHolds", {
    name: "DS_TRIGGERS.Settings.ResolutionHolds.Name",
    hint: "DS_TRIGGERS.Settings.ResolutionHolds.Hint",
    scope: "world",
    config: true,
    type: Boolean,
    default: true
  });
  game.settings.register(MODULE_ID, "holdInertTriggers", {
    name: "DS_TRIGGERS.Settings.HoldInertTriggers.Name",
    hint: "DS_TRIGGERS.Settings.HoldInertTriggers.Hint",
    scope: "world",
    config: true,
    type: Boolean,
    default: false
  });
  game.settings.register(MODULE_ID, "damageInterrupts", {
    name: "DS_TRIGGERS.Settings.DamageInterrupts.Name",
    hint: "DS_TRIGGERS.Settings.DamageInterrupts.Hint",
    scope: "world",
    config: true,
    type: Boolean,
    default: true
  });
  game.settings.register(MODULE_ID, "fmInterrupts", {
    name: "DS_TRIGGERS.Settings.FmInterrupts.Name",
    hint: "DS_TRIGGERS.Settings.FmInterrupts.Hint",
    requiresModule: { id: "draw-steel-combat-tools", label: "Combat Tools" },
    scope: "world",
    config: true,
    type: Boolean,
    default: true
  });
  game.settings.register(MODULE_ID, "turnInterrupts", {
    name: "DS_TRIGGERS.Settings.TurnInterrupts.Name",
    hint: "DS_TRIGGERS.Settings.TurnInterrupts.Hint",
    scope: "world",
    config: true,
    type: Boolean,
    default: true
  });
  game.settings.register(MODULE_ID, "offerVillainActions", {
    name: "DS_TRIGGERS.Settings.OfferVillainActions.Name",
    hint: "DS_TRIGGERS.Settings.OfferVillainActions.Hint",
    scope: "world",
    config: true,
    type: Boolean,
    default: true
  });
  game.settings.register(MODULE_ID, "featureTriggers", {
    name: "DS_TRIGGERS.Settings.FeatureTriggers.Name",
    hint: "DS_TRIGGERS.Settings.FeatureTriggers.Hint",
    scope: "world",
    config: true,
    type: Boolean,
    default: true
  });
  game.settings.register(MODULE_ID, "derivedTriggers", {
    name: "DS_TRIGGERS.Settings.DerivedTriggers.Name",
    hint: "DS_TRIGGERS.Settings.DerivedTriggers.Hint",
    scope: "world",
    config: true,
    type: Boolean,
    default: true,
    onChange: (on) => onDerivedSetting(on),
  });
  game.settings.register(MODULE_ID, "featureShareCards", {
    name: "DS_TRIGGERS.Settings.FeatureShareCards.Name",
    hint: "DS_TRIGGERS.Settings.FeatureShareCards.Hint",
    scope: "world",
    config: true,
    type: Boolean,
    default: true
  });
  game.settings.register(MODULE_ID, "featureIgnore", {
    name: "DS_TRIGGERS.Settings.FeatureIgnore.Name",
    hint: "DS_TRIGGERS.Settings.FeatureIgnore.Hint",
    scope: "world",
    config: true,
    type: String,
    default: JSON.stringify([{ dsid: "perseverance", name: "Perseverance" }]),
    onChange: () => {
      for (const app of foundry.applications.instances.values()) {
        if (app.document?.documentName === "Item" || app.document?.type === "hero") app.render();
      }
      Hooks.callAll("dst.ignoredFeaturesChanged");
    },
  });
  game.settings.register(MODULE_ID, "resourceGains", {
    name: "DS_TRIGGERS.Settings.ResourceGains.Name",
    hint: "DS_TRIGGERS.Settings.ResourceGains.Hint",
    scope: "world",
    config: true,
    type: String,
    choices: {
      auto: "DS_TRIGGERS.Settings.ResourceGains.Auto",
      stack: "DS_TRIGGERS.Settings.ResourceGains.Stack",
      off: "DS_TRIGGERS.Settings.ResourceGains.Off",
    },
    default: "auto"
  });
  game.settings.register(MODULE_ID, "resourcesUiSync", {
    name: "DS_TRIGGERS.Settings.ResourcesUiSync.Name",
    hint: "DS_TRIGGERS.Settings.ResourcesUiSync.Hint",
    scope: "world",
    config: true,
    type: Boolean,
    default: true,
    requiresModule: { id: "draw-steel-resources-ui", label: "Resources UI" },
  });
  game.settings.register(MODULE_ID, "rosterGains", {
    name: "DS_TRIGGERS.Settings.RosterGains.Name",
    hint: "DS_TRIGGERS.Settings.RosterGains.Hint",
    scope: "client",
    config: true,
    type: Boolean,
    default: true,
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
    setReaper,
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
    toggleSnooze,
    isActorSnoozed,
    isTriggerSnoozed,
    setSnooze,
    clearSnooze,
    listSnoozes,
    noteUseCancelled,
    ownsResourceGain,
    canUndoResourceGain,
    undoResourceGain,
  };
});

const SETTING_HEADERS = {
  primaryGamemaster: "General",
  damagePrompts: "Stack",
  rollLock: "Rolls",
  damageInterrupts: "DamageMovement",
  turnInterrupts: "Turns",
  featureTriggers: "Features",
  resourceGains: "Resources",
  debugMode: "Debug",
};

const HEADER_FALLBACK = { Resources: ["rosterGains"] };
const SUB_SETTINGS = ["allSceneTokens"];

Hooks.on("renderSettingsConfig", (_app, html) => {
  const root = html instanceof HTMLElement ? html : html?.[0];
  if (!root) return;
  const groupOf = (key) => root.querySelector(`[name="${MODULE_ID}.${key}"]`)?.closest(".form-group")
    ?? root.querySelector(`[data-setting-id="${MODULE_ID}.${key}"]`);
  for (const [key, header] of Object.entries(SETTING_HEADERS)) {
    const el = [key, ...(HEADER_FALLBACK[header] ?? [])].map(groupOf).find(Boolean);
    if (!el || el.previousElementSibling?.classList?.contains("dst-settings-header")) continue;
    const h = document.createElement("h3");
    h.className = "dst-settings-header";
    h.textContent = game.i18n.localize(`DS_TRIGGERS.Settings.Headers.${header}`);
    el.insertAdjacentElement("beforebegin", h);
  }
  for (const key of SUB_SETTINGS) groupOf(key)?.classList.add("dst-sub-setting");
});

registerSnoozeHooks();

Hooks.once("ready", () => {
  registerDamagePillBridge();
  console.log(`${MODULE_ID} | ready (v${game.modules.get(MODULE_ID).version})`);

  
  
  const cfg = game.settings.settings.get(`${MODULE_ID}.primaryGamemaster`);
  if (cfg) cfg.choices = gmChoices();
  claimPrimaryGM().catch((err) => console.warn(`${MODULE_ID} | could not claim the primary seat`, err));

  if (getSetting("debugMode")) scanWorld();
});
