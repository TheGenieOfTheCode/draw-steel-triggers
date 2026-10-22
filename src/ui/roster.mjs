import { getTriggeredAbilities, isMaliceAbility, triggerEffectText } from "../triggers/registry.mjs";
import { candidateEntries } from "../triggers/dispatch.mjs";
import { sourceOf, isDerived } from "../triggers/derived.mjs";
import { snoozeFor, actorSnoozeFor } from "./snooze.mjs";
import { heroGainLines, gainsActive, gainSnoozeId, lineText } from "../triggers/resource-gains.mjs";
import { MODULE_ID } from "../util.mjs";

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

const _plain = (s) => String(s ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().toLowerCase();

function _effectOf(item) {
  if (item.featureLine?.effect) return item.featureLine.effect;
  try { return triggerEffectText(item); } catch { return ""; }
}

const SPENT_LABELS = { round: "UsedThisRound", encounter: "UsedThisEncounter", turn: "UsedThisTurn" };

function _row(actor, entry) {
  const item = entry.item;
  const dsid = item.system?._dsid ?? item.dsid ?? null;
  const snooze = snoozeFor(actor, dsid);
  const resource = item.system?.resource;
  const trigger = item.system?.trigger ?? "";
  return {
    costBadge: _cost(actor, item),
    cost: Number.isFinite(resource) ? resource : 0,
    uuid: item.uuid,
    openUuid: (isDerived(item) ? sourceOf(item) : null)?.uuid ?? item.uuid,
    dsid,
    name: item.name,
    trigger,
    free: !!entry.free,
    noEmbed: !!entry.featureLine,
    snoozed: !!snooze,
    snoozeLabel: snooze?.label ?? "",
    spentLabel: SPENT_LABELS[entry.spentOnce] ? game.i18n.localize(`DS_TRIGGERS.Queue.${SPENT_LABELS[entry.spentOnce]}`) : "",
    actorUuid: actor.uuid,
    searchName: `${item.name} ${actor.name}`.toLowerCase(),
    searchTrigger: _plain(trigger),
    searchEffect: _plain(_effectOf(item)),
  };
}

const _byName = (a, b) => a.name.localeCompare(b.name);

const _byCost = (a, b) => (a.cost - b.cost) || a.name.localeCompare(b.name);

function _split(actor) {
  const own = [];
  const malice = [];
  for (const entry of getTriggeredAbilities(actor, { includeSpent: true }) ?? []) {
    (isMaliceAbility(entry.item) ? malice : own).push(_row(actor, entry));
  }
  return { own: own.sort(_byName), malice };
}

function _group(actor, abilities) {
  const whole = actorSnoozeFor(actor);
  return {
    actorUuid: actor.uuid,
    name: actor.name,
    img: actor.img,
    abilities,
    snoozedCount: abilities.filter((a) => a.snoozed).length,
    actorSnoozed: !!whole,
    actorSnoozeLabel: whole?.label ?? "",
  };
}

function _checkedActors() {
  const monsters = new Map();
  const heroes = new Map();
  const defeated = CONFIG.specialStatusEffects?.DEFEATED ?? "dead";
  const combat = game.combat;
  for (const { actor } of candidateEntries()) {
    if (!actor || actor.statuses?.has(defeated)) continue;
    if (combat?.combatants.some((c) => c.actor === actor && c.isDefeated)) continue;
    const bucket = actor.hasPlayerOwner ? heroes : monsters;
    if (!bucket.has(actor.uuid)) bucket.set(actor.uuid, actor);
  }

  
  const heroIds = new Set([...heroes.values()].map((a) => a.id));
  for (const actor of game.actors) {
    if (!_isCompanionOrRetainer(actor) || heroes.has(actor.uuid) || monsters.has(actor.uuid)) continue;
    if (_mentorOf(actor) && heroIds.has(_mentorOf(actor).id)) heroes.set(actor.uuid, actor);
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

function _gainGroup(actor) {
  const rows = heroGainLines(actor)
    .filter(({ line }) => line.enabled && line.automated)
    .map(({ item, line }) => {
      const dsid = gainSnoozeId(line);
      const snooze = snoozeFor(actor, dsid);
      return {
        costBadge: { malice: false, label: `+${line.amount}` },
        cost: 0, uuid: item.uuid, openUuid: item.uuid, dsid, name: line.name, trigger: lineText(line), free: false, noEmbed: true,
        snoozed: !!snooze, snoozeLabel: snooze?.label ?? "", actorUuid: actor.uuid,
        searchName: `${line.name} ${actor.name}`.toLowerCase(), searchTrigger: _plain(lineText(line)), searchEffect: "",
      };
    })
    .sort(_byName);
  return rows.length ? _group(actor, rows) : null;
}

const _showGains = () => gainsActive() && game.settings.get(MODULE_ID, "rosterGains");

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
    const { monsters, heroes } = _checkedActors();
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
    const gainGroups = _showGains() ? heroes.filter((a) => a.type === "hero").map(_gainGroup).filter(Boolean) : [];
    if (gainGroups.length) sections.push({ id: "gains", label: L("SectionGains"), groups: gainGroups, collapsed: true, divided: true });
  } else {
    const groups = collect(_playerActors());
    if (groups.length) sections.push({ id: "mine", label: L("SectionMine"), groups, collapsed: false });
    const gainGroups = _showGains() ? _playerActors().filter((a) => a.type === "hero").map(_gainGroup).filter(Boolean) : [];
    if (gainGroups.length) sections.push({ id: "gains", label: L("SectionGains"), groups: gainGroups, collapsed: false });
    if (maliceRows.size) {
      sections.push({ id: "malice", label: L("SectionMalice"), flat: [...maliceRows.values()].sort(_byCost), collapsed: false });
    }
  }

  const count = sections.reduce((n, s) =>
    n + (s.flat?.length ?? 0) + (s.groups ?? []).reduce((m, g) => m + g.abilities.length, 0), 0);

  return { sections, any: sections.length > 0, isGM: game.user.isGM, count };
}
