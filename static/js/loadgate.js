// ── Load generations ─────────────────────────────────────────────────────────
// Opening a second PDF while the first is still loading used to run both loads at
// once: the first one's awaits resumed against the second document's state, so its
// geometry, script and notes binding landed on the wrong paper (A2). Each load takes
// a generation; work that resumes after an await asks whether it is still current
// and, when a newer load has begun, stops without touching anything. The token also
// carries `.signal`, aborted the moment a newer load begins, so work that can be
// cancelled (the batched script build) stops at once instead of running on.
//
// Imports nothing and touches no DOM, so it unit-tests in plain Node.

export function createLoadGate() {
  let generation = 0;
  let controller = new AbortController();
  const tokenFor = (mine) => Object.assign(() => mine === generation, { signal: controller.signal });

  return {
    /** Start a new load. @returns {(() => boolean) & {signal: AbortSignal}} true while no later load has begun */
    begin: () => {
      controller.abort();
      controller = new AbortController();
      return tokenFor(++generation);
    },
    /** Join the current load without superseding it (a rebuild of the open paper). */
    current: () => tokenFor(generation),
  };
}
