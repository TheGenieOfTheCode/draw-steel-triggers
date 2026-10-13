import { MODULE_ID } from "../util.mjs";
import { abilityBanesOn } from "./line-effects.mjs";

Hooks.once("ready", () => {
  if (!game.modules.get("lib-wrapper")?.active || !CONFIG.Item.dataModels?.ability?.prototype?.getActorModifiers) return;
  libWrapper.register(MODULE_ID, "CONFIG.Item.dataModels.ability.prototype.getActorModifiers", function (wrapped, ...args) {
    const out = wrapped(...args);
    const banes = abilityBanesOn(this.actor ?? this.parent?.actor, this._dsid ?? this.parent?.system?._dsid);
    const modifiers = out ?? args[0]?.modifiers;
    if (banes && modifiers) modifiers.banes = (Number(modifiers.banes) || 0) + banes;
    return out;
  }, "WRAPPER");
});
