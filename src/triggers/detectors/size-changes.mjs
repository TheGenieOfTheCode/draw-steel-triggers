import { dispatchTriggerEvent, triggersLive } from "../dispatch.mjs";
import { isPrimaryGM, dbg } from "../../util.mjs";

const SIZE_KEY = /^system\.combat\.size\b/;

const changesSize = (effect) => [...(effect.system?.changes ?? effect.changes ?? [])].some((c) => SIZE_KEY.test(c?.key ?? ""));
const actorOf = (effect) => (effect.parent?.documentName === "Actor" ? effect.parent : null);

function fire(effect) {
  const actor = actorOf(effect);
  if (!actor || !isPrimaryGM() || !triggersLive()) return;
  const token = actor.token ?? actor.getActiveTokens?.()[0]?.document ?? null;
  dbg(`${actor.name} had its size changed by ${effect.name}`);
  dispatchTriggerEvent({
    event: "SIZE_CHANGES",
    subjectActor: actor,
    subjectToken: token,
    causeLabel: game.i18n.format("DS_TRIGGERS.Reminder.SizeChanges", { name: token?.name ?? actor.name }),
  });
}

Hooks.on("createActiveEffect", (effect) => {
  if (!effect.disabled && changesSize(effect)) fire(effect);
});

Hooks.on("updateActiveEffect", (effect, changes) => {
  if (changes.disabled === false && changesSize(effect)) fire(effect);
});
