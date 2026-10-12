const L = (k, data) => data
  ? game.i18n.format(`DS_TRIGGERS.Editor.Impact.${k}`, data)
  : game.i18n.localize(`DS_TRIGGERS.Editor.Impact.${k}`);

const E = (k, data) => data ? game.i18n.format(`DS_TRIGGERS.Editor.${k}`, data) : game.i18n.localize(`DS_TRIGGERS.Editor.${k}`);
const REDIRECT_KEYS = { self: "RedirectSelf", reflect: "RedirectReflect", chooser: "RedirectChooser", swap: "RedirectSwap", flanker: "RedirectFlanker", after: "RedirectAfter" };

const charLabel = (c) => game.i18n.localize(ds.CONFIG?.characteristics?.[c]?.label ?? c);
const charOptions = () => Object.keys(ds.CONFIG?.characteristics ?? {}).map((value) => ({ value, label: charLabel(value) }));
const opt = (value, label, current) => ({ value, label, selected: String(current ?? "") === String(value) });
const num = (v, min = 0) => Math.max(min, Math.floor(Number(v) || 0));

const TARGETING = new Set(["TARGETED_BY_STRIKE", "TARGETED_BY_ABILITY"]);
const PRE_ROLL_MODS = new Set([...TARGETING, "MAKES_STRIKE", "POWER_ROLL"]);
const held = (c) => c.event === "WOULD_TAKE_DAMAGE";

function rollModSummary(mod) {
  const parts = [];
  if (mod?.edges) parts.push(E(mod.edges === 2 ? "RollModDoubleEdge" : "RollModEdge"));
  if (mod?.banes) parts.push(E(mod.banes === 2 ? "RollModDoubleBane" : "RollModBane"));
  if (mod?.bonus) parts.push(E("RollModBonus", { n: `${mod.bonus > 0 ? "+" : ""}${mod.bonus}` }));
  if (mod?.tierShift) parts.push(E(mod.tierShift > 0 ? "RollModTierUp" : "RollModTierDown"));
  return parts.join(", ") || L("RollNothing");
}

const amountOf = (src) => src?.char ? charLabel(src.char) : String(src?.amount ?? 0);

export const IMPACTS = [
  {
    id: "hold", icon: "fa-solid fa-hand",
    keys: [],
    supports: (c) => c.event === "TAKES_DAMAGE" || held(c),
    has: held,
    add: (c) => { c.event = "WOULD_TAKE_DAMAGE"; },
    remove: (c) => {
      c.event = "TAKES_DAMAGE";
      for (const k of ["halfDamage", "damageReduction", "damageRedirect", "redirectRange", "redirectPool", "unreducible"]) delete c[k];
    },
    summary: () => L("hold.Summary"),
  },
  {
    id: "halfHeld", icon: "fa-solid fa-circle-half-stroke",
    keys: ["halfDamage"],
    supports: held,
    has: (c) => !!c.halfDamage,
    add: (c) => { c.halfDamage = true; },
    summary: () => L("halfHeld.Summary"),
  },
  {
    id: "reduceHeld", icon: "fa-solid fa-shield-halved",
    keys: ["damageReduction"],
    supports: held,
    has: (c) => c.damageReduction != null,
    add: (c) => { c.damageReduction = 1; },
    summary: (c) => {
      const r = c.damageReduction;
      if (r === "level") return L("reduceHeld.ByLevel");
      if (typeof r === "object") return L("reduceHeld.ByChar", { n: r.base ?? 0, char: charLabel(r.char) });
      return L("reduceHeld.ByN", { n: r });
    },
    fields: (c) => {
      const r = c.damageReduction;
      const mode = r === "level" ? "level" : typeof r === "object" ? "char" : "flat";
      return [
        { name: "mode", label: L("FieldBy"), type: "select", rerender: true, options: [
          opt("flat", L("reduceHeld.Flat"), mode), opt("level", L("reduceHeld.Level"), mode), opt("char", L("reduceHeld.Char"), mode)] },
        ...(mode === "level" ? [] : [{ name: "amount", label: L(mode === "char" ? "FieldBase" : "FieldAmount"), type: "number", value: typeof r === "object" ? r.base ?? 0 : r }]),
        ...(mode === "char" ? [{ name: "char", label: L("FieldChar"), type: "select", options: charOptions().map((o) => opt(o.value, o.label, r.char)) }] : []),
      ];
    },
    read: (c, v) => {
      if (v.mode === "level") c.damageReduction = "level";
      else if (v.mode === "char") c.damageReduction = { base: num(v.amount), char: v.char || Object.keys(ds.CONFIG?.characteristics ?? {})[0] };
      else c.damageReduction = num(v.amount);
    },
  },
  {
    id: "redirectHeld", icon: "fa-solid fa-people-arrows",
    keys: ["damageRedirect", "redirectRange", "redirectPool", "unreducible"],
    supports: held,
    has: (c) => !!c.damageRedirect,
    add: (c) => { c.damageRedirect = "director"; },
    summary: (c) => L(c.damageRedirect === "pool" ? "redirectHeld.Pool" : "redirectHeld.Director"),
    fields: (c) => [
      { name: "who", label: L("redirectHeld.Who"), type: "select", rerender: true, options: [
        opt("director", L("redirectHeld.Director"), c.damageRedirect), opt("pool", L("redirectHeld.Pool"), c.damageRedirect)] },
      ...(c.damageRedirect === "pool" ? [
        { name: "allies", label: L("redirectHeld.Allies"), type: "checkbox", checked: c.redirectPool === "selfOrAlly" },
        { name: "range", label: L("redirectHeld.Range"), hint: L("redirectHeld.RangeHint"), type: "number", value: c.redirectRange ?? 0 },
      ] : []),
      { name: "unreducible", label: L("redirectHeld.Unreducible"), type: "checkbox", checked: !!c.unreducible },
    ],
    read: (c, v) => {
      c.damageRedirect = v.who === "pool" ? "pool" : "director";
      if (c.damageRedirect === "pool") {
        if (v.allies) c.redirectPool = "selfOrAlly"; else delete c.redirectPool;
        if (num(v.range) > 0) c.redirectRange = num(v.range); else delete c.redirectRange;
      } else { delete c.redirectPool; delete c.redirectRange; }
      if (v.unreducible) c.unreducible = true; else delete c.unreducible;
    },
  },
  {
    id: "halfStrike", icon: "fa-solid fa-circle-half-stroke",
    keys: ["targetedHalf", "halfOnUse"],
    supports: (c) => TARGETING.has(c.event) || !!c.postRoll,
    has: (c) => !!(c.targetedHalf || c.halfOnUse),
    add: (c) => { c[c.postRoll ? "halfOnUse" : "targetedHalf"] = true; },
    summary: (c) => L(c.postRoll ? "halfStrike.After" : "halfStrike.Before"),
    normalize: (c) => {
      const want = c.postRoll ? "halfOnUse" : "targetedHalf";
      delete c[want === "halfOnUse" ? "targetedHalf" : "halfOnUse"];
      if (!c[want]) c[want] = true;
    },
  },
  {
    id: "rollMod", icon: "fa-solid fa-dice-d10",
    keys: ["rollMod"],
    supports: (c) => PRE_ROLL_MODS.has(c.event) || !!c.postRoll,
    has: (c) => !!c.rollMod,
    add: (c) => { c.rollMod = { banes: 1 }; },
    summary: (c) => rollModSummary(c.rollMod),
    fields: (c) => {
      const m = c.rollMod ?? {};
      const dice = m.edges ? `edges${m.edges}` : m.banes ? `banes${m.banes}` : "";
      return [
        { name: "dice", label: L("rollMod.Dice"), type: "select", options: [
          opt("", L("RollNothing"), dice), opt("edges1", E("RollModEdge"), dice), opt("edges2", E("RollModDoubleEdge"), dice),
          opt("banes1", E("RollModBane"), dice), opt("banes2", E("RollModDoubleBane"), dice)] },
        { name: "bonus", label: L("rollMod.Bonus"), type: "number", value: m.bonus ?? 0, min: -99 },
        { name: "tier", label: L("rollMod.Tier"), type: "select", options: [
          opt("0", L("RollNothing"), m.tierShift ?? 0), opt("1", E("RollModTierUp"), m.tierShift), opt("-1", E("RollModTierDown"), m.tierShift)] },
        { name: "perTarget", label: L("rollMod.PerTarget"), hint: L("rollMod.PerTargetHint"), type: "checkbox", checked: !!m.perTarget },
      ];
    },
    read: (c, v) => {
      const mod = {};
      const [, kind, n] = String(v.dice ?? "").match(/^(edges|banes)(\d)$/) ?? [];
      if (kind) mod[kind] = Number(n);
      const bonus = Math.trunc(Number(v.bonus) || 0);
      if (bonus) mod.bonus = bonus;
      if (Number(v.tier)) mod.tierShift = Math.sign(Number(v.tier));
      if (v.perTarget) mod.perTarget = true;
      c.rollMod = mod;
    },
  },
  {
    id: "redirect", icon: "fa-solid fa-arrows-turn-to-dots",
    keys: ["redirect", "reflectHalf", "redirectPool"],
    supports: (c) => TARGETING.has(c.event),
    has: (c) => !!c.redirect,
    add: (c) => { c.redirect = "self"; },
    summary: (c) => E(REDIRECT_KEYS[c.redirect] ?? "RedirectSelf"),
    fields: (c) => [
      { name: "mode", label: L("redirect.Mode"), type: "select", rerender: true,
        options: ["self", "reflect", "chooser", "swap", "flanker", "after"].map((m) => opt(m, E(REDIRECT_KEYS[m]), c.redirect)) },
      ...(c.redirect === "reflect" ? [{ name: "half", label: L("redirect.ReflectHalf"), type: "checkbox", checked: !!c.reflectHalf }] : []),
      ...(c.redirect === "chooser" ? [{ name: "allies", label: L("redirect.Allies"), type: "checkbox", checked: c.redirectPool === "selfOrAlly" }] : []),
    ],
    read: (c, v) => {
      c.redirect = v.mode || "self";
      if (c.redirect === "reflect" && v.half) c.reflectHalf = true; else delete c.reflectHalf;
      if (c.redirect === "chooser" && v.allies) c.redirectPool = "selfOrAlly"; else delete c.redirectPool;
    },
  },
  {
    id: "fmMod", icon: "fa-solid fa-arrows-up-down-left-right",
    keys: ["fmMod"],
    supports: (c) => c.event === "FORCE_MOVES" || c.event === "FORCE_MOVED",
    has: (c) => !!c.fmMod,
    add: (c) => { c.fmMod = { mode: "boost", amount: 1 }; },
    summary: (c) => L(`fmMod.${c.fmMod.mode}`, { n: amountOf(c.fmMod) }),
    fields: (c) => {
      const m = c.fmMod;
      const counted = ["boost", "reduce", "redirect", "objectDamage"].includes(m.mode);
      const from = m.char ? "char" : "amount";
      return [
        { name: "mode", label: L("fmMod.Mode"), type: "select", rerender: true,
          options: ["boost", "reduce", "redirect", "slide", "vertical", "objectDamage", "stability"].map((k) => opt(k, L(`fmMod.Mode_${k}`), m.mode)) },
        ...(counted ? [
          { name: "from", label: L("FieldBy"), type: "select", rerender: true, options: [opt("amount", L("FieldAmount"), from), opt("char", L("FieldChar"), from)] },
          from === "char"
            ? { name: "char", label: L("FieldChar"), type: "select", options: charOptions().map((o) => opt(o.value, o.label, m.char)) }
            : { name: "amount", label: L("FieldAmount"), type: "number", value: m.amount ?? 1 },
        ] : []),
      ];
    },
    read: (c, v) => {
      const mod = { mode: v.mode || "boost" };
      if (["boost", "reduce", "redirect", "objectDamage"].includes(mod.mode)) {
        if (v.from === "char") mod.char = v.char || c.fmMod?.char || Object.keys(ds.CONFIG?.characteristics ?? {})[0];
        else mod.amount = num(v.amount ?? c.fmMod?.amount ?? 1);
      }
      c.fmMod = mod;
    },
  },
  {
    id: "fallReduce", icon: "fa-solid fa-feather",
    keys: ["fallReduction"],
    supports: (c) => c.event === "FALL_START",
    has: (c) => c.fallReduction != null,
    add: (c) => { c.fallReduction = 1; },
    summary: (c) => c.fallReduction === "jump" ? L("fallReduce.Jump") : L("fallReduce.ByN", { n: c.fallReduction }),
    fields: (c) => [
      { name: "by", label: L("FieldBy"), type: "select", rerender: true, options: [
        opt("n", L("fallReduce.Squares"), c.fallReduction === "jump" ? "jump" : "n"), opt("jump", L("fallReduce.Jump"), c.fallReduction === "jump" ? "jump" : "n")] },
      ...(c.fallReduction === "jump" ? [] : [{ name: "amount", label: L("FieldAmount"), type: "number", value: c.fallReduction }]),
    ],
    read: (c, v) => { c.fallReduction = v.by === "jump" ? "jump" : num(v.amount ?? 1, 1); },
  },
  {
    id: "fallSafe", icon: "fa-solid fa-parachute-box",
    keys: ["fallSafe"],
    supports: (c) => c.event === "FALL_START",
    has: (c) => !!c.fallSafe,
    add: (c) => { c.fallSafe = true; },
    summary: () => L("fallSafe.Summary"),
  },
  {
    id: "fallCancel", icon: "fa-solid fa-hand-holding",
    keys: ["fallCancel"],
    supports: (c) => c.event === "FALL_START",
    has: (c) => !!c.fallCancel,
    add: (c) => { c.fallCancel = true; },
    summary: () => L("fallCancel.Summary"),
  },
  {
    id: "damageBonus", icon: "fa-solid fa-burst",
    keys: ["damageBonus"],
    supports: (c) => c.event === "DEALS_DAMAGE",
    has: (c) => c.damageBonus != null,
    add: (c) => { c.damageBonus = 1; },
    summary: (c) => L("damageBonus.Summary", { n: c.damageBonus }),
    fields: (c) => [{ name: "amount", label: L("FieldAmount"), type: "number", value: c.damageBonus }],
    read: (c, v) => { c.damageBonus = num(v.amount, 1); },
  },
  {
    id: "markVictim", icon: "fa-solid fa-ghost",
    keys: ["markVictim"],
    supports: (c) => c.event === "DEALS_DAMAGE",
    has: (c) => !!c.markVictim,
    add: (c) => { c.markVictim = "insubstantial"; },
    summary: (c) => L(`markVictim.${c.markVictim}`),
    fields: (c) => [{ name: "mark", label: L("markVictim.Mark"), type: "select", options: [opt("insubstantial", L("markVictim.insubstantial"), c.markVictim)] }],
    read: (c, v) => { c.markVictim = v.mark || "insubstantial"; },
  },
  {
    id: "turn", icon: "fa-solid fa-hourglass-half",
    keys: ["turnLock", "bonusTurn", "manualTurn", "squadTurn"],
    supports: (c) => c.event === "TURN_START" || c.event === "TURN_END",
    has: (c) => !!c.turnLock,
    add: (c) => { c.turnLock = true; },
    summary: (c) => [L("turn.Summary"), c.bonusTurn && L("turn.Bonus"), c.squadTurn && L("turn.Squad"), c.manualTurn && L("turn.Manual")].filter(Boolean).join(", "),
    fields: (c) => ["bonusTurn", "squadTurn", "manualTurn"].map((k) => ({ name: k, label: L(`turn.${k}`), type: "checkbox", checked: !!c[k] })),
    read: (c, v) => { for (const k of ["bonusTurn", "squadTurn", "manualTurn"]) { if (v[k]) c[k] = true; else delete c[k]; } },
  },
];

export const impactById = (id) => IMPACTS.find((i) => i.id === id);

export function removeImpact(impact, clause) {
  if (impact.remove) return impact.remove(clause);
  for (const k of impact.keys) delete clause[k];
}

export function moveImpact(impact, from, to) {
  for (const k of impact.keys) {
    if (from[k] !== undefined) to[k] = foundry.utils.deepClone(from[k]);
    delete from[k];
  }
}

export function pruneImpacts(clause) {
  for (const impact of IMPACTS) {
    if (!impact.has(clause)) continue;
    if (!impact.supports(clause)) removeImpact(impact, clause);
    else impact.normalize?.(clause);
  }
}

export const impactLabel = (impact) => L(`${impact.id}.Label`);
export const impactHint = (impact) => L(`${impact.id}.Hint`);
