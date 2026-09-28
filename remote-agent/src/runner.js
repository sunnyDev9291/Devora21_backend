const { pullQueue, ackDelivery } = require("./client");
const { saveQueueItemFiles } = require("./download");

function log(...args) {
  const ts = new Date().toISOString();
  console.log(`[${ts}]`, ...args);
}

async function processQueueOnce(config) {
  const data = await pullQueue(config, 10);
  const items = Array.isArray(data?.items) ? data.items : [];

  if (items.length === 0) {
    return { processed: 0, delivered: 0, failed: 0 };
  }

  log(
    `Pulled ${items.length} item(s) for device ${data.deviceName || data.deviceId || ""}`
  );

  let delivered = 0;
  let failed = 0;

  for (const item of items) {
    const id = item.deliveryId;
    try {
      const saved = await saveQueueItemFiles(
        item,
        config.saveDir,
        config.overwrite
      );
      await ackDelivery(config, id, "delivered");
      delivered += 1;
      log(`Delivered ${id}:`, saved.join(" | "));
    } catch (err) {
      failed += 1;
      const message = err instanceof Error ? err.message : String(err);
      log(`Failed ${id}:`, message);
      try {
        await ackDelivery(config, id, "failed", message);
      } catch (ackErr) {
        log(
          `Ack failed for ${id}:`,
          ackErr instanceof Error ? ackErr.message : String(ackErr)
        );
      }
    }
  }

  return { processed: items.length, delivered, failed };
}

async function runLoop(config, { once = false } = {}) {
  log("Devora21 remote agent started");
  log(`API: ${config.apiBaseUrl}`);
  log(`Save dir: ${config.saveDir}`);
  log(`Poll every ${config.pollIntervalMs}ms`);

  const tick = async () => {
    try {
      const result = await processQueueOnce(config);
      if (result.processed > 0) {
        log(
          `Batch done: processed=${result.processed} delivered=${result.delivered} failed=${result.failed}`
        );
      }
    } catch (err) {
      const status = err && err.status;
      const message = err instanceof Error ? err.message : String(err);
      log(`Poll error${status ? ` (${status})` : ""}:`, message);
    }
  };

  await tick();
  if (once) {
    log("Single poll finished (--once)");
    return;
  }

  setInterval(tick, config.pollIntervalMs);
}

module.exports = { runLoop, processQueueOnce };
