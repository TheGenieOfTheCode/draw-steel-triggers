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
const POTENCY_ON_POST = new Set(["DEALS_DAMAGE", "USES_ABILITY", "RESISTS_POTENCY"]);
const held = (c) => c.event === "WOULD_TAKE_DAMAGE";

function rollModSummary(mod) {
  const parts = [];
  if (mod?.edges) parts.push(E(mod.edges === 2 ? "RollModDoubleEdge" : "RollModEdge"));
  if (mod?.banes) parts.push(E(mod.banes === 2 ? "RollModDoubleBane" : "RollModBane"));
  if (mod?.bonus) parts.push(E("RollModBonus", { n: `${mod.bonus > 0 ? "+" : ""}${mod.bonus}` }));
  if (mod?.tierShift) parts.push(E(mod.tierShift > 0 ? "RollModTierUp" : "RollModTierDown"));
  if (mod?.negateBane) parts.push(E("RollModNegateBane"));
  return parts.join(", ") || L("RollNothing");
}

const isDiceBonus = (b) => typeof b === "string" && /\d*d\d/i.test(b);
const monsterKeywordLabel = (k) => game.i18n.localize(ds.CONFIG.monsters?.keywords?.[k]?.label ?? k);

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
      for (const k of ["halfDamage", "damageReduction", "damageRedirect", "redirectRange", "redirectPool", "unreducible", "potencyMod"]) delete c[k];
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
    id: "potencyMod", icon: "fa-solid fa-scale-unbalanced",
    keys: ["potencyMod"],
    supports: (c) => held(c) || TARGETING.has(c.event) || POTENCY_ON_POST.has(c.event),
    has: (c) => !!c.potencyMod,
    add: (c) => { c.potencyMod = { amount: -1, scope: "one" }; },
    summary: (c) => {
      const m = c.potencyMod;
      const n = m.char
        ? `${m.amount < 0 ? "-" : "+"}${Math.abs(m.amount) === 1 ? "" : `${Math.abs(m.amount)} x `}${charLabel(m.char)}`
        : `${m.amount > 0 ? "+" : ""}${m.amount}`;
      return L(m.scope === "all" ? "potencyMod.SummaryAll" : "potencyMod.SummaryOne", { n }) + (m.spend ? L("potencyMod.SpendSuffix") : "");
    },
    fields: (c) => [
      { name: "amount", label: L("FieldAmount"), type: "number", value: c.potencyMod.amount ?? -1, min: -9 },
      { name: "char", label: L("FieldChar"), hint: L("potencyMod.CharHint"), type: "select", options: [
        opt("", L("potencyMod.CharNone"), c.potencyMod.char ?? ""), ...charOptions().map((o) => opt(o.value, o.label, c.potencyMod.char))] },
      { name: "scope", label: L("potencyMod.Scope"), type: "select", options: [
        opt("one", L("potencyMod.One"), c.potencyMod.scope), opt("all", L("potencyMod.All"), c.potencyMod.scope)] },
      { name: "spend", label: L("potencyMod.Spend"), hint: L("potencyMod.SpendHint"), type: "checkbox", checked: !!c.potencyMod.spend },
    ],
    read: (c, v) => {
      const amount = Math.trunc(Number(v.amount) || 0) || -1;
      c.potencyMod = { amount, ...(v.char ? { char: v.char } : {}), scope: v.scope === "all" ? "all" : "one", ...(v.spend ? { spend: true } : {}) };
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
      const dice = m.negateBane ? "negate" : m.edges ? `edges${m.edges}` : m.banes ? `banes${m.banes}` : "";
      return [
        { name: "dice", label: L("rollMod.Dice"), type: "select", options: [
          opt("", L("RollNothing"), dice), opt("edges1", E("RollModEdge"), dice), opt("edges2", E("RollModDoubleEdge"), dice),
          opt("banes1", E("RollModBane"), dice), opt("banes2", E("RollModDoubleBane"), dice), opt("negate", E("RollModNegateBane"), dice)] },
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
      if (v.dice === "negate") mod.negateBane = true;
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
      const counted = ["boost", "reduce", "adjust", "redirect", "objectDamage"].includes(m.mode);
      const from = m.char ? "char" : "amount";
      return [
        { name: "mode", label: L("fmMod.Mode"), type: "select", rerender: true,
          options: ["boost", "reduce", "adjust", "redirect", "slide", "pull", "vertical", "objectDamage", "stability"].map((k) => opt(k, L(`fmMod.Mode_${k}`), m.mode)) },
        ...(counted ? [
          { name: "from", label: L("FieldBy"), type: "select", rerender: true, options: [opt("amount", L("FieldAmount"), from), opt("char", L("FieldChar"), from)] },
          from === "char"
            ? { name: "char", label: L("FieldChar"), type: "select", options: charOptions().map((o) => opt(o.value, o.label, m.char)) }
            : { name: "amount", label: L("FieldAmount"), type: "number", value: m.amount ?? 1 },
          ...(m.mode === "boost" || m.mode === "reduce" ? [{ name: "perSurge", label: L("fmMod.PerSurge"), hint: L("fmMod.PerSurgeHint"), type: "number", value: m.perSurge ?? 0 }] : []),
        ] : []),
      ];
    },
    read: (c, v) => {
      const mod = { mode: v.mode || "boost" };
      if (["boost", "reduce", "adjust", "redirect", "objectDamage"].includes(mod.mode)) {
        if (v.from === "char") mod.char = v.char || c.fmMod?.char || Object.keys(ds.CONFIG?.characteristics ?? {})[0];
        else mod.amount = num(v.amount ?? c.fmMod?.amount ?? 1);
      }
      const perSurge = num(v.perSurge ?? c.fmMod?.perSurge ?? 0);
      if ((mod.mode === "boost" || mod.mode === "reduce") && perSurge > 0) mod.perSurge = perSurge;
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
    id: "fallAdjust", icon: "fa-solid fa-arrows-up-down",
    keys: ["fallAdjust"],
    supports: (c) => c.event === "FALL_START",
    has: (c) => !!c.fallAdjust,
    add: (c) => { c.fallAdjust = { amount: 1 }; },
    summary: (c) => L("fallAdjust.Summary", { n: amountOf(c.fallAdjust) }),
    fields: (c) => {
      const from = c.fallAdjust.char ? "char" : "amount";
      return [
        { name: "from", label: L("FieldBy"), type: "select", rerender: true, options: [opt("amount", L("FieldAmount"), from), opt("char", L("FieldChar"), from)] },
        from === "char"
          ? { name: "char", label: L("FieldChar"), type: "select", options: charOptions().map((o) => opt(o.value, o.label, c.fallAdjust.char)) }
          : { name: "amount", label: L("FieldAmount"), type: "number", value: c.fallAdjust.amount ?? 1 },
      ];
    },
    read: (c, v) => {
      c.fallAdjust = v.from === "char"
        ? { char: v.char || c.fallAdjust?.char || Object.keys(ds.CONFIG?.characteristics ?? {})[0] }
        : { amount: num(v.amount ?? c.fallAdjust?.amount ?? 1, 1) };
    },
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
    keys: ["damageBonus", "damageBonusType", "damageBonusVs"],
    supports: (c) => ["DEALS_DAMAGE", "MAKES_STRIKE", "USES_ABILITY"].includes(c.event),
    has: (c) => c.damageBonus != null,
    add: (c) => { c.damageBonus = 1; },
    summary: (c) => {
      const n = c.damageBonus === "highest" ? L("damageBonus.Highest") : isDiceBonus(c.damageBonus) ? c.damageBonus
        : typeof c.damageBonus === "string" ? charLabel(c.damageBonus) : c.damageBonus;
      const type = c.damageBonusType ? ` ${game.i18n.localize(ds.CONFIG.damageTypes?.[c.damageBonusType]?.label ?? c.damageBonusType)}` : "";
      const vs = c.damageBonusVs?.keyword ? L("damageBonus.Vs", { n: c.damageBonusVs.amount, keyword: monsterKeywordLabel(c.damageBonusVs.keyword) }) : "";
      return L(c.optional ? "damageBonus.SummaryOptional" : "damageBonus.Summary", { n: `${n}${type}` }) + vs;
    },
    fields: (c) => {
      const b = c.damageBonus;
      const from = b === "highest" ? "highest" : isDiceBonus(b) ? "dice" : typeof b === "string" ? "char" : "amount";
      return [
        { name: "from", label: L("FieldBy"), type: "select", rerender: true,
          options: [opt("amount", L("FieldAmount"), from), opt("dice", L("damageBonus.Dice"), from), opt("highest", L("damageBonus.Highest"), from), opt("char", L("FieldChar"), from)] },
        ...(from === "amount" ? [{ name: "amount", label: L("FieldAmount"), type: "number", value: Number(b) || 1 }]
          : from === "dice" ? [{ name: "dice", label: L("damageBonus.Dice"), type: "text", value: b }]
          : from === "char" ? [{ name: "char", label: L("FieldChar"), type: "select", options: charOptions().map((o) => opt(o.value, o.label, b)) }] : []),
        { name: "type", label: L("damageBonus.Type"), hint: L("damageBonus.TypeHint"), type: "select",
          options: [opt("", L("damageBonus.SameType"), c.damageBonusType ?? ""), ...Object.entries(ds.CONFIG.damageTypes ?? {}).map(([k, v]) => opt(k, game.i18n.localize(v.label ?? k), c.damageBonusType))] },
        { name: "vsKeyword", label: L("damageBonus.VsKeyword"), hint: L("damageBonus.VsHint"), type: "select", rerender: true,
          options: [opt("", L("damageBonus.VsNone"), c.damageBonusVs?.keyword ?? ""), ...Object.keys(ds.CONFIG.monsters?.keywords ?? {}).map((k) => opt(k, monsterKeywordLabel(k), c.damageBonusVs?.keyword))] },
        ...(c.damageBonusVs?.keyword ? [{ name: "vsAmount", label: L("damageBonus.VsAmount"), type: "number", value: c.damageBonusVs.amount ?? 1 }] : []),
        { name: "optional", label: L("damageBonus.Optional"), hint: L("damageBonus.OptionalHint"), type: "checkbox", checked: !!c.optional },
      ];
    },
    read: (c, v) => {
      c.damageBonus = v.from === "highest" ? "highest" : v.from === "char" ? (v.char || charOptions()[0]?.value || "might")
        : v.from === "dice" ? (isDiceBonus(String(v.dice ?? "").trim()) ? String(v.dice).trim() : "1d6") : num(v.amount, 1);
      if (v.type) c.damageBonusType = v.type; else delete c.damageBonusType;
      if (v.vsKeyword) c.damageBonusVs = { keyword: v.vsKeyword, amount: num(v.vsAmount ?? c.damageBonusVs?.amount ?? 1, 1) };
      else delete c.damageBonusVs;
      if (v.optional) c.optional = true; else delete c.optional;
    },
  },
  {
    id: "damageType", icon: "fa-solid fa-fire",
    keys: ["damageTypeChange"],
    supports: (c) => c.event === "DEALS_DAMAGE",
    has: (c) => !!c.damageTypeChange,
    add: (c) => { c.damageTypeChange = "fire"; },
    summary: (c) => L("damageType.Summary", { type: ds.CONFIG.damageTypes?.[c.damageTypeChange]?.label ?? c.damageTypeChange }),
    fields: (c) => [{ name: "type", label: L("damageType.Type"), type: "select",
      options: "acid|cold|corruption|fire|holy|lightning|poison|psychic|sonic".split("|").map((t) => opt(t, ds.CONFIG.damageTypes?.[t]?.label ?? t, c.damageTypeChange)) }],
    read: (c, v) => { c.damageTypeChange = v.type || "fire"; },
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
    id: "markDealer", icon: "fa-solid fa-crosshairs",
    keys: ["markDealer"],
    supports: (c) => c.event === "TAKES_DAMAGE",
    has: (c) => !!c.markDealer,
    add: (c) => { c.markDealer = { effect: "" }; },
    summary: (c) => L("markDealer.Summary", { effect: c.markDealer.effect || "?" }),
    fields: (c) => [{ name: "effect", label: L("markDealer.Effect"), type: "text", value: c.markDealer.effect ?? "" }],
    read: (c, v) => { c.markDealer = { ...c.markDealer, effect: String(v.effect ?? "").trim() }; },
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
