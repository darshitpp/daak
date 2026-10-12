# 1. Record architecture decisions

- **Date:** 2026-09-14
- **Status:** Accepted
- **Deciders:** Daak maintainers

## Context

Daak makes several hard-to-reverse choices: Noise XX instead of TLS, a single
Rust core behind UniFFI plus a JSI TurboModule, CBOR over CDDL as the schema
source of truth, and SQLite via `rusqlite`. The reasoning behind these choices
lives in the architecture spec, which is deliberately not version-controlled.
Without a committed decision log, future contributors see the *what* but not the
*why*, and re-litigate settled questions.

## Decision

We will keep architecture decision records in `docs/adr/`, one file per
decision, in the Michael Nygard format (Context, Decision, Consequences). ADRs
are committed to the repository, unlike `docs/superpowers/**`. An Accepted ADR
is immutable; a changed decision gets a new ADR that supersedes it.

## Consequences

- The rationale for every locked decision in the project instructions becomes reviewable in
  version control and survives the local-only spec.
- Every non-trivial decision adds a short writing task; trivial changes are
  exempt.
- Contributors must check the ADR index before changing a settled area.
