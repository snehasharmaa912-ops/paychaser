const DAY_MS = 86_400_000;
export const toISODate = (date) => date.toISOString().slice(0, 10);
export const addDays = (iso, days) =>
  toISODate(new Date(Date.parse(`${iso}T00:00:00Z`) + days * DAY_MS));
export const daysBetween = (fromIso, toIso) =>
  Math.round((Date.parse(`${toIso}T00:00:00Z`) - Date.parse(`${fromIso}T00:00:00Z`)) / DAY_MS);
