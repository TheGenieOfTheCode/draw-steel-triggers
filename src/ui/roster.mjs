import { getTriggeredAbilities, isMaliceAbility } from "../triggers/registry.mjs";
import { snoozeFor } from "./snooze.mjs";

const COMPANION = "draw-steel-companion.companion";

const _isCompanionOrRetainer = (actor) => actor?.type === "retainer" || actor?.type === COMPANION;

const _mentorOf = (actor) => actor?.system?.retainer?.mentor ?? null;

function _cost(actor, item) {
  const resource = item.system?.resource;
  if (!Number.isFinite(resource) || resource <= 0) return null;
  const malice = actor?.type !== "hero" && actor?.type !== "character";
  return {
    malice,
    label: malice
      ? game.i18n.format("DS_TRIGGERS.Queue.CostMalice", { n: resource })
      : `${resource} ${actor?.system?.coreResource?.name ?? ""}`.trim(),
  };
}

function _row(actor, entry) {
  const item = entry.item;
  const dsid = item.system?._dsid ?? item.dsid ?? null;
  const snooze = snoozeFor(actor, dsid);
  const resource = item.system?.resource;
  return {
    costBadge: _cost(actor, item),
    cost: Number.isFinite(resource) ? resource : 0,
    uuid: item.uuid,
    dsid,
    name: item.name,
    trigger: item.system?.trigger ?? "",
    free: !!entry.free,
    snoozed: !!snooze,
    snoozeLabel: snooze?.label ?? "",
    actorUuid: actor.uuid,
  };
}

const _byName = (a, b) => a.name.localeCompare(b.name);

const _byCost = (a, b) => (a.cost - b.cost) || a.name.localeCompare(b.name);

function _split(actor) {
  const own = [];
  const malice = [];
  for (const entry of getTriggeredAbilities(actor) ?? []) {
    (isMaliceAbility(entry.item) ? malice : own).push(_row(actor, entry));
  }
  return { own: own.sort(_byName), malice };
}

function _group(actor, abilities) {
  return {
    actorUuid: actor.uuid,
    name: actor.name,
    img: actor.img,
    abilities,
    snoozedCount: abilities.filter((a) => a.snoozed).length,
  };
}

function _combatActors() {
  const combat = game.combat;
  if (!combat?.started) return { monsters: [], heroes: [] };

  const monsters = new Map();
  const heroes = new Map();
  for (const combatant of combat.combatants) {
    const actor = combatant.actor;
    if (!actor) continue;
    const bucket = actor.hasPlayerOwner ? heroes : monsters;
    if (!bucket.has(actor.id)) bucket.set(actor.id, actor);
  }

  
  for (const actor of game.actors) {
    if (!_isCompanionOrRetainer(actor) || heroes.has(actor.id) || monsters.has(actor.id)) continue;
    if (_mentorOf(actor) && heroes.has(_mentorOf(actor).id)) heroes.set(actor.id, actor);
  }

  return { monsters: [...monsters.values()], heroes: [...heroes.values()] };
}

function _playerActors() {
  const own = game.user.character;
  if (!own) return [];
  const out = [own];
  for (const actor of game.actors) {
    if (!_isCompanionOrRetainer(actor)) continue;
    if (_mentorOf(actor)?.id === own.id) out.push(actor);
  }
  return out;
}

export function buildRoster() {
  const L = (k) => game.i18n.localize(`DS_TRIGGERS.Queue.${k}`);
  const sections = [];
  const maliceRows = new Map();

  const collect = (actors) => actors.map((actor) => {
    const { own, malice } = _split(actor);
    
    for (const row of malice) if (!maliceRows.has(row.name)) maliceRows.set(row.name, row);
    return own.length ? _group(actor, own) : null;
  }).filter(Boolean);

  if (game.user.isGM) {
    const { monsters, heroes } = _combatActors();
    const monsterGroups = collect(monsters);
    const heroGroups = collect(heroes);

    if (monsterGroups.length) sections.push({ id: "monsters", label: L("SectionMonsters"), groups: monsterGroups, collapsed: false });
    if (maliceRows.size) {
      sections.push({
        id: "malice",
        label: L("SectionMalice"),
        flat: [...maliceRows.values()].sort(_byCost),
        collapsed: false,
      });
    }
    if (heroGroups.length) sections.push({ id: "heroes", label: L("SectionHeroes"), groups: heroGroups, collapsed: true, divided: true });
  } else {
    const groups = collect(_playerActors());
    if (groups.length) sections.push({ id: "mine", label: L("SectionMine"), groups, collapsed: false });
    if (maliceRows.size) {
      sections.push({ id: "malice", label: L("SectionMalice"), flat: [...maliceRows.values()].sort(_byCost), collapsed: false });
    }
  }

  const count = sections.reduce((n, s) =>
    n + (s.flat?.length ?? 0) + (s.groups ?? []).reduce((m, g) => m + g.abilities.length, 0), 0);

  return { sections, any: sections.length > 0, isGM: game.user.isGM, count };
}
