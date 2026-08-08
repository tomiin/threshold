# Threshold

**Prove you're allowed in, without saying who you are.**

Age and eligibility checks for places people *choose* to go — gambling sites, adult
platforms — built on the [Midnight](https://midnight.network) network in
[Compact](https://docs.midnight.network).

Three government agencies vouch for you. You prove to a site that at least two of
them did, and that you're currently eligible. The site learns one bit and a code
that means nothing anywhere else. It never learns your name, never sees a document,
and can't compare notes with any other site about you.

And you can shut yourself out of every participating site at once — without
identifying yourself to a single one of them.

---

## The problem

To answer one question — *"is this person allowed in?"* — the internet currently
collects a hundred facts. You photograph your passport and upload it to an
age-verification vendor. A casino takes your licence so it can check you against a
self-exclusion register. Every operator ends up holding a pile of identity documents
it doesn't want, can't protect, and will eventually leak.

The rules were written when checking someone *required* holding their papers. That
hasn't been true for a while.

## The thesis: verification as a proof, not a disclosure

The policy goals behind identity checks are reasonable — keep minors out, honour
self-exclusion, don't serve people who are barred. What's unreasonable is the
implementation: satisfy those goals by making everyone hand their identity to
everyone.

Threshold separates the two. The goals are met by a *proof*. The identity stays with
the person.

That's not a weaker check. On several axes it's a stronger one:

| | Today | Threshold |
|---|---|---|
| What the operator stores | Passport scans, DOB, address | A pseudonym |
| Breach exposure | Every operator is a target | Nothing worth stealing |
| Self-exclusion | Identify **everyone** to catch the few who asked for help | Nobody is identified |
| Forgery | One document check, one issuer | Two of three independent agencies must agree |
| Cross-site tracking | Operators + vendors can correlate you | Mathematically impossible |
| Revocation | Stale list screening | Credentials expire daily |

## How it works

**Three agencies** — a state DMV, a passport office, a federal registry — each
attest independently. In person, exactly as you'd renew a licence today. The agency
verifies the human by its normal means and then signs off that this person controls
a particular key. Nothing about you is published: what lands on the chain is an
opaque hash.

**You need two of the three.** One compromised or mistaken agency isn't enough to
manufacture an identity.

**Credentials last one day.** Each attestation is bound to the current *period*.
Agencies re-attest each morning. This is the same trick the web's certificate system
landed on: rather than maintaining lists of revoked things, make the things expire
quickly and simply stop renewing what should die.

**Proving eligibility reveals nothing.** You prove — in zero knowledge — that at
least two agencies attested you *for today*. The site gets `eligible: true` and a
pseudonym derived from your key **and that site's identifier**. Two operators
comparing their logs see unrelated codes.

**Self-exclusion is yours to pull.** One action locks you out of every participating
operator. You choose the term: 7 days, 30 days, 6 months, or 5 years. You can extend
whenever you like. You can *never* shorten it — a decision made soberly can't be
revised at 2am. When the term ends, returning takes a deliberate request plus a
seven-day reflection window. It's never one click.

Because eligibility works by *expiry* rather than by checking a blocklist, an
excluded person doesn't get flagged — they simply stop being renewed. To an
operator, someone who excluded themselves is indistinguishable from someone who
never enrolled. **Operators cannot detect problem gamblers in order to target them.**

## On-chain vs off-chain

**Never on-chain:** passport data, names, dates of birth, biometrics, any court order.

**On-chain:** opaque attestation hashes, the agencies' public identifiers, the
current period, pseudonyms, and counts.

## Honest limits

Everything below is a real weakness. They're here because a reviewer who finds them
unaided assumes you missed them; a reviewer who sees you name them tends to trust
the rest.

**1. The agencies still hold a link between you and your commitment.**
Self-exclusion only works because you can't just generate a fresh key and enrol
again — which means agencies must record *"this human already has a credential."*
Three agencies holding that is a large improvement on ten thousand operators holding
passport scans. It is not zero, and this project doesn't claim it is.

**2. Exclusion takes effect at the next renewal, not instantly.**
Checking a blocklist on every proof would mean disclosing a stable value about you
every time, which would make all your visits linkable. We chose unlinkability and
accepted up to one period of delay. With daily periods that's under 24 hours. The
delay falls on the *entry* side; getting back in is deliberately much slower.

**3. An observer could tell which agencies attested a proof. FIXED.**
Sharper than it first looked, and I owe the specifics to a reviewer on the
Midnight forum. In the original design each agency had its own tree, and
`checkRoot` is a ledger read, so the computed Merkle root had to be disclosed.
One `proveEligibility` therefore wrote three roots into the public transcript.
For an agency you were enrolled with, the disclosed root matched a genuine
historic root of that tree, already public on-chain. For one you were not, the
witness handed back a dummy path and the root matched nothing. Anyone reading the
transaction could compare the two and recover the exact attestation pattern. The
2-of-3 boolean stayed inside the circuit; its inputs did not. Not *who* you are,
but in a small population, combined with timing, that leaks.

The fix was a redesign rather than a patch, and it has now landed. There is one
shared tree. The leaf is `hash(identityCommitment, period, agencyTag)`, and only
the attesting agency can produce its own tag, because `attest` tags with the
caller's own derived id. A proof presents two memberships against that single
tree and the circuit asserts the two agency tags differ. Both membership checks
must pass, so both disclosed roots are ordinary roots of the same tree and both
published booleans are `true` for every proof that lands. There is nothing left
that varies between callers.

While rewriting this I found a second and more serious problem in the same
circuit. `merkleTreePathRoot` hashes the path's **own** leaf, and the witness
that supplies the path runs on the prover's machine. The old code derived a leaf
from the caller's key, passed it to the witness as a hint, and then used only the
returned path — so a prover could return any attested person's path and be
admitted having never been attested by anyone. That is a soundness break rather
than a privacy leak: the contract admitted people it should have rejected. Both
proofs now assert `path.leaf == leaf` before checking membership. The attack and
the fix are demonstrated end to end at
[merkle-leaf-binding-probe](https://github.com/tomiin/merkle-leaf-binding-probe);
the binding costs 8 circuit rows and does not change `k`.

Worth recording why this survived a test suite. There was already a test called
*"fails for someone never attested"*, and it passed throughout. It used an honest
witness. A test suite that only ever exercises honest witnesses cannot detect a
witness-trust bug, whatever the test is named.

**4. Anonymity is bounded by enrolment.** Three enrolled people means one-in-three.
This matters at pilot scale and stops mattering at national scale.

**5. Two of three agencies is not protection from a government.**
It protects against one agency's breach, error, or corrupt insider. All three are
still the same state. Don't oversell it.

**6. Making age verification privacy-safe may make mandates spread.**
The strongest argument against requiring ID to access things online is that it
destroys privacy. Removing that objection makes such laws easier to pass. The
mitigation is in the design rather than in a policy promise: proofs answer exactly
one question, credentials expire, and there is no persistent identifier for a
verifier to accumulate.

**7. It excludes people without documents — and doubly so.**
Roughly 850 million people worldwide have no formal identification. Any system
anchored in government credentials locks them out, and requiring *two* agencies
raises that bar rather than lowering it. Threshold makes the forgery story
stronger and the inclusion story worse. A real deployment needs a route in for
people the state hasn't documented, and this project does not have one.

**8. The agencies become gatekeepers.**
If access depends on a live credential, whoever issues it can switch someone off.
That power gets used for mundane reasons (an administrative lapse) and occasionally
for bad ones. Deliberately scoping this to *optional* venues limits the blast
radius, and requiring two of three agencies means no single one can quietly drop a
person — but it does not eliminate the concern.

**9. Metadata can still identify you.**
Brave Research makes this point well: a proof is rarely seen in isolation. Combine
which agencies attested you, the site you're on, your IP and the time, and the
tuple can be far more identifying than the proof itself. Unlinkable pseudonyms do
not fix a linkable network layer.

**10. The cryptography here is unaudited.**
The contract compiles and its behaviour is covered by tests. That is not the same
as a security review, and published research has found subtle flaws in
zero-knowledge systems that were audited. Treat this as a design demonstration, not
something to deploy.

## Related work

This project doesn't claim to have invented privacy-preserving age verification.
The direction is well established and moving quickly — which is the point: it
suggests the architecture is right, not that it's original.

- **Google Wallet** shipped zero-knowledge age verification in 2025 (Bumble as a
  launch partner) — the largest wallet provider betting that age assurance becomes
  cryptographic rather than documentary.
- **The EU Digital Identity (EUDI) framework** includes a ZK age-verification
  protocol expected around the end of 2026.
- **The iGaming sector** is converging on ZK verification and *on-chain
  self-exclusion* standards, describing much the same pattern implemented here:
  a player self-excludes once, and other operators can check that status without
  learning who they are.
- **zkCreds, zkLogin, Polygon ID / Iden3** are the credential-system lineage this
  builds on, and **Semaphore**-style anonymous membership is the mechanism behind
  the Merkle proofs.
- **Regulatory pressure is real**: the UK ICO fined Reddit £14.5m in early 2026 for
  relying on self-declared age gates, while also warning that over-collecting data
  to verify age creates its own liability. That squeeze is the opening for
  approaches like this one.

**Where this differs** from most of the above: attestation requires **two of three
independent agencies** rather than one issuer; **self-exclusion is a first-class
action the user holds**, with real durations, extend-only semantics and a
reflection window; and **revocation works by expiry**, which sidesteps the
unlinkability problem rather than trading it away.

**A tension worth naming.** Brave Research points out that credential systems often
"phone home" — the issuer gets contacted at verification time and so learns where
and how often your ID is used. Threshold avoids that: proofs are checked against
on-chain state, so the agencies never learn where you went. Brave also notes that
privacy-preserving revocation is underdeveloped and hard to reconcile with
unlinkability. That's precisely the wall this design hit, and expiry-based renewal
is the answer it settled on — with the cost written down in the limits above.

## Why not banking

An earlier version of this aimed at bank KYC. It doesn't work, for reasons worth
recording:

- A bank legally must identify customers, screen names against sanctions lists, and
  file reports that name people. A pseudonym can't do any of that.
- Banks' downside is unlimited liability and their upside is a smaller breach
  surface. None would adopt it voluntarily.
- Most importantly: **exclusion from banking is existential.** Building a mechanism
  that can silently make someone unbankable everywhere, instantly, is a dangerous
  thing to hand anyone.

The same mechanism is *appropriate* where exclusion is proportionate and where the
person themselves holds the lever. That's the pivot: not identity for everything, but
eligibility for the places you choose to enter.

## Run it

Requires Node 20+ and the Compact compiler.

**Contract — compile and test:**

```bash
cd contract
npm install
npm run compact-fast     # compile (skip ZK key generation — fast)
npm test                 # 21 tests
```

**The dashboard:**

```bash
cd site
npm install
npm start                # http://localhost:5190
```

Every button in the dashboard executes the real compiled circuits.

### A walkthrough

1. **Agency tab** — attest Alice from the DMV, then switch to the Passport Office and
   attest her again. Notice what you never typed: no name, no date of birth, no
   document number.
2. **Individual tab** — Alice is eligible. Prove to the casino, approve the consent
   screen, and she's in. Prove to the adult platform too: **different code, same
   person.**
3. **Operator tab** — the console shows verifications and two numbers that are the
   entire pitch: *personal data held: none; ID documents stored: 0.*
4. **Self-exclude** for six months, then *Next day* and *Run daily renewal*. Watch the
   agencies get refused. Alice can no longer get into either site.
5. Try to shorten the exclusion — the contract refuses. Skip 180 days, request
   reinstatement, and note it *still* takes another seven days.

## What's tested

21 tests covering the two-of-three threshold, cross-operator unlinkability, daily
expiry and renewal, self-exclusion (including extend-only), the reinstatement term
and reflection window, and the property that an operator can't distinguish an
excluded person from an unenrolled one.

## Status

A proof of concept. The cryptography is real and executes; the agency integrations,
the wallet flow, and the accountable-authority design are not built yet.

Roadmap, roughly in order of importance:

- **Multi-party control of the registry.** One key advancing periods is fine for a
  demo and wrong for production.
- **Off-chain proof presentation.** Eligibility doesn't need to be a transaction at
  all — the site can verify a proof against on-chain roots as a free read. That's
  cheaper *and* more private, since no record of a verification exists anywhere.
- **Fee sponsorship.** Nobody should need to hold cryptocurrency to prove they're 18.
- **Wallet integration** (Lace) for the consent flow.
- **A real registry** for the "one human, one credential" rule.

---

Built on / for the [Midnight Network](https://midnight.network) using the
[Compact](https://docs.midnight.network) smart-contract language.
