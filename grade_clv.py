#!/usr/bin/env python3
"""
Root entry point for the CLV Validation Engine.
Usage: python3 grade_clv.py [--snapshots PATH] [--output PATH] [--hurdle 0.10]
"""

import sys
from pathlib import Path

# Add project root to sys.path
BASE_DIR = Path(__file__).resolve().parent
if str(BASE_DIR) not in sys.path:
    sys.path.insert(0, str(BASE_DIR))

from src.grade_clv import main

if __name__ == "__main__":
    main()
