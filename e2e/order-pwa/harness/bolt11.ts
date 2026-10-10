/**
 * A minimal BOLT11 encoder — bech32 + tagged fields + the checksum.
 *
 * Why this exists: the stub mint must return an invoice that is a REAL BOLT11
 * string, because the whole point of the E2E is to exercise the shipped client's
 * `<img src>`/`<code>` invoice path and the service's `qrDataUri()` encoder with
 * something well formed. A placeholder like `lnbc1fake` would prove nothing.
 *
 * What it deliberately does NOT do: sign. The 65-byte signature field is random
 * bytes derived from the invoice's own payment hash, so the invoice is
 * syntactically valid and independently decodable (the spec decodes it with
 * `light-bolt11-decoder`, which does not verify signatures), but it is
 * UNPAYABLE and no node would route it. That is the honest limit of a stub mint,
 * and it is stated in REPORT.md.
 *
 * Amounts: expressed with the `n` (nano) multiplier as an integer, because
 * 1 sat = 10 nBTC exactly — no float ever touches the amount.
 */

const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const GENERATOR = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];

function polymod(values: number[]): number {
  let chk = 1;
  for (const value of values) {
    const top = chk >> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ value;
    for (let i = 0; i < 5; i++) if ((top >> i) & 1) chk ^= GENERATOR[i];
  }
  return chk;
}

function hrpExpand(hrp: string): number[] {
  const out: number[] = [];
  for (const c of hrp) out.push(c.charCodeAt(0) >> 5);
  out.push(0);
  for (const c of hrp) out.push(c.charCodeAt(0) & 31);
  return out;
}

/** bytes -> 5-bit words (zero padded, as bech32 data). */
function toWords(bytes: Uint8Array): number[] {
  const out: number[] = [];
  let acc = 0;
  let bits = 0;
  for (const byte of bytes) {
    acc = ((acc << 8) | byte) & 0xffffff;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out.push((acc >> bits) & 31);
    }
  }
  if (bits > 0) out.push((acc << (5 - bits)) & 31);
  return out;
}

/** A fixed-width unsigned integer -> 5-bit words (BOLT11's 35-bit timestamp). */
function intToWords(value: number, bitLength: number): number[] {
  const out: number[] = [];
  for (let shift = bitLength - 5; shift >= 0; shift -= 5) {
    out.push(Math.floor(value / 2 ** shift) % 32);
  }
  return out;
}

function checksum(hrp: string, data: number[]): number[] {
  const polymodValue = polymod(hrpExpand(hrp).concat(data).concat([0, 0, 0, 0, 0, 0])) ^ 1;
  return [0, 1, 2, 3, 4, 5].map((i) => (polymodValue >> (5 * (5 - i))) & 31);
}

/** tag(5 bits) + length(10 bits) + data. */
function field(tag: string, dataWords: number[]): number[] {
  const index = CHARSET.indexOf(tag);
  if (index < 0) throw new Error(`unknown bolt11 tag ${tag}`);
  if (dataWords.length > 1023) throw new Error(`bolt11 field ${tag} too long`);
  return [index, (dataWords.length >> 5) & 31, dataWords.length & 31, ...dataWords];
}

/**
 * A non-negative integer -> the 5-bit words of a BOLT11 *integer* field.
 *
 * Padding goes on the LEFT, so that reading the words back as one big-endian
 * integer yields exactly `value`. That is why this is not `toWords(intBytes)`,
 * which pads on the right and would make an `x` of 900 read back as 14400.
 */
function intFieldWords(value: number): number[] {
  if (!Number.isInteger(value) || value < 0) throw new Error(`bad bolt11 integer field ${value}`);
  const wordCount = Math.max(1, Math.ceil(value.toString(2).length / 5));
  return intToWords(value, wordCount * 5);
}

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

function hexBytes(hex: string): Uint8Array {
  if (!/^[0-9a-f]*$/.test(hex) || hex.length % 2 !== 0) throw new Error("bad hex");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export interface StubInvoice {
  /** Integer sats. The only money unit this harness ever uses. */
  sats: number;
  /** 32-byte payment hash, hex. */
  paymentHash: string;
  description: string;
  expirySeconds: number;
  createdAt: number;
  /** 65 bytes: an unpayable placeholder (see the module comment). */
  signature: Uint8Array;
}

/** 1 sat = 10 nano-BTC, so the amount is always an integer. */
export function encodeBolt11(invoice: StubInvoice): string {
  if (!Number.isInteger(invoice.sats) || invoice.sats <= 0) {
    throw new Error(`bolt11 amount must be a positive integer of sats, got ${invoice.sats}`);
  }
  const hrp = `lnbc${invoice.sats * 10}n`;

  const data: number[] = [
    ...intToWords(invoice.createdAt, 35),
    ...field("p", toWords(hexBytes(invoice.paymentHash))),
    ...field("d", toWords(utf8(invoice.description))),
    ...field("x", intFieldWords(invoice.expirySeconds)),
    ...toWords(invoice.signature),
  ];
  const words = [...data, ...checksum(hrp, data)];
  return `${hrp}1${words.map((w) => CHARSET[w]).join("")}`;
}
