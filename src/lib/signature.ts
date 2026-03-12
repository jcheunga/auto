import crypto from "node:crypto";

export function verifyMondaySignature(
  rawBody: Buffer,
  signatureHeader: string | undefined,
  signingSecret: string | undefined
): boolean {
  if (!signingSecret) {
    return true;
  }
  if (!signatureHeader) {
    return false;
  }

  const expected = crypto
    .createHmac("sha256", signingSecret)
    .update(rawBody)
    .digest("hex");

  const received = signatureHeader.replace(/^sha256=/, "");

  if (expected.length !== received.length) {
    return false;
  }

  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(received));
}
