#!/usr/bin/env python3
"""Stress test: 100 threads writing IDs and timestamps to a log file."""

import threading
import time
import os
import random
from pathlib import Path

LOG_FILE = "/tmp/stress_test.log"
NUM_THREADS = 100

def writer(thread_id: int):
    """Write thread ID and timestamp to log file."""
    timestamp = time.time()
    entry = f"{thread_id}|{timestamp:.6f}\n"
    with open(LOG_FILE, "a") as f:
        f.write(entry)

def main():
    # Clear previous log
    if os.path.exists(LOG_FILE):
        os.remove(LOG_FILE)

    print(f"Spawning {NUM_THREADS} threads...")
    
    # Create and start all threads
    threads = []
    for i in range(NUM_THREADS):
        t = threading.Thread(target=writer, args=(i,))
        threads.append(t)
        t.start()
    
    # Wait for all threads to complete
    for t in threads:
        t.join()
    
    print("All threads completed. Reading back log...")
    
    # Read back and verify
    with open(LOG_FILE, "r") as f:
        lines = f.readlines()
    
    # Parse entries
    found_ids = set()
    for line in lines:
        line = line.strip()
        if line:
            parts = line.split("|")
            if len(parts) == 2:
                thread_id = int(parts[0])
                found_ids.add(thread_id)
    
    # Verify all 100 entries present
    expected_ids = set(range(NUM_THREADS))
    
    if found_ids == expected_ids:
        print(f"SUCCESS: All {NUM_THREADS} entries verified successfully!")
        print(f"Log file size: {os.path.getsize(LOG_FILE)} bytes")
        return True
    else:
        missing = expected_ids - found_ids
        extra = found_ids - expected_ids
        print(f"FAILED: Missing {len(missing)} entries: {missing}")
        print(f"Extra {len(extra)} entries: {extra}")
        return False

if __name__ == "__main__":
    success = main()
    exit(0 if success else 1)
