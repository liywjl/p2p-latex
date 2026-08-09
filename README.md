# P2P LaTeX

A free, local-first LaTeX editor with real-time peer-to-peer collaboration — an
Overleaf alternative with no server, no account, and no subscription. Your
files live in a normal folder on your disk; sharing happens over an encrypted
peer-to-peer swarm built on the [Holepunch / Pears](https://docs.pears.com/)
stack.

<img width="2880" height="1752" alt="screenshot" src="https://github.com/user-attachments/assets/f968b123-c26b-4765-80d8-17a72c461e24" />

## Features

- **Point at a folder and write** — open any folder of `.tex` files, get a
  CodeMirror editor with LaTeX highlighting, snippets, and autocomplete.
- **Live PDF preview** — recompiles automatically as you save (debounced),
  with a virtualized PDF viewer that renders only visible pages, so a
  2,000-page thesis scrolls as smoothly as a 2-page CV.
- **Real-time collaboration, Google-Docs style** — click *Share this project*,
  send the invite key to a colleague, and you're both editing the same
  document with live cursors. Concurrent edits merge conflict-free (Yjs CRDTs).
- **Truly peer-to-peer** — peers find each other through the Hyperswarm DHT
  and connect directly with end-to-end encryption (Noise). No relay server
  ever sees your writing. Each collaborator compiles locally on their own
  machine.
- **Sessions survive restarts** — the shared state persists in `.p2platex/`;
  everyone gets a *Reconnect* button and offline edits merge back in when you
  return. Re-joining a folder you've synced before merges instead of
  overwriting.
- **SyncTeX both ways** — ⌘-click a line in the editor to flash its spot in
  the PDF; ⌘-click the PDF to jump to the exact source line.
- **Smart autocomplete** — `\cite{` completes from your `.bib` files,
  `\ref{` from every `\label` in the project, plus snippets for common
  commands and environments.
- **No LaTeX memorisation needed** — a formatting toolbar with undo/redo,
  bold/italic/underline (⌘B/⌘I), sections, lists, math, figure/table
  templates, comment toggle (⌘/), and find & replace (⌘F). Every button's
  tooltip shows the LaTeX it inserts, so the toolbar doubles as a tutor.
- **Quick compile for big documents** — when chapters are pulled in with
  `\include{…}`, auto-compiles rebuild *only the chapters you just edited*
  (via a generated `\includeonly`), reusing page numbers and cross-references
  from the last full build. A thesis-sized document recompiles at the cost of
  one chapter. The Compile button and PDF export always run a full build.
- **One-click PDF export**, per-project settings, file rename/delete from the
  tree, and toast feedback for anything that goes wrong.

## How sharing works

1. Host opens a project and clicks **Share this project** → gets an invite key
   (a random 52-character string).
2. Host sends the key to a colleague over any channel (it's the only secret —
   treat it like a password to the document).
3. Colleague pastes the key on the welcome screen, picks an empty folder, and
   the whole project syncs into it. From then on both folders stay in sync
   while the session is open, and both people can edit simultaneously.

Under the hood the swarm topic is a hash of the key (the DHT never learns the
key), and each connection must additionally prove knowledge of the key before
any data is exchanged.

Peer discovery uses the public Hyperswarm DHT, which is bootstrapped through
nodes operated by [Holepunch](https://holepunch.to). No document data flows
through them — they only help peers find each other — but sharing does depend
on that third-party infrastructure being up.

## LaTeX engines and licensing

This app **never bundles or redistributes TeX**. That is deliberate: TeX Live
is a collection of thousands of packages under many licenses (LPPL, GPL, …),
and redistributing a modified distribution carries naming and licensing
obligations. Instead, the app detects a distribution you installed yourself
and drives it:

- **[Tectonic](https://tectonic-typesetting.github.io)** (`brew install tectonic`) —
  MIT-licensed single binary that downloads packages from CTAN on demand.
  Easiest start.
- **[MacTeX](https://tug.org/mactex/) / [TeX Live](https://tug.org/texlive/)** —
  the full classic distribution; the app prefers `latexmk` from it, which
  gives properly incremental builds (only reruns the passes that are needed —
  important for very large documents).

Packages/add-ons are fetched by *your* distribution from CTAN at compile time,
so they never pass through this project's distribution chain at all.

Everything the app itself ships is permissively licensed: Electron, React,
CodeMirror (MIT), PDF.js (Apache-2.0), Yjs (MIT), Hyperswarm (MIT).

## Install

Build an installer with `npm run dist` — on macOS this produces
`dist/P2P LaTeX-<version>-arm64.dmg` (unsigned; set a Developer ID identity in
`electron-builder.yml` for public distribution). Linux (AppImage/deb) and
Windows (NSIS) targets are configured too and build on their native platforms.

## Development

```bash
npm install
npm run dev        # dev mode with hot reload
npm run build      # production bundles into out/
npx electron out/main/index.js   # run the production build
npm test           # unit tests (synctex + log parsers)
npm run dist       # build installers into dist/
```

Useful env vars for testing:

- `P2PLATEX_DEBUG=1` — forward renderer console output to the terminal.
- `P2PLATEX_SMOKE=/path/to/project` — auto-open a project on launch.

## Working on very large documents

- `latexmk` keeps aux files in `.p2platex/build/` between runs, so recompiles
  only redo what changed.
- For chapter-level iteration, use `\includeonly{chapters/three}` in your
  preamble (with `\include` rather than `\input` for chapters) — LaTeX will
  then typeset only that chapter while keeping cross-references from the
  cached aux files.
- Auto-compile is debounced and coalesced: rapid saves during a compile queue
  at most one follow-up run.

### Measured at thesis scale

`npm run stress` generates a synthetic 100-chapter thesis and benchmarks the
whole pipeline. On an Apple Silicon laptop with Tectonic:

| Metric | Result |
| --- | --- |
| Document | 1,863 pages, 103 files, 1,500-entry bibliography |
| Full compile | 38 s |
| Quick compile after editing one chapter | 4.6 s |
| Open the finished PDF in the viewer (PDF.js) | 0.3 s |
| Initial sync payload a joiner downloads | 3.9 MB |
| CRDT cost per keystroke in a 460 kB file | ~26 µs, 33-byte update |

## Current limitations (v1)

- Binary assets over 25 MB are not synced (edit text collaboratively; move
  giant figure folders around out-of-band).
- First-time join into a folder overwrites that folder's contents with the
  shared project (re-joins merge). Pick an empty folder the first time.
- Offline edits to the *same file* by two people merge whole-file (last
  reconnect wins per file) rather than line-by-line; live edits always merge
  cleanly.
- macOS installers are unsigned out of the box — right-click → Open the first
  time, or configure signing.

## License

MIT
