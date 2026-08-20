# Contributing to Lirrly

Thanks for your interest in Lirrly. A few things to know before you send a change.

## License & copyright

Lirrly is licensed under the **GNU Affero General Public License v3.0 (AGPL-3.0-only)**.
By contributing you agree that your contribution is provided under that license.

**Developer Certificate of Origin (DCO).** Every commit must be signed off, certifying you
wrote the change (or have the right to submit it) under the project license. Add a sign-off
line to each commit:

```
Signed-off-by: Your Name <you@example.com>
```

(`git commit -s` adds it automatically. See https://developercertificate.org/.)

**Relicensing / commercial rights.** The maintainer (copyright holder, © mshrmnsr) may offer
Lirrly under separate commercial terms in addition to the AGPL (dual licensing / an open-core
"Pro" tier). To keep that possible, by submitting a contribution you grant the maintainer a
perpetual, worldwide, royalty-free right to also license your contribution under other terms,
including proprietary ones. If you are not comfortable with this, open an issue to discuss
before contributing rather than sending code. This is standard practice for open-core projects
(e.g. GitLab, Grafana, Mattermost) and it is what keeps the project sustainable.

## Development

See `lirrly/README.md` for setup, run, and the quality gates (`npm run lint && npm test &&
npm run build`; `cargo clippy -- -D warnings && cargo fmt --check`). CI runs all of them on
every push.

## Ground rules

- Keep the privacy posture: never add code that sends transcripts, audio, API keys, or
  personal text off the device without explicit, opt-in user consent.
- Match the surrounding code's style; no new dependencies without discussion.
- One focused change per pull request, with a clear description.
