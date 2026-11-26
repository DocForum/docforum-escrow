Issue #471 (Phase E6): the Python SDK (`sdk-python`, 0.2.0) adds
`create_escrow_with_acceptance`, `accept`, `cancel`, `top_up` and
`transfer_payee`. Each one is authorized by the signer alone, and an explicit
actor (`payer=`, `payee=`, `current_payee=`) that isn't the signer raises
`InvalidArgumentError` before any request. Arguments follow `contract-spec.json`
and contract failures surface as the existing typed `ContractError` subclasses.
`transfer_payee` refuses the contract id as the new payee client-side.
`extend_refund_after` and `rotate_releaser` need two signatures and stay out of
scope. No contract change.
