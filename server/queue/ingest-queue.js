"use strict";

/**
 * High-Throughput Ingest Queue Engine.
 *
 * Buffers incoming event batches in-memory and flushes them in bulk to the
 * feature extractor and database worker. Provides backpressure protection,
 * latency metrics, and non-blocking sub-5ms HTTP responses under heavy load.
 */

class IngestQueue {
  /**
   * @param {Object} opts
   * @param {Function} opts.processor - async function(batch) to process queue items
   * @param {number} [opts.maxBatchSize=50] - max jobs processed in a single bulk iteration
   * @param {number} [opts.flushIntervalMs=50] - interval between worker ticks
   * @param {number} [opts.maxQueueSize=10000] - max items before backpressure shedding
   * @param {Object} [opts.logger] - Fastify or custom logger
   */
  constructor(opts = {}) {
    if (typeof opts.processor !== "function") {
      throw new Error("IngestQueue requires a processor function");
    }

    this.processor = opts.processor;
    this.maxBatchSize = opts.maxBatchSize || 50;
    this.flushIntervalMs = opts.flushIntervalMs || 50;
    this.maxQueueSize = opts.maxQueueSize || 10000;
    this.logger = opts.logger || console;

    this.queue = [];
    this.isProcessing = false;
    this.timer = null;

    // Metrics
    this.metrics = {
      enqueued_total: 0,
      processed_total: 0,
      dropped_total: 0,
      errors_total: 0,
      batches_processed: 0,
      last_flush_at: null,
      avg_batch_time_ms: 0,
    };

    this.start();
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.tick();
    }, this.flushIntervalMs);
    // Allow process to exit cleanly if timer is only active handle
    if (this.timer.unref) this.timer.unref();
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Enqueue an incoming job.
   * @param {Object} job
   * @returns {boolean} true if accepted, false if dropped due to backpressure
   */
  enqueue(job) {
    if (this.queue.length >= this.maxQueueSize) {
      this.metrics.dropped_total++;
      if (this.logger.warn) {
        this.logger.warn({ queue_size: this.queue.length }, "Ingest queue backpressure threshold reached, shedding load");
      }
      return false;
    }

    this.queue.push({
      data: job,
      enqueuedAt: Date.now(),
    });
    this.metrics.enqueued_total++;

    // Fast-path: if queue reaches half batch size, trigger tick immediately
    if (this.queue.length >= Math.floor(this.maxBatchSize / 2) && !this.isProcessing) {
      setImmediate(() => this.tick());
    }

    return true;
  }

  /**
   * Worker tick: pull up to maxBatchSize items and process.
   */
  async tick() {
    if (this.isProcessing || this.queue.length === 0) return;

    this.isProcessing = true;
    const batch = this.queue.splice(0, this.maxBatchSize);
    const start = Date.now();

    try {
      await this.processor(batch.map((b) => b.data));
      const duration = Date.now() - start;

      this.metrics.processed_total += batch.length;
      this.metrics.batches_processed++;
      this.metrics.last_flush_at = new Date().toISOString();
      this.metrics.avg_batch_time_ms = Math.round(
        this.metrics.avg_batch_time_ms === 0
          ? duration
          : (this.metrics.avg_batch_time_ms * 0.9) + (duration * 0.1)
      );
    } catch (err) {
      this.metrics.errors_total++;
      if (this.logger.error) {
        this.logger.error({ err: err.message, batch_size: batch.length }, "Error processing ingest queue batch");
      }
    } finally {
      this.isProcessing = false;
      // If there are still items remaining, process next batch immediately
      if (this.queue.length > 0) {
        setImmediate(() => this.tick());
      }
    }
  }

  /**
   * Get queue health and operational metrics.
   */
  getStats() {
    return {
      queue_size: this.queue.length,
      max_queue_size: this.maxQueueSize,
      is_processing: this.isProcessing,
      ...this.metrics,
    };
  }

  /**
   * Flush all remaining jobs before shutting down.
   */
  async flushAndDrain() {
    this.stop();
    while (this.queue.length > 0 || this.isProcessing) {
      if (this.isProcessing) {
        // A tick is already in flight. `tick()` would return immediately on its
        // guard, so retrying in a bare loop only schedules microtasks and the
        // event loop never advances the in-flight processor — a hard hang.
        // Yield to the macrotask queue instead and re-check.
        await new Promise((r) => setTimeout(r, 5));
        continue;
      }
      await this.tick();
    }
  }
}

module.exports = {
  IngestQueue,
};
