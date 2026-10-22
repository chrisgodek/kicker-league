#!/usr/bin/env python3
"""Database helpers. DATABASE_URL comes from the environment or the project's .env file.

  python3 scripts/db.py apply      run supabase/schema.sql (safe to re-run)
"""
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def database_url():
    url = os.environ.get("DATABASE_URL")
    env = ROOT / ".env"
    if not url and env.exists():
        for line in env.read_text().splitlines():
            if line.strip().startswith("DATABASE_URL="):
                url = line.split("=", 1)[1].strip().strip('"').strip("'")
    if not url or "[YOUR-PASSWORD]" in url:
        sys.exit("DATABASE_URL is not set. Copy .env.example to .env and fill it in.")
    return url


def connect():
    import psycopg  # pip install "psycopg[binary]"
    return psycopg.connect(database_url())


def apply_schema():
    sql = (ROOT / "supabase" / "schema.sql").read_text()
    with connect() as conn:
        conn.execute(sql)
    print("Schema applied.")


if __name__ == "__main__":
    if sys.argv[1:] == ["apply"]:
        apply_schema()
    else:
        print(__doc__)
