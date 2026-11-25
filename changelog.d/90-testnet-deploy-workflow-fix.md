Issue #90 (Phase E7): fixed `testnet-deploy.yml`, which GitHub could not parse
(every push to main showed a failed run). The deployment record PR body is now
written to a file instead of a multi-line `--body` string, the record branch
push authenticates with the job token (checkout keeps
`persist-credentials: false`), and the record names the deployed commit rather
than the workflow's own ref.
