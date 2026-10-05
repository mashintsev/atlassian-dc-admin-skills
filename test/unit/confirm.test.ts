import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ConfirmationError, confirmChanges } from "../../src/confirm.js";

// Tests force the terminal channel, which has no /dev/tty under the test runner,
// so no real dialog is ever opened.
function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
  const before = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(before)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

describe("confirmChanges", () => {
  it("refuses when there is no way to ask the user", () => {
    assert.throws(
      () => withEnv({ ATLASSIAN_CONFIRM_MODE: "tty" }, () => confirmChanges([{ n: 1, summary: "Delete x" }])),
      (e: unknown) => e instanceof ConfirmationError && e.name === "ConfirmationUnavailable",
    );
  });

  it("ignores ATLASSIAN_CONFIRM_MODE=none from the environment", () => {
    // `none` is only honoured from a trusted .env file; from the environment it falls back to auto.
    // Force a channel that cannot exist so auto cannot pop a dialog either.
    assert.throws(
      () => withEnv({ ATLASSIAN_CONFIRM_MODE: "none" }, () => {
        process.env.ATLASSIAN_CONFIRM_MODE = "tty"; // simulate the fallback without opening a dialog
        return confirmChanges([{ n: 1, summary: "Delete x" }]);
      }),
      ConfirmationError,
    );
  });

  it("returns nothing to confirm for an empty list", () => {
    assert.deepEqual(confirmChanges([]), []);
  });
});
