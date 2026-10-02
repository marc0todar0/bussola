// ---------------------------------------------------------------------------
// A queue of one: jobs run one at a time, in the order they came
// ---------------------------------------------------------------------------
// The notification reader (inbox_controller.readItem) asks a model that runs
// on this machine's CPU; two readings at once would each take twice as long.
// In process and in memory: a job lost to a restart is found again at the
// next start (resumePending), because its item is still marked pending.
//
// The worker is expected to catch its own errors; one it lets through is
// logged and the queue goes on.
const createQueue = (worker) => {
  const jobs = [];
  const queued = new Set();
  let running = false;

  const drain = async () => {
    if (running) return;
    running = true;
    try {
      while (jobs.length) {
        const job = jobs.shift();
        try {
          await worker(job);
        } catch (error) {
          console.error(`[queue] job ${job && job.id} failed: ${error.message}`);
        } finally {
          queued.delete(job && job.id);
        }
      }
    } finally {
      running = false;
    }
  };

  return {
    // The same id twice is queued once.
    push(job) {
      if (job && job.id != null && queued.has(job.id)) return;
      if (job && job.id != null) queued.add(job.id);
      jobs.push(job);
      setImmediate(drain);
    },
    size: () => jobs.length + (running ? 1 : 0),
    // Resolves when nothing is queued or running. For tests.
    idle: async () => {
      while (running || jobs.length) await new Promise((r) => setTimeout(r, 10));
    },
  };
};

module.exports = { createQueue };
