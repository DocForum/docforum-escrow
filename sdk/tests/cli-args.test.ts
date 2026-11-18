import { describe, expect, it } from "vitest";
import { parseArgs } from "../src/cli-args.js";

describe("CLI argument parsing", () => {
  it("parses a command, valued options, and boolean flags", () => {
    const parsed = parseArgs(["create", "--contract-id=C123", "--amount", "500", "--dry-run", "--json"]);
    expect(parsed.command).toBe("create");
    expect(parsed.values).toEqual({ "contract-id": "C123", amount: "500" });
    expect(parsed.flags).toEqual(new Set(["dry-run", "json"]));
  });

  it("rejects secrets in argv", () => {
    expect(() => parseArgs(["release", "--secret-key", "SABC"])).toThrow(/cannot be supplied/);
    expect(() => parseArgs(["release", "--signer-secret=SABC"])).toThrow(/cannot be supplied/);
    expect(() => parseArgs(["release", "--signer-file", `S${"A".repeat(55)}`])).toThrow(/Secret keys cannot/);
    expect(() => parseArgs(["release", "--private-key", `S${"A".repeat(55)}`])).toThrow(/Unknown option/);
  });

  it("rejects missing values and unexpected positional arguments", () => {
    expect(() => parseArgs(["show", "--escrow-id"])).toThrow(/requires a value/);
    expect(() => parseArgs(["show", "123"])).toThrow(/Unexpected argument/);
  });
});
