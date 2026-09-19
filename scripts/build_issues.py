#!/usr/bin/env python3
"""
Rebuilds issues.json from whatever PDFs are sitting in issues/.

Nobody should need to run this by hand — the GitHub Action does it automatically
every time a PDF is added or removed. It exists so that publishing an issue is
"upload the file", with no JSON to edit.

Filenames are read loosely, so all of these work:
    2026-10.pdf
    2026-10-october-issue.pdf
    October 2026.pdf
    oct-2026.pdf
A file with no recognisable month is skipped and reported, rather than silently
vanishing from the site.
"""

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ISSUES_DIR = ROOT / "issues"
MANIFEST = ROOT / "issues.json"
TITLE = "The Edwardsburg Voice"

MONTHS = {
    "january": 1, "jan": 1, "february": 2, "feb": 2, "march": 3, "mar": 3,
    "april": 4, "apr": 4, "may": 5, "june": 6, "jun": 6, "july": 7, "jul": 7,
    "august": 8, "aug": 8, "september": 9, "sep": 9, "sept": 9,
    "october": 10, "oct": 10, "november": 11, "nov": 11, "december": 12, "dec": 12,
}
MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July",
               "August", "September", "October", "November", "December"]


def parse_year_month(stem):
    """Return (year, month) from a filename stem, or None if we can't tell."""
    # 2026-10 / 2026_10 / 2026.10 anywhere in the name
    m = re.search(r"(20\d{2})[-_. ](0[1-9]|1[0-2])", stem)
    if m:
        return int(m.group(1)), int(m.group(2))

    lowered = stem.lower()
    # "October 2026", "oct-2026", "2026 october"
    for name, num in MONTHS.items():
        pattern = rf"(?:^|[^a-z]){re.escape(name)}(?:[^a-z]|$)"
        if re.search(pattern, lowered):
            year = re.search(r"(20\d{2})", stem)
            if year:
                return int(year.group(1)), num
    return None


def main():
    if not ISSUES_DIR.is_dir():
        print(f"No {ISSUES_DIR} directory; nothing to do.")
        return 0

    found, skipped = [], []
    for pdf in sorted(ISSUES_DIR.glob("*.pdf")):
        parsed = parse_year_month(pdf.stem)
        if not parsed:
            skipped.append(pdf.name)
            continue
        year, month = parsed
        found.append({
            "id": f"{year:04d}-{month:02d}",
            "label": f"{MONTH_NAMES[month - 1]} {year}",
            "file": f"issues/{pdf.name}",
        })

    # Newest first — the site shows issues[0] as the current issue.
    found.sort(key=lambda i: i["id"], reverse=True)

    # Two files claiming the same month would give the viewer duplicate ids.
    seen, issues = set(), []
    for issue in found:
        if issue["id"] in seen:
            skipped.append(f"{issue['file']} (duplicate of {issue['id']})")
            continue
        seen.add(issue["id"])
        issues.append(issue)

    for name in skipped:
        print(f"SKIPPED: {name} — no month I could read in the filename.")

    if not issues:
        print("ERROR: no usable PDFs found; leaving issues.json alone.")
        return 1

    MANIFEST.write_text(
        json.dumps({"title": TITLE, "issues": issues}, indent=2) + "\n",
        encoding="utf-8",
    )
    print(f"Wrote {MANIFEST.name} with {len(issues)} issue(s):")
    for issue in issues:
        print(f"  {issue['label']:<20} {issue['file']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
