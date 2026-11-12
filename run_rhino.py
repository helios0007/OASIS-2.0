"""Rhino model -> safe hours, from the command line.

Run:  python run_rhino.py data/rhino/sample_flat.3dm
Reads the room and windows from the model, simulates the heatwave week with
the nightly power cut, then re-simulates each single design change.
Materials, floor level and occupants use the baseline values (params.py).
"""
import json
import sys

import pandas as pd

from oasis.assess import assess
from oasis.from_rhino import read_model
from oasis.params import BASELINE


def main():
    if len(sys.argv) != 2:
        sys.exit("Usage: python run_rhino.py <model.3dm>")
    geometry, report = read_model(sys.argv[1])
    print(json.dumps(report, indent=2))

    summary, _, changes = assess(dict(BASELINE, **geometry))
    print("\nAs drawn:")
    print(json.dumps(summary, indent=2))
    print("\nSingle design changes, best first:")
    table = pd.DataFrame(changes).drop(columns="hourly")
    print(table.to_string(index=False))


if __name__ == "__main__":
    main()
