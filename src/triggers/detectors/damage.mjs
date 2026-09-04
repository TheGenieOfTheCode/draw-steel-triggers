import { dispatchTriggerEvent, collectTriggerMatches } from "../dispatch.mjs";
import { enqueueDamageHold, consumeDamageBypass } from "../queue.mjs";
import { MODULE_ID, getSetting } from "../../util.mjs";

let _pendingDamageType = null;
Hooks.once("ready", () => {
  if (!game.modules.get("lib-wrapper")?.active) return;
  libWrapper.register(MODULE_ID, "ds.data.Actor.BaseActorModel.prototype.takeDamage", function (wrapped, damage, options = {}) {
    _pendingDamageType = options?.type ?? null;
    try {
      _warnSquadHoldLimit(this.parent, options?.type ?? null);
      return wrapped(damage, options);
    } finally {
      _pendingDamageType = null;
    }
  }, "WRAPPER");
});

const _squadHoldWarned = new Map();

function _warnSquadHoldLimit(actor, damageType) {
  if (!game.users.activeGM?.isSelf) return;
  if (!getSetting("damageInterrupts")) return;
  if (!game.combat?.started) return;
  if (!actor?.system?.isMinion) return;
  const group = game.combat.combatants.find((c) => c.actor === actor)?.group;
  if (!group) return;
  const now = Date.now();
  if ((_squadHoldWarned.get(group.id) ?? 0) > now - 3000) return;

  const token = actor.getActiveTokens(true, true)[0] ?? null;
  const matches = collectTriggerMatches("WOULD_TAKE_DAMAGE", actor, token).filter((m) =>
    !m.malice && (m.parse?.confidence === "high" || m.parse?.source === "manual")
    && (!damageType || !m.clause.damageTypes || m.clause.damageTypes.includes(damageType)));
  if (!matches.length) return;
  _squadHoldWarned.set(group.id, now);

  ui.notifications.warn(game.i18n.format("DS_TRIGGERS.Queue.SquadHoldNotice", { name: actor.name }));
  const items = matches.map((m) => {
    const trigger = m.item.system.trigger ?? "";
    return `<li><a class="dst-ability-link" data-item-uuid="${m.item.uuid}" data-tooltip="${game.i18n.localize("DS_TRIGGERS.Reminder.LinkTooltip")}"><strong>${m.item.name}</strong></a> (${m.actor.name})<br><em>${trigger}</em></li>`;
  }).join("");
  ChatMessage.create({
    content: `<div class="dst-reminder"><p class="dst-reminder-header">${game.i18n.localize("DS_TRIGGERS.Queue.SquadHoldHeader")}</p><p>${game.i18n.format("DS_TRIGGERS.Queue.SquadHoldBody", { name: actor.name })}</p><ul>${items}</ul></div>`,
    whisper: game.users.filter((u) => u.isGM).map((u) => u.id),
    speaker: { alias: game.i18n.localize("DS_TRIGGERS.Reminder.Speaker") },
    flags: { [MODULE_ID]: { reminder: { event: "SQUAD_HOLD_LIMIT" } } },
  });
}

Hooks.on("modifyTokenAttribute", (change, updates, actor) => {
  if (change?.attribute !== "stamina" || !actor) return;
  if (consumeDamageBypass(actor.uuid)) return;
  if (!getSetting("damageInterrupts")) return;
  if (!game.combat?.started) return;
  const cur = actor.system.stamina;
  if (!cur) return;
  const curTotal = cur.value + (cur.temporary ?? 0);
  const newTotal = (updates["system.stamina.value"] ?? cur.value) + (updates["system.stamina.temporary"] ?? cur.temporary ?? 0);
  const amount = curTotal - newTotal;
  if (amount <= 0) return;

  const token = actor.getActiveTokens(true, true)[0] ?? null;
  let matches = collectTriggerMatches("WOULD_TAKE_DAMAGE", actor, token).filter((m) =>
    !m.malice && (m.parse?.confidence === "high" || m.parse?.source === "manual"));
  
  if (_pendingDamageType) matches = matches.filter((m) => !m.clause.damageTypes || m.clause.damageTypes.includes(_pendingDamageType));
  if (!matches.length) return;

  enqueueDamageHold(matches, {
    causeLabel: game.i18n.format("DS_TRIGGERS.Queue.HeldDamageCause", { name: actor.name, amount }),
    heldDamage: { actorUuid: actor.uuid, actorName: actor.name, amount },
  });
  ui.notifications.info(game.i18n.format("DS_TRIGGERS.Queue.HeldDamageNotice", { name: actor.name }));
  return false;
});

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
