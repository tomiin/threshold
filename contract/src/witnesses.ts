// Private state + witness implementations for the ZK-KYC contract.
//
// A holder's ONLY private state is their secret key. Everything the proof needs
// (which agencies attested them, and the Merkle paths proving it) is derived
// from public tree state at proving time, so a holder never stores attestation
// blobs. They just need their key.
import type { Ledger } from './managed/threshold/contract/index.js';
import { pureCircuits } from './managed/threshold/contract/index.js';

// Tree depth declared in threshold.compact (HistoricMerkleTree<10, Bytes<32>>).
const TREE_DEPTH = 10;

export type ThresholdPrivateState = {
  // The holder's (or issuer's, or authority's) identity key. Never disclosed.
  secretKey: Uint8Array;
  // Test-only. Forces the path witnesses to return the path for SOMEBODY ELSE'S
  // leaf. That is exactly what a malicious prover would do, since the witness
  // runs on their machine. Used by the path-binding regression test.
  forgePathForLeaf?: Uint8Array;
};

export const createPrivateState = (
  secretKey: Uint8Array,
  forgePathForLeaf?: Uint8Array,
): ThresholdPrivateState => ({ secretKey, forgePathForLeaf });

type WitnessContext<L, PS> = {
  privateState: PS;
  ledger: L;
};

// The shape the compiler expects back for a MerkleTreePath<10, Bytes<32>>.
type PathValue = {
  leaf: Uint8Array;
  path: { sibling: { field: bigint }; goes_left: boolean }[];
};

// A well-formed but deliberately invalid path, used when the holder does not
// have the attestation being asked for. It recomputes to a root matching no
// tree, so `checkRoot` fails and the circuit's own assert fires with a readable
// message rather than the witness throwing an opaque error.
//
// Note this is NOT the old dummy-path trick. Previously a dummy stood in for a
// missing agency and the resulting FALSE was published, which is what leaked the
// attestation pattern. Now both proofs must succeed, so a dummy only ever
// produces a failed transaction, never a published false.
const dummyPath = (leaf: Uint8Array): PathValue => ({
  leaf,
  path: Array.from({ length: TREE_DEPTH }, () => ({
    sibling: { field: 0n },
    goes_left: false,
  })),
});

type Tree = { findPathForLeaf(leaf: Uint8Array): unknown };

// Which agencies have actually attested this holder for the current period.
// Returns their tags in ledger order. The circuit only ever sees two of them,
// and never learns which two.
const attestingAgencies = (ledger: Ledger, sk: Uint8Array): Uint8Array[] => {
  const idc = pureCircuits.identityCommitment(sk);
  const tags = [ledger.issuerDmv, ledger.issuerPassport, ledger.issuerFederal];
  return tags.filter((tag) => {
    const leaf = pureCircuits.attestationLeaf(idc, ledger.period, tag);
    return (ledger.attestTree as unknown as Tree).findPathForLeaf(leaf) != null;
  });
};

// Pick the nth agency that attested this holder.
//
// The filler matters. It has to be DISTINCT per slot, not a shared zero value.
// If both slots fell back to the same bytes, a holder with no attestations at
// all would trip the "same agency" assert, while a holder with exactly one
// would trip the membership assert — so the failure message would tell you
// which of the two you were looking at. Distinct fillers push every failure
// onto the membership assert, and every rejection reads the same.
const nthAgency = (ledger: Ledger, sk: Uint8Array, n: number): Uint8Array => {
  const found = attestingAgencies(ledger, sk)[n];
  if (found) return found;
  const filler = new Uint8Array(32);
  filler[0] = 0xff;
  filler[1] = n;
  return filler;
};

const pathFor = (
  ledger: Ledger,
  ps: ThresholdPrivateState,
  leaf: Uint8Array,
): PathValue => {
  const target = ps.forgePathForLeaf ?? leaf;
  const found = (ledger.attestTree as unknown as Tree).findPathForLeaf(target);
  return (found as unknown as PathValue) ?? dummyPath(target);
};

// Witness names must match the `witness` declarations in threshold.compact.
export const witnesses = {
  localSecretKey: (
    context: WitnessContext<Ledger, ThresholdPrivateState>,
  ): [ThresholdPrivateState, Uint8Array] => [context.privateState, context.privateState.secretKey],

  attestorA: (
    { privateState, ledger }: WitnessContext<Ledger, ThresholdPrivateState>,
  ): [ThresholdPrivateState, Uint8Array] =>
    [privateState, nthAgency(ledger, privateState.secretKey, 0)],

  attestorB: (
    { privateState, ledger }: WitnessContext<Ledger, ThresholdPrivateState>,
  ): [ThresholdPrivateState, Uint8Array] =>
    [privateState, nthAgency(ledger, privateState.secretKey, 1)],

  attestPathA: (
    { privateState, ledger }: WitnessContext<Ledger, ThresholdPrivateState>,
    leaf: Uint8Array,
  ): [ThresholdPrivateState, PathValue] => [privateState, pathFor(ledger, privateState, leaf)],

  attestPathB: (
    { privateState, ledger }: WitnessContext<Ledger, ThresholdPrivateState>,
    leaf: Uint8Array,
  ): [ThresholdPrivateState, PathValue] => [privateState, pathFor(ledger, privateState, leaf)],
};
