import { MODULE_ID, getSetting, dbg, isPrimaryGM } from "../util.mjs";
import { isMaliceAbility } from "./registry.mjs";
import { footprintGap, scopeMatches, usedAbilityMatches } from "./dispatch.mjs";
import { featureGainLines, lineAutomated } from "../parser/feature-lines.mjs";
import { enqueuePromptEntries, getQueueMirror } from "./queue.mjs";

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

const GATES = {
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
  if (!item || !resource || !["feature", "subclass"].includes(item.type)) return [];
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

export function heroGainLines(actor) {
  const resource = resourceName(actor);
  if (!resource) return [];
  const bases = [];
  const upgrades = [];
  const seen = new Set();
  for (const item of actor.items) {
    for (const line of itemGainLines(item, resource)) {
      if (line.kind !== "trigger" && line.kind !== "upgrade") continue;
      if (seen.has(line.key)) continue;
      seen.add(line.key);
      const entry = { item, line: effectiveLine(item, line) };
      (line.kind === "upgrade" ? upgrades : bases).push(entry);
    }
  }
  for (const up of upgrades) {
    const base = bases.find((b) => b.line.kind === "trigger" && _sig(b.line) === _sig(up.line));
    if (!base) { bases.push(up); continue; }
    if (_size(up.line.amount) > _size(base.line.amount)) {
      base.line = { ...base.line, amount: up.line.amount, upgradedBy: up.item.name };
    }
  }
  return bases;
}

function _lineMatches(line, e, hero, heroToken) {
  const ctx = e.eventContext;
  return (line.parse?.clauses ?? []).some((clause) => {
    if (clause.event !== e.event) return false;
    if (e.event === "TAKES_DAMAGE" && ctx.dealerOnly && !line.gates.includes("dealerJudged")) return false;
    const subjectToken = _token(e.subjectToken);
    if (!scopeMatches(clause, hero, _token(heroToken)?.disposition ?? null, e.subjectActor, subjectToken?.disposition ?? null)) return false;
    if (Number.isFinite(clause.range) && clause.range > 0 && e.subjectActor && e.subjectActor !== hero
      && !_near(heroToken, subjectToken, clause.range)) return false;
    if (clause.damageTypes?.length && !clause.damageTypes.includes(ctx.damageType)) return false;
    if (e.event === "USES_ABILITY" && !usedAbilityMatches(clause, e.usedAbility, hero, ctx)) return false;
    return line.gates.every((id) => GATES[id]?.(e, hero, heroToken) ?? false);
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

function _ruiTrackKey(actor, line) {
  if (!_rui || !getSetting("resourcesUiSync")) return null;
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

function _cardHTML({ actor, resource, total, previous, current, line, item, rollHTML }) {
  const source = line.upgradedBy ? `${item.name}, ${line.upgradedBy}` : item.name;
  return `<div class="dst-gain-card">
    <div class="dst-gain-head">${L("Gained", { name: actor.name, amount: `<strong>${total}</strong>`, resource })}</div>
    <div class="dst-gain-method"><em>${line.sentence}</em> <span class="dst-gain-source">(${source})</span></div>
    ${rollHTML ?? ""}
    <div class="dst-gain-foot">
      <span class="dst-gain-summary">${resource}: ${previous} → ${current}</span>
      <button type="button" class="dst-gain-undo" data-tooltip="${L("UndoTooltip")}"><i class="fa-solid fa-rotate-left"></i> ${L("Undo")}</button>
    </div>
  </div>`;
}

async function _gain(combat, actor, item, line) {
  const once = !!line.once;
  const key = once ? _recordKey(actor, line) : `${_recordKey(actor, line)}-${foundry.utils.randomID(6)}`;
  const trackKey = _ruiTrackKey(actor, line);
  if (_busy.has(key) || _spent(combat, actor, line, trackKey)) return;
  _busy.add(key);
  try {
    const roll = await new Roll(String(line.amount), actor.getRollData()).evaluate();
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
    await ChatMessage.create({
      _id: cardId,
      speaker: ChatMessage.getSpeaker({ actor }),
      content: _cardHTML({ actor, resource, total, previous, current, line, item, rollHTML: dice ? await roll.render() : null }),
      ...(dice ? { rolls: [roll] } : {}),
      flags: { [MODULE_ID]: { resourceGain: { actorId: actor.id, record: key, amount: total, previous, current, method: line.sentence } } },
    }, { keepId: true });
    dbg(`resource gain: ${actor.name} ${line.key} +${total}`);
  } catch (err) {
    console.warn(`${MODULE_ID} | resource gain ${line.key} for ${actor.name} failed`, err);
  } finally {
    _busy.delete(key);
  }
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
  for (const { actor, token } of _heroes(combat)) {
    for (const { item, line } of heroGainLines(actor)) {
      if (!line.enabled || !line.automated) continue;
      let hit = false;
      try { hit = _lineMatches(line, e, actor, token); } catch (err) { dbg(`resource gain line ${line.key} threw`, err); }
      if (!hit) continue;
      if (getSetting("resourceGains") === "stack") _offer(combat, actor, item, line, e);
      else _gain(combat, actor, item, line);
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
    _causeLabel: L("StackCause", { amount: line.amount, resource, line: line.sentence }),
    _gain: { line: line.key, record },
  }], { event: e.event, causeLabel: e.causeLabel ?? "" });
}

export async function resolveStackGain(entry, outcome) {
  const combat = game.combat;
  const actor = fromUuidSync(entry.ownerActorUuid);
  if (!combat?.started || !actor) return;
  const found = heroGainLines(actor).find((x) => x.line.key === entry.gain.line);
  if (!found) return;
  if (outcome === "used") return _gain(combat, actor, found.item, found.line);
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
      else await _socket?.executeAsGM("resourceGainUndo", trackKey);
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

let _socket = null;
Hooks.once("socketlib.ready", () => {
  _socket = socketlib.registerModule(MODULE_ID);
  _socket?.register("resourceGainUndo", (trackKey) => _afterRuiUndo(trackKey));
  _socket?.register("resourceGainUndoRecord", (recordKey) => undoGain(recordKey));
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
  return _socket?.executeAsGM("resourceGainUndoRecord", record);
}

Hooks.on("renderChatMessageHTML", (message, html) => {
  if (!message.getFlag(MODULE_ID, "resourceGain")) return;
  const button = html.querySelector(".dst-gain-undo");
  if (!button) return;
  if (!canUndoResourceGain(message)) { button.remove(); return; }
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
  const rolls = [...(message.rolls ?? []), ...(message.system?.parts?.contents ?? []).flatMap((p) => p?.rolls ?? [])];
  const natural = rolls.some((r) => r instanceof PowerRoll && Number(r.dice?.[0]?.total) >= 19);
  if (!natural) return;
  const tokenId = message.speaker?.token;
  const token = tokenId ? canvas.scene?.tokens?.get(tokenId) ?? null : null;
  const actor = token?.actor ?? (message.speaker?.actor ? game.actors.get(message.speaker.actor) : null);
  if (!actor) return;
  noteGainEvent({ event: "NATURAL_19_20", subjectActor: actor, subjectToken: token ?? actor.getActiveTokens(true, true)[0] ?? null });
});

Hooks.on("dsct.forcedMovement", (ctx) => {
  if (!(Number(ctx?.moved) > 0)) return;
  const token = _token(ctx.target);
  noteGainEvent({ event: "FORCE_MOVED", subjectActor: token?.actor ?? null, subjectToken: token });
});
