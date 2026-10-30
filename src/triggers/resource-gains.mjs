import { MODULE_ID, getSetting, dbg, isPrimaryGM, executeAsDirector } from "../util.mjs";
import { isMaliceAbility } from "./registry.mjs";
import { ignoredByRule } from "./ignore-rules.mjs";
import { eventHits, footprintGap, scopeMatches, usedAbilityMatches, isMinionActor, damageOutcomeMatches, organizationMatches } from "./dispatch.mjs";
import { featureGainLines, lineAutomated } from "../parser/feature-lines.mjs";
import { DAMAGE_MODIFYING } from "../parser/trigger-parser.mjs";
import { enqueuePromptEntries, getQueueMirror } from "./queue.mjs";
import { isTriggerSnoozed } from "../ui/snooze.mjs";
import { cardContent, postSystemCard, speakerFor, withFaces } from "../ui/system-card.mjs";
import { tip, tipAttrs } from "../ui/tips.mjs";

const RUI = "draw-steel-resources-ui";
const CT = "draw-steel-combat-tools";
const FLAG = "resourceGains";
const LINES_FLAG = "gainLines";

let _rui = null;
const _busy = new Set();
const _turnHeroes = new Map();
const _lineCache = new Map();
const _offered = new Map();

export const gainsActive = () => getSetting("resourceGains") !== "off";

export const gainSnoozeId = (line) => `gain:${line.key}`;

export function lineText(line) {
  const text = String(line.sentence ?? "").replace(/^additionally,\s*/i, "");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

const _token = (t) => t?.document ?? t ?? null;
const _near = (a, b, squares) => {
  a = _token(a); b = _token(b);
  if (!a || !b || a.parent !== b.parent) return false;
  return footprintGap(a, b) < squares * canvas.grid.distance;
};

const _origin = (effect) => {
  try { return effect.origin ? fromUuidSync(effect.origin)?.actor ?? null : null; } catch { return null; }
};

const _taggedBy = (target, hero, ctKey, systemName) => {
  if (!target || !hero) return false;
  if (game.modules.get(CT)?.active) return target.effects.some((e) => e.flags?.[CT]?.[ctKey]?.actorId === hero.id);
  return target.effects.some((e) => e.name === systemName && _origin(e) === hero);
};
const judgedBy = (target, hero) => _taggedBy(target, hero, "judgement", "Judgement");
const markedBy = (target, hero) => _taggedBy(target, hero, "mark", "Mark");

const _typed = (e) => {
  const type = e.eventContext?.damageType;
  return typeof type === "string" && !["", "untyped", "holy"].includes(type);
};

const _threeHeroes = (e) => {
  const combat = game.combat;
  if (e.event !== "USES_ABILITY" || e.subjectActor?.type !== "hero" || !combat) return false;
  const key = `${combat.id}:${combat.round}:${combat.turn}`;
  if (!_turnHeroes.has(key)) { _turnHeroes.clear(); _turnHeroes.set(key, new Set()); }
  const heroes = _turnHeroes.get(key);
  heroes.add(e.subjectActor.id);
  return heroes.size >= 3;
};

const _heroDied = (e) => {
  if (e.event !== "STAMINA_BELOW" || e.subjectActor?.type !== "hero") return false;
  const line = -Number(e.subjectActor.system?.stamina?.winded ?? 0);
  const { prevValue, curValue } = e.eventContext ?? {};
  return prevValue > line && curValue <= line;
};

const _inLineOfEffect = (heroToken, otherToken) => {
  const a = _token(heroToken)?.object, b = _token(otherToken)?.object;
  if (!a || !b) return false;
  if (a === b) return true;
  return !!game.modules.get("draw-steel-ctlib")?.api?.hasSightToToken?.(a, b);
};

const squadVictim = (actor) => isMinionActor(actor) && game.combat?.combatants.find((c) => c.actor === actor)?.group?.type === "squad";

let _turnKey = "";
const _turnDamage = new Map();
const _turnTypedDamage = new Map();
function _noteTurnDamage(e) {
  const ctx = e.eventContext;
  if (e.event !== "TAKES_DAMAGE" || !e.subjectActor || (ctx.dealerOnly && !squadVictim(e.subjectActor))) return;
  const combat = game.combat;
  const key = `${combat.id}:${combat.round}:${combat.turn}`;
  if (key !== _turnKey) { _turnKey = key; _turnDamage.clear(); _turnTypedDamage.clear(); }
  const who = _token(e.subjectToken)?.uuid ?? e.subjectActor.uuid;
  const amount = Number(ctx.damageAmount ?? e.triggerDamage) || 0;
  const add = (totals) => {
    const before = totals.get(who) ?? 0;
    totals.set(who, before + amount);
    return { before, after: before + amount };
  };
  e.turnDamage = add(_turnDamage);
  if (_typed(e)) e.turnTypedDamage = add(_turnTypedDamage);
}

const _overLevel = (e, hero, line) => {
  const limit = (line?.turnDamageBase ?? 5) + (Number(hero.system?.level) || 1);
  const typed = (line?.parse?.clauses ?? []).some((c) => c.damageTypes?.length);
  const total = typed ? e.turnTypedDamage : e.turnDamage;
  return !!total && total.before <= limit && total.after > limit;
};

const _nullField = (hero) => hero.items.find((i) => i.type === "ability" && i.system?._dsid === "null-field") ?? null;
const _inNullField = (hero, heroToken, otherToken) => {
  const field = _nullField(hero);
  if (!field || Number(hero.system?.stamina?.value ?? 1) <= 0) return false;
  return _near(heroToken, otherToken, Number.parseInt(field.system?.distance?.primary) || 1);
};

const _spentRx = () => {
  const parts = game.i18n.localize("DRAW_STEEL.Item.ability.ConfigureUse.SpentFlavor").split(/(\{value\}|\{name\})/);
  const rx = parts.map((p) => (p === "{value}" ? "\\d+" : p === "{name}" ? ".+" : p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  return new RegExp(`^${rx.join("")}$`, "i");
};

function _maliceDamage(e) {
  const { ability, dealerActor, dealerMessage } = e.eventContext;
  if (!dealerActor || dealerActor.type === "hero") return false;
  const sys = ability?.system ?? {};
  if (ability && (sys.category === "villain" || isMaliceAbility(ability) || Number(sys.resource) > 0)) return true;
  return !!dealerMessage?.flavor && _spentRx().test(dealerMessage.flavor.trim());
}

const _valuesOf = (c) => c?.contents ?? (c instanceof Map ? [...c.values()] : Object.values(c ?? {}));
const DEFENSIVE = /\bbanes?\b|\bhalve[sd]?\b|\bhalf (?:the )?damage\b|\breduc\w*\b[^.]*\bdamage\b|\bdamage\b[^.]*\breduc\w*/i;
function defensiveTriggered(ability) {
  if (!ability) return false;
  const sys = ability.system ?? {};
  if (DAMAGE_MODIFYING.has(sys._dsid)) return true;
  const texts = [sys.description?.value];
  for (const section of _valuesOf(sys.effects)) texts.push(section?.description);
  for (const effect of _valuesOf(sys.power?.effects)) {
    for (const n of [1, 2, 3]) texts.push(effect?.[effect.type]?.[`tier${n}`]?.display);
  }
  return texts.some((t) => DEFENSIVE.test(String(t ?? "").replace(/<[^>]+>/g, " ")));
}

const GATES = {
  turnDamageOverLevel: (e, hero, tok, line) => _overLevel(e, hero, line),
  inNullField: (e, hero, tok) => _inNullField(hero, tok, e.subjectToken),
  maliceDamage: (e) => _maliceDamage(e),
  unwillingFall: (e, hero, tok, line) => e.eventContext.willing !== true && Number(e.eventContext.fallHeight) >= (line.fallMin ?? 5),
  lastRecovery: (e) => Number(e.subjectActor?.system?.recoveries?.value) === 0,
  dealerJudged: (e, hero) => judgedBy(e.eventContext.dealerActor, hero),
  victimJudged: (e, hero) => judgedBy(e.eventContext.victimActor, hero),
  victimMarked: (e, hero) => markedBy(e.eventContext.victimActor, hero),
  typedDamage: (e) => _typed(e),
  surged: (e) => Number(e.eventContext.surgeSpend) > 0,
  threeSurges: (e) => Number(e.eventContext.surgeSpend) >= 3,
  maliceAbility: (e) => isMaliceAbility(e.usedAbility),
  lineOfEffect: (e, hero, tok) => _inLineOfEffect(tok, e.subjectToken),
  threeHeroes: (e) => e.threeHeroes === true,
  heroDeath: (e) => _heroDied(e),
};

const classItem = (actor) => actor?.items?.find((i) => i.type === "class") ?? null;
export const resourceName = (actor) => classItem(actor)?.system?.primary ?? null;

export function itemGainLines(item, resource = resourceName(item?.actor)) {
  if (!item || !resource || !["feature", "subclass"].includes(item.type) || ignoredByRule(item)) return [];
  const html = item.system?.description?.value ?? "";
  const cached = _lineCache.get(item.uuid);
  if (cached && cached.html === html && cached.resource === resource) return cached.lines;
  const lines = featureGainLines(html, { resource, dsid: item.system?._dsid ?? "" });
  _lineCache.set(item.uuid, { html, resource, lines });
  return lines;
}

export function effectiveLine(item, line) {
  const saved = item.getFlag(MODULE_ID, LINES_FLAG)?.[line.key] ?? {};
  const out = { ...line, enabled: saved.enabled ?? !line.optional };
  if (saved.amount) out.amount = String(saved.amount);
  if (Array.isArray(saved.clauses) && saved.clauses.length) out.parse = { clauses: saved.clauses, confidence: "high", source: "manual" };
  if (Array.isArray(saved.gates)) out.gates = saved.gates;
  if (saved.once !== undefined) out.once = saved.once;
  if (line.kind === "bonus" && saved.bonusTarget) { out.bonusTarget = saved.bonusTarget; out.manual = []; }
  const bookName = `DS_TRIGGERS.Gain.Names.${line.key}`;
  out.name = saved.name || (game.i18n.has(bookName) ? game.i18n.localize(bookName) : line.kind === "upgrade" ? item.name : null);
  out.automated = lineAutomated({ ...out, manual: out.parse?.source === "manual" ? [] : out.manual });
  return out;
}

const _sig = (line) => {
  const c = line.parse?.clauses?.[0] ?? {};
  return [c.event, c.scope, line.once, c.range ?? "", [...line.gates].sort().join(","), (c.damageTypes ?? []).join(",")].join("|");
};
const _size = (amount) => {
  const m = String(amount).match(/^(\d+)d(\d+)(?:\+(\d+))?$/);
  return m ? Number(m[1]) * (Number(m[2]) + 1) / 2 + Number(m[3] ?? 0) : Number(amount) || 0;
};

export function namedGainLines(actor) {
  const resource = resourceName(actor);
  if (!resource) return [];
  const out = [];
  const seen = new Set();
  let n = 0;
  for (const item of actor.items) {
    for (const line of itemGainLines(item, resource)) {
      if (!["trigger", "upgrade", "bonus"].includes(line.kind)) continue;
      if (seen.has(line.key)) continue;
      seen.add(line.key);
      const effective = effectiveLine(item, line);
      effective.name ??= L("NameFallback", { resource, n: ++n });
      out.push({ item, line: effective });
    }
  }
  return out;
}

const _fromDomain = (actor, item) => item.type === "subclass"
  || actor.items.get(item.getFlag("draw-steel", "advancement")?.parentId)?.type === "subclass";

const _plus = (a, b) => (/^\d+$/.test(a) && /^\d+$/.test(b) ? String(Number(a) + Number(b)) : `${a}+${b}`);

function _addBonuses(actor, bases, bonuses) {
  for (const { item, line } of bonuses) {
    if (!line.enabled || !line.automated) continue;
    for (const base of bases) {
      const hit = line.bonusFor === "domain" ? _fromDomain(actor, base.item) : base.line.key === line.bonusTarget;
      if (!hit) continue;
      base.line = { ...base.line, amount: _plus(base.line.amount, line.amount), baseAmount: base.line.baseAmount ?? base.line.amount,
        bonuses: [...(base.line.bonuses ?? []), { amount: line.amount, name: item.name }] };
    }
  }
}

export function heroGainLines(actor) {
  const bases = [];
  const upgrades = [];
  const bonuses = [];
  for (const entry of namedGainLines(actor)) {
    const kind = entry.line.kind;
    (kind === "upgrade" ? upgrades : kind === "bonus" ? bonuses : bases).push(entry);
  }
  for (const up of upgrades) {
    const base = bases.find((b) => b.line.kind === "trigger" && _sig(b.line) === _sig(up.line));
    if (!base) { bases.push(up); continue; }
    if (_size(up.line.amount) > _size(base.line.amount)) {
      base.line = { ...base.line, amount: up.line.amount, upgradedBy: up.item.name };
    }
  }
  _addBonuses(actor, bases, bonuses);
  return bases;
}

function _lineMatches(line, e, hero, heroToken) {
  const ctx = e.eventContext;
  return (line.parse?.clauses ?? []).some((clause) => {
    if (!eventHits(clause.event, e.event)) return false;
    if (e.event === "TAKES_DAMAGE" && ctx.dealerOnly && !line.gates.includes("dealerJudged") && !squadVictim(e.subjectActor)) return false;
    const subjectToken = _token(e.subjectToken);
    if (!scopeMatches(clause, hero, _token(heroToken)?.disposition ?? null, e.subjectActor, subjectToken?.disposition ?? null)) return false;
    if (Number.isFinite(clause.range) && clause.range > 0 && e.subjectActor && e.subjectActor !== hero
      && !_near(heroToken, subjectToken, clause.range)) return false;
    if (clause.damageTypes?.length && !clause.damageTypes.includes(ctx.damageType)) return false;
    if (clause.conditions?.length && !clause.conditions.includes(ctx.condition)) return false;
    if (clause.tierFilter?.length && !(ctx.tiers ?? []).some((t) => clause.tierFilter.includes(t))) return false;
    if (clause.damageOutcome?.length && !damageOutcomeMatches(clause.damageOutcome, ctx)) return false;
    if (!organizationMatches(clause, e.subjectActor)) return false;
    if (e.event === "USES_ABILITY" && !usedAbilityMatches(clause, e.usedAbility, hero, { ...ctx, usedTargets: e.usedTargets ?? [], userToken: subjectToken })) return false;
    if (clause.defensiveTriggered && !defensiveTriggered(e.usedAbility)) return false;
    return line.gates.every((id) => GATES[id]?.(e, hero, heroToken, line) ?? false);
  });
}

const scopeKey = (scope) => (scope === "turn" ? "turn" : scope === "encounter" ? "encounter" : "round");
const _record = (combat) => combat?.getFlag(MODULE_ID, FLAG) ?? {};
const _recordKey = (actor, line) => `${actor.id}-${line.key}`;

function _ruiStore(actor) {
  let shared = false;
  try { shared = game.settings.get(RUI, "combatTracking") && game.settings.get(RUI, "sharedTracking"); } catch { shared = false; }
  if (shared) return { shared: true, keys: actor.getFlag(RUI, "usedEntries") ?? [] };
  const app = _rui?.ResourceApp;
  if (!app) return { shared: false, set: new Set() };
  app._usedEntries ??= {};
  app._usedEntries[actor.id] ??= new Set();
  return { shared: false, set: app._usedEntries[actor.id] };
}

function _ruiUsed(actor, trackKey) {
  if (!_rui || !trackKey) return false;
  const store = _ruiStore(actor);
  return store.shared ? store.keys.includes(trackKey) : store.set.has(trackKey);
}

async function _ruiMark(actor, trackKey, used) {
  if (!_rui || !trackKey) return;
  const store = _ruiStore(actor);
  if (store.shared) {
    const keys = used ? [...new Set([...store.keys, trackKey])] : store.keys.filter((k) => k !== trackKey);
    await actor.setFlag(RUI, "usedEntries", keys);
  } else if (used) store.set.add(trackKey);
  else store.set.delete(trackKey);
  if (_rui.ResourceApp._instance?.rendered) _rui.ResourceApp._instance.render(false);
}

const _words = (s) => String(s ?? "").toLowerCase().replace(/<[^>]+>/g, " ").replace(/[^a-z0-9]+/g, " ").trim();

const _ruiTracking = () => { try { return !!game.settings.get(RUI, "combatTracking"); } catch { return false; } };

function _ruiTrackKey(actor, line) {
  if (!_rui || !getSetting("resourcesUiSync") || !_ruiTracking()) return null;
  try {
    const classDef = _rui.getClassDefinition(actor);
    if (!classDef) return null;
    const want = _words(line.trigger);
    if (!want) return null;
    const entries = _rui.resolveEntries(classDef.gains ?? [], _rui.getHeroLevel(actor));
    const entry = entries.find((en) => en.id && !en.isGroupHeader && _words(en.description).includes(want));
    return entry ? `${scopeKey(entry.trackUsage)}:${entry.id}` : null;
  } catch { return null; }
}

function _spent(combat, actor, line, trackKey) {
  if (line.once) {
    const rec = _record(combat)[_recordKey(actor, line)];
    if (rec && (line.once === "encounter" || rec.round === combat.round)) return true;
  }
  return !!(line.once && _ruiUsed(actor, trackKey));
}

const L = (key, data) => (data ? game.i18n.format(`DS_TRIGGERS.Gain.${key}`, data) : game.i18n.localize(`DS_TRIGGERS.Gain.${key}`));

function _cardContent({ actor, resource, total, previous, current, line }) {
  const esc = foundry.utils.escapeHTML;
  const gained = `${withFaces(L("Gained", { name: actor.name, amount: total, resource }), [actor])} <span class="dst-gain-change">(${previous} → ${current})</span>`;
  const upgraded = (line.upgradedBy ? `<p class="dst-gain-upgraded">${esc(L("Upgraded", { amount: line.baseAmount ?? total, name: line.upgradedBy }))}</p>` : "")
    + (line.bonuses ?? []).map((b) => `<p class="dst-gain-upgraded">${esc(L("Bonus", { amount: b.amount, name: b.name }))}</p>`).join("");
  return cardContent({
    intro: gained,
    body: `<h5 class="dst-gain-title">${esc(line.name)}</h5>
      <p class="dst-gain-rule">${esc(cap(lineText(line)))}</p>${upgraded}`,
    buttons: `<button type="button" class="dst-gain-undo" ${tipAttrs(tip("GainUndo", { title: L("Undo"), body: L("UndoTooltip") }))}><i class="fa-solid fa-rotate-left" inert></i> ${L("Undo")}</button>`,
  });
}

const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : "");

async function _gain(combat, actor, item, line) {
  const once = !!line.once;
  const key = once ? _recordKey(actor, line) : `${_recordKey(actor, line)}-${foundry.utils.randomID(6)}`;
  const trackKey = _ruiTrackKey(actor, line);
  if (_busy.has(key) || _spent(combat, actor, line, trackKey)) return;
  _busy.add(key);
  try {
    const roll = await new ds.rolls.DSRoll(String(line.amount), actor.getRollData()).evaluate();
    const total = Number(roll.total) || 0;
    const previous = Number(actor.system?.hero?.primary?.value ?? 0);
    const current = previous + total;
    await actor.update({ "system.hero.primary.value": current });
    if (once) await _ruiMark(actor, trackKey, true);
    const resource = resourceName(actor);
    const dice = roll.dice.length > 0;
    
    const cardId = foundry.utils.randomID();
    await combat.update({
      [`flags.${MODULE_ID}.${FLAG}.${key}`]: {
        actorId: actor.id, line: line.key, itemId: item.id, trackKey, amount: total, round: combat.round, cardIds: [cardId],
      },
    });
    const title = game.i18n.format("DRAW_STEEL.EDITOR.Enrichers.Gain.MessageTitle.Default", { type: resource, targets: "" }).trim();
    await postSystemCard({
      id: cardId,
      title,
      speaker: { ...ChatMessage.getSpeaker({ actor }), ...speakerFor("Gain") },
      content: _cardContent({ actor, resource, total, previous, current, line }),
      parts: [{ type: "roll", flavor: title, rolls: [roll] }, { type: "content" }],
      ...(dice ? { rolls: [roll] } : {}),
      flags: { [MODULE_ID]: { resourceGain: { actorId: actor.id, record: key, amount: total, previous, current, method: lineText(line) } } },
    });
    dbg(`resource gain: ${actor.name} ${line.key} +${total}`);
  } catch (err) {
    console.warn(`${MODULE_ID} | resource gain ${line.key} for ${actor.name} failed`, err);
  } finally {
    _busy.delete(key);
  }
}


const _queues = new Map();
function _inTurn(actor, fn) {
  const next = (_queues.get(actor.id) ?? Promise.resolve()).then(fn, fn);
  _queues.set(actor.id, next.catch(() => {}));
  return next;
}

function _heroes(combat) {
  const seen = new Set();
  const out = [];
  for (const c of combat.combatants) {
    const actor = c.actor;
    if (actor?.type !== "hero" || seen.has(actor.id)) continue;
    seen.add(actor.id);
    out.push({ actor, token: c.token ?? actor.getActiveTokens(true, true)[0] ?? null });
  }
  return out;
}

export function noteGainEvent(e) {
  if (!gainsActive() || !isPrimaryGM()) return;
  const combat = game.combat;
  if (!combat?.started) return;
  e = { ...e, eventContext: e.eventContext ?? {} };
  e.threeHeroes = _threeHeroes(e);
  _noteTurnDamage(e);
  const defeated = CONFIG.specialStatusEffects?.DEFEATED ?? "dead";
  for (const { actor, token } of _heroes(combat)) {
    
    if (actor.statuses?.has(defeated) && String(resourceName(actor) ?? "").toLowerCase() !== "drama") continue;
    for (const { item, line } of heroGainLines(actor)) {
      if (!line.enabled || !line.automated) continue;
      if (isTriggerSnoozed(actor, gainSnoozeId(line))) continue;
      let hit = false;
      try { hit = _lineMatches(line, e, actor, token); } catch (err) { dbg(`resource gain line ${line.key} threw`, err); }
      if (!hit) continue;
      if (getSetting("resourceGains") === "stack") _offer(combat, actor, item, line, e);
      else _inTurn(actor, () => _gain(combat, actor, item, line));
    }
  }
}

function _offer(combat, actor, item, line, e) {
  const record = _recordKey(actor, line);
  if (_spent(combat, actor, line, _ruiTrackKey(actor, line))) return;
  if (line.once && (Date.now() - (_offered.get(record) ?? 0) < 3000
    || getQueueMirror().some((q) => q.state === "pending" && q.gain?.record === record))) return;
  _offered.set(record, Date.now());
  const resource = resourceName(actor);
  enqueuePromptEntries([{
    actor, item,
    _itemName: line.name,
    _causeLabel: L("StackCause", { amount: line.amount, resource, line: lineText(line) }),
    _gain: { line: line.key, record },
  }], { event: e.event, causeLabel: e.causeLabel ?? "" });
}

export async function resolveStackGain(entry, outcome) {
  const combat = game.combat;
  const actor = fromUuidSync(entry.ownerActorUuid);
  if (!combat?.started || !actor) return;
  const found = heroGainLines(actor).find((x) => x.line.key === entry.gain.line);
  if (!found) return;
  if (outcome === "used") return _inTurn(actor, () => _gain(combat, actor, found.item, found.line));
  if (!found.line.once) return;
  await combat.update({ [`flags.${MODULE_ID}.${FLAG}.${entry.gain.record}`]: {
    actorId: actor.id, line: found.line.key, declined: true, amount: 0, round: combat.round, cardIds: [],
  } });
}

export function ownsResourceGain(actorId, trackKey) {
  return Object.values(_record(game.combat)).some((rec) => rec.actorId === actorId && rec.trackKey === trackKey);
}

export async function undoGain(recordKey) {
  const combat = game.combat;
  const rec = _record(combat)[recordKey];
  if (!rec) return false;
  const actor = game.actors.get(rec.actorId);
  if (actor) {
    const value = Number(actor.system?.hero?.primary?.value ?? 0);
    await actor.update({ "system.hero.primary.value": value - Number(rec.amount || 0) }, { dsblQuiet: true });
    if (rec.trackKey && _ruiUsed(actor, rec.trackKey)) await _ruiMark(actor, rec.trackKey, false);
  }
  const cards = (rec.cardIds ?? []).filter((id) => game.messages.has(id));
  await combat.update({ [`flags.${MODULE_ID}.${FLAG}.${recordKey}`]: new foundry.data.operators.ForcedDeletion() });
  if (cards.length) await ChatMessage.deleteDocuments(cards);
  dbg(`resource gain undone: ${actor?.name} ${rec.line} -${rec.amount}`);
  return true;
}

async function _afterRuiUndo(trackKey) {
  const combat = game.combat;
  if (!combat || !trackKey) return;
  for (const [key, rec] of Object.entries(_record(combat))) {
    if (rec.trackKey !== trackKey) continue;
    const actor = game.actors.get(rec.actorId);
    if (!actor || _ruiUsed(actor, trackKey)) continue;
    await undoGain(key);
  }
}

function _wrapUndo(ResourceApp) {
  const patch = (actions) => {
    const original = actions?.undoUsage;
    if (typeof original !== "function" || original._dstWrapped) return;
    const wrapped = async function (event, target) {
      const trackKey = target?.dataset?.trackKey;
      await original.call(this, event, target);
      if (game.user.isGM) await _afterRuiUndo(trackKey);
      else await executeAsDirector(_socket, "resourceGainUndo", trackKey);
    };
    wrapped._dstWrapped = true;
    actions.undoUsage = wrapped;
  };
  patch(ResourceApp.DEFAULT_OPTIONS?.actions);
  patch(ResourceApp._instance?.options?.actions);
}

Hooks.once("ready", async () => {
  if (!game.modules.get(RUI)?.active) return;
  try {
    const [app, logic, data] = await Promise.all([
      import(`/modules/${RUI}/src/resources/resource-app.mjs`),
      import(`/modules/${RUI}/src/resources/resource-logic.mjs`),
      import(`/modules/${RUI}/src/resources/resource-data.mjs`),
    ]);
    _rui = { ResourceApp: app.ResourceApp, ...logic, CLASS_DEFINITIONS: data.CLASS_DEFINITIONS };
    _wrapUndo(app.ResourceApp);
  } catch (err) {
    _rui = null;
    console.warn(`${MODULE_ID} | Draw Steel - Resources UI could not be read, so gains made here are not marked used there`, err);
  }
});

async function _clearUnreachedMarks(combat, prefixes) {
  if (!_rui || !isPrimaryGM() || !getSetting("resourcesUiSync") || !_ruiTracking()) return;
  try { if (!game.settings.get(RUI, "sharedTracking")) return; } catch { return; }
  const reached = new Set(_rui.getAllHeroActors?.() ?? []);
  for (const { actor } of _heroes(combat)) {
    if (reached.has(actor)) continue;
    const keys = actor.getFlag(RUI, "usedEntries") ?? [];
    const keep = prefixes ? keys.filter((k) => !prefixes.some((p) => k.startsWith(p))) : [];
    if (keep.length === keys.length) continue;
    if (keep.length) await actor.setFlag(RUI, "usedEntries", keep);
    else await actor.unsetFlag(RUI, "usedEntries");
  }
}

Hooks.on("updateCombat", (combat, changes) => {
  const prefixes = changes.round !== undefined ? ["turn:", "round:"] : changes.turn !== undefined ? ["turn:"] : null;
  if (prefixes) _clearUnreachedMarks(combat, prefixes).catch((err) => console.warn(`${MODULE_ID} | Resources UI marks could not be cleared`, err));
});
Hooks.on("deleteCombat", (combat) => {
  _clearUnreachedMarks(combat, null).catch((err) => console.warn(`${MODULE_ID} | Resources UI marks could not be cleared`, err));
});

let _socket = null;
Hooks.once("socketlib.ready", () => {
  _socket = socketlib.registerModule(MODULE_ID);
  _socket?.register("resourceGainUndo", (trackKey) => _afterRuiUndo(trackKey));
  _socket?.register("resourceGainUndoRecord", (recordKey) => undoGain(recordKey));
  _socket?.register("resourceGainFall", (fall) => _noteFall(fall));
});

export function canUndoResourceGain(message) {
  const gain = message?.flags?.[MODULE_ID]?.resourceGain;
  if (!gain || !_record(game.combat)[gain.record]) return false;
  return game.user.isGM || !!game.actors.get(gain.actorId)?.isOwner;
}

export async function undoResourceGain(message) {
  if (!canUndoResourceGain(message)) return false;
  const { record } = message.flags[MODULE_ID].resourceGain;
  if (isPrimaryGM()) return undoGain(record);
  return executeAsDirector(_socket, "resourceGainUndoRecord", record);
}

Hooks.on("renderChatMessageHTML", (message, html) => {
  if (!message.getFlag(MODULE_ID, "resourceGain")) return;
  const button = html.querySelector(".dst-gain-undo");
  if (!button) return;
  if (!canUndoResourceGain(message)) {
    const footer = button.closest(".dst-card-buttons");
    button.remove();
    if (footer && !footer.children.length) footer.remove();
    return;
  }
  button.addEventListener("click", async (event) => {
    event.preventDefault();
    button.disabled = true;
    await undoResourceGain(message);
  });
});

Hooks.on("createChatMessage", (message) => {
  if (!gainsActive() || !isPrimaryGM() || !game.combat?.started) return;
  const PowerRoll = globalThis.ds?.rolls?.PowerRoll;
  if (!PowerRoll) return;
  const rolls = [...(message.rolls ?? []), ...(message.system?.parts?.contents ?? []).flatMap((p) => p?.rolls ?? [])]
    .filter((r) => r instanceof PowerRoll);
  if (!rolls.length) return;
  const tokenId = message.speaker?.token;
  const token = tokenId ? canvas.scene?.tokens?.get(tokenId) ?? null : null;
  const actor = token?.actor ?? (message.speaker?.actor ? game.actors.get(message.speaker.actor) : null);
  if (!actor) return;
  const subjectToken = token ?? actor.getActiveTokens(true, true)[0] ?? null;
  const tiers = [...new Set(rolls.map((r) => Number(r.product)).filter((t) => t >= 1 && t <= 3))];
  if (tiers.length) noteGainEvent({ event: "POWER_ROLL_RESULT", subjectActor: actor, subjectToken, eventContext: { tiers } });
  if (rolls.some((r) => Number(r.dice?.[0]?.total) >= 19)) noteGainEvent({ event: "NATURAL_19_20", subjectActor: actor, subjectToken });
  if (rolls.some((r) => Number(r.dice?.[0]?.total) === 2)) noteGainEvent({ event: "NATURAL_2", subjectActor: actor, subjectToken });
});

function _noteFall({ tokenUuid, height, willing }) {
  const token = fromUuidSync(tokenUuid);
  if (token?.actor) noteGainEvent({ event: "FALL_START", subjectActor: token.actor, subjectToken: token, eventContext: { fallHeight: height, willing } });
}

Hooks.on("dsct.preFall", (ctx) => {
  const token = ctx.token?.document ?? ctx.token;
  if (!gainsActive() || token?.actor?.type !== "hero") return;
  setTimeout(async () => {
    const mods = await Promise.all(ctx.holds ?? []);
    if (ctx.cancel || mods.some((m) => m?.cancel)) return;
    const reduced = [ctx, ...mods].reduce((n, m) => n + (Number(m?.reduction) || 0), 0);
    const fall = { tokenUuid: token.uuid, height: Number(ctx.height) - reduced, willing: ctx.willing === true };
    if (isPrimaryGM()) _noteFall(fall);
    else executeAsDirector(_socket, "resourceGainFall", fall);
  }, 0);
});
