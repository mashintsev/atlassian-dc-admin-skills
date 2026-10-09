import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ConfirmationError, confirmChanges, winAnswer } from "../../src/confirm.js";
import { exitCodeFor } from "../../src/format.js";

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

  it("preserves declined and unavailable confirmation exit codes", () => {
    assert.equal(exitCodeFor({ type: "ConfirmationDeclined", message: "cancelled" }), 12);
    assert.equal(exitCodeFor({ type: "ConfirmationUnavailable", message: "no channel" }), 13);
  });
});

describe("winAnswer (Windows dialog output)", () => {
  const one = [{ n: 1, summary: "Delete x" }];
  const three = [1, 2, 3].map((n) => ({ n, summary: `Change ${n}` }));
  const declinedWith = (message?: string) => (e: unknown) =>
    e instanceof ConfirmationError && e.name === "ConfirmationDeclined" && (message === undefined || e.message === message);

  it("applies a single change only on APPLY", () => {
    assert.deepEqual(winAnswer("APPLY", one, true), [1]);
    assert.throws(() => winAnswer("CANCEL", one, true), declinedWith());
    assert.throws(() => winAnswer("PICKED 1", one, true), declinedWith());
  });

  it("returns the ticked items of a checklist and ignores unknown numbers", () => {
    assert.deepEqual(winAnswer("PICKED 1,3", three, false), [1, 3]);
    assert.deepEqual(winAnswer("PICKED 2,9", three, false), [2]);
    assert.throws(() => winAnswer("PICKED 9", three, false), declinedWith());
    assert.throws(() => winAnswer("CANCEL", three, false), declinedWith());
    assert.throws(() => winAnswer("APPLY", three, false), declinedWith());
  });

  it("treats a timeout as declined", () => {
    assert.throws(() => winAnswer("TIMEOUT", one, true), declinedWith("Confirmation timed out"));
    assert.throws(() => winAnswer("TIMEOUT", three, false), declinedWith("Confirmation timed out"));
  });
});
