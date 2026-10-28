import { randomBytes } from 'node:crypto';

const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

export type IdPrefix = 'acc' | 'txn' | 'trf' | 'att';

/** Stripe-style ID: a readable type prefix plus 20 random base62 characters (~119 bits). */
export function newId(prefix: IdPrefix): string {
  const bytes = randomBytes(20);
  let suffix = '';
  for (const byte of bytes) suffix += ALPHABET[byte % ALPHABET.length];
  return `${prefix}_${suffix}`;
}
