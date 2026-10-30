"""decision_2d — precommitted pilot harness for the Decision 2D historical-quote
validation study.

Status: awaiting licensed quote acquisition. Every module here is
code-correctness-tested against SYNTHETIC fixtures only; no results claim is
made or implied until `run_pilot.py` executes against a licensed quote store
under the frozen contract.

Design rules enforced across the package:
  * the frozen contract (artifacts/decision_2d_contract.json) governs; hashes
    are verified before any evaluation (refit lock);
  * quotes are licensed and timestamped, never synthetic, in a vendor-agnostic
    canonical schema;
  * strictly point-in-time selection with explicit leakage assertions;
  * quote availability and missingness are preserved and reported (a historical
    quote is not proof of executability);
  * settlement handles pushes and voids exactly as the contract specifies;
  * every economic metric carries a game-clustered bootstrap CI.
"""

__version__ = "0.1.0"
