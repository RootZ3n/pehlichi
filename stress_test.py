#!/usr/bin/env python3
"""Stress test: 100 threads appending IDs and timestamps to one log file.

Shared across the Trio, so this file is byte-identical in Pehlichi, Loony-Luna and
Mad-Ptah. It is the union of the behaviour the three copies had drifted into:

  * an absolute log path, so a run never writes into the repository it was started from
    (one copy used a bare relative name and left its log behind in the working tree);
  * a NUM_THREADS constant rather than a hardcoded literal repeated in three places;
  * elapsed timing and an explicit missing-log guard;
  * verification by *identity* -- every expected ID present, and nothing unexpected --
    rather than by counting lines, which cannot tell a lost entry from a duplicated one;
  * an exit status that reflects the result, so the script is usable from a runner.

The appends are deliberately unsynchronised. Serialising them behind a mutex would make
the test pass by construction and stop it exercising the thing it exists to exercise:
whether concurrent O_APPEND writes from many threads survive intact.
"""

import os
import threading
import time

LOG_FILE = "/tmp/stress_test.log"
NUM_THREADS = 100


def writer(thread_id: int) -> None:
    """Append this thread's ID and timestamp as one delimited record."""
    timestamp = time.time()
    entry = f"{thread_id}|{timestamp:.6f}\n"
    with open(LOG_FILE, "a") as handle:
        handle.write(entry)


def main() -> bool:
    if os.path.exists(LOG_FILE):
        os.remove(LOG_FILE)

    print(f"Spawning {NUM_THREADS} threads...")
    started = time.time()

    threads = []
    for thread_id in range(NUM_THREADS):
        thread = threading.Thread(target=writer, args=(thread_id,))
        threads.append(thread)
        thread.start()

    for thread in threads:
        thread.join()

    elapsed = time.time() - started
    print(f"All threads finished in {elapsed:.4f} seconds. Reading back log...")

    if not os.path.exists(LOG_FILE):
        print("FAILED: log file not found after all threads completed.")
        return False

    with open(LOG_FILE) as handle:
        lines = handle.readlines()

    found_ids = set()
    malformed = 0
    for line in lines:
        record = line.strip()
        if not record:
            continue
        parts = record.split("|")
        if len(parts) == 2 and parts[0].isdigit():
            found_ids.add(int(parts[0]))
        else:
            malformed += 1

    expected_ids = set(range(NUM_THREADS))
    missing = expected_ids - found_ids
    extra = found_ids - expected_ids

    print(f"Total entries: {len(lines)}")
    if not missing and not extra and not malformed:
        print(f"SUCCESS: All {NUM_THREADS} entries verified successfully!")
        print(f"Log file size: {os.path.getsize(LOG_FILE)} bytes")
        return True

    print(f"FAILED: missing {len(missing)} entries: {sorted(missing)}")
    print(f"        extra {len(extra)} entries: {sorted(extra)}")
    print(f"        malformed records: {malformed}")
    return False


if __name__ == "__main__":
    exit(0 if main() else 1)
