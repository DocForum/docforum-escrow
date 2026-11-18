import { describe, expect, it } from "vitest";
import { ArchivedEntryError, isArchivedEntryFailure } from "../src/index.js";

describe("archived contract state handling", () => {
  it("recognizes the SDK's expired-state error and leaves unrelated failures alone", () => {
    expect(isArchivedEntryFailure(Object.assign(new Error("expired"), { name: "ExpiredState" }))).toBe(true);
    expect(isArchivedEntryFailure(new Error("Automatic restoration attempt limit reached"))).toBe(true);
    expect(isArchivedEntryFailure(new Error("contract not found"))).toBe(false);
  });

  it("provides a typed error that identifies the affected SDK method", () => {
    const cause = Object.assign(new Error("expired"), { name: "ExpiredState" });
    const error = new ArchivedEntryError("getEscrow", "error", cause);

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("ArchivedEntryError");
    expect(error.method).toBe("getEscrow");
    expect(error.cause).toBe(cause);
    expect(error.message).toContain('archivalBehavior to "auto"');
  });
});
