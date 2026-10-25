#!/usr/bin/env python3
"""Standalone, offline evidence-chain verifier.

    python verify.py postmortem.json

Recomputes every evidence leaf from its payload, rebuilds the Merkle root through the
embedded inclusion proofs, and verifies the Ed25519 signature over
(verdict || root || timestamp). No network, no server, no other project files needed
beyond `cryptography`. Prints VERIFIED or TAMPERED and exits non-zero on tamper.
"""
import json
import sys

from ic import enable_utf8_stdout
from ic.evidence_chain import verify_postmortem


def main(argv: list[str]) -> int:
    enable_utf8_stdout()
    if len(argv) != 2:
        print("usage: python verify.py <postmortem.json>", file=sys.stderr)
        return 2
    with open(argv[1], "r", encoding="utf-8") as f:
        doc = json.load(f)

    try:
        ok, msgs = verify_postmortem(doc)
    except (KeyError, TypeError, ValueError) as e:   # not a sealed postmortem: never "verified"
        print(f"MALFORMED: not a sealed postmortem ({type(e).__name__}: {e})")
        print("TAMPERED ❌")
        return 1

    v = doc.get("verdict", {})
    print(f"incident:    {v.get('incident_id')}")
    print(f"root_cause:  {v.get('root_cause_id')}  (posterior {v.get('posterior')})")
    print(f"merkle_root: {doc['signing']['merkle_root']}")
    print(f"leaves:      {len(doc.get('evidence', []))}")
    print("-" * 60)
    for m in msgs:
        print(f"  {m}")
    print("-" * 60)
    print("VERIFIED ✅" if ok else "TAMPERED ❌")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
