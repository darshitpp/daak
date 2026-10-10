/**
 * The pairing number as the user reads it out loud.
 *
 * The engine formats the number with `{n:06}` (`crypto/sas.rs`): 6 digits, zero
 * padded, no space. The design shows 2 groups of 3 (`482 917`). A value that
 * is not 6 digits comes back as received. Guessing a grouping for it would put
 * a number on screen that the engine did not produce.
 */
export function formatSas(sas: string): string {
  const digits = sas.replace(/ /g, '');
  return /^\d{6}$/.test(digits) ? `${digits.slice(0, 3)} ${digits.slice(3)}` : sas;
}

