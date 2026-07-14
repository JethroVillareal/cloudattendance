from __future__ import annotations

import json
import sqlite3

from database import DB_PATH


def main() -> None:
    if not DB_PATH.exists():
        raise SystemExit(2)
    connection = sqlite3.connect(DB_PATH)
    try:
        row = connection.execute(
            "SELECT state_json FROM state_snapshots WHERE state_key = ?", ("primary",)
        ).fetchone()
    except sqlite3.OperationalError:
        row = None
    finally:
        connection.close()
    if not row:
        raise SystemExit(3)
    state = json.loads(row[0])
    print(json.dumps(state, ensure_ascii=False, separators=(",", ":")))


if __name__ == "__main__":
    main()
