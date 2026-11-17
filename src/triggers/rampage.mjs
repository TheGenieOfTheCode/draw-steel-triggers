import { MODULE_ID, isPrimaryGM, dbg } from "../util.mjs";
import { cardContent, postSystemCard, withFaces } from "../ui/system-card.mjs";
import { enqueuePromptEntries } from "./queue.mjs";

const RAMPAGING = 8;
const IMMUNE = 12;
const EXTRA = 16;
const EXTRA_LEVEL = 4;
const IMMUNITY_ID = "vMFxV4AZ4oM9LbFD";
const FLAG = "rampage";

const lib = () => game.modules.get("draw-steel-ctlib")?.api;
const L = (key, data = {}) => game.i18n.format(`DS_TRIGGERS.Rampage.${key}`, data);

const RAMPAGE_DSIDS = new Set(["bh-rampage", "rampage"]);
const rampageFeature = (hero) => hero?.items?.find((i) => i.type === "feature" && RAMPAGE_DSIDS.has(i.system?._dsid ?? "")) ?? null;
const masterOf = (companion) => companion?.system?.companion?.master ?? null;
const companionsOf = (hero) => (lib()?.companionsOf?.(hero) ?? []).map((t) => t.actor).filter(Boolean);
const levelOf = (actor) => Number(actor?.system?.level ?? 0) || 0;
const feralStrikeOf = (companion) => companion?.items?.find((i) => i.type === "ability" && (i.system?._dsid ?? "") === "feral-strike") ?? null;
const fighting = (actor) => game.combats.some((c) => c.started && c.combatants.some((x) => x.actor === actor));
const heroicOf = (actor) => Number(actor?.system?.hero?.primary?.value) || 0;

export const rampageOf = (companion) => Number(companion?.system?.companion?.rampage) || 0;

const _heroic = new Map();
const _rampage = new Map();
const _ending = new Set();

export function rampageDamageBonus(actor, ability) {
  if (actor?.type !== "companion" || (ability?.system?._dsid ?? "") !== "feral-strike") return null;
  const hero = masterOf(actor);
  const feature = rampageFeature(hero);
  if (!feature || rampageOf(actor) < EXTRA || levelOf(hero) < EXTRA_LEVEL) return null;
  const amount = Number(actor.system?.characteristics?.intuition?.value) || 0;
  if (amount <= 0) return null;
  return { name: feature.name, amount, type: null, dice: null, optional: false, item: feature, actor, potencyMod: null, perRound: false, auto: true };
}

async function addRampage(hero, spent) {
  if (!rampageFeature(hero)) return;
  for (const companion of companionsOf(hero)) {
    dbg(`rampage: ${hero.name} spent ${spent} ferocity, ${companion.name} gains ${spent} rampage`);
    await companion.update({ "system.companion.rampage": rampageOf(companion) + spent });
  }
}

async function syncRampage(companion) {
  const hero = masterOf(companion);
  const feature = rampageFeature(hero);
  if (!feature) return;
  const now = rampageOf(companion);
  const before = _rampage.get(companion.uuid) ?? 0;
  _rampage.set(companion.uuid, now);
  const immunity = companion.effects.find((e) => e.getFlag(MODULE_ID, FLAG) === "immunity");
  if (now >= IMMUNE && !immunity) {
    const source = feature.effects.get(IMMUNITY_ID) ?? feature.effects.find((e) => /damage immunity/i.test(e.name));
    if (source) {
      const data = source.toObject();
      delete data._id;
      Object.assign(data, { disabled: false, transfer: false, origin: feature.uuid });
      foundry.utils.setProperty(data, `flags.${MODULE_ID}.${FLAG}`, "immunity");
      await companion.createEmbeddedDocuments("ActiveEffect", [data]);
    }
  } else if (now < IMMUNE && immunity) await immunity.delete();
  if (before < RAMPAGING && now >= RAMPAGING) {
    const recipients = game.users.filter((u) => u.isGM || companion.testUserPermission(u, "OWNER")).map((u) => u.id);
    await postSystemCard({
      title: feature.name,
      flavor: null,
      kind: "Reminder",
      content: cardContent({ intro: withFaces(L("Rampaging", { name: companion.name, n: now }), [companion]) }),
      whisper: recipients,
    });
  }
}

async function resetRampage(companion) {
  _rampage.delete(companion.uuid);
  const effects = companion.effects.filter((e) => e.getFlag(MODULE_ID, FLAG)).map((e) => e.id);
  if (effects.length) await companion.deleteEmbeddedDocuments("ActiveEffect", effects).catch(() => {});
  if (rampageOf(companion)) await companion.update({ "system.companion.rampage": 0 });
}

function offerFeralStrike(hero) {
  for (const companion of companionsOf(hero)) {
    if (rampageOf(companion) < RAMPAGING) continue;
    const item = feralStrikeOf(companion);
    if (!item) continue;
    const causeLabel = L("FeralCause", { name: companion.name, hero: hero.name });
    enqueuePromptEntries([{ actor: companion, item, _causeLabel: causeLabel }], { event: "TURN_END", causeLabel });
  }
}

async function surgesFor(part, context) {
  const use = part?.message?.system?.parts?.contents?.find?.((p) => p.type === "abilityUse");
  const ability = use?.abilityUuid ? fromUuidSync(use.abilityUuid, { strict: false }) : null;
  const companion = ability?.actor;
  if (companion?.type !== "companion" || (ability.system?._dsid ?? "") !== "feral-strike") return;
  const hero = masterOf(companion);
  if (!rampageFeature(hero) || rampageOf(companion) < RAMPAGING || !hero.isOwner) return;
  const heroToken = hero.getActiveTokens?.()[0]?.document ?? null;
  const total = (s) => (Number(s?.value) || 0) + (Number(s?.temporary) || 0);
  const allies = (context.applied ?? []).filter((a) => a.actor && a.actor !== companion && a.actor !== hero
    && total(a.after) < total(a.before)
    && (!heroToken || a.actor.getActiveTokens?.()[0]?.document?.disposition === heroToken.disposition));
  if (!allies.length) return;
  const each = 2 + (rampageOf(companion) >= EXTRA && levelOf(hero) >= EXTRA_LEVEL ? 1 : 0);
  const gained = allies.length * each;
  await hero.update({ "system.hero.surges": (Number(hero.system?.hero?.surges) || 0) + gained });
  ui.notifications.info(L("Surges", { hero: hero.name, n: gained, allies: allies.length }));
}

const _slaked = new Set();
const SLAKE = /^Slake My Thirst in Blood$/i;

async function slakeFor(part, context) {
  const message = part?.message;
  if (part?.type !== "targetResult" || !message?.id || _slaked.has(message.id)) return;
  const use = message.system?.parts?.contents?.find?.((p) => p.type === "abilityUse");
  const hero = (use?.abilityUuid ? fromUuidSync(use.abilityUuid, { strict: false }) : null)?.actor;
  if (hero?.type !== "hero" || !hero.isOwner) return;
  const companion = companionsOf(hero).find((c) => rampageOf(c) >= RAMPAGING && c.items.some((i) => SLAKE.test(i.name)));
  if (!companion) return;
  const total = (s) => (Number(s?.value) || 0) + (Number(s?.temporary) || 0);
  if (!(context.applied ?? []).some((a) => a.actor?.statuses?.has("bleeding") && total(a.after) < total(a.before))) return;
  _slaked.add(message.id);
  await hero.update({ "system.hero.surges": (Number(hero.system?.hero?.surges) || 0) + 2 });
  ui.notifications.info(L("Slake", { hero: hero.name, name: companion.name }));
}

export function registerRampage() {
  Hooks.once("ready", () => {
    for (const actor of game.actors) if (rampageFeature(actor)) _heroic.set(actor.uuid, heroicOf(actor));
    for (const actor of game.actors) if (actor.type === "companion") _rampage.set(actor.uuid, rampageOf(actor));
    const APPLY = lib()?.APPLY;
    if (APPLY) Hooks.on(APPLY, (part, action, context) => {
      if (action !== "applyDamage") return;
      surgesFor(part, context).catch((err) => dbg("rampage surges failed", err));
      slakeFor(part, context).catch((err) => dbg("slake surges failed", err));
    });
  });
  Hooks.on("updateActor", (actor, changes) => {
    if (!isPrimaryGM()) return;
    if (foundry.utils.hasProperty(changes, "system.hero.primary.value") && rampageFeature(actor)) {
      const now = heroicOf(actor);
      const before = _heroic.get(actor.uuid) ?? now;
      _heroic.set(actor.uuid, now);
      if (now < before && fighting(actor) && !_ending.has(actor.uuid)) addRampage(actor, before - now);
    }
    if (actor.type === "companion" && foundry.utils.hasProperty(changes, "system.companion.rampage")) syncRampage(actor);
  });
  Hooks.on("combatTurnChange", (combat, previous) => {
    if (!isPrimaryGM()) return;
    const hero = combat.combatants.get(previous?.combatantId)?.actor;
    if (rampageFeature(hero)) offerFeralStrike(hero);
  });
  Hooks.on("preDeleteCombat", (combat) => {
    for (const c of combat.combatants) if (c.actor) _ending.add(c.actor.uuid);
  });
  Hooks.on("deleteCombat", async (combat) => {
    if (!isPrimaryGM()) return;
    for (const c of combat.combatants) {
      if (c.actor?.type === "companion" && rampageFeature(masterOf(c.actor))) await resetRampage(c.actor);
    }
    setTimeout(() => { for (const c of combat.combatants) if (c.actor) _ending.delete(c.actor.uuid); }, 5000);
  });
}
