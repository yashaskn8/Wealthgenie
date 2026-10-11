const SHA256 = /^[a-f0-9]{64}$/i;
const FIXTURE_SOURCE_CLASS = 'SYNTHETIC_FIXTURE';

function validDigest(value) {
  return typeof value === 'string' && SHA256.test(value);
}

function result(eventType, observation, currentState, nextState = currentState) {
  return Object.freeze({
    eventType,
    sourceClass: FIXTURE_SOURCE_CLASS,
    watchId: observation.watchId,
    generation: observation.generation,
    observationId: observation.observationId,
    observedAt: observation.observedAt ?? null,
    previousFactHash: currentState?.parsedFactHash ?? null,
    observedFactHash: observation.parsedFactHash ?? null,
    rawContentChanged: Boolean(currentState?.rawContentHash
      && observation.rawContentHash
      && currentState.rawContentHash !== observation.rawContentHash),
    nextState,
  });
}

/**
 * Classifies controlled synthetic observations for deterministic tests only.
 * This policy has no source access, financial authority, persistence, or alerting.
 */
export function classifySyntheticProofBreakObservation({ sourceClass, watchId, generation, currentState = null, observation }) {
  if (sourceClass !== FIXTURE_SOURCE_CLASS) {
    throw Object.assign(new Error('ProofBreak fixture policy accepts synthetic observations only.'), {
      code: 'GENIEPROOF_FIXTURE_SOURCE_REQUIRED',
    });
  }
  if (typeof watchId !== 'string' || !watchId || watchId.length > 128
      || !Number.isSafeInteger(generation) || generation < 1
      || !observation || typeof observation !== 'object' || Array.isArray(observation)
      || typeof observation.observationId !== 'string' || !observation.observationId
      || observation.observationId.length > 128) {
    throw Object.assign(new Error('ProofBreak fixture observation is malformed.'), {
      code: 'GENIEPROOF_FIXTURE_INVALID',
    });
  }

  const boundObservation = { ...observation, watchId, generation };
  if (currentState && currentState.generation > generation) {
    return result('SUPERSEDED', boundObservation, currentState);
  }
  if (currentState && currentState.generation !== generation) {
    throw Object.assign(new Error('ProofBreak fixture generation does not match its current state.'), {
      code: 'GENIEPROOF_FIXTURE_GENERATION_MISMATCH',
    });
  }
  if (currentState?.lastObservationId === observation.observationId) {
    return result('REPLAY_DUPLICATE', boundObservation, currentState);
  }

  if (observation.availability === 'UNAVAILABLE') {
    return result('SOURCE_UNAVAILABLE', boundObservation, currentState);
  }
  if (observation.availability !== 'AVAILABLE'
      || !validDigest(observation.rawContentHash)
      || !validDigest(observation.parsedFactHash)
      || typeof observation.observedAt !== 'string'
      || !Number.isFinite(Date.parse(observation.observedAt))) {
    throw Object.assign(new Error('ProofBreak fixture observation is missing valid source-neutral hashes or time.'), {
      code: 'GENIEPROOF_FIXTURE_INVALID',
    });
  }
  if (currentState?.lastObservedAt && Date.parse(observation.observedAt) < Date.parse(currentState.lastObservedAt)) {
    return result('OUT_OF_ORDER', boundObservation, currentState);
  }

  const nextState = Object.freeze({
    generation,
    lastObservationId: observation.observationId,
    lastObservedAt: new Date(observation.observedAt).toISOString(),
    rawContentHash: observation.rawContentHash.toLowerCase(),
    parsedFactHash: observation.parsedFactHash.toLowerCase(),
  });
  if (!currentState) return result('BASELINE_RECORDED', boundObservation, currentState, nextState);
  if (currentState.parsedFactHash.toLowerCase() === observation.parsedFactHash.toLowerCase()) {
    return result('FACTS_UNCHANGED', boundObservation, currentState, nextState);
  }
  return result('FACTS_CHANGED', boundObservation, currentState, nextState);
}

export const PROOFBREAK_FIXTURE_SOURCE_CLASS = FIXTURE_SOURCE_CLASS;
