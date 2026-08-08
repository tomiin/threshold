// In-memory harness around the compiled Threshold contract.
// `as(name)` swaps the acting caller so `localSecretKey()` resolves to them.
import {
  Contract,
  type Ledger,
  ledger,
  pureCircuits,
} from './managed/threshold/contract/index.js';
import { type ThresholdPrivateState, createPrivateState, witnesses } from './witnesses.js';
import {
  type CircuitContext,
  type CircuitResults,
  type ContractAddress,
  QueryContext,
  sampleContractAddress,
  createConstructorContext,
  CostModel,
} from '@midnight-ntwrk/compact-runtime';
import * as utils from './utils/utils.js';

export const deployerCoinPublicKey = utils.toHexPadded('registry');

// Off-chain mirrors of the contract's pure circuits.
export const identityCommitment = (sk: Uint8Array): Uint8Array => pureCircuits.identityCommitment(sk);
export const issuerId = (sk: Uint8Array): Uint8Array => pureCircuits.issuerId(sk);
export const attestationLeaf = (idc: Uint8Array, p: Uint8Array, agency: Uint8Array): Uint8Array =>
  pureCircuits.attestationLeaf(idc, p, agency);
export const pseudonymFor = (sk: Uint8Array, verifierId: Uint8Array): Uint8Array =>
  pureCircuits.pseudonymFor(sk, verifierId);
export const nextPeriod = (p: Uint8Array): Uint8Array => pureCircuits.nextPeriod(p);

// Self-exclusion tiers, mirroring the contract.
export const TIER = { SEVEN_DAYS: 0, THIRTY_DAYS: 1, SIX_MONTHS: 2, FIVE_YEARS: 3 } as const;
export const TIER_PERIODS: Record<number, number> = { 0: 7, 1: 30, 2: 180, 3: 1825 };
export const REFLECTION_PERIODS = 7;

export const key = (label: string): Uint8Array => {
  const b = new Uint8Array(32);
  b.set(new TextEncoder().encode(label).slice(0, 32));
  return b;
};

export class ThresholdSimulator {
  readonly contract: Contract<ThresholdPrivateState>;
  circuitContext: CircuitContext<ThresholdPrivateState>;
  userPrivateStates: Record<string, ThresholdPrivateState>;
  updateUserPrivateState: (ps: ThresholdPrivateState) => void;
  contractAddress: ContractAddress;

  constructor(registrySk: Uint8Array, dmvId: Uint8Array, passportId: Uint8Array, federalId: Uint8Array) {
    this.contract = new Contract<ThresholdPrivateState>(witnesses);
    this.contractAddress = sampleContractAddress();
    const ps = createPrivateState(registrySk);
    const { currentPrivateState, currentContractState, currentZswapLocalState } =
      this.contract.initialState(
        createConstructorContext(ps, deployerCoinPublicKey),
        dmvId, passportId, federalId,
      );
    this.circuitContext = {
      currentPrivateState,
      currentZswapLocalState,
      currentQueryContext: new QueryContext(currentContractState.data, this.contractAddress),
      costModel: CostModel.initialCostModel(),
    };
    this.userPrivateStates = { registry: currentPrivateState };
    this.updateUserPrivateState = () => {};
  }

  static deploy(registrySk: Uint8Array, dmvSk: Uint8Array, passportSk: Uint8Array, federalSk: Uint8Array) {
    const sim = new ThresholdSimulator(
      registrySk,
      pureCircuits.issuerId(dmvSk),
      pureCircuits.issuerId(passportSk),
      pureCircuits.issuerId(federalSk),
    );
    sim.register('dmv', dmvSk);
    sim.register('passport', passportSk);
    sim.register('federal', federalSk);
    return sim;
  }

  register(name: string, secretKey: Uint8Array, forgePathForLeaf?: Uint8Array): void {
    this.userPrivateStates[name] = createPrivateState(secretKey, forgePathForLeaf);
  }

  as(name: string): ThresholdSimulator {
    const ps = this.userPrivateStates[name];
    if (!ps) throw new Error(`No private state for '${name}'.`);
    this.circuitContext = { ...this.circuitContext, currentPrivateState: ps };
    this.updateUserPrivateState = (next) => { this.userPrivateStates[name] = next; };
    return this;
  }

  getLedger(): Ledger {
    return ledger(this.circuitContext.currentQueryContext.state);
  }

  private commit<T>(r: CircuitResults<ThresholdPrivateState, T>): T {
    this.circuitContext = r.context;
    this.updateUserPrivateState(r.context.currentPrivateState);
    return r.result;
  }

  // ---- contract calls ----
  advancePeriod(): void {
    this.commit(this.contract.impureCircuits.advancePeriod(this.circuitContext));
  }
  attest(idc: Uint8Array): void {
    this.commit(this.contract.impureCircuits.attest(this.circuitContext, idc));
  }
  selfExclude(tier: number): void {
    this.commit(this.contract.impureCircuits.selfExclude(this.circuitContext, BigInt(tier)));
  }
  requestReinstatement(): void {
    this.commit(this.contract.impureCircuits.requestReinstatement(this.circuitContext));
  }
  proveEligibility(verifierId: Uint8Array): Uint8Array {
    return this.commit(this.contract.impureCircuits.proveEligibility(this.circuitContext, verifierId));
  }
  isVerified(pseudonym: Uint8Array): boolean {
    return this.commit(this.contract.impureCircuits.isVerified(this.circuitContext, pseudonym));
  }
  currentPeriod(): Uint8Array {
    return this.commit(this.contract.impureCircuits.currentPeriod(this.circuitContext));
  }
  currentPeriodNumber(): bigint {
    return this.commit(this.contract.impureCircuits.currentPeriodNumber(this.circuitContext));
  }

  // ---- helpers for tests / dashboard ----
  // Re-attest a set of people for the CURRENT period (what agencies do each day).
  reattest(issuers: string[], holders: { name: string; sk: Uint8Array }[]): void {
    for (const h of holders) {
      for (const i of issuers) this.as(i).attest(identityCommitment(h.sk));
    }
  }
}
