import { dispatchTriggerEvent } from "../dispatch.mjs";

Hooks.on("preUpdateActor", (actor, changed, options) => {
  const stamina = changed.system?.stamina;
  if (!stamina || (!("value" in stamina) && !("temporary" in stamina))) return;
  const prev = actor.system.stamina;
  if (!prev) return;
  options.dsTriggersPrev = { value: prev.value, temporary: prev.temporary ?? 0, winded: prev.winded ?? 0 };
});

Hooks.on("updateActor", (actor, changed, options) => {
  const prev = options.dsTriggersPrev;
  if (!prev) return;
  const cur = actor.system.stamina;
  if (!cur) return;

  const token = actor.getActiveTokens(true, true)[0] ?? null;
  const prevTotal = prev.value + prev.temporary;
  const curTotal = cur.value + (cur.temporary ?? 0);

  if (curTotal < prevTotal) {
    dispatchTriggerEvent({
      event: "TAKES_DAMAGE",
      subjectActor: actor,
      subjectToken: token,
      causeLabel: game.i18n.format("DS_TRIGGERS.Reminder.TakesDamage", { name: actor.name, amount: prevTotal - curTotal }),
    });
  }
  if (prev.value > 0 && cur.value <= 0) {
    dispatchTriggerEvent({
      event: "DIES",
      subjectActor: actor,
      subjectToken: token,
      causeLabel: game.i18n.format("DS_TRIGGERS.Reminder.Dies", { name: actor.name }),
    });
  }
  if (prev.winded > 0 && prev.value > prev.winded && cur.value <= prev.winded) {
    dispatchTriggerEvent({
      event: "WINDED_OR_DYING",
      subjectActor: actor,
      subjectToken: token,
      causeLabel: game.i18n.format("DS_TRIGGERS.Reminder.Winded", { name: actor.name }),
    });
  }
  if (cur.value > prev.value) {
    dispatchTriggerEvent({
      event: "REGAINS_STAMINA",
      subjectActor: actor,
      subjectToken: token,
      causeLabel: game.i18n.format("DS_TRIGGERS.Reminder.RegainsStamina", { name: actor.name, amount: cur.value - prev.value }),
    });
  }
});
