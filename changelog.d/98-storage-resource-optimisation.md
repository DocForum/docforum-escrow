Issue #98 (Phase E7): added a Soroban resource profile for the 13 functions
in the resource baseline. A dedicated status record reduces `get_status`
CPU instructions by 41% and memory by 52% in the measured native test
environment, while increasing create and settlement costs due to the extra
persistent write. Moving `NextId` to persistent storage was rejected because
it raised create costs further. The status key changes storage layout and
requires redeployment under a new testnet contract ID per ADR 0005.
