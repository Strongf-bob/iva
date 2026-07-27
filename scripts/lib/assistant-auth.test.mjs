import { strict as assert } from "node:assert";
import { generateAssistantBearer } from "./assistant-auth.mjs";

const first = generateAssistantBearer();
const second = generateAssistantBearer();

assert.match(first, /^[A-Za-z0-9_-]{43}$/);
assert.notEqual(first, second);
console.log("assistant-auth: all assertions passed");
