import test from "node:test";
import assert from "node:assert/strict";

import { requireConfiguredApiKey } from "../src/runtime-config";

test("requireConfiguredApiKey returns a configured API key", () => {
  assert.equal(requireConfiguredApiKey("secret"), "secret");
  assert.equal(requireConfiguredApiKey("  secret  "), "secret");
});

test("requireConfiguredApiKey rejects missing or blank API keys", () => {
  assert.throws(() => requireConfiguredApiKey(undefined), /VAJRA_API_KEY must be set/);
  assert.throws(() => requireConfiguredApiKey(""), /VAJRA_API_KEY must be set/);
  assert.throws(() => requireConfiguredApiKey("   "), /VAJRA_API_KEY must be set/);
});
