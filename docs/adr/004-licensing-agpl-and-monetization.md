# ADR-004: Relicense to AGPL-3.0 and plan open-core monetization

Date: 2026-08-17
Status: Accepted

## Context

Lirrly shipped v0.3 under MIT. MIT is maximally permissive: anyone — including a well-funded
competitor (Wispr, superwhisper, etc.) — can take the code, close it, add their own paywall,
and sell it, with no obligation to contribute anything back. The maintainer intends to
monetize Lirrly later (a paid tier / paywall) while keeping it genuinely open source. MIT
works against that; a strong copyleft license plus sole copyright ownership works for it.

The maintainer (`m55h11r11` / mshrmnsr) is the **sole author** — verified via `git log`
authorship — so relicensing going forward is clean. (Code already published under MIT at commit
`e21e2ec` remains available under MIT for that snapshot; this is harmless — it is an early v0.3
with no paid features — and does not affect the license of future versions.)

## Decision

1. **Relicense to GNU AGPL-3.0-only.** Strongest common copyleft: anyone who distributes the
   app — or runs a modified version as a network service — must release their source under the
   same terms. This lets us share every line while preventing anyone else from building a
   proprietary product on our code. AGPL (not plain GPL) is chosen because it also closes the
   "wrap it in a hosted service" loophole, which matters once a "Lirrly Cloud" backend exists.
2. **Retain 100% copyright ownership.** AGPL binds *everyone else*, not the copyright holder.
   As sole owner, the maintainer keeps the right to **dual-license**: ship a proprietary /
   paid "Pro" build or sell commercial licenses alongside the AGPL version. This is the
   MongoDB / GitLab / Grafana model.
3. **Protect that right from contributions.** Outside contributions under AGPL would otherwise
   remove the ability to relicense. `CONTRIBUTING.md` requires a DCO sign-off **and** a grant
   letting the maintainer also license contributions under other terms. Keep any paid/Pro code
   in a **separate private repository**, never mixed into the AGPL tree.

## Monetization model (how the paywall actually works)

A paywall on features that live in the open-source tree is unenforceable — anyone can compile
the free build. So monetize with **open core**, not by locking the open code:

- **Pro features** (closed-source modules or license-key-gated): e.g. the local/streaming
  engine (ADR-003), team/shared dictionaries, advanced transforms, sync.
- **Lirrly Cloud** (hosted, paid): managed transcription so users don't need their own Groq
  key, premium models, plus the crash/feedback/admin backend. Keep this backend as **separate
  proprietary code** so the AGPL network clause never forces it open.
- **Paid convenience**: sell the ready-to-run signed/notarized build while source stays free.

The public site copy was updated to stop promising "no paywall / no pro tier / free forever";
it now says the app is free and open-source (AGPL-3.0) with an optional paid Pro tier possibly
arriving later, and the open-source core staying free.

## Consequences

- Competitors can't legally close and resell Lirrly's code.
- The maintainer keeps a clear, standard path to revenue (dual license + open core).
- Every source file should carry an SPDX header (`SPDX-License-Identifier: AGPL-3.0-only`);
  metadata (`package.json`, `Cargo.toml`) now declares `AGPL-3.0-only`.

## Revisit if

The project wants stronger commercial protection than AGPL provides (e.g. forbidding
competitors' commercial use *now*) → consider a source-available license such as BSL-1.1,
accepting that it is no longer OSI "open source" and conflicts with the current brand.
