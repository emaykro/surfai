"use strict";

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const { IngestQueue } = require("../queue/ingest-queue");

describe("IngestQueue High-Load Engine", () => {
  test("enqueues and processes batches asynchronously", async () => {
    const processed = [];
    const queue = new IngestQueue({
      maxBatchSize: 10,
      flushIntervalMs: 10,
      processor: async (batch) => {
        processed.push(...batch);
      },
    });

    for (let i = 0; i < 5; i++) {
      const ok = queue.enqueue({ id: i, payload: `event_${i}` });
      assert.equal(ok, true);
    }

    assert.equal(queue.getStats().queue_size, 5);
    assert.equal(queue.getStats().enqueued_total, 5);

    // Wait for tick
    await queue.flushAndDrain();

    assert.equal(processed.length, 5);
    assert.equal(queue.getStats().queue_size, 0);
    assert.equal(queue.getStats().processed_total, 5);
  });

  test("applies backpressure shedding when maxQueueSize is reached", () => {
    const queue = new IngestQueue({
      maxBatchSize: 10,
      maxQueueSize: 3,
      flushIntervalMs: 1000, // keep items in queue
      processor: async () => {},
    });

    assert.equal(queue.enqueue({ id: 1 }), true);
    assert.equal(queue.enqueue({ id: 2 }), true);
    assert.equal(queue.enqueue({ id: 3 }), true);
    // 4th should be dropped
    assert.equal(queue.enqueue({ id: 4 }), false);

    const stats = queue.getStats();
    assert.equal(stats.queue_size, 3);
    assert.equal(stats.dropped_total, 1);

    queue.stop();
  });

  test("handles processor errors gracefully without crashing worker loop", async () => {
    let callCount = 0;
    const queue = new IngestQueue({
      maxBatchSize: 2,
      flushIntervalMs: 10,
      processor: async () => {
        callCount++;
        throw new Error("Simulated DB failure");
      },
    });

    queue.enqueue({ id: 1 });
    await queue.flushAndDrain();

    const stats = queue.getStats();
    assert.equal(stats.errors_total, 1);
    assert.equal(callCount, 1);
  });
});

describe("IngestQueue graceful drain", () => {
  test("drains items that arrive while a slow batch is in flight", async () => {
    const processed = [];
    let inFlight = 0;
    let maxConcurrent = 0;

    const queue = new IngestQueue({
      maxBatchSize: 2,
      flushIntervalMs: 5,
      processor: async (batch) => {
        inFlight++;
        maxConcurrent = Math.max(maxConcurrent, inFlight);
        await new Promise((r) => setTimeout(r, 20));
        processed.push(...batch);
        inFlight--;
      },
    });

    queue.enqueue({ id: 1 });
    queue.enqueue({ id: 2 });
    // Let the first tick start so the drain runs against an in-flight batch.
    await new Promise((r) => setTimeout(r, 10));
    queue.enqueue({ id: 3 });

    await queue.flushAndDrain();

    assert.equal(processed.length, 3);
    assert.deepEqual(processed.map((p) => p.id).sort(), [1, 2, 3]);
    assert.equal(queue.getStats().queue_size, 0);
    // The guard must never let two batches run at once.
    assert.equal(maxConcurrent, 1);
  });

  test("flushAndDrain yields instead of spinning while a tick is in flight", async () => {
    let ticks = 0;
    const queue = new IngestQueue({
      maxBatchSize: 10,
      flushIntervalMs: 5,
      processor: async () => {
        ticks++;
        await new Promise((r) => setTimeout(r, 60));
      },
    });

    queue.enqueue({ id: 1 });
    await new Promise((r) => setTimeout(r, 10)); // tick now in flight, queue empty

    let drainPolls = 0;
    const realTick = queue.tick.bind(queue);
    queue.tick = async () => {
      drainPolls++;
      return realTick();
    };

    await queue.flushAndDrain();

    assert.equal(ticks, 1);
    // A busy-spin would poll thousands of times over the 60ms wait.
    assert.ok(drainPolls < 50, `expected a yielding drain loop, got ${drainPolls} polls`);
  });
});
