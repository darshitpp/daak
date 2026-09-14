# Architecture Decision Records

This directory holds Daak's architecture decision records (ADRs) in the
[Michael Nygard format](https://cognitect.com/blog/2011/11/15/documenting-architecture-decisions).
Unlike `docs/superpowers/**` (specs and implementation plans, which are local-only
and gitignored), **ADRs are version-controlled** so the decision log travels with
the code.

## When to write one

Write an ADR when a decision is expensive to reverse: a wire format, a
cryptographic primitive, a storage engine, a cross-platform strategy, or a
dependency with a large blast radius. The locked decisions in `AGENTS.md` all
belong here.

## Naming

`NNNN-short-imperative-title.md`, zero-padded to four digits, numbered from 0001.
Never renumber or delete an accepted ADR; supersede it instead.

## Status values

`Proposed` → `Accepted` → (`Deprecated` or `Superseded by ADR-NNNN`).

## Adding one

1. Copy `template.md` to `NNNN-your-title.md`.
2. Fill in Context, Decision, and Consequences.
3. Open a PR. The ADR number is the next free one on `main` at merge time.

## Index

| ADR | Title | Status |
|---|---|---|
| [0001](0001-record-architecture-decisions.md) | Record architecture decisions | Accepted |
