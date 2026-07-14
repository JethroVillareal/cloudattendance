"""Import the real Node/ESP32 data/db.json records into SQLite."""

import json
import sys

from database import import_json_database


if __name__ == "__main__":
    result = import_json_database(make_backup="--no-backup" not in sys.argv)
    print("SQLite synchronized from data/db.json:")
    print(json.dumps(result, indent=2))
