// Threshold — demo backend.
//
// Holds one instance of the compiled Threshold contract and exposes it over a
// small REST API. Every /api call below executes the REAL Compact circuits.
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ThresholdSimulator, key, identityCommitment, pseudonymFor, TIER_PERIODS, REFLECTION_PERIODS,
} from '../contract/src/simulator.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const AGENCIES = [
  { id: 'dmv', label: 'State DMV' },
  { id: 'passport', label: 'Passport Office' },
  { id: 'federal', label: 'Federal Registry' },
];
const PEOPLE = [
  { id: 'alice', label: 'Alice' },
  { id: 'bob', label: 'Bob' },
  { id: 'chris', label: 'Chris' },
];
const OPERATORS = [
  { id: 'casino', label: 'Royal Flush Casino', kind: 'Gambling' },
  { id: 'adult', label: 'Velvet (18+)', kind: 'Adult platform' },
];
const TIERS = [
  { id: 0, label: '7 days', blurb: 'A short break.' },
  { id: 1, label: '30 days', blurb: 'A month away.' },
  { id: 2, label: '6 months', blurb: 'The standard self-exclusion term.' },
  { id: 3, label: '5 years', blurb: 'Long-term. Take this seriously.' },
];

const SK: Record<string, Uint8Array> = {
  registry: key('registry-operator'),
  dmv: key('dmv-agency'), passport: key('passport-agency'), federal: key('federal-agency'),
  alice: key('alice'), bob: key('bob'), chris: key('chris'),
};

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');

// --- demo bookkeeping (display only; the chain does not know this) ---
type Demo = {
  attestedThisPeriod: Record<string, string[]>;
  exclusion: Record<string, { tier: number; untilPeriod: number; clearAt: number | null }>;
  log: { period: number; text: string; kind: string }[];
  verifications: Record<string, { pseudonym: string; period: number }[]>;
};
let sim: ThresholdSimulator;
let demo: Demo;

function note(text: string, kind = 'info') {
  demo.log.unshift({ period: Number(sim.as('registry').currentPeriodNumber()), text, kind });
  demo.log = demo.log.slice(0, 40);
}

function reset() {
  sim = ThresholdSimulator.deploy(SK.registry, SK.dmv, SK.passport, SK.federal);
  for (const p of PEOPLE) sim.register(p.id, SK[p.id]);
  demo = {
    attestedThisPeriod: { alice: [], bob: [], chris: [] },
    exclusion: {},
    log: [],
    verifications: { casino: [], adult: [] },
  };
  note('Contract deployed. Three agencies registered.', 'good');
}
reset();

const periodNow = () => Number(sim.as('registry').currentPeriodNumber());

function personStatus(id: string) {
  const attested = demo.attestedThisPeriod[id] ?? [];
  const ex = demo.exclusion[id];
  const now = periodNow();
  let state: string;
  if (ex && (ex.clearAt === null || now < ex.clearAt)) state = 'excluded';
  else if (attested.length >= 2) state = 'eligible';
  else state = 'not-eligible';
  return {
    attested,
    state,
    exclusion: ex
      ? {
          tier: ex.tier,
          tierLabel: TIERS[ex.tier].label,
          periodsLeft: Math.max(0, ex.untilPeriod - now),
          canRequest: now >= ex.untilPeriod && ex.clearAt === null,
          clearIn: ex.clearAt === null ? null : Math.max(0, ex.clearAt - now),
        }
      : null,
  };
}

function snapshot() {
  const l = sim.getLedger();
  return {
    period: periodNow(),
    agencies: AGENCIES, people: PEOPLE, operators: OPERATORS, tiers: TIERS,
    reflection: REFLECTION_PERIODS,
    counts: {
      attestations: Number(l.attestationCount),
      verifications: Number(l.verificationCount),
      exclusions: Number(l.exclusionCount),
    },
    status: Object.fromEntries(PEOPLE.map(p => [p.id, personStatus(p.id)])),
    verifications: demo.verifications,
    log: demo.log,
  };
}

const ok = (res: any, extra = {}) => res.json({ ok: true, ...extra, ...snapshot() });
const fail = (res: any, e: any) => res.status(400).json({ ok: false, error: String(e?.message ?? e), ...snapshot() });

app.get('/api/state', (_req, res) => res.json(snapshot()));
app.post('/api/reset', (_req, res) => { reset(); ok(res); });

// An agency attests a person for the current period.
app.post('/api/attest', (req, res) => {
  const { agency, person } = req.body ?? {};
  try {
    sim.as(agency).attest(identityCommitment(SK[person]));
    const list = demo.attestedThisPeriod[person];
    if (!list.includes(agency)) list.push(agency);
    note(`${AGENCIES.find(a => a.id === agency)?.label} attested ${person}.`);
    ok(res);
  } catch (e) {
    note(`Attestation refused for ${person}.`, 'bad');
    fail(res, e);
  }
});

// The daily renewal batch: every agency re-attests everyone it can.
app.post('/api/renew', (_req, res) => {
  let refused = 0, done = 0;
  for (const p of PEOPLE) {
    for (const a of AGENCIES) {
      try {
        sim.as(a.id).attest(identityCommitment(SK[p.id]));
        const list = demo.attestedThisPeriod[p.id];
        if (!list.includes(a.id)) list.push(a.id);
        done++;
      } catch { refused++; }
    }
  }
  note(`Daily renewal: ${done} attestations issued, ${refused} refused (self-excluded).`, refused ? 'warn' : 'good');
  ok(res);
});

// Move the clock on a day. Credentials from the previous period go stale.
app.post('/api/advance', (_req, res) => {
  try {
    sim.as('registry').advancePeriod();
    demo.attestedThisPeriod = { alice: [], bob: [], chris: [] };
    note(`A new day began (period ${periodNow()}). All credentials from yesterday have expired.`, 'warn');
    ok(res);
  } catch (e) { fail(res, e); }
});

// A person proves eligibility to an operator.
app.post('/api/prove', (req, res) => {
  const { person, operator } = req.body ?? {};
  try {
    const p = sim.as(person).proveEligibility(key(operator));
    const entry = { pseudonym: hex(p), period: periodNow() };
    demo.verifications[operator].push(entry);
    note(`${OPERATORS.find(o => o.id === operator)?.label} verified a customer.`, 'good');
    res.json({ ok: true, pseudonym: hex(p), ...snapshot() });
  } catch (e) {
    note(`${OPERATORS.find(o => o.id === operator)?.label} refused a customer (not eligible).`, 'bad');
    fail(res, e);
  }
});

// Self-exclusion.
app.post('/api/self-exclude', (req, res) => {
  const { person, tier } = req.body ?? {};
  try {
    sim.as(person).selfExclude(Number(tier));
    const until = periodNow() + TIER_PERIODS[Number(tier)];
    demo.exclusion[person] = { tier: Number(tier), untilPeriod: until, clearAt: null };
    note(`Someone self-excluded for ${TIERS[Number(tier)].label}.`, 'warn');
    ok(res);
  } catch (e) { fail(res, e); }
});

app.post('/api/request-reinstatement', (req, res) => {
  const { person } = req.body ?? {};
  try {
    sim.as(person).requestReinstatement();
    demo.exclusion[person].clearAt = periodNow() + REFLECTION_PERIODS;
    note(`A reinstatement was requested. It takes effect after a ${REFLECTION_PERIODS}-day reflection window.`, 'info');
    ok(res);
  } catch (e) { fail(res, e); }
});

// Skip ahead n days (so a 6-month term is demonstrable), renewing as we go.
app.post('/api/skip', (req, res) => {
  const days = Math.min(Number(req.body?.days ?? 1), 2000);
  try {
    for (let i = 0; i < days; i++) {
      sim.as('registry').advancePeriod();
      demo.attestedThisPeriod = { alice: [], bob: [], chris: [] };
      for (const p of PEOPLE) for (const a of AGENCIES) {
        try {
          sim.as(a.id).attest(identityCommitment(SK[p.id]));
          const l = demo.attestedThisPeriod[p.id]; if (!l.includes(a.id)) l.push(a.id);
        } catch { /* excluded */ }
      }
    }
    note(`Skipped ${days} days (agencies renewed daily).`, 'info');
    ok(res);
  } catch (e) { fail(res, e); }
});

app.get('/api/pseudonym', (req, res) => {
  const person = String(req.query.person ?? ''), operator = String(req.query.operator ?? '');
  if (!SK[person]) return res.status(400).json({ error: 'unknown person' });
  res.json({ pseudonym: hex(pseudonymFor(SK[person], key(operator))) });
});

const PORT = process.env.PORT ?? 5190;
app.listen(PORT, () => console.log(`\n  Threshold → http://localhost:${PORT}\n`));
