import { dispatchTriggerEvent } from "../dispatch.mjs";
import { MODULE_ID, dbg } from "../../util.mjs";

const SYSTEM = "draw-steel";

Hooks.on("preUpdateActor", (actor, changed, options) => {
  if (foundry.utils.getProperty(changed, "system.hero.surges") === undefined) return;
  options.dsTriggersSurges = Number(actor.system?.hero?.surges) || 0;
});

Hooks.on("updateActor", (actor, changed, options) => {
  const before = options.dsTriggersSurges;
  if (before === undefined) return;
  const gained = (Number(actor.system?.hero?.surges) || 0) - before;
  if (!(gained > 0)) return;
  dispatchTriggerEvent({
    event: "GAINS_SURGE",
    subjectActor: actor,
    subjectToken: actor.getActiveTokens(true, true)[0] ?? null,
    causeLabel: game.i18n.format("DS_TRIGGERS.Reminder.GainsSurge", { name: actor.name, amount: gained }),
    eventContext: { surges: gained },
  });
});

const maliceNow = () => Number(game.settings.get(SYSTEM, "malice")?.value ?? 0) || 0;
let _malice = null;
let _resetting = 0;

Hooks.once("ready", () => {
  _malice = maliceNow();
  const model = game.actors?.malice;
  const proto = model && Object.getPrototypeOf(model);
  for (const name of ["startCombat", "resetMalice"]) {
    const original = proto?.[name];
    if (typeof original !== "function" || original[MODULE_ID]) continue;
    proto[name] = async function (...args) {
      _resetting++;
      try { return await original.apply(this, args); } finally { _resetting--; }
    };
    proto[name][MODULE_ID] = true;
  }
});

Hooks.on("updateSetting", (setting) => {
  if (setting.key !== `${SYSTEM}.malice`) return;
  const before = _malice;
  _malice = maliceNow();
  if (_resetting || before == null || !(before > _malice)) return;
  dbg(`the Director spent ${before - _malice} Malice`);
  dispatchTriggerEvent({
    event: "MALICE_SPENT",
    causeLabel: game.i18n.format("DS_TRIGGERS.Reminder.MaliceSpent", { amount: before - _malice }),
    eventContext: { malice: before - _malice },
  });
});
