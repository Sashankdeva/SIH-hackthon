#!/usr/bin/env python3
"""Canary-value privacy proof — PS26171_Sprint_Plan.pdf, Privacy Guard Day 3.

Checks server/logs/reason_requests.jsonl (written by
server/app/middleware.py) for any of the known canary values seeded in
mock-site/privacy-test.html, PLUS any values you pass on the command
line. Run this AFTER driving the extension against a running server.

For a live demo, this is the strongest version of the proof: have the
examiner type their own real name/email/phone into the mock site
themselves, then run this with --value for each thing they typed. It
checks their input, not a pre-arranged list — you can't be accused of
having pre-scripted a value they chose on the spot.

Only pass values that were actually typed into a sensitive field
(name/email/phone/password/card). Don't pass the task_id shown in the
console or popup — it's an intentional, non-sensitive request
identifier, not PII, and will correctly show up as a "LEAK" since it's
supposed to be there. That's the tool working, not a bug.

Usage:
    python scripts/canary_check.py
    python scripts/canary_check.py --value "whatever.they.typed@example.com" --value "their real name"
"""

import argparse
import json
import sys
from pathlib import Path

LOG_PATH = Path(__file__).resolve().parent.parent / "server" / "logs" / "reason_requests.jsonl"

# The exact seed values in mock-site/privacy-test.html. Checked as raw
# substrings — if a real capture/redaction bug ever let one through
# partially masked, that would still contain enough of this string to
# match.
CANARY_VALUES = [
    "CANARY_EMAIL_12345",
    "CANARY_PHONE_5550100",
    "CANARY_PASSWORD_hunter2",
    "CANARY_NAME_Test Subject",
    "CANARY_CARD_4242424242424242",
]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument(
        "--value",
        action="append",
        default=[],
        metavar="TEXT",
        help="An additional value to check for — e.g. whatever an examiner just typed into the mock site. Repeatable.",
    )
    args = parser.parse_args()

    values_to_check = CANARY_VALUES + args.value

    if not LOG_PATH.exists():
        print(f"FAIL: no request log at {LOG_PATH}.")
        print("Drive the extension against a running server first.")
        return 1

    lines = LOG_PATH.read_text(encoding="utf-8").strip().splitlines()
    if not lines:
        print(f"FAIL: {LOG_PATH} exists but is empty — no /reason requests were logged.")
        return 1

    total_hits = 0
    for i, line in enumerate(lines, start=1):
        record = json.loads(line)
        raw = json.dumps(record.get("parsed_body"))
        hits = [v for v in values_to_check if v in raw]
        if hits:
            total_hits += len(hits)
            print(f"LEAK in request {i} (sha256={record['sha256'][:12]}...): {hits}")

    print(f"\nChecked {len(lines)} logged request(s) against {len(values_to_check)} value(s)"
          f" ({len(CANARY_VALUES)} built-in + {len(args.value)} custom).")
    if args.value:
        print(f"Custom values checked: {args.value}")
    if total_hits == 0:
        print("PASS: zero raw values reached the server.")
        return 0
    print(f"FAIL: {total_hits} raw value(s) reached the server.")
    return 1


if __name__ == "__main__":
    sys.exit(main())
