// ---------------------------------------------------------------------------
// Simple per-key async mutex. Blackjack's hit/stand/double/split each do a
// read-modify-write across multiple DB calls (draw a card, maybe play the
// dealer, log the bet, credit the balance) that can't be collapsed into one
// atomic SQL statement the way Mines/withdrawals/the deposit webhook were —
// so instead we just make sure two requests for the SAME user can never run
// one of these actions concurrently in the first place. Requests for the
// same key queue up and run strictly one after another; different users
// never block each other.
//
// This only serializes within a single Node process. It's sufficient here
// because the app runs as a single server instance — if this ever runs as
// multiple instances behind a load balancer, this would need to move to a
// DB-level or Redis-based lock instead.
// ---------------------------------------------------------------------------

const queues = new Map(); // key -> tail promise of the current chain

export function withLock(key, fn) {
  const prev = queues.get(key) || Promise.resolve();
  const run = prev.then(fn, fn); // run fn regardless of whether the previous job succeeded or failed
  // Keep the queue moving even if `run` rejects — store a version that
  // swallows the error just for chaining purposes; callers still get the
  // real rejection from the `run` promise we return below.
  const tail = run.then(() => {}, () => {});
  queues.set(key, tail);
  tail.finally(() => {
    if (queues.get(key) === tail) queues.delete(key); // don't leak entries forever
  });
  return run;
}
