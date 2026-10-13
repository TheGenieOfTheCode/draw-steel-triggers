import { MODULE_ID, dbg, isPrimaryGM } from "../util.mjs";

const turnKey = (round, turn) => `${round}:${turn}`;
const sceneActors = () => new Set((canvas.scene?.tokens ?? []).map((t) => t.actor).filter(Boolean));

export async function markDealer(owner, dealer, spec, source) {
  if (!owner || !dealer || dealer === owner || !spec?.effect) return;
  const name = spec.effect;
  const exclusive = spec.exclusiveBelowLevel != null && (Number(owner.system?.level) || 0) < spec.exclusiveBelowLevel;
  for (const actor of sceneActors().add(dealer)) {
    const stale = actor.effects.filter((e) => {
      const f = e.getFlag(MODULE_ID, "dealerMark");
      return f?.ownerUuid === owner.uuid && f.name === name && (exclusive || actor === dealer);
    }).map((e) => e.id);
    if (stale.length) await actor.deleteEmbeddedDocuments("ActiveEffect", stale).catch(() => {});
  }
  const template = source?.effects?.find((e) => e.name === name)?.toObject() ?? { name, img: source?.img ?? null };
  const { _id, ...data } = template;
  const combat = game.combat;
  const at = combat?.started ? turnKey(combat.round, combat.turn) : null;
  await dealer.createEmbeddedDocuments("ActiveEffect", [{
    ...data, transfer: false, disabled: false, origin: source?.uuid ?? owner.uuid,
    flags: { ...(data.flags ?? {}), [MODULE_ID]: { ...(data.flags?.[MODULE_ID] ?? {}), dealerMark: {
      ownerUuid: owner.uuid, name, at, ...(spec.ownEnd ? { ownEnd: true } : {}), ...(spec.noTriggered ? { noTriggered: true } : {}),
    } } },
  }]);
  ui.notifications.info(game.i18n.format("DS_TRIGGERS.LineEffect.Applied", { name: dealer.name, effect: name, source: source?.name ?? "" }));
  dbg(`${source?.name}: ${dealer.name} carries ${name} from ${owner.name}${exclusive ? " (replacing earlier marks)" : ""}`);
}

Hooks.on("combatTurnChange", (combat, previous) => {
  if (!isPrimaryGM() || !previous?.combatantId) return;
  const owner = combat.combatants.get(previous.combatantId)?.actor;
  if (!owner) return;
  const ending = turnKey(previous.round, previous.turn);
  for (const actor of sceneActors()) {
    const done = actor.effects.filter((e) => {
      const f = e.getFlag(MODULE_ID, "dealerMark");
      return f?.ownerUuid === owner.uuid && !f.ownEnd && f.at !== ending;
    }).map((e) => e.id);
    if (done.length) actor.deleteEmbeddedDocuments("ActiveEffect", done).catch(() => {});
  }
});

export const triggersBlocked = (actor) => !!actor?.effects?.some((e) => e.active && e.getFlag(MODULE_ID, "dealerMark")?.noTriggered);

const VICTIM_MARKS = {
  insubstantial: { key: "Insubstantial", img: "icons/creatures/magical/spirit-undead-ghost-blue.webp", expiry: "turnEnd" },
};

export async function markVictim(owner, victim, label, sourceName) {
  const mark = VICTIM_MARKS[label];
  if (!mark || !owner || !victim || victim === owner) return;
  const existing = victim.effects.find((e) => {
    const flag = e.getFlag(MODULE_ID, "victimMark");
    return flag?.label === label && flag.ownerUuid === owner.uuid;
  });
  if (existing) await existing.delete().catch(() => {});
  await victim.createEmbeddedDocuments("ActiveEffect", [{
    name: game.i18n.format(`DS_TRIGGERS.LineEffect.${mark.key}`, { owner: owner.name }),
    img: mark.img,
    origin: owner.uuid,
    description: `<p>${foundry.utils.escapeHTML(game.i18n.format(`DS_TRIGGERS.LineEffect.${mark.key}Desc`, { owner: owner.name, source: sourceName ?? "" }))}</p>`,
    duration: { expiry: mark.expiry },
    flags: { [MODULE_ID]: { victimMark: { label, ownerUuid: owner.uuid } } },
  }]);
  ui.notifications.info(game.i18n.format("DS_TRIGGERS.LineEffect.Applied", { name: victim.name, effect: game.i18n.format(`DS_TRIGGERS.LineEffect.${mark.key}`, { owner: owner.name }), source: sourceName ?? "" }));
  dbg(`${sourceName}: ${victim.name} is now ${label} to ${owner.name}`);
}

const stabilityEffect = (name, img, amount, origin) => ({
  name, img, origin,
  changes: [{ key: "system.combat.stability", mode: 2, value: String(amount), priority: null }],
  duration: { expiry: "roundEnd" },
  flags: { [MODULE_ID]: { stabilityShare: true } },
});

export async function shareStability(owner, ally, amount, sourceName, img) {
  const n = Math.max(0, Math.floor(Number(amount) || 0));
  if (!n || !owner || !ally) return 0;
  const name = game.i18n.format("DS_TRIGGERS.LineEffect.Stability", { source: sourceName });
  await owner.createEmbeddedDocuments("ActiveEffect", [stabilityEffect(name, img, -n, owner.uuid)]);
  await ally.createEmbeddedDocuments("ActiveEffect", [stabilityEffect(name, img, n, owner.uuid)]);
  ui.notifications.info(game.i18n.format("DS_TRIGGERS.LineEffect.StabilityShared", { owner: owner.name, ally: ally.name, n }));
  return n;
}

export async function pickStabilityShare(ownerName, max, sourceName) {
  const options = Array.from({ length: max + 1 }, (_, i) => `<option value="${i}"${i === max ? " selected" : ""}>${i}</option>`).join("");
  const picked = await foundry.applications.api.DialogV2.prompt({
    window: { title: sourceName },
    content: `<p>${foundry.utils.escapeHTML(game.i18n.format("DS_TRIGGERS.LineEffect.StabilityPrompt", { owner: ownerName }))}</p>
      <div class="form-group"><label>${game.i18n.localize("DS_TRIGGERS.LineEffect.StabilityAmount")}</label>
      <div class="form-fields"><select name="amount">${options}</select></div></div>`,
    ok: { label: game.i18n.localize("DS_TRIGGERS.LineEffect.StabilityConfirm"), callback: (event, button) => Number(button.form.elements.amount.value) },
    rejectClose: false,
  }).catch(() => null);
  return Number.isFinite(picked) ? picked : null;
}

export const ABILITY_BANE_KEY = `flags.${MODULE_ID}.abilityBanes`;

const changesOf = (effect) => effect?.system?.changes ?? effect?.changes ?? [];
const changesPath = (effect) => (Array.isArray(effect?.system?.changes) ? "system.changes" : "changes");

export function abilityBanesOn(actor, dsid) {
  if (!actor || !dsid) return 0;
  return actor.effects.filter((e) => e.active && changesOf(e).some((c) => c.key === ABILITY_BANE_KEY && c.value === dsid)).length;
}

export async function baneAbility(target, ability, spec, source) {
  const dsid = ability?.system?._dsid;
  if (!target || !dsid || !spec?.effect) return;
  const line = { key: ABILITY_BANE_KEY, value: dsid, type: "override", phase: "initial", priority: null };
  const named = (list) => list.filter((c) => c.key === ABILITY_BANE_KEY)
    .map((c) => target.items.find((i) => i.system?._dsid === c.value)?.name ?? c.value).join(", ");
  const existing = target.effects.find((e) => e.name === spec.effect && changesOf(e).some((c) => c.key === ABILITY_BANE_KEY));
  if (existing) {
    const changes = changesOf(existing).map((c) => ({ ...c }));
    if (changes.some((c) => c.key === ABILITY_BANE_KEY && c.value === dsid)) return;
    changes.push(line);
    await existing.update({ [changesPath(existing)]: changes,
      description: game.i18n.format("DS_TRIGGERS.LineEffect.AbilityBaneDesc", { abilities: named(changes), source: source?.name ?? spec.effect }) });
  } else {
    const end = ds.CONFIG?.effectEnds?.encounter ? "encounter" : null;
    await target.createEmbeddedDocuments("ActiveEffect", [{
      name: spec.effect, img: source?.img ?? null, type: "base", transfer: false, disabled: false, origin: source?.uuid ?? null,
      system: { changes: [line], ...(end ? { end: { type: end } } : {}) },
      ...(end ? { duration: { expiry: ds.CONFIG.effectEnds.encounter.expiryEvent ?? null } } : {}),
      description: game.i18n.format("DS_TRIGGERS.LineEffect.AbilityBaneDesc", { abilities: named([line]), source: source?.name ?? spec.effect }),
    }]);
  }
  ui.notifications.info(game.i18n.format("DS_TRIGGERS.LineEffect.AbilityBane", { name: target.name, ability: ability.name, source: source?.name ?? spec.effect }));
  dbg(`${source?.name}: ${target.name} takes a bane on ${ability.name} for the rest of the encounter`);
}
