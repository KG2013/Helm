import type { Episode, ReleaseGateResult } from './types.js';
import { evaluateReleaseGate } from './trace.js';

export interface FixedEvaluationCase {
  id: string;
  split: 'dev' | 'holdout';
  critical?: boolean;
  run(attempt: number): Promise<Episode>;
}

export interface FixedEvaluationMatrix {
  episodes: Episode[];
  gate: ReleaseGateResult;
}

/** Run a fixed case matrix sequentially so every attempt has an explicit index. */
export async function runFixedEvaluationMatrix(cases: readonly FixedEvaluationCase[], repetitions = 3): Promise<FixedEvaluationMatrix> {
  if (!Number.isInteger(repetitions) || repetitions < 3) throw new Error('Fixed evaluation matrix requires at least three repetitions.');
  const episodes: Episode[] = [];
  const criticalCaseIds = [...new Set(cases.filter((evaluationCase) => evaluationCase.critical !== false).map((evaluationCase) => evaluationCase.id))];
  for (const evaluationCase of cases) {
    for (let attempt = 1; attempt <= repetitions; attempt += 1) {
      const episode = await evaluationCase.run(attempt);
      if (episode.evaluationCase !== evaluationCase.id || episode.evaluationSplit !== evaluationCase.split || episode.evaluationAttempt !== attempt) {
        throw new Error(`Evaluation case ${evaluationCase.id}/${evaluationCase.split} returned mismatched metadata for attempt ${attempt}.`);
      }
      episodes.push(episode);
    }
  }
  return { episodes, gate: evaluateReleaseGate(episodes, { requireFixedMatrix: true, criticalCaseIds, repetitions }) };
}
