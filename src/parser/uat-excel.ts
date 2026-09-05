import * as XLSX from "xlsx";

export type UATObservation = {
  observationId: string;
  testCaseId?: string;
  module?: string;
  processArea?: string;
  processCode?: string;
  system?: string;
  transactionId?: string;
  title?: string;
  expectedBehavior: string;
  actualBehavior: string;
  evidenceReferences: string[];
  severity?: string;
  evaluation?: {
    rootCause?: string;
    resolutionDecision?: string;
    productLimitationFlag?: string;
    resolutionStatus?: string;
  };
  source: { githubPath: string; sheetName: string; rowNumber: number };
};

export type UATParseResult = { observations: UATObservation[]; sheets: string[] };

const aliases: Record<string, string> = {
  observationid: "observationId", obsid: "observationId", testcaseid: "testCaseId", testcase: "testCaseId",
  module: "module", processarea: "processArea", processcode: "processCode", system: "system", platform: "system",
  transactionid: "transactionId", documentid: "transactionId", title: "title", observationtitle: "title",
  expectedbehavior: "expectedBehavior", expectedbehaviour: "expectedBehavior", actualbehavior: "actualBehavior", actualbehaviour: "actualBehavior",
  evidence: "evidenceReferences", evidencereference: "evidenceReferences", evidencereferences: "evidenceReferences", severity: "severity",
  rootcause: "rootCause", resolutiondecision: "resolutionDecision", resolutionnotes: "resolutionDecision",
  productlimitation: "productLimitationFlag", productlimitationflag: "productLimitationFlag", resolutionstatus: "resolutionStatus"
};

export function parseUATWorkbook(buffer: Buffer, githubPath: string): UATParseResult {
  let workbook: XLSX.WorkBook;
  try {
    workbook = XLSX.read(buffer, { type: "buffer", cellDates: false, raw: false });
  } catch (error) {
    throw new Error(`Unable to read Excel workbook ${githubPath}: ${error instanceof Error ? error.message : "invalid workbook"}`);
  }
  if (workbook.SheetNames.length === 0) throw new Error(`Workbook has no worksheets: ${githubPath}`);

  const observations: UATObservation[] = [];
  const recognizedSheets: string[] = [];
  const seen = new Set<string>();
  for (const sheetName of workbook.SheetNames) {
    const rows = XLSX.utils.sheet_to_json<unknown[]>(workbook.Sheets[sheetName], { header: 1, defval: "", raw: false }) as unknown[][];
    const header = findHeader(rows);
    if (!header) continue;
    recognizedSheets.push(sheetName);
    const columns = header.values.map((value, index) => ({ index, field: aliases[normalizeHeader(value)] }));
    const required = new Set(["observationId", "expectedBehavior", "actualBehavior"]);
    const found = new Set(columns.map((column) => column.field).filter(Boolean));
    const missing = [...required].filter((field) => !found.has(field));
    if (missing.length > 0) throw new Error(`Sheet "${sheetName}" is missing required headers: ${missing.join(", ")}`);

    for (let rowIndex = header.row + 1; rowIndex < rows.length; rowIndex += 1) {
      const row = rows[rowIndex];
      if (row.every((value) => String(value ?? "").trim() === "")) continue;
      const values = new Map<string, string>();
      for (const column of columns) if (column.field) values.set(column.field, String(row[column.index] ?? "").trim());
      const observationId = values.get("observationId") ?? "";
      const expectedBehavior = values.get("expectedBehavior") ?? "";
      const actualBehavior = values.get("actualBehavior") ?? "";
      if (!observationId || !expectedBehavior || !actualBehavior) {
        throw new Error(`Sheet "${sheetName}" row ${rowIndex + 1} must include observation ID, expected behavior, and actual behavior`);
      }
      if (seen.has(observationId)) throw new Error(`Duplicate observation ID "${observationId}" in workbook ${githubPath}`);
      seen.add(observationId);
      const observation: UATObservation = {
        observationId, expectedBehavior, actualBehavior,
        evidenceReferences: splitReferences(values.get("evidenceReferences")),
        source: { githubPath, sheetName, rowNumber: rowIndex + 1 }
      };
      for (const field of ["testCaseId", "module", "processArea", "processCode", "system", "transactionId", "title", "severity"] as const) {
        const value = values.get(field);
        if (value) observation[field] = value;
      }
      const evaluation = pickEvaluation(values);
      if (Object.keys(evaluation).length > 0) observation.evaluation = evaluation;
      observations.push(observation);
    }
  }
  if (recognizedSheets.length === 0) throw new Error(`Workbook contains no recognizable UAT observation sheet: ${githubPath}`);
  if (observations.length === 0) throw new Error(`Workbook contains no observation rows: ${githubPath}`);
  return { observations, sheets: recognizedSheets };
}

function findHeader(rows: unknown[][]): { row: number; values: unknown[] } | null {
  for (let row = 0; row < Math.min(rows.length, 50); row += 1) {
    const values = rows[row] ?? [];
    const fields = values.map((value) => aliases[normalizeHeader(value)]).filter(Boolean);
    if (["observationId", "expectedBehavior", "actualBehavior"].some((field) => fields.includes(field))) return { row, values };
  }
  return null;
}

function normalizeHeader(value: unknown): string {
  return String(value ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function splitReferences(value: string | undefined): string[] {
  return value ? value.split(/[\n;,]+/).map((item) => item.trim()).filter(Boolean) : [];
}

function pickEvaluation(values: Map<string, string>): NonNullable<UATObservation["evaluation"]> {
  const evaluation: NonNullable<UATObservation["evaluation"]> = {};
  for (const field of ["rootCause", "resolutionDecision", "productLimitationFlag", "resolutionStatus"] as const) {
    const value = values.get(field);
    if (value) evaluation[field] = value;
  }
  return evaluation;
}
