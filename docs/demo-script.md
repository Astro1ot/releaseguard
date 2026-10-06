# Five-minute interview demo

Prepare the full Compose lab and a separate kind namespace before recording. Collect evidence in advance; do not rely on downloading images during the meeting.

1. **0:00 — The problem.** Explain that pod readiness and successful CI do not prove a customer can place and receive an order. Show the status UI and make a synthetic purchase.
2. **0:45 — The release gate.** Show one Helm chart, two overlays, a schema-rejected typo and the Python code that remembers the previous deployed revision.
3. **1:30 — Bad release.** Run the Kubernetes rehearsal. Show a successful readiness probe with a broken catalog, failed business smoke, the exact rollback revision and recovery evidence. The pipeline remains failed.
4. **2:45 — Partial failure.** Show the Redis drill: catalog still works, fallback origin rate stays bounded per process, readiness stays up and the incident resolves. Explain the cross-replica limit.
5. **3:45 — Data correctness.** Show the order/outbox transaction, consumer deduplication and the migration lock-timeout report. Explain the crash window and why the schema rollback is not automatic.
6. **4:45 — Tradeoffs.** State three limitations: process-local status history, single ephemeral broker and no production TLS/secret provider. Describe the next engineering change you would make and why.

For an early demo without Docker, show the UI and HTTP contract only. Say explicitly that the in-memory mode does not test database locks, broker recovery or Helm rollback.

## Browser order recovery

Create a test order, reload the page, then press **Check order status**. The saved
order ID remains the same; this button only reads status. If creation is uncertain,
**Recover saved order** retries the saved product/key and locks product selection.
The draft is stored before sending. A failed storage read or unsupported Web Locks
blocks creation rather than discarding the original request. Other tabs on the same
origin share the saved operation and cannot send simultaneously. Use one origin
consistently (127.0.0.1:8080); localhost and the direct API port have separate storage.
