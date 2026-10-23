

const _providers = new Map();

export function registerRollModProvider(dsid, provider) {
  if (!dsid || typeof provider !== "function") throw new Error("registerRollModProvider requires a dsid and a function");
  _providers.set(dsid, provider);
}

export function unregisterRollModProvider(dsid) {
  _providers.delete(dsid);
}

export const rollModProviderFor = (dsid) => (dsid ? _providers.get(dsid) ?? null : null);
