# Releasing

Source now declares unreleased `1.0.2`. The previously published package and GitHub release history are not synchronized to this source. Registry publication is withheld until real settlement/delivery/replay validation; a passing synthetic suite is insufficient.

## Required gate

1. Start from the exact default-branch commit to be released.
2. Reproduce the repository quickstart in a clean environment.
3. Confirm all required GitHub checks pass on that commit.
4. Update the changelog or prepare generated release notes.
5. Create an annotated Semantic Versioning tag: `vMAJOR.MINOR.PATCH`.
6. Create a GitHub release from that exact tag.
7. Verify any package registry version and digest match the release.

## Claim boundary

A release proves a versioned artifact exists. It does not prove production
readiness, security certification, third-party validation, adoption, revenue,
or performance. Those claims require separate evidence.

## Download a tested evaluation snapshot

Open a successful default-branch **Node integrity** run in
[Actions](https://github.com/prettybusysolutions-eng/x402-mcp-server/actions).
Download its `evaluation-<commit>` artifact (GitHub sign-in may be required).
The bundle contains `source.tar.gz`, `COMMIT.txt`, and `SHA256SUMS`.
After extracting the Actions ZIP, run `sha256sum -c SHA256SUMS`, then extract
`source.tar.gz` and follow `source/QUICKSTART.md`. Artifacts expire after 30 days;
use the recorded commit to retrieve the same source later.

This is a tested source snapshot, not a published versioned release or evidence
that untested integrations work. Release publication and registry verification
remain separate gates.
