import { MODULE_ID } from "../util.mjs";
import { isMaliceAbility } from "../triggers/registry.mjs";
import { BASIC_MALICE, maliceKey } from "../triggers/malice.mjs";

const TARGET = "ds.applications.sheets.DrawSteelNPCSheet.prototype._prepareAbilitiesContext";

async function withMaliceSection(wrapped, ...args) {
  const context = await wrapped(...args);
  const malice = [];
  for (const section of Object.values(context)) {
    const keep = [];
    for (const entry of section.abilities ?? []) (isMaliceAbility(entry.item) ? malice : keep).push(entry);
    section.abilities = keep;
  }
  if (!malice.length) return context;
  const generic = (item) => !!item.getFlag(MODULE_ID, "basicMalice") || maliceKey(item) in BASIC_MALICE;
  const cost = (item) => Number(item.system?.resource) || 0;
  malice.sort((a, b) => cost(a.item) - cost(b.item) || generic(a.item) - generic(b.item));
  const out = {};
  const add = () => { out.malice = { label: game.i18n.localize("DS_TRIGGERS.Sheet.MaliceActions"), abilities: malice, showHeader: true, showAdd: false }; };
  for (const [key, section] of Object.entries(context)) {
    if (key === "villain" && !out.malice) add();
    if (this.isPlayMode && !section.abilities.length) continue;
    out[key] = section;
  }
  if (!out.malice) add();
  return out;
}

Hooks.once("setup", () => {
  if (!ds.applications?.sheets?.DrawSteelNPCSheet?.prototype?._prepareAbilitiesContext) return;
  if (game.modules.get("lib-wrapper")?.active) {
    libWrapper.register(MODULE_ID, TARGET, withMaliceSection, "WRAPPER");
    return;
  }
  const proto = ds.applications.sheets.DrawSteelNPCSheet.prototype;
  const original = proto._prepareAbilitiesContext;
  proto._prepareAbilitiesContext = function (...args) { return withMaliceSection.call(this, original.bind(this), ...args); };
});
