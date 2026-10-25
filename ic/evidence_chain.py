"""Evidence chain — hash every cited evidence item into a Merkle tree, sign the
verdict + root with Ed25519. Produces a `postmortem.json` that `verify.py` can check
fully offline.
"""
from __future__ import annotations

import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import (Ed25519PrivateKey,
                                                               Ed25519PublicKey)

from .models import EvidenceItem, Verdict, canonical_json

KEY_DIR = Path("keys")
PRIV_PATH = KEY_DIR / "ic_ed25519.pem"


# --- key management --------------------------------------------------------

def _load_or_create_key() -> Ed25519PrivateKey:
    if PRIV_PATH.exists():
        return serialization.load_pem_private_key(PRIV_PATH.read_bytes(), password=None)
    KEY_DIR.mkdir(exist_ok=True)
    key = Ed25519PrivateKey.generate()
    PRIV_PATH.write_bytes(key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    ))
    return key


def public_key_hex(key: Ed25519PrivateKey) -> str:
    return key.public_key().public_bytes(
        encoding=serialization.Encoding.Raw,
        format=serialization.PublicFormat.Raw,
    ).hex()


# --- Merkle tree -----------------------------------------------------------

def _hash_pair(a: bytes, b: bytes) -> bytes:
    return hashlib.sha256(a + b).digest()


def merkle_root_and_proofs(leaf_hex: list[str]) -> tuple[str, list[list[dict]]]:
    """Return (root_hex, proofs) where proofs[i] is the inclusion path for leaf i.
    Each proof step is {"sibling": hex, "side": "L"|"R"} (side of the sibling)."""
    if not leaf_hex:
        empty = hashlib.sha256(b"").hexdigest()
        return empty, []
    level = [bytes.fromhex(h) for h in leaf_hex]
    proofs: list[list[dict]] = [[] for _ in leaf_hex]
    index_map = list(range(len(leaf_hex)))  # leaf-index -> position in current level

    while len(level) > 1:
        nxt: list[bytes] = []
        pos_map: dict[int, int] = {}
        for i in range(0, len(level), 2):
            left = level[i]
            right = level[i + 1] if i + 1 < len(level) else level[i]  # duplicate odd
            parent = _hash_pair(left, right)
            pos_map[i] = pos_map[i + 1 if i + 1 < len(level) else i] = len(nxt)
            nxt.append(parent)
        # record sibling for every leaf, based on its current position
        for leaf_i, cur in enumerate(index_map):
            if cur is None:
                continue
            if cur % 2 == 0:
                sib = cur + 1 if cur + 1 < len(level) else cur
                proofs[leaf_i].append({"sibling": level[sib].hex(), "side": "R"})
            else:
                proofs[leaf_i].append({"sibling": level[cur - 1].hex(), "side": "L"})
        index_map = [pos_map[c] for c in index_map]
        level = nxt

    return level[0].hex(), proofs


def _apply_proof(leaf_hex: str, proof: list[dict]) -> str:
    cur = bytes.fromhex(leaf_hex)
    for step in proof:
        sib = bytes.fromhex(step["sibling"])
        cur = _hash_pair(sib, cur) if step["side"] == "L" else _hash_pair(cur, sib)
    return cur.hex()


# --- signing basis ---------------------------------------------------------

def _verdict_core(verdict_dict: dict) -> dict:
    """The verdict as signed — excluding the fields derived from signing itself."""
    return {k: v for k, v in verdict_dict.items() if k not in ("merkle_root", "signature")}


def signing_basis(verdict_dict: dict, merkle_root: str, timestamp: str) -> str:
    return canonical_json(_verdict_core(verdict_dict)) + merkle_root + timestamp


# --- seal / write ----------------------------------------------------------

def seal(verdict: Verdict, items: list[EvidenceItem], timestamp: Optional[str] = None) -> dict:
    key = _load_or_create_key()
    timestamp = timestamp or datetime.now(timezone.utc).isoformat()
    leaf_hex = [it.content_hash() for it in items]
    root, proofs = merkle_root_and_proofs(leaf_hex)
    basis = signing_basis(verdict.model_dump(), root, timestamp)
    signature = key.sign(basis.encode("utf-8")).hex()
    return {
        "merkle_root": root,
        "signature": signature,
        "public_key": public_key_hex(key),
        "timestamp": timestamp,
        "leaf_hex": leaf_hex,
        "proofs": proofs,
    }


def write_postmortem(verdict: Verdict, items: list[EvidenceItem], path: str = "postmortem.json",
                     sealed: Optional[dict] = None) -> str:
    sealed = sealed or seal(verdict, items)
    evidence_out = []
    for i, it in enumerate(items):
        evidence_out.append({
            "source_type": it.source_type,
            "source_uri": it.source_uri,
            "retrieved_at": it.retrieved_at,
            "measures": it.measures,
            "probe_id": it.probe_id,
            "payload": it.payload,
            "leaf_hash": sealed["leaf_hex"][i],
            "proof": sealed["proofs"][i],
        })
    doc = {
        "verdict": verdict.model_dump(),
        "signing": {
            "timestamp": sealed["timestamp"],
            "merkle_root": sealed["merkle_root"],
            "signature": sealed["signature"],
            "public_key": sealed["public_key"],
        },
        "evidence": evidence_out,
    }
    Path(path).write_text(json.dumps(doc, indent=2))
    return path


# --- verification (shared by verify.py) ------------------------------------

def verify_postmortem(doc: dict) -> tuple[bool, list[str]]:
    """Recompute leaves from embedded evidence, rebuild the root via inclusion proofs,
    verify the Ed25519 signature. Returns (ok, messages)."""
    msgs: list[str] = []
    signing = doc["signing"]
    root = signing["merkle_root"]
    ok = True

    # 1. recompute each leaf from its evidence payload and check the inclusion proof.
    for e in doc["evidence"]:
        recomputed = hashlib.sha256(
            (canonical_json(e["payload"]) + e["source_uri"] + str(e["retrieved_at"]))
            .encode("utf-8")).hexdigest()
        if recomputed != e["leaf_hash"]:
            ok = False
            msgs.append(f"TAMPERED leaf: {e['source_uri']} (hash mismatch)")
            continue
        if _apply_proof(recomputed, e["proof"]) != root:
            ok = False
            msgs.append(f"BROKEN proof: {e['source_uri']} does not chain to the root")

    # 1b. completeness: the signed verdict lists every evidence ref it cites, so a leaf removed
    #     from the file (each remaining proof still checks out) is caught here.
    embedded = {e["source_uri"] for e in doc["evidence"]}
    missing = sorted(set(doc.get("verdict", {}).get("evidence_refs") or []) - embedded)
    if missing:
        ok = False
        msgs.append(f"MISSING evidence: {len(missing)} cited leaf(s) removed, e.g. {missing[0]}")

    # 2. verify the signature over verdict-core || root || timestamp.
    basis = signing_basis(doc["verdict"], root, signing["timestamp"])
    try:
        pub = Ed25519PublicKey.from_public_bytes(bytes.fromhex(signing["public_key"]))
        pub.verify(bytes.fromhex(signing["signature"]), basis.encode("utf-8"))
        msgs.append("signature OK")
    except Exception:
        ok = False
        msgs.append("TAMPERED: signature does not verify over (verdict || root || timestamp)")

    return ok, msgs
