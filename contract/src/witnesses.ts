// Private state + witness implementations for the ZK-KYC contract.
//
// A holder's ONLY private state is their secret key. Everything else the proof
// needs (the Merkle paths showing which issuers attested them) is derived from
// public tree state at proving time — so a holder never has to store or manage
// attestation blobs, they just need their key.
import type { Ledger } from './managed/threshold/contract/index.js';

// Tree depth declared in zk-kyc.compact (HistoricMerkleTree<10, Bytes<32>>).
const TREE_DEPTH = 10;

export type ThresholdPrivateState = {
  // The holder's (or issuer's, or authority's) identity key. Never disclosed.
  secretKey: Uint8Array;
};

export const createPrivateState = (secretKey: Uint8Array): ThresholdPrivateState => ({
  secretKey,
});

// The runtime hands witnesses a context containing the current private state
// and a read-only view of the ledger.
type WitnessContext<L, PS> = {
  privateState: PS;
  ledger: L;
};

// The shape the compiler expects back for a MerkleTreePath<10, Bytes<32>>.
type PathValue = {
  leaf: Uint8Array;
  path: { sibling: { field: bigint }; goes_left: boolean }[];
};

// A well-formed but deliberately INVALID path.
//
// This is what makes the 2-of-3 threshold work without leaking anything: if an
// issuer has not attested this holder, we still have to hand the circuit a path
// of the right shape. This dummy recomputes to a root that matches no tree, so
// `checkRoot` returns false and that issuer simply counts as "no" — rather than
// the proof failing outright, which would reveal that the holder tried.
const dummyPath = (leaf: Uint8Array): PathValue => ({
  leaf,
  path: Array.from({ length: TREE_DEPTH }, () => ({
    sibling: { field: 0n },
    goes_left: false,
  })),
});

// Look up a real membership path for `leaf` in `tree`, falling back to the
// dummy when this issuer has not attested this holder for the current epoch.
const pathOrDummy = (
  tree: { findPathForLeaf(leaf: Uint8Array): unknown },
  leaf: Uint8Array,
): PathValue => {
  const found = tree.findPathForLeaf(leaf);
  return (found as unknown as PathValue) ?? dummyPath(leaf);
};

// Witness names must match the `witness` declarations in zk-kyc.compact.
export const witnesses = {
  localSecretKey: (
    context: WitnessContext<Ledger, ThresholdPrivateState>,
  ): [ThresholdPrivateState, Uint8Array] => [context.privateState, context.privateState.secretKey],

  dmvPath: (
    context: WitnessContext<Ledger, ThresholdPrivateState>,
    leaf: Uint8Array,
  ): [ThresholdPrivateState, PathValue] => [
    context.privateState,
    pathOrDummy(context.ledger.dmvTree, leaf),
  ],

  passportPath: (
    context: WitnessContext<Ledger, ThresholdPrivateState>,
    leaf: Uint8Array,
  ): [ThresholdPrivateState, PathValue] => [
    context.privateState,
    pathOrDummy(context.ledger.passportTree, leaf),
  ],

  federalPath: (
    context: WitnessContext<Ledger, ThresholdPrivateState>,
    leaf: Uint8Array,
  ): [ThresholdPrivateState, PathValue] => [
    context.privateState,
    pathOrDummy(context.ledger.federalTree, leaf),
  ],
};
