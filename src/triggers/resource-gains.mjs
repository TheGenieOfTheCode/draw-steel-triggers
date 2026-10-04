import { MODULE_ID, getSetting, dbg, isPrimaryGM } from "../util.mjs";
import { isMaliceAbility } from "./registry.mjs";
import { footprintGap } from "./dispatch.mjs";

const RUI = "draw-steel-resources-ui";
const CT = "draw-steel-combat-tools";
const FLAG = "resourceGains";

let _rui = null;
const _busy = new Set();
const _turnHeroes = new Map();

export const gainsActive = () => !!_rui && game.modules.get(RUI)?.active && getSetting("resourceGains") !== "off";

const _token = (t) => t?.document ?? t ?? null;
const _near = (a, b, squares) => {
  a = _token(a); b = _token(b);
  if (!a || !b || a.parent !== b.parent) return false;
  return footprintGap(a, b) < squares * canvas.grid.distance;
};
const _ally = (actor, token, hero, heroToken) => {
  if (!actor) return false;
  if (actor === hero) return true;
  const a = _token(token), h = _token(heroToken);
  if (a && h) return a.disposition === h.disposition;
  return actor.type === "hero";
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

const _surged = (e) => Number(e.eventContext?.surgeSpend) > 0;

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

const RULES = {
  fury: {
    "damage-trigger": (e, hero) => e.event === "TAKES_DAMAGE" && e.subjectActor === hero,
    "winded-dying": (e, hero) => e.event === "WINDED_OR_DYING" && e.subjectActor === hero,
  },
  elementalist: {
    "damage-trigger": (e, hero, tok) => e.event === "TAKES_DAMAGE" && _typed(e)
      && (e.subjectActor === hero || _near(tok, e.subjectToken, 10)),
  },
  talent: {
    "force-move-trigger": (e) => e.event === "FORCE_MOVED",
  },
  null: {
    "malice-trigger": (e) => e.event === "USES_ABILITY" && isMaliceAbility(e.usedAbility),
  },
  shadow: {
    "surge-damage-trigger": (e, hero) => e.event === "DEALS_DAMAGE" && e.subjectActor === hero && _surged(e),
  },
  tactician: {
    "mark-damage-trigger": (e, hero, tok) => e.event === "DEALS_DAMAGE"
      && _ally(e.subjectActor, e.subjectToken, hero, tok) && markedBy(e.eventContext?.victimActor, hero),
    "ally-heroic-trigger": (e, hero, tok) => e.event === "USES_ABILITY" && e.subjectActor !== hero
      && e.usedAbility?.system?.category === "heroic"
      && _ally(e.subjectActor, e.subjectToken, hero, tok) && _near(tok, e.subjectToken, 10),
  },
  censor: {
    "judged-damages-you": (e, hero) => e.event === "TAKES_DAMAGE" && e.subjectActor === hero
      && judgedBy(e.eventContext?.dealerActor, hero),
    "damage-judged": (e, hero) => e.event === "DEALS_DAMAGE" && e.subjectActor === hero
      && judgedBy(e.eventContext?.victimActor, hero),
  },
  troubadour: {
    "three-heroes-trigger": (e) => e.threeHeroes === true,
    "winded-trigger": (e) => e.event === "WINDED_OR_DYING" && e.subjectActor?.type === "hero",
    "natural-19-20-trigger": (e, hero, tok) => e.event === "NATURAL_19_20" && _inLineOfEffect(tok, e.subjectToken),
    "hero-dies-trigger": (e) => _heroDied(e),
  },
};

const familyOf = (id) => String(id).replace(/-lv\d+$/, "");
const scopeKey = (scope) => (scope === "turn" ? "turn" : scope === "encounter" ? "encounter" : "round");
const _record = (combat) => combat?.getFlag(MODULE_ID, FLAG) ?? {};
const _recordKey = (actor, family) => `${actor.id}-${family}`;

function _ruiUsed(actor, trackKey) {
  let shared = false;
  try { shared = game.settings.get(RUI, "combatTracking") && game.settings.get(RUI, "sharedTracking"); } catch { shared = false; }
  if (shared) return (actor.getFlag(RUI, "usedEntries") ?? []).includes(trackKey);
  return !!_rui?.ResourceApp?._usedEntries?.[actor.id]?.has(trackKey);
}

function _spent(combat, actor, family, entry) {
  if (!entry.trackUsage) return false;
  const rec = _record(combat)[_recordKey(actor, family)];
  if (rec && (entry.trackUsage === "encounter" || rec.round === combat.round)) return true;
  return _ruiUsed(actor, `${scopeKey(entry.trackUsage)}:${entry.id}`);
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

function _liveEntry(actor, family) {
  const classDef = _rui.getClassDefinition(actor);
  if (!classDef) return null;
  const entries = _rui.resolveEntries(classDef.gains ?? [], _rui.getHeroLevel(actor));
  return entries.find((en) => en.id && familyOf(en.id) === family && !en.isDescriptionOnly && !en.isGroupHeader) ?? null;
}

function _classKey(actor) {
  const classDef = _rui.getClassDefinition(actor);
  if (!classDef) return null;
  return Object.entries(_rui.CLASS_DEFINITIONS).find(([, def]) => def === classDef)?.[0] ?? classDef.id ?? null;
}

async function _gain(combat, actor, family, entry) {
  const key = _recordKey(actor, family);
  if (_busy.has(key) || _spent(combat, actor, family, entry)) return;
  _busy.add(key);
  try {
    const before = Number(actor.system?.hero?.primary?.value ?? 0);
    const cardIds = [];
    const hook = Hooks.on("createChatMessage", (m) => {
      if (m.speaker?.actor === actor.id && (m.content ?? "").includes("dsresources-chat-card")) cardIds.push(m.id);
    });
    try { await _rui.ResourceApp.executeGainHeroic(actor, entry.id); }
    finally { Hooks.off("createChatMessage", hook); }
    const amount = Number(actor.system?.hero?.primary?.value ?? 0) - before;
    dbg(`resource gain: ${actor.name} ${entry.id} +${amount}`);
    if (!entry.trackUsage) return;
    await combat.update({
      [`flags.${MODULE_ID}.${FLAG}.${key}`]: {
        actorId: actor.id, gainId: entry.id, trackKey: `${scopeKey(entry.trackUsage)}:${entry.id}`, amount, round: combat.round, cardIds,
      },
    });
  } catch (err) {
    console.warn(`${MODULE_ID} | resource gain ${entry.id} for ${actor.name} failed`, err);
  } finally {
    _busy.delete(key);
  }
}

export function noteGainEvent(e) {
  if (!gainsActive() || !isPrimaryGM()) return;
  const combat = game.combat;
  if (!combat?.started) return;
  e = { ...e, eventContext: e.eventContext ?? {} };
  e.threeHeroes = _threeHeroes(e);
  for (const { actor, token } of _heroes(combat)) {
    const rules = RULES[_classKey(actor)];
    if (!rules) continue;
    for (const [family, test] of Object.entries(rules)) {
      let hit = false;
      try { hit = test(e, actor, token); } catch (err) { dbg(`resource gain rule ${family} threw`, err); }
      if (!hit) continue;
      const entry = _liveEntry(actor, family);
      if (entry) _gain(combat, actor, family, entry);
    }
  }
}

export function ownsResourceGain(actorId, trackKey) {
  return Object.values(_record(game.combat)).some((rec) => rec.actorId === actorId && rec.trackKey === trackKey);
}

async function _afterUndo(trackKey) {
  const combat = game.combat;
  if (!combat || !trackKey) return;
  for (const [key, rec] of Object.entries(_record(combat))) {
    if (rec.trackKey !== trackKey) continue;
    const actor = game.actors.get(rec.actorId);
    if (!actor || _ruiUsed(actor, trackKey)) continue;
    const value = Number(actor.system?.hero?.primary?.value ?? 0);
    await actor.update({ "system.hero.primary.value": Math.max(0, value - Number(rec.amount || 0)) }, { dsblQuiet: true });
    
    const cards = (rec.cardIds ?? []).filter((id) => game.messages.has(id));
    if (cards.length) await ChatMessage.deleteDocuments(cards);
    await combat.update({ [`flags.${MODULE_ID}.${FLAG}.${key}`]: new foundry.data.operators.ForcedDeletion() });
    dbg(`resource gain undone: ${actor.name} ${rec.gainId} -${rec.amount}`);
  }
}

function _wrapUndo(ResourceApp) {
  const patch = (actions) => {
    const original = actions?.undoUsage;
    if (typeof original !== "function" || original._dstWrapped) return;
    const wrapped = async function (event, target) {
      const trackKey = target?.dataset?.trackKey;
      await original.call(this, event, target);
      if (game.user.isGM) await _afterUndo(trackKey);
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
    if (typeof app.ResourceApp?.executeGainHeroic !== "function") throw new Error("ResourceApp.executeGainHeroic is missing");
    _rui = { ResourceApp: app.ResourceApp, ...logic, CLASS_DEFINITIONS: data.CLASS_DEFINITIONS };
    _wrapUndo(app.ResourceApp);
  } catch (err) {
    _rui = null;
    console.warn(`${MODULE_ID} | Draw Steel - Resources UI could not be read, so heroic resource gains stay manual`, err);
  }
});

let _socket = null;
Hooks.once("socketlib.ready", () => {
  _socket = socketlib.registerModule(MODULE_ID);
  _socket?.register("resourceGainUndo", (trackKey) => _afterUndo(trackKey));
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
