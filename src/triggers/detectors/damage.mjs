import { dispatchTriggerEvent, collectTriggerMatches, isMinionActor } from "../dispatch.mjs";
import { enqueueDamageHold, consumeDamageBypass, deathOfferedFor } from "../queue.mjs";
import { deferDeathApi } from "../../compat/death-tracker.mjs";
import { MODULE_ID, getSetting, dbg, batchedNotice } from "../../util.mjs";

let _pendingDamageType = null;


let _pendingStaminaLoss = false;

let _dealer = null;

const _typeFor = new Map();

function _dealerFromMessage(message) {
  if (!message) return null;
  const speaker = message.speaker ?? {};
  const token = speaker.token ? canvas.tokens?.get(speaker.token)?.document ?? null : null;
  const actor = token?.actor ?? (speaker.actor ? game.actors.get(speaker.actor) : null);
  const use = message.system?.parts?.contents?.find((p) => p.type === "abilityUse");
  const ability = use?.abilityUuid ? fromUuidSync(use.abilityUuid) : null;
  return actor ? { actor, token, ability } : null;
}

Hooks.once("ready", () => {
  if (!game.modules.get("lib-wrapper")?.active) return;

  libWrapper.register(MODULE_ID, "ds.rolls.DamageRoll.applyDamageCallback", async function (wrapped, event) {
    const button = event?.currentTarget;
    const li = button?.closest?.("[data-message-id]");
    const message = li ? game.messages.get(li.dataset.messageId) : null;
    _dealer = _dealerFromMessage(message);
    if (_dealer) {
      const part = button.closest?.("[data-message-part]")?.dataset.messagePart ?? "";
      _dealer.surges = Number(message.getFlag(MODULE_ID, "surgeRolls")?.[`${part}:${button.dataset.index}`]) || 0;
      dbg(`system damage button: dealer is ${_dealer.actor.name}${_dealer.surges ? `, ${_dealer.surges} surge(s) in the damage` : ""}`);
    }
    try {
      return await wrapped(event);
    } finally {
      _dealer = null;
    }
  }, "WRAPPER");

  
  libWrapper.register(MODULE_ID, "ds.data.pseudoDocuments.messageParts.AbilityResult.prototype.modifyDamageDialog", async function (wrapped, ...args) {
    let actor = this.ability?.actor;
    if (actor?.type === "retainer") actor = actor.system.retainer?.mentor ?? actor;
    const before = Number(actor?.system?.hero?.surges ?? 0);
    const roll = await wrapped(...args);
    const spent = before - Number(actor?.system?.hero?.surges ?? 0);
    const message = this.message ?? this.parent;
    if (roll && spent > 0 && message?.isOwner) {
      const key = `${this.id}:${(this.rolls?.length ?? 1) - 1}`;
      await message.update({ [`flags.${MODULE_ID}.surgeRolls.${key}`]: spent });
    }
    return roll;
  }, "WRAPPER");

  libWrapper.register(MODULE_ID, "ds.data.Actor.BaseActorModel.prototype.takeDamage", function (wrapped, damage, options = {}) {
    _pendingDamageType  = options?.type ?? null;
    if (this.parent?.uuid) _typeFor.set(this.parent.uuid, options?.type ?? "");
    _pendingStaminaLoss = !!options?.staminaLoss;
    try {
      if (_tryHoldDamage(this, damage, options)) return this.parent;
      return wrapped(damage, options);
    } finally {
      _pendingDamageType  = null;
      _pendingStaminaLoss = false;
    }
  }, "MIXED");
});

function _holdMatches(actor, token, damageType) {
  let matches = collectTriggerMatches("WOULD_TAKE_DAMAGE", actor, token).filter((m) =>
    !m.malice && (m.parse?.confidence === "high" || m.parse?.source === "manual"));
  if (damageType) matches = matches.filter((m) => !m.clause.damageTypes || m.clause.damageTypes.includes(damageType));
  return matches;
}

function _deathMatches(actor, token, damageType, lethal) {
  if (!lethal || actor.type === "hero" || !deferDeathApi()) return [];
  const group = game.combat?.combatants.find((c) => c.actor === actor)?.group;
  if (isMinionActor(actor) && group?.type === "squad") return [];
  return collectTriggerMatches("DIES", actor, token, null, { damageType })
    .filter((m) => m.item.featureLine?.defersDeath)
    .map((m) => ({ ...m, defersDeath: true }));
}


function _lastMinionDeath(group, hit, damageType) {
  if (!deferDeathApi()) return null;
  const defeated = CONFIG.specialStatusEffects?.DEFEATED ?? "dead";
  const living = Array.from(group.members ?? []).filter((c) => c.token && isMinionActor(c.actor) && !c.isDefeated && !c.actor.statuses?.has(defeated));
  const targeted = new Set([...game.user.targets].map((t) => t.document));
  const rank = (c) => (c.token === hit ? 0 : targeted.has(c.token) ? 1 : 2);
  for (const c of living.sort((a, b) => rank(a) - rank(b))) {
    const matches = collectTriggerMatches("DIES", c.actor, c.token, null, { damageType })
      .filter((m) => m.item.featureLine?.defersDeath)
      .map((m) => ({ ...m, defersDeath: true }));
    if (matches.length) return { token: c.token, matches };
  }
  return null;
}

function _lethal(actor, damage, options) {
  const stamina = actor.system?.stamina;
  if (!(stamina?.value > 0)) return false;
  const { immunity = 0, weakness = 0 } = actor.system.calculateImmunityAndWeakness?.({
    type: options?.type, ignoredImmunities: [...(options?.ignoredImmunities ?? [])],
  }) ?? {};
  return damage + weakness - immunity >= stamina.value + (stamina.temporary ?? 0);
}

function _tryHoldDamage(model, damage, options) {
  const actor = model.parent;
  if (!actor) return false;
  if (options?.dstBypass) return false;
  if (!getSetting("damageInterrupts")) return false;
  if (!game.combat?.started) return false;
  if (!(damage > 0)) return false;

  const token = actor.getActiveTokens(true, true)[0] ?? null;
  const deaths = _deathMatches(actor, token, options?.type ?? null, _lethal(actor, damage, options));
  const matches = [..._holdMatches(actor, token, options?.type ?? null), ...deaths];
  if (!matches.length) return false;

  const damageOptions = {};
  if (options?.type) damageOptions.type = options.type;
  if (options?.ignoredImmunities?.length) damageOptions.ignoredImmunities = [...options.ignoredImmunities];
  if (options?.dsbl) damageOptions.dsbl = foundry.utils.deepClone(options.dsbl);

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
      tokenUuid: token?.uuid ?? null,
      amount: damage,
      damageType: options?.type ?? null,
      damageOptions,
      deathOffered: deaths.length > 0,
    },
  });
  batchedNotice("HeldDamageNotice", actor.name);
  return true;
}

Hooks.on("modifyTokenAttribute", (change, updates, actor) => {
  if (change?.attribute !== "stamina" || !actor) return;
  if (_pendingStaminaLoss) return;
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
  const lethal = cur.value > 0 && (updates["system.stamina.value"] ?? cur.value) <= 0;
  const deaths = _deathMatches(actor, token, _pendingDamageType, lethal);
  const matches = [..._holdMatches(actor, token, _pendingDamageType), ...deaths];
  if (!matches.length) return;

  enqueueDamageHold(matches, {
    causeLabel: game.i18n.format("DS_TRIGGERS.Queue.HeldDamageCause", { name: actor.name, amount }),
    heldDamage: { actorUuid: actor.uuid, actorName: actor.name, tokenUuid: token?.uuid ?? null, amount, deathOffered: deaths.length > 0 },
  });
  batchedNotice("HeldDamageNotice", actor.name);
  return false;
});


Hooks.on("preUpdateCombatantGroup", (group, changes, options) => {
  if (options?.dstBypass || options?.staminaLoss) return;
  const next = foundry.utils.getProperty(changes, "system.staminaValue");
  const prev = Number(group.system?.staminaValue);
  if (next === undefined || !Number.isFinite(prev) || !(prev - Number(next) > 0)) return;
  if (!getSetting("damageInterrupts")) return;
  if (!game.combat?.started) return;
  const tokenId = options?.dstd?.primaryTargetId;
  const hit = tokenId ? group.parent?.scene?.tokens?.get(tokenId) ?? canvas.scene?.tokens?.get(tokenId) ?? null : null;
  const damageType = options?.ds?.damageType || null;
  const death = Number(next) <= 0 ? _lastMinionDeath(group, hit, damageType) : null;
  const token = hit ?? death?.token ?? null;
  const actor = token?.actor;
  if (!actor) return;
  const matches = [...(hit ? _holdMatches(actor, token, damageType) : []), ...(death?.matches ?? [])];
  if (!matches.length) return;

  const amount = prev - Number(next);
  enqueueDamageHold(matches, {
    causeLabel: game.i18n.format("DS_TRIGGERS.Queue.HeldDamageCause", { name: token.name, amount }),
    heldDamage: {
      actorUuid: actor.uuid,
      actorName: token.name,
      tokenUuid: token.uuid,
      amount,
      damageType,
      deathOffered: !!death?.matches.length,
      deathActorUuid: death?.token.actor.uuid ?? null,
      squad: {
        groupUuid: group.uuid,
        ds: foundry.utils.deepClone(options.ds ?? {}),
        dstd: foundry.utils.deepClone(options.dstd),
        areaCap: options.dstd?.isAreaAbility ? Number(actor.system?.stamina?.max) || null : null,
      },
    },
  });
  batchedNotice("HeldDamageNotice", token.name);
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
        eventContext: { victimActor: victim, victimToken: doc instanceof TokenDocument ? doc : null, damageType: r.damageType ?? null, surgeSpend: Number(r.surgeSpend?.surges) || null, ability: dealer.ability },
      });
      dispatchTriggerEvent({
        event: "TAKES_DAMAGE",
        subjectActor: victim,
        subjectToken: doc instanceof TokenDocument ? doc : null,
        causeLabel: game.i18n.format("DS_TRIGGERS.Reminder.DealsDamage", {
          name: dealer.actor.name, target: victim.name, amount: r.amount,
        }),
        triggerDamage: Number(r.amount),
        eventContext: { dealerOnly: true, dealerActor: dealer.actor, dealerToken: dealer.token, damageType: r.damageType ?? null, ability: dealer.ability },
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
  const damageType = _typeFor.get(actor.uuid) ?? null;
  _typeFor.delete(actor.uuid);
  const prevTotal = prev.value + prev.temporary;
  const curTotal = cur.value + (cur.temporary ?? 0);

  
  if (curTotal < prevTotal) {
    dispatchTriggerEvent({
      event: "LOSES_STAMINA",
      subjectActor: actor,
      subjectToken: token,
      causeLabel: game.i18n.format("DS_TRIGGERS.Reminder.LosesStamina", { name: actor.name, amount: prevTotal - curTotal }),
    });
  }

  if (curTotal < prevTotal && !options.staminaLoss) {
    dispatchTriggerEvent({
      event: "TAKES_DAMAGE",
      subjectActor: actor,
      subjectToken: token,
      causeLabel: game.i18n.format("DS_TRIGGERS.Reminder.TakesDamage", { name: actor.name, amount: prevTotal - curTotal }),
      eventContext: { dealerActor: _dealer?.actor ?? null, dealerToken: _dealer?.token ?? null, damageType, ability: _dealer?.ability ?? null },
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
        eventContext: { victimActor: actor, victimToken: token, damageType, surgeSpend: _dealer.surges || null, ability: _dealer.ability ?? null },
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
      eventContext: { damageType, deathOffered: deathOfferedFor(actor.uuid) },
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
