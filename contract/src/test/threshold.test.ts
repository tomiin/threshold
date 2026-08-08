import { describe, it, expect } from 'vitest';
import {
  ThresholdSimulator, key, identityCommitment, pseudonymFor, nextPeriod,
  attestationLeaf, TIER, TIER_PERIODS, REFLECTION_PERIODS,
} from '../simulator.js';

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');

const REGISTRY = key('registry-operator');
const DMV = key('dmv-agency');
const PASSPORT = key('passport-agency');
const FEDERAL = key('federal-agency');
const ALICE = key('alice');
const BOB = key('bob');
const OUTSIDER = key('outsider');
const CASINO = key('casino-op');
const ADULT = key('adult-op');

const fresh = () => {
  const s = ThresholdSimulator.deploy(REGISTRY, DMV, PASSPORT, FEDERAL);
  s.register('alice', ALICE);
  s.register('bob', BOB);
  s.register('outsider', OUTSIDER);
  return s;
};
const attestBy = (s: ThresholdSimulator, issuers: string[], sk: Uint8Array) => {
  for (const i of issuers) s.as(i).attest(identityCommitment(sk));
};
// Move the clock forward n periods, re-attesting the given people each period.
const advance = (s: ThresholdSimulator, n: number, reattest: { who: string[]; sk: Uint8Array }[] = []) => {
  for (let i = 0; i < n; i++) {
    s.as('registry').advancePeriod();
    for (const r of reattest) attestBy(s, r.who, r.sk);
  }
};

describe('setup', () => {
  it('registers the registry operator and the three agencies', () => {
    const l = fresh().getLedger();
    expect(hex(l.issuerDmv)).not.toBe(hex(l.issuerPassport));
    expect(l.periodNumber).toBe(0n);
  });
});

describe('eligibility: two of three agencies', () => {
  it('passes with two agencies', () => {
    const s = fresh();
    attestBy(s, ['dmv', 'passport'], ALICE);
    const p = s.as('alice').proveEligibility(CASINO);
    expect(hex(p)).toBe(hex(pseudonymFor(ALICE, CASINO)));
  });

  it('fails with only one agency', () => {
    const s = fresh();
    attestBy(s, ['dmv'], ALICE);
    expect(() => s.as('alice').proveEligibility(CASINO)).toThrow(/not attested by two agencies/i);
  });

  it('fails for someone never attested', () => {
    const s = fresh();
    expect(() => s.as('outsider').proveEligibility(CASINO)).toThrow(/not attested by two agencies/i);
  });

  it('rejects attestation from a non-agency', () => {
    const s = fresh();
    expect(() => s.as('outsider').attest(identityCommitment(ALICE)))
      .toThrow(/not a registered agency/i);
  });
});

describe('unlinkability across operators', () => {
  it('a casino and an adult site see DIFFERENT pseudonyms for the same person', () => {
    const s = fresh();
    attestBy(s, ['dmv', 'passport'], ALICE);
    const atCasino = s.as('alice').proveEligibility(CASINO);
    const atAdult = s.as('alice').proveEligibility(ADULT);
    expect(hex(atCasino)).not.toBe(hex(atAdult));
  });

  it('the same operator sees a stable pseudonym for a returning person', () => {
    const s = fresh();
    attestBy(s, ['dmv', 'passport'], ALICE);
    expect(hex(s.as('alice').proveEligibility(CASINO)))
      .toBe(hex(s.as('alice').proveEligibility(CASINO)));
  });
});

describe('short-lived credentials', () => {
  it('an attestation expires when the period turns', () => {
    const s = fresh();
    attestBy(s, ['dmv', 'passport'], ALICE);
    expect(() => s.as('alice').proveEligibility(CASINO)).not.toThrow();

    s.as('registry').advancePeriod();
    expect(() => s.as('alice').proveEligibility(CASINO)).toThrow(/not attested by two agencies/i);
  });

  it('re-attestation in the new period restores eligibility', () => {
    const s = fresh();
    attestBy(s, ['dmv', 'passport'], ALICE);
    s.as('registry').advancePeriod();
    attestBy(s, ['dmv', 'passport'], ALICE);
    expect(() => s.as('alice').proveEligibility(CASINO)).not.toThrow();
  });

  it('advances the period tag deterministically', () => {
    const s = fresh();
    const before = s.as('registry').currentPeriod();
    s.as('registry').advancePeriod();
    expect(hex(s.as('registry').currentPeriod())).toBe(hex(nextPeriod(before)));
    expect(s.as('registry').currentPeriodNumber()).toBe(1n);
  });
});

describe('self-exclusion', () => {
  it('THE POINT: excluding yourself locks you out of EVERY operator at the next period', () => {
    const s = fresh();
    attestBy(s, ['dmv', 'passport'], ALICE);
    expect(() => s.as('alice').proveEligibility(CASINO)).not.toThrow();

    s.as('alice').selfExclude(TIER.SIX_MONTHS);

    // Next period: agencies try to re-attest everyone, but Alice is refused.
    s.as('registry').advancePeriod();
    expect(() => s.as('dmv').attest(identityCommitment(ALICE))).toThrow(/self-excluded/i);

    // So she holds no valid credential — at any operator.
    expect(() => s.as('alice').proveEligibility(CASINO)).toThrow(/not attested by two agencies/i);
    expect(() => s.as('alice').proveEligibility(ADULT)).toThrow(/not attested by two agencies/i);
  });

  it('does not affect anyone else', () => {
    const s = fresh();
    attestBy(s, ['dmv', 'passport'], ALICE);
    attestBy(s, ['dmv', 'passport'], BOB);
    s.as('alice').selfExclude(TIER.THIRTY_DAYS);
    advance(s, 1, [{ who: ['dmv', 'passport'], sk: BOB }]);
    expect(() => s.as('bob').proveEligibility(CASINO)).not.toThrow();
  });

  it('can be EXTENDED to a longer tier', () => {
    const s = fresh();
    s.as('alice').selfExclude(TIER.SEVEN_DAYS);
    expect(() => s.as('alice').selfExclude(TIER.SIX_MONTHS)).not.toThrow();
  });

  it('can NEVER be shortened — no 2am change of mind', () => {
    const s = fresh();
    s.as('alice').selfExclude(TIER.SIX_MONTHS);
    expect(() => s.as('alice').selfExclude(TIER.SEVEN_DAYS))
      .toThrow(/extended but never shortened/i);
  });
});

describe('reinstatement', () => {
  it('cannot be requested before the chosen term has run', () => {
    const s = fresh();
    s.as('alice').selfExclude(TIER.THIRTY_DAYS);
    advance(s, 5);
    expect(() => s.as('alice').requestReinstatement())
      .toThrow(/has not finished/i);
  });

  it('requires a request — the term simply running out is not enough', () => {
    const s = fresh();
    s.as('alice').selfExclude(TIER.SEVEN_DAYS);
    advance(s, TIER_PERIODS[TIER.SEVEN_DAYS] + 1);
    // No request made: agencies still refuse.
    expect(() => s.as('dmv').attest(identityCommitment(ALICE))).toThrow(/self-excluded/i);
  });

  it('still holds you through the reflection window after requesting', () => {
    const s = fresh();
    s.as('alice').selfExclude(TIER.SEVEN_DAYS);
    advance(s, TIER_PERIODS[TIER.SEVEN_DAYS]);
    s.as('alice').requestReinstatement();
    advance(s, 2); // less than the reflection window
    expect(() => s.as('dmv').attest(identityCommitment(ALICE)))
      .toThrow(/reflection window/i);
  });

  it('lets you back in after the term AND the reflection window', () => {
    const s = fresh();
    s.as('alice').selfExclude(TIER.SEVEN_DAYS);
    advance(s, TIER_PERIODS[TIER.SEVEN_DAYS]);
    s.as('alice').requestReinstatement();
    advance(s, REFLECTION_PERIODS);
    attestBy(s, ['dmv', 'passport'], ALICE);
    expect(() => s.as('alice').proveEligibility(CASINO)).not.toThrow();
  });

  it('cannot be requested by someone who never excluded themselves', () => {
    const s = fresh();
    expect(() => s.as('bob').requestReinstatement()).toThrow(/not currently excluded/i);
  });
});

describe('operator-side lookup', () => {
  it('reports a pseudonym as verified after a successful proof', () => {
    const s = fresh();
    attestBy(s, ['dmv', 'passport'], ALICE);
    const p = s.as('alice').proveEligibility(CASINO);
    expect(s.as('alice').isVerified(p)).toBe(true);
  });

  it('an operator cannot tell an excluded person from an unenrolled one', () => {
    const s = fresh();
    // Both simply fail to produce a proof; nothing distinguishes the reasons.
    s.as('alice').selfExclude(TIER.SIX_MONTHS);
    advance(s, 1);
    expect(() => s.as('alice').proveEligibility(CASINO)).toThrow(/not attested by two agencies/i);
    expect(() => s.as('outsider').proveEligibility(CASINO)).toThrow(/not attested by two agencies/i);
  });
});

// Regression tests for the two flaws the single-tree rewrite closes.
//
// 1. Disclosure. Three per-agency trees meant three checkRoot calls, and
//    checkRoot publishes its result, so the transcript spelled out exactly
//    which agencies had attested a caller. One shared tree with the agency in
//    the leaf means both checks must pass, so every successful proof publishes
//    the same two values.
//
// 2. Soundness. merkleTreePathRoot hashes the path's OWN leaf, and the witness
//    runs on the prover's machine. Without binding the returned path to the
//    leaf the circuit derived, anyone could present an attested person's path
//    and be admitted having never been attested.
//    See github.com/tomiin/merkle-leaf-binding-probe.
describe('path binding', () => {
  it('rejects a path belonging to a genuinely attested person', () => {
    const s = fresh();
    attestBy(s, ['dmv', 'passport'], ALICE);

    // Mallory has no attestations. Her witness returns Alice's DMV path.
    const l = s.getLedger();
    const aliceDmvLeaf = attestationLeaf(identityCommitment(ALICE), l.period, l.issuerDmv);
    s.register('mallory', key('mallory'), aliceDmvLeaf);

    expect(() => s.as('mallory').proveEligibility(CASINO))
      .toThrow(/does not match this holder/);
  });

  it('still admits the rightful holder', () => {
    const s = fresh();
    attestBy(s, ['dmv', 'passport'], ALICE);
    expect(() => s.as('alice').proveEligibility(CASINO)).not.toThrow();
  });
});

describe('failures are indistinguishable', () => {
  // Whatever the reason a proof fails, it fails the same way. An operator
  // watching rejections learns nothing about which case they are looking at.
  it('reads identically for nobody, one agency, and self-excluded', () => {
    const grab = (fn: () => void): string => {
      try { fn(); return 'NO THROW'; } catch (e) { return (e as Error).message; }
    };

    const never = grab(() => fresh().as('outsider').proveEligibility(CASINO));

    const s1 = fresh();
    attestBy(s1, ['dmv'], ALICE);
    const one = grab(() => s1.as('alice').proveEligibility(CASINO));

    const s2 = fresh();
    attestBy(s2, ['dmv', 'passport'], ALICE);
    s2.as('alice').selfExclude(TIER.SIX_MONTHS);
    advance(s2, 1);
    const excluded = grab(() => s2.as('alice').proveEligibility(CASINO));

    expect(one).toBe(never);
    expect(excluded).toBe(never);
    expect(never).toMatch(/not attested by two agencies/);
  });
});
