# Contributing

Thanks for helping out! This is a small project — issues and pull requests of
any size are welcome.

## Development setup

```bash
npm install
npm run dev        # launches the app with hot reload
```

You'll want a TeX distribution installed to exercise compiling:
[Tectonic](https://tectonic-typesetting.github.io) (`brew install tectonic`)
is the quickest start; TeX Live / MacTeX gives you `latexmk`, which the app
prefers.

## Checks to run before a PR

```bash
npm run typecheck   # strict TypeScript, no emit
npm test            # unit tests (log parser, SyncTeX, path safety)
```

Optional but appreciated for changes touching compiling or collaboration:

```bash
npm run stress                      # thesis-scale benchmark (~1,850 pages)
npm run stress -- --chapters 10     # quicker variant
npm run test:p2p                    # real two-peer swarm integration test
```

## Layout

- `src/main/` — Electron main process: compile pipeline, P2P swarm,
  filesystem IPC, SyncTeX. No UI code here.
- `src/renderer/` — React UI: editor (CodeMirror 6), PDF viewer (PDF.js),
  collaboration layer (`lib/collab.ts`, Yjs).
- `src/shared/` — types and constants used by both processes.
- `tests/` — plain `node:test` suites run with tsx; no Electron required.

## Security-sensitive invariants

Two rules exist because shared projects can come from strangers — please
don't relax them without discussion:

- Compiles must never execute project-controlled code: no `-shell-escape`,
  and latexmk runs with `-norc` so a synced `.latexmkrc` is never executed
  (`src/main/compiler.ts`).
- Every path arriving over IPC goes through `safeJoin`
  (`src/main/safepath.ts`): nothing outside the project root, no hidden
  files except `.p2platex/`.

## Releases (maintainers)

`npm version patch && git push --follow-tags` — CI builds installers for all
platforms and attaches them to a draft release.
