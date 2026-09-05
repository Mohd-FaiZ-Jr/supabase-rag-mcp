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

export type UATSummary = {
  testCaseId?: string;
  testCaseTitle?: string;
  overallStatus?: string;
  expectedResult?: string;
  actualResult?: string;
  behavioralDelta?: string;
};

export type UATParseResult = {
  observations: UATObservation[];
  sheets: string[];
  testCase?: string;
  applicationUrl?: string;
  summary?: UATSummary;
};

const aliases: Record<string, string> = {
  observationid: "observationId", obsid: "observationId", testcaseid: "testCaseId", testcase: "testCaseId",
  module: "module", processarea: "processArea", processcode: "processCode", system: "system", platform: "system", systemplatform: "system",
  transactionid: "transactionId", documentid: "transactionId", transactiondocumentid: "transactionId", title: "title", observationtitle: "title",
  expectedbehavior: "expectedBehavior", expectedbehaviour: "expectedBehavior", actualbehavior: "actualBehavior", actualbehaviour: "actualBehavior",
  evidence: "evidenceReferences", evidencereference: "evidenceReferences", evidencereferences: "evidenceReferences", evidenceref: "evidenceReferences", screenshot: "evidenceReferences", screenshotevidenceref: "evidenceReferences", severity: "severity",
  rootcause: "rootCause", resolutiondecision: "resolutionDecision", resolutionnotes: "resolutionDecision", resolutiondecisionnotes: "resolutionDecision",
  productlimitation: "productLimitationFlag", productlimitationflag: "productLimitationFlag", sapproductlimitationflag: "productLimitationFlag", resolutionstatus: "resolutionStatus"
};

const summaryAliases: Record<string, keyof UATSummary> = {
  testcaseid: "testCaseId", testcase: "testCaseId", testcasetitle: "testCaseTitle", title: "testCaseTitle",
  overallstatus: "overallStatus", expectedresult: "expectedResult", actualresult: "actualResult",
  behavioraldelta: "behavioralDelta", behaviouraldelta: "behavioralDelta"
};

const instructionLabels = {
  testCase: new Set(["testcase", "testcaseid", "testcasename"]),
  applicationUrl: new Set(["applicationurl", "appurl", "url"])
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
  let testCase: string | undefined;
  let applicationUrl: string | undefined;
  let summary: UATSummary | undefined;
  for (const sheetName of workbook.SheetNames) {
    const rows = XLSX.utils.sheet_to_json<unknown[]>(workbook.Sheets[sheetName], { header: 1, defval: "", raw: false }) as unknown[][];
    if (sheetName.trim().toLowerCase() === "instructions") {
      testCase = findInstructionValue(rows, instructionLabels.testCase) ?? testCase;
      applicationUrl = findInstructionValue(rows, instructionLabels.applicationUrl) ?? applicationUrl;
      continue;
    }
    if (sheetName.trim().toLowerCase() === "_dropdowns") continue;
    if (sheetName.trim().toLowerCase() === "summary dashboard") {
      summary = parseSummary(rows) ?? summary;
      continue;
    }
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
  return { observations, sheets: recognizedSheets, testCase, applicationUrl, summary };
}

export function buildUATDocumentContent(result: UATParseResult): string {
  const observationSections = result.observations.map((observation) => [
    `## Observation ${observation.observationId}`,
    `Test Case: ${result.testCase ?? observation.testCaseId ?? ""}`,
    `Application: ${result.applicationUrl ?? ""}`,
    `Observation ID: ${observation.observationId}`,
    `Module: ${observation.module ?? ""}`,
    `Observation Title: ${observation.title ?? ""}`,
    `Expected Behaviour: ${observation.expectedBehavior}`,
    `Actual Behaviour: ${observation.actualBehavior}`,
    `Severity: ${observation.severity ?? ""}`,
    ...(observation.evaluation?.rootCause ? [`Root Cause: ${observation.evaluation.rootCause}`] : []),
    ...(observation.evaluation?.resolutionDecision ? [`Resolution/Decision Notes: ${observation.evaluation.resolutionDecision}`] : []),
    ...(observation.evaluation?.resolutionStatus ? [`Resolution Status: ${observation.evaluation.resolutionStatus}`] : [])
  ].join("\n")).join("\n\n");
  const summarySection = result.summary ? [
    "# UAT Summary",
    `Test Case ID: ${result.summary.testCaseId ?? result.testCase ?? ""}`,
    `Test Case Title: ${result.summary.testCaseTitle ?? ""}`,
    `Overall Status: ${result.summary.overallStatus ?? ""}`,
    `Expected Result: ${result.summary.expectedResult ?? ""}`,
    `Actual Result: ${result.summary.actualResult ?? ""}`,
    `Behavioral Delta: ${result.summary.behavioralDelta ?? ""}`
  ].join("\n") : "";
  return ["# UAT Observations", observationSections, summarySection].filter(Boolean).join("\n\n");
}

function findHeader(rows: unknown[][]): { row: number; values: unknown[] } | null {
  for (let row = 0; row < Math.min(rows.length, 50); row += 1) {
    const values = rows[row] ?? [];
    const fields = values.map((value) => aliases[normalizeHeader(value)]).filter(Boolean);
    if (["observationId", "expectedBehavior", "actualBehavior"].some((field) => fields.includes(field))) return { row, values };
  }
  return null;
}

function parseSummary(rows: unknown[][]): UATSummary | null {
  const header = findNamedHeader(rows, summaryAliases);
  if (!header) return null;
  const columns = header.values.map((value, index) => ({ index, field: summaryAliases[normalizeHeader(value)] }));
  for (let rowIndex = header.row + 1; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex];
    if (!row || row.every((value) => String(value ?? "").trim() === "")) continue;
    const parsed: UATSummary = {};
    for (const column of columns) if (column.field) parsed[column.field] = String(row[column.index] ?? "").trim();
    return parsed;
  }
  return null;
}

function findNamedHeader(rows: unknown[][], names: Record<string, unknown>): { row: number; values: unknown[] } | null {
  for (let row = 0; row < Math.min(rows.length, 50); row += 1) {
    const values = rows[row] ?? [];
    if (values.map((value) => names[normalizeHeader(value)]).filter(Boolean).length > 0) return { row, values };
  }
  return null;
}

function findInstructionValue(rows: unknown[][], labels: Set<string>): string | undefined {
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex];
    for (let index = 0; index < row.length; index += 1) {
      if (!labels.has(normalizeHeader(row[index]))) continue;
      const sameRowValue = row.slice(index + 1).map((value) => String(value ?? "").trim()).find(Boolean);
      if (sameRowValue) return sameRowValue;
      const nextRowValue = rows[rowIndex + 1]?.find((value) => String(value ?? "").trim());
      if (nextRowValue) return String(nextRowValue).trim();
    }
  }
  return undefined;
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
