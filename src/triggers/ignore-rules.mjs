const _rules = new Map();

export function registerIgnoreRule(id, rule) {
  if (!id || typeof rule !== "function") throw new Error("registerIgnoreRule requires an id and a function (item) => boolean");
  _rules.set(String(id), rule);
  refreshIgnored();
}

export function unregisterIgnoreRule(id) {
  if (_rules.delete(String(id))) refreshIgnored();
}

export function ignoredByRule(item) {
  if (!item || !_rules.size) return false;
  for (const [id, rule] of _rules) {
    try {
      if (rule(item)) return true;
    } catch (err) {
      console.error(`DS Triggers | ignore rule "${id}" threw for ${item.uuid}`, err);
    }
  }
  return false;
}

export function refreshIgnored() {
  Hooks.callAll("dst.ignoredFeaturesChanged");
}
