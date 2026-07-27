import { randomBytes } from "node:crypto";

/** Generate the shared secret used by Iva's local Eve clients. */
export function generateAssistantBearer() {
  return randomBytes(32).toString("base64url");
}
