/**
 * Minimal BOLT11 reader: just enough to take an invoice produced by a hosted Lightning provider
 * (which may not return the payment hash until the invoice is paid) and extract, with the bech32
 * checksum verified, the two things L402 needs before payment — the payment hash (tagged field
 * `p`) and the amount encoded in the human-readable part. It does not verify the node signature:
 * the invoice comes straight from our own authenticated provider API, not from a third party.
 */
const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const GENERATORS = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];

function polymod(values: number[]): number {
  let chk = 1;
  for (const v of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= GENERATORS[i]!;
  }
  return chk >>> 0;
}

function hrpExpand(hrp: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) >> 5);
  out.push(0);
  for (let i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) & 31);
  return out;
}

function wordsToBytes(words: number[]): Buffer {
  let acc = 0, bits = 0;
  const out: number[] = [];
  for (const w of words) {
    acc = (acc << 5) | w; bits += 5;
    while (bits >= 8) { bits -= 8; out.push((acc >> bits) & 0xff); }
    acc &= (1 << bits) - 1;
  }
  return Buffer.from(out);
}

const MULTIPLIER_MSAT: Record<string, bigint> = { "": 100_000_000_000n, m: 100_000_000n, u: 100_000n, n: 100n };

/** Returns null — never throws — for anything that isn't a well-formed, checksummed BOLT11. */
export function decodeBolt11(invoice: string): { network: string; amountMsat: bigint | null; paymentHash: Buffer } | null {
  const s = invoice.trim().toLowerCase().replace(/^lightning:/, "");
  if (s.length > 7089) return null;
  const sep = s.lastIndexOf("1");
  if (sep < 3 || sep + 7 > s.length) return null;
  const hrp = s.slice(0, sep);
  const words: number[] = [];
  for (const ch of s.slice(sep + 1)) {
    const v = CHARSET.indexOf(ch);
    if (v < 0) return null;
    words.push(v);
  }
  if (polymod([...hrpExpand(hrp), ...words]) !== 1) return null;
  const m = /^ln(bcrt|bc|tbs|tb|sb)(\d*)([munp]?)$/.exec(hrp);
  if (!m) return null;
  let amountMsat: bigint | null = null;
  if (m[2]) {
    const n = BigInt(m[2]);
    if (m[3] === "p") { if (n % 10n !== 0n) return null; amountMsat = n / 10n; }
    else amountMsat = n * MULTIPLIER_MSAT[m[3] ?? ""]!;
  } else if (m[3]) return null;
  const data = words.slice(0, -6); // drop checksum
  let pos = 7; // timestamp
  const end = data.length - 104; // signature (65 bytes)
  let paymentHash: Buffer | null = null;
  while (pos + 3 <= end) {
    const type = data[pos]!, len = data[pos + 1]! * 32 + data[pos + 2]!;
    pos += 3;
    if (pos + len > end) return null;
    if (type === 1 && len === 52 && !paymentHash) paymentHash = wordsToBytes(data.slice(pos, pos + len)).subarray(0, 32);
    pos += len;
  }
  if (!paymentHash || paymentHash.length !== 32) return null;
  return { network: m[1]!, amountMsat, paymentHash };
}
