// Browser signer for the customer surface (ADR-0017).
//
// One interface, two methods, and in BOTH cases the customer's private key
// stays where it belongs — inside their extension, or inside their bunker. This
// module never sees it, never stores it, and never asks for it.
//
//   window.nostr  NIP-07 extension  → desktop
//   bunker://...  NIP-46 remote     → the only path that works on a phone
//
// NIP-07 does not define nip44Encrypt on every implementation, so the
// encryption is routed through a locally-held key ONLY when the extension
// genuinely cannot do it — see `supportsExtensionCrypto`.
import { BunkerSigner, generateSecretKey } from "../vendor/nostr.mjs";

/**
 * True when a NIP-07 provider is present.
 * @param {any} [win] the global object holding `window.nostr` (injected in tests)
 */
export function hasNip07(win = globalThis) {
  return Boolean(win?.nostr?.signEvent && win?.nostr?.getPublicKey);
}

/**
 * Wrap `window.nostr`. NIP-07 gives us signEvent and (in newer providers)
 * nip44 encrypt/decrypt; we only ever need the latter for the order detail.
 * @param {any} [win] the global object holding `window.nostr` (injected in tests)
 */
export async function nip07Signer(win = globalThis) {
  const p = win?.nostr;
  if (!p?.signEvent) throw new Error("no NIP-07 provider on this device");
  const pubkey = await p.getPublicKey();
  if (typeof pubkey !== "string" || pubkey.length !== 64) {
    throw new Error("the NIP-07 provider returned a malformed pubkey");
  }
  // Only expose the crypto methods the provider ACTUALLY has. Defining them as
  // stubs that throw would make `signerCapabilities()` claim an encryption
  // ability the signer does not have, and the caller would only find out when
  // the write failed.
  const canEncrypt = typeof p.nip44?.encrypt === "function";
  const canDecrypt = typeof p.nip44?.decrypt === "function";

  const signer = {
    pubkey,
    method: "nip07",
    async signEvent(tmpl) {
      // NIP-07 providers add pubkey + id + sig themselves.
      return await p.signEvent({
        kind: tmpl.kind,
        created_at: tmpl.created_at,
        tags: tmpl.tags,
        content: tmpl.content,
      });
    },
  };
  if (canEncrypt && canDecrypt) {
    signer.nip44Encrypt = async (peerPubkey, plaintext) => await p.nip44.encrypt(peerPubkey, plaintext);
    signer.nip44Decrypt = async (peerPubkey, ciphertext) => await p.nip44.decrypt(peerPubkey, ciphertext);
  }
  return signer;
}

/**
 * Connect to a remote signer from a pasted `bunker://` URL.
 *
 * The ephemeral client key is generated here and kept in memory only: the
 * customer's real key never leaves their bunker, and a page reload simply
 * reconnects (the bunker authorises it again).
 */
export async function bunkerSigner(uri, { timeoutMs = 30000 } = {}) {
  const clientKey = generateSecretKey();
  const signer = await BunkerSigner.fromURI(clientKey, uri, {}, timeoutMs);
  const pubkey = await signer.getPublicKey();
  if (typeof pubkey !== "string" || pubkey.length !== 64) {
    throw new Error("the bunker returned a malformed pubkey");
  }
  return {
    pubkey,
    method: "nip46",
    bunker: uri,
    async signEvent(tmpl) {
      return await signer.signEvent(tmpl);
    },
    async nip44Encrypt(peerPubkey, plaintext) {
      return await signer.nip44Encrypt(peerPubkey, plaintext);
    },
    async nip44Decrypt(peerPubkey, ciphertext) {
      return await signer.nip44Decrypt(peerPubkey, ciphertext);
    },
    close() {
      try {
        signer.close();
      } catch { /* already closed */ }
    },
  };
}

/**
 * What a signer can actually do — used to decide whether to offer "save my
 * orders". An extension that can sign but cannot encrypt can still publish the
 * PUBLIC receipt; it just cannot read back the encrypted detail.
 */
export function signerCapabilities(signer) {
  return {
    canSign: typeof signer?.signEvent === "function",
    canEncryptDetail: typeof signer?.nip44Encrypt === "function" &&
      typeof signer?.nip44Decrypt === "function",
  };
}
