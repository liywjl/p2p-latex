# Security

## Reporting a vulnerability

Email **contact@thabotech.com** with a description and reproduction steps.
Please don't open a public issue for anything exploitable — give us a chance
to fix it first. You'll get an acknowledgement within a few days.

## Threat model & honest limitations

p2p-latex is local-first: your project is a folder on disk, synced over
Hyperswarm to peers who hold the share key. Things a security-minded reader
should know:

- **The share key is the whole capability.** Anyone holding it has full
  read *and write* access to the project — there is no read-only role and
  no way to rotate a leaked key short of starting a new share. Treat the
  key like a password. It is stored in `.p2platex/session.json` inside the
  project folder, so don't commit that directory if you put the project
  under version control.
- **Compiling a shared project trusts the document.** Shell-escape is
  disabled and the compiler runs without a shell, so LaTeX cannot execute
  commands — but TeX can still read files your user can read (via `\input`)
  and embed their contents into the output PDF. Only compile projects from
  people you trust, the same way you'd treat opening someone's makefile.
- **Peers can write any file inside the project folder.** Sync applies
  collaborator changes to the shared folder, constrained to the project
  root with dotfiles blocked — a malicious peer can alter your `.tex`
  sources but cannot escape the folder or touch things like `.git/hooks`.
- **Peer discovery uses the public Hyperswarm DHT** (Holepunch bootstrap
  nodes). Document content travels only between peers holding the key,
  end-to-end encrypted by the transport. There is no telemetry, no
  analytics, and no update phone-home.

If any of this is a blocker for your use case, treat p2p-latex as
enthusiast software — that's what it is today.
