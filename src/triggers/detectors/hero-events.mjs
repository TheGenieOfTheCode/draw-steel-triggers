import { dispatchTriggerEvent, activeCombat } from "../dispatch.mjs";
import { MODULE_ID } from "../../util.mjs";

const SYSTEM = "draw-steel";

Hooks.on("preUpdateActor", (actor, changed, options) => {
  if (foundry.utils.getProperty(changed, "system.recoveries.value") === undefined) return;
  options.dsTriggersRecoveries = Number(actor.system?.recoveries?.value) || 0;
});

Hooks.on("updateActor", (actor, changed, options) => {
  const before = options.dsTriggersRecoveries;
  if (before === undefined) return;
  const spent = before - (Number(actor.system?.recoveries?.value) || 0);
  if (!(spent > 0)) return;
  dispatchTriggerEvent({
    event: "SPENDS_RECOVERY",
    subjectActor: actor,
    subjectToken: actor.getActiveTokens(true, true)[0] ?? null,
    causeLabel: game.i18n.format("DS_TRIGGERS.Reminder.SpendsRecovery", { name: actor.name }),
  });
});

let _resetting = false;

Hooks.once("ready", () => {
  const tokens = game.actors?.heroTokens;
  const proto = tokens && Object.getPrototypeOf(tokens);
  if (!proto?.resetTokens || proto.resetTokens[MODULE_ID]) return;
  const original = proto.resetTokens;
  proto.resetTokens = async function (...args) {
    _resetting = true;
    try { return await original.apply(this, args); } finally { _resetting = false; }
  };
  proto.resetTokens[MODULE_ID] = true;
});

const tokenCount = (raw) => {
  try { return Number((typeof raw === "string" ? JSON.parse(raw) : raw)?.value) || 0; } catch { return 0; }
};

Hooks.on("preUpdateSetting", (setting, changed, options) => {
  if (setting.key !== `${SYSTEM}.heroTokens` || !("value" in changed)) return;
  options.dsTriggersHeroTokens = { before: tokenCount(setting.value), reset: _resetting };
});

Hooks.on("updateSetting", (setting, changed, options) => {
  const note = options.dsTriggersHeroTokens;
  if (setting.key !== `${SYSTEM}.heroTokens` || !note || note.reset) return;
  const gained = tokenCount(setting.value) - note.before;
  if (!(gained > 0)) return;
  const combat = activeCombat();
  const heroes = combat
    ? combat.combatants.filter((c) => c.actor?.type === "hero").map((c) => ({ actor: c.actor, token: c.token }))
    : [...(game.actors.party?.system?.members?.documentsByType?.hero ?? [])].map((actor) => ({ actor, token: actor.getActiveTokens(true, true)[0] ?? null }));
  for (const { actor, token } of heroes) {
    dispatchTriggerEvent({
      event: "HERO_TOKEN_EARNED",
      subjectActor: actor,
      subjectToken: token,
      causeLabel: game.i18n.format("DS_TRIGGERS.Reminder.HeroTokenEarned", { count: gained }),
    });
  }
});
