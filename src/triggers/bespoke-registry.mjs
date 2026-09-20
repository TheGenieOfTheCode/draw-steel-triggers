

const HANDLERS = {};

export function registerBespokeUse(dsid, fn) {
  HANDLERS[dsid] = fn;
}

export const getBespokeUse = (dsid) => (dsid ? HANDLERS[dsid] ?? null : null);

export const hasBespokeUse = (dsid) => !!getBespokeUse(dsid);
