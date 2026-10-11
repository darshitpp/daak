# Contributing to Daak

Thank you for your interest in Daak. This file explains how to report a bug,
suggest a change, and send a pull request.

## Before you start

- Search the [open issues](https://github.com/darshitpp/daak/issues) first.
  Your topic can exist already.
- For a large change, open an issue first. Describe the problem and your plan.
  The maintainer can tell you if the change fits before you spend time on it.
- Daak is local network only. It has no account system and no internet relay.
  A change that adds either one does not fit.

## Report a bug

Open an issue. Include:

1. The Daak version (see **Settings**) and the system version.
2. The two devices that take part, for example "Pixel 8, Android 15" and
   "MacBook Air, macOS 14".
3. The steps that cause the bug.
4. What you expected, and what happened.
5. The type of network (home router, office, guest network).

Do not attach private files. Do not post a pairing code or a QR code.

For a security problem, do not open a public issue. Use
[private vulnerability reporting](https://github.com/darshitpp/daak/security/advisories/new).

## Suggest a feature

Open an issue. Describe the problem you want to solve, not only the solution.

## Set up the project

You need Rust (stable), Node.js, `pnpm` 9, and the native tools for your target
system. See [`apps/mobile/README.md`](apps/mobile/README.md) for native builds.

```bash
git clone https://github.com/<your-user>/daak.git
cd daak
pnpm install
```

## Project layout

| Path | Content |
| --- | --- |
| `crates/daak-core` | The Rust engine. It is the only implementation of the protocol. |
| `crates/daak-ffi` | UniFFI bindings for the mobile and macOS apps. |
| `crates/daakd`, `crates/daak-ipc` | The background daemon and its IPC. |
| `packages/core` | The TypeScript `DaakEngine` interface. |
| `packages/ui` | The screens. They have no platform conditionals. |
| `packages/platform` | The native module wrappers. |
| `apps/mobile`, `apps/desktop` | The iOS, Android, and macOS app shells. |
| `proto/` | The CBOR schemas. Do not edit `proto/gen` by hand. |

## Make a change

1. Fork the repository and create a branch from `main`.
2. Write a test that fails. Then write the code that makes it pass.
3. Run all the checks below.
4. Commit and push your branch.
5. Open a pull request.

### Checks

Run each check before you open a pull request. CI runs the same checks.

```bash
cargo fmt --all --check
cargo clippy --all-targets -- -D warnings
cargo test --workspace
pnpm -r typecheck
pnpm -r test
```

Some tests open network sockets and register a test service on your network.
Do not run them while you test with two real devices.

### Rules for code

- Keep a change small and focused. One pull request does one thing.
- Match the style of the code around your change.
- Do not add a dependency when a few lines of code do the job.
- Do not change the wire format, the schemas in `proto/`, or the cipher suite
  without an issue and an agreement first.
- `packages/ui` must not contain platform conditionals. Put platform
  differences in `packages/platform`.
- Add a new engine event in every layer: the `EngineEvent` variant, the UniFFI
  definition, the `daakd` mapping, and the TypeScript types with their
  contract test.

### Commit messages

Use the format `type(scope): short summary`. Use these types: `feat`, `fix`,
`docs`, `test`, `refactor`, `chore`.

```text
fix(core): cap the thread page at one mebibyte of json
```

## Pull request checklist

- [ ] The change has a test, or the description says why it has none.
- [ ] All checks above pass.
- [ ] The description says what changed and why.
- [ ] The description links the issue, if one exists.
- [ ] No generated files, build output, or secrets are in the diff.

A maintainer reviews each pull request. Expect questions and requests for
changes. Review can take several days.

## License of your contribution

Daak uses the [Apache License 2.0](LICENSE). When you send a contribution, you
agree that it falls under the same license (Section 5 of the license). You keep
your copyright. Keep the license header and copyright notices in the files you
change.
