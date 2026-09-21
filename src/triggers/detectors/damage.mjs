import { dispatchTriggerEvent, collectTriggerMatches } from "../dispatch.mjs";
import { enqueueDamageHold, consumeDamageBypass } from "../queue.mjs";
import { MODULE_ID, getSetting, dbg } from "../../util.mjs";

let _pendingDamageType = null;

let _dealer = null;

function _dealerFromMessage(message) {
  if (!message) return null;
  const speaker = message.speaker ?? {};
  const token = speaker.token ? canvas.tokens?.get(speaker.token) ?? null : null;
  const actor = token?.actor ?? (speaker.actor ? game.actors.get(speaker.actor) : null);
  return actor ? { actor, token } : null;
}

Hooks.once("ready", () => {
  if (!game.modules.get("lib-wrapper")?.active) return;

  libWrapper.register(MODULE_ID, "ds.rolls.DamageRoll.applyDamageCallback", async function (wrapped, event) {
    const li = event?.currentTarget?.closest?.("[data-message-id]");
    _dealer = _dealerFromMessage(li ? game.messages.get(li.dataset.messageId) : null);
    if (_dealer) dbg(`system damage button: dealer is ${_dealer.actor.name}`);
    try {
      return await wrapped(event);
    } finally {
      _dealer = null;
    }
  }, "WRAPPER");

  libWrapper.register(MODULE_ID, "ds.data.Actor.BaseActorModel.prototype.takeDamage", function (wrapped, damage, options = {}) {
    _pendingDamageType = options?.type ?? null;
    try {
      if (_tryHoldDamage(this, damage, options)) return this.parent;
      return wrapped(damage, options);
    } finally {
      _pendingDamageType = null;
    }
  }, "MIXED");
});

function _holdMatches(actor, token, damageType) {
  let matches = collectTriggerMatches("WOULD_TAKE_DAMAGE", actor, token).filter((m) =>
    !m.malice && (m.parse?.confidence === "high" || m.parse?.source === "manual"));
  if (damageType) matches = matches.filter((m) => !m.clause.damageTypes || m.clause.damageTypes.includes(damageType));
  return matches;
}

function _tryHoldDamage(model, damage, options) {
  const actor = model.parent;
  if (!actor) return false;
  if (options?.dstBypass) return false;
  if (!getSetting("damageInterrupts")) return false;
  if (!game.combat?.started) return false;
  if (!(damage > 0)) return false;

  const token = actor.getActiveTokens(true, true)[0] ?? null;
  const matches = _holdMatches(actor, token, options?.type ?? null);
  if (!matches.length) return false;

  const damageOptions = {};
  if (options?.type) damageOptions.type = options.type;
  if (options?.ignoredImmunities?.length) damageOptions.ignoredImmunities = [...options.ignoredImmunities];

  const typeLabel = options?.type
    ? game.i18n.localize(ds.CONFIG.damageTypes?.[options.type]?.label ?? options.type)
    : null;
  const causeLabel = typeLabel
    ? game.i18n.format("DS_TRIGGERS.Queue.HeldDamageCauseTyped", { name: actor.name, amount: damage, type: typeLabel })
    : game.i18n.format("DS_TRIGGERS.Queue.HeldDamageCause", { name: actor.name, amount: damage });

  enqueueDamageHold(matches, {
    causeLabel,
    heldDamage: {
      actorUuid: actor.uuid,
      actorName: actor.name,
      amount: damage,
      damageType: options?.type ?? null,
      damageOptions,
    },
  });
  ui.notifications.info(game.i18n.format("DS_TRIGGERS.Queue.HeldDamageNotice", { name: actor.name }));
  return true;
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
  const matches = _holdMatches(actor, token, _pendingDamageType);
  if (!matches.length) return;

  enqueueDamageHold(matches, {
    causeLabel: game.i18n.format("DS_TRIGGERS.Queue.HeldDamageCause", { name: actor.name, amount }),
    heldDamage: { actorUuid: actor.uuid, actorName: actor.name, amount },
  });
  ui.notifications.info(game.i18n.format("DS_TRIGGERS.Queue.HeldDamageNotice", { name: actor.name }));
  return false;
});

const DSTD_ID = "draw-steel-target-damage";
const _seenApplications = new Set();

const _damageRecords = (record) => (Array.isArray(record?.records) ? record.records : [record])
  .filter((r) => r?.kind === "damage" && r?.status === "applied" && Number(r?.amount) > 0);

Hooks.on("updateChatMessage", (message) => {
  
  const state = message.getFlag(DSTD_ID, "state");
  const applications = state?.applications;
  if (!applications) return;

  
  const age = Date.now() - Number(state.updatedAt ?? 0);
  if (!(age >= 0) || age > 15000) return;

  const dealer = _dealerFromMessage(message);
  if (!dealer) {
    dbg(`target damage recorded on ${message.id} but its speaker resolves to no actor`);
    return;
  }

  const keyFor = (operationId, r) =>
    `${message.id}:${operationId}:${r.target?.tokenUuid ?? r.target?.actorUuid ?? ""}`;

  for (const [operationId, record] of Object.entries(applications)) {
    
    for (const r of (Array.isArray(record?.records) ? record.records : [record])) {
      if (r?.status !== "applied") _seenApplications.delete(keyFor(operationId, r));
    }

    for (const r of _damageRecords(record)) {
      const victimUuid = r.target?.tokenUuid ?? r.target?.actorUuid ?? "";
      const key = keyFor(operationId, r);
      if (_seenApplications.has(key)) continue;
      _seenApplications.add(key);

      const doc = victimUuid ? fromUuidSync(victimUuid) : null;
      const victim = doc?.actor ?? doc ?? null;
      if (!victim || victim === dealer.actor) {
        dbg(`skipped a damage record on ${message.id}: victim ${victimUuid || "unnamed"} is the dealer or could not be resolved`);
        continue;
      }

      dbg(`target damage recorded: ${dealer.actor.name} dealt ${r.amount} to ${victim.name}`);
      dispatchTriggerEvent({
        event: "DEALS_DAMAGE",
        subjectActor: dealer.actor,
        subjectToken: dealer.token,
        causeLabel: game.i18n.format("DS_TRIGGERS.Reminder.DealsDamage", {
          name: dealer.actor.name, target: victim.name, amount: r.amount,
        }),
        triggerDamage: Number(r.amount),
      });
    }
  }

  if (_seenApplications.size > 400) _seenApplications.clear();
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

    
    if (_dealer && _dealer.actor !== actor) {
      dispatchTriggerEvent({
        event: "DEALS_DAMAGE",
        subjectActor: _dealer.actor,
        subjectToken: _dealer.token,
        causeLabel: game.i18n.format("DS_TRIGGERS.Reminder.DealsDamage", {
          name: _dealer.actor.name, target: actor.name, amount: prevTotal - curTotal,
        }),
        triggerDamage: prevTotal - curTotal,
        victimActorUuid: actor.uuid,
      });
    }
  }
  if (cur.value < prev.value) {
    dispatchTriggerEvent({
      event: "STAMINA_BELOW",
      subjectActor: actor,
      subjectToken: token,
      eventContext: { prevValue: prev.value, curValue: cur.value },
      causeLabel: game.i18n.format("DS_TRIGGERS.Reminder.StaminaBelow", { name: actor.name, value: cur.value }),
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
