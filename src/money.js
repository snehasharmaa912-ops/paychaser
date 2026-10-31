export const toCents = (value) => Math.round(Number(value) * 100);
export const fromCents = (cents) => (cents / 100).toFixed(2);
export function isValidAmount(value) {
  return /^\d{1,9}(\.\d{1,2})?$/.test(String(value)) && Number(value) > 0;
}
