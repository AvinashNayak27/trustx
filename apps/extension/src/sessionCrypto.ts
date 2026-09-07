import { encrypt } from 'eciesjs';
import type { SessionMaterial } from '@tee-replay/protocol';

/** ECIES-encrypt session material to the TEE secp256k1 public key; returns base64 ciphertext. */
export function encryptSessionMaterial(
  encryptionPublicKey: string,
  material: SessionMaterial,
): string {
  const plaintext = new TextEncoder().encode(JSON.stringify(material));
  const ciphertext = encrypt(encryptionPublicKey, plaintext);
  let binary = '';
  for (const byte of ciphertext) binary += String.fromCharCode(byte);
  return btoa(binary);
}
