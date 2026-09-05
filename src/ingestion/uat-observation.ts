import { createHash } from "node:crypto";
import type { UATObservation } from "../parser/uat-excel.js";
import { SupabaseService } from "../services/supabase.js";

export type UATIngestionResult = {
  status: "success";
  sheets: string[];
  observationsProcessed: number;
  observationsCreated: number;
  observationsUpdated: number;
  duplicates: number;
  errors: never[];
};

export async function ingestUATObservations(
  observations: UATObservation[], sheets: string[], supabase: SupabaseService
): Promise<UATIngestionResult> {
  let created = 0;
  let updated = 0;
  for (const observation of observations) {
    const result = await supabase.upsertUATObservation({
      observation_id: observation.observationId,
      test_case_id: observation.testCaseId,
      module: observation.module,
      process_area: observation.processArea,
      process_code: observation.processCode,
      system: observation.system,
      transaction_id: observation.transactionId,
      title: observation.title,
      expected_behavior: observation.expectedBehavior,
      actual_behavior: observation.actualBehavior,
      evidence_references: observation.evidenceReferences,
      severity: observation.severity,
      source_github_path: observation.source.githubPath,
      source_sheet: observation.source.sheetName,
      source_row: observation.source.rowNumber,
      content_hash: createHash("sha256").update(JSON.stringify(observation)).digest("hex")
    });
    if (result.created) created += 1;
    else if (result.changed) updated += 1;
    if (observation.evaluation && result.changed) await supabase.upsertUATEvaluation(result.id, observation.evaluation);
  }
  return { status: "success", sheets, observationsProcessed: observations.length, observationsCreated: created, observationsUpdated: updated, duplicates: 0, errors: [] };
}
