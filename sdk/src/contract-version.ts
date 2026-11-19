/**
 * Contract versions this SDK can talk to, as reported by the contract's
 * `version()`: at least `minInclusive` and below `maxExclusive`. 2.0.0 is the
 * first version whose `create_escrow` takes the fee arguments this SDK sends.
 * 3.x (issue #48, docs/adr/0013) reclaims a settled escrow's record, so
 * `getEscrow` fails for settled ids; use `getStatus` for those.
 */
export const SUPPORTED_CONTRACT_VERSIONS = { minInclusive: "2.0.0", maxExclusive: "4.0.0" } as const;

function parseContractVersion(version: string): [number, number, number] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

function compareContractVersions(a: [number, number, number], b: [number, number, number]): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

/** Whether a contract `version()` value is within `SUPPORTED_CONTRACT_VERSIONS`. */
export function isSupportedContractVersion(version: string): boolean {
  const parsed = parseContractVersion(version);
  if (!parsed) return false;
  const min = parseContractVersion(SUPPORTED_CONTRACT_VERSIONS.minInclusive)!;
  const max = parseContractVersion(SUPPORTED_CONTRACT_VERSIONS.maxExclusive)!;
  return compareContractVersions(parsed, min) >= 0 && compareContractVersions(parsed, max) < 0;
}

/**
 * Thrown when a contract's version is outside `SUPPORTED_CONTRACT_VERSIONS`.
 * `version` is `null` for an older deployment with no `version()` function.
 */
export class UnsupportedContractVersionError extends Error {
  readonly name = "UnsupportedContractVersionError";
  readonly contractId: string;
  readonly version: string | null;
  constructor(contractId: string, version: string | null) {
    const { minInclusive, maxExclusive } = SUPPORTED_CONTRACT_VERSIONS;
    super(
      `Contract ${contractId} ${version === null ? "has no version() function" : `is version ${version}`}; ` +
        `this SDK supports >=${minInclusive} <${maxExclusive}.`,
    );
    this.contractId = contractId;
    this.version = version;
  }
}
