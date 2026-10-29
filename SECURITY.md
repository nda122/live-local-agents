# Security and privacy

Run only on localhost as a single-user application. Do not expose the server directly to the internet. Requests that change state require a per-process token and local Host/Origin checks. These controls do not protect against a compromised local machine.

Browser actions require expiring, single-use approvals in a separate temporary browser session. Downloads and popups are blocked. Public-address URL checks reduce access to private network services. This is not a complete browser sandbox or a guarantee against hostile websites.

File access must be enabled for a selected folder. Hidden paths, traversal, and symlinks are rejected. Note writes require review and reject changed originals. Avoid selecting folders containing secrets. Website and file content can contain prompt injection; model instructions cannot guarantee resistance. Disable web tools when working with sensitive local content.

Persistent memory is opt-in, editable, exportable, and deletable. Keep data/, model weights, recordings, credentials, and personal test artifacts out of Git. Browser speech/model services and external search have their own data handling behavior.

This project has not received an independent security audit. Report reproducible issues without including private files or credentials.
