import * as XLSX from "xlsx";

export type ValidationError = {
  code: string;
  sheet?: string;
  row?: number;
  message: string;
};

export type IssueCreationFailure = {
  observationId: string;
  message: string;
};

export type BlockedExecution = {
  executionId: string;
  testCaseId: string;
  title: string;
  priority: string | null;
  status: string;
  steps: number | null;
  passed: number | null;
  failed: number | null;
};

export type TestExecutionRecord = {
  executionId: string;
  testCaseId: string;
  title: string;
  priority: string | null;
  status: string;
  steps: number | null;
  passed: number | null;
  failed: number | null;
};

export type StepExecutionRecord = {
  executionId: string;
  testCaseId: string;
  step: string;
  action: string;
  expected: string;
  actual: string;
  status: string;
};

export type ObservationRecord = {
  sNo: string;
  observationId: string;
  executionId: string;
  testCaseId: string;
  requirement: string;
  stepNo: string;
  title: string;
  expected: string;
  actual: string;
  severity: string;
  defectType: string;
  rootCause: string;
  resolutionStatus: string;
  assignedTo: string;
  reportedByDate: string;
  evidenceLink: string;
  sourceSheet: string;
  sourceRow: number;
};

export type TestCaseDetailRecord = {
  testCaseId: string;
  title: string;
  requirement: string;
  category: string;
  priority: string;
  steps: string;
};

export type ObservationIssuePackage = {
  observationId: string;
  executionId: string;
  testCaseId: string;
  requirement: string;
  title: string;
  stepNo: string;
  expected: string;
  actual: string;
  severity: string;
  defectType: string;
  rootCause: string;
  evidenceLink: string;
  matchedExecution?: TestExecutionRecord;
  stepExecutions: StepExecutionRecord[];
  testCaseDetails?: TestCaseDetailRecord;
  issueTitle: string;
  issueBody: string;
  dataIntegrityWarnings: string[];
  skipIssue: boolean;
  deduplicationKey: string;
};

export type TestExecutionIngestionResult = {
  source: string;
  sheets: string[];
  totalObservationRows: number;
  eligibleObservations: number;
  skippedNonFailObservations: number;
  blockedExecutions: BlockedExecution[];
  duplicatesSkipped: number;
  issuesCreated: number;
  issueCreationFailures: IssueCreationFailure[];
  validationErrors: ValidationError[];
  packages: ObservationIssuePackage[];
};

const REQUIRED_SHEETS = ["Test Execution", "Step Execution", "Observations", "Test Case Details"] as const;

const TEST_EXECUTION_HEADERS = {
  executionId: "Execution ID",
  testCaseId: "Test Case ID",
  title: "Title",
  priority: "Priority",
  status: "Status",
  steps: "Steps",
  passed: "Passed",
  failed: "Failed"
} as const;

const STEP_EXECUTION_HEADERS = {
  executionId: "Execution ID",
  testCaseId: "Test Case ID",
  step: "Step",
  action: "Action",
  expected: "Expected",
  actual: "Actual",
  status: "Status"
} as const;

const OBSERVATION_HEADERS = {
  sNo: "S.No",
  observationId: "Observation ID",
  executionId: "Execution ID",
  testCaseId: "Test Case ID",
  requirement: "Requirement",
  stepNo: "Step No.",
  title: "Title",
  expected: "Expected",
  actual: "Actual",
  severity: "Severity",
  defectType: "Defect Type",
  rootCause: "Root Cause",
  resolutionStatus: "Resolution Status (Pass/Fail)",
  assignedTo: "Assigned To",
  reportedByDate: "Reported By / Date",
  evidenceLink: "Evidence Link"
} as const;

const TEST_CASE_DETAILS_HEADERS = {
  testCaseId: "Test Case ID",
  title: "Title",
  requirement: "Requirement",
  category: "Category",
  priority: "Priority",
  steps: "Steps"
} as const;

export function parseTestExecutionWorkbook(buffer: Buffer, githubPath: string): TestExecutionIngestionResult {
  let workbook: XLSX.WorkBook;
  try {
    workbook = XLSX.read(buffer, { type: "buffer", cellDates: false, raw: false });
  } catch (error) {
    throw new Error(`Unable to read Excel workbook ${githubPath}: ${error instanceof Error ? error.message : "invalid workbook"}`);
  }

  if (workbook.SheetNames.length === 0) throw new Error(`Workbook has no worksheets: ${githubPath}`);

  const processedSheets = new Set<string>();
  const validationErrors: ValidationError[] = [];
  const blockedExecutions: BlockedExecution[] = [];
  const executionByComposite = new Map<string, TestExecutionRecord>();
  const stepExecutionByComposite = new Map<string, StepExecutionRecord[]>();
  const testCaseDetailsById = new Map<string, TestCaseDetailRecord>();
  const observationRows: ObservationRecord[] = [];

  for (const requiredSheet of REQUIRED_SHEETS) {
    const normalizedSheet = workbook.SheetNames.find((sheet) => normalizeSheetName(sheet) === normalizeSheetName(requiredSheet));
    if (!normalizedSheet) {
      throw new Error(`Workbook is missing required sheet: ${requiredSheet}`);
    }
    processedSheets.add(normalizedSheet);
  }

  const sheetNameMap = new Map<string, string>();
  for (const name of workbook.SheetNames) sheetNameMap.set(normalizeSheetName(name), name);

  const testExecutionSheetName = sheetNameMap.get(normalizeSheetName("Test Execution"));
  if (testExecutionSheetName) {
    const parsed = parseSheetRows(workbook, testExecutionSheetName, TEST_EXECUTION_HEADERS);
    if (parsed.missingHeaders.length > 0) {
      throw new Error(`Test Execution sheet is missing required headers: ${parsed.missingHeaders.join(", ")}`);
    }
    for (const row of parsed.rows) {
      const record = toTestExecutionRecord(row.row, parsed.headerMap, testExecutionSheetName);
      if (!record) continue;
      const composite = `${record.executionId}|${record.testCaseId}`;
      executionByComposite.set(composite, record);
      if (normalizeStatus(record.status) === "BLOCKED") {
        blockedExecutions.push({
          executionId: record.executionId,
          testCaseId: record.testCaseId,
          title: record.title,
          priority: record.priority,
          status: record.status,
          steps: record.steps,
          passed: record.passed,
          failed: record.failed
        });
      }
    }
  }

  const stepExecutionSheetName = sheetNameMap.get(normalizeSheetName("Step Execution"));
  if (stepExecutionSheetName) {
    const parsed = parseSheetRows(workbook, stepExecutionSheetName, STEP_EXECUTION_HEADERS);
    if (parsed.missingHeaders.length > 0) {
      throw new Error(`Step Execution sheet is missing required headers: ${parsed.missingHeaders.join(", ")}`);
    }
    for (const row of parsed.rows) {
      const record = toStepExecutionRecord(row.row, parsed.headerMap, stepExecutionSheetName);
      if (!record) continue;
      const composite = `${record.executionId}|${record.testCaseId}`;
      const list = stepExecutionByComposite.get(composite) ?? [];
      list.push(record);
      stepExecutionByComposite.set(composite, list);
    }
  }

  const observationsSheetName = sheetNameMap.get(normalizeSheetName("Observations"));
  if (observationsSheetName) {
    const parsed = parseSheetRows(workbook, observationsSheetName, OBSERVATION_HEADERS);
    if (parsed.missingHeaders.length > 0) {
      throw new Error(`Observations sheet is missing required headers: ${parsed.missingHeaders.join(", ")}`);
    }
    for (const row of parsed.rows) {
      const record = toObservationRecord(row.row, parsed.headerMap, observationsSheetName, row.rowNumber);
      if (!record) continue;
      observationRows.push(record);
    }
  }

  const testCaseDetailsSheetName = sheetNameMap.get(normalizeSheetName("Test Case Details"));
  if (testCaseDetailsSheetName) {
    const parsed = parseSheetRows(workbook, testCaseDetailsSheetName, TEST_CASE_DETAILS_HEADERS);
    if (parsed.missingHeaders.length > 0) {
      throw new Error(`Test Case Details sheet is missing required headers: ${parsed.missingHeaders.join(", ")}`);
    }
    for (const row of parsed.rows) {
      const record = toTestCaseDetailRecord(row.row, parsed.headerMap, testCaseDetailsSheetName);
      if (!record) continue;
      testCaseDetailsById.set(record.testCaseId, record);
    }
  }

  const eligiblePackages: ObservationIssuePackage[] = [];
  let skippedNonFailObservations = 0;
  let duplicatesSkipped = 0;
  const issueCreationFailures: IssueCreationFailure[] = [];

  for (const observation of observationRows) {
    const normalizedStatus = normalizeStatus(observation.resolutionStatus);
    if (normalizedStatus !== "FAIL") {
      skippedNonFailObservations += 1;
      continue;
    }

    const composite = `${observation.executionId}|${observation.testCaseId}`;
    const matchedExecution = executionByComposite.get(composite);
    const stepExecutions = sortStepRows(stepExecutionByComposite.get(composite) ?? []);
    const testCaseDetails = observation.testCaseId ? testCaseDetailsById.get(observation.testCaseId) : undefined;

    const dataIntegrityWarnings: string[] = [];
    if (!matchedExecution) dataIntegrityWarnings.push(`Missing Test Execution relationship for ${observation.executionId} + ${observation.testCaseId}.`);
    if (stepExecutions.length === 0) dataIntegrityWarnings.push(`Missing Step Execution relationship for ${observation.executionId} + ${observation.testCaseId}.`);
    if (!testCaseDetails) dataIntegrityWarnings.push(`Missing Test Case Details relationship for Test Case ID ${observation.testCaseId}.`);

    const warningMessage = dataIntegrityWarnings.length > 0 ? `Data integrity warning: ${dataIntegrityWarnings.join(" ")}` : "";
    if (warningMessage) validationErrors.push({ code: "missing_relationship", sheet: observationsSheetName, row: observation.sourceRow, message: warningMessage });

    const packageRequirement = observation.requirement || (testCaseDetails?.requirement ?? "");
    const packageTitle = observation.title || (testCaseDetails?.title ?? "");
    const packageIssueTitle = `[RCA] ${observation.observationId}: ${packageTitle || "Untitled observation"}`;

    const issueBody = buildIssueBody({
      observation,
      matchedExecution,
      stepExecutions,
      testCaseDetails,
      dataIntegrityWarnings
    });

    const skipIssue = false;
    const packageRecord: ObservationIssuePackage = {
      observationId: observation.observationId,
      executionId: observation.executionId,
      testCaseId: observation.testCaseId,
      requirement: packageRequirement,
      title: packageTitle,
      stepNo: observation.stepNo,
      expected: observation.expected,
      actual: observation.actual,
      severity: observation.severity,
      defectType: observation.defectType,
      rootCause: observation.rootCause,
      evidenceLink: observation.evidenceLink,
      matchedExecution,
      stepExecutions,
      testCaseDetails,
      issueTitle: packageIssueTitle,
      issueBody,
      dataIntegrityWarnings,
      skipIssue,
      deduplicationKey: observation.observationId
    };

    eligiblePackages.push(packageRecord);

    if (!observation.observationId || !observation.executionId || !observation.testCaseId) {
      issueCreationFailures.push({ observationId: observation.observationId || "UNKNOWN", message: "Eligible observation is missing required identity fields" });
      validationErrors.push({ code: "missing_identity", sheet: observationsSheetName, row: observation.sourceRow, message: `Observation row ${observation.sourceRow} is missing identity fields` });
    }
  }

  const packagesForIssueCreation = eligiblePackages.filter((pkg) => !pkg.skipIssue);
  const issuePackages = packagesForIssueCreation.map((pkg) => {
    if (!pkg.observationId || !pkg.executionId || !pkg.testCaseId) {
      return { ...pkg, skipIssue: true };
    }
    return pkg;
  });

  const createdIssues = issuePackages.filter((pkg) => !pkg.skipIssue).length;
  const duplicates = duplicatesSkipped;

  return {
    source: githubPath,
    sheets: [...processedSheets],
    totalObservationRows: observationRows.length,
    eligibleObservations: issuePackages.length,
    skippedNonFailObservations,
    blockedExecutions,
    duplicatesSkipped: duplicates,
    issuesCreated: createdIssues,
    issueCreationFailures,
    validationErrors,
    packages: issuePackages
  };
}

function buildIssueBody(params: {
  observation: ObservationRecord;
  matchedExecution?: TestExecutionRecord;
  stepExecutions: StepExecutionRecord[];
  testCaseDetails?: TestCaseDetailRecord;
  dataIntegrityWarnings: string[];
}): string {
  const { observation, matchedExecution, stepExecutions, testCaseDetails, dataIntegrityWarnings } = params;

  const executionSummary = matchedExecution ? [
    `- Execution ID: ${matchedExecution.executionId}`,
    `- Test Case ID: ${matchedExecution.testCaseId}`,
    `- Title: ${matchedExecution.title}`,
    `- Priority: ${matchedExecution.priority ?? ""}`,
    `- Status: ${matchedExecution.status}`,
    `- Steps: ${matchedExecution.steps ?? ""}`,
    `- Passed: ${matchedExecution.passed ?? ""}`,
    `- Failed: ${matchedExecution.failed ?? ""}`
  ].join("\n") : `- Execution ID: ${observation.executionId}\n- Test Case ID: ${observation.testCaseId}`;

  const testCaseDetailsSection = testCaseDetails ? [
    `- Title: ${testCaseDetails.title}`,
    `- Requirement: ${testCaseDetails.requirement}`,
    `- Category: ${testCaseDetails.category}`,
    `- Priority: ${testCaseDetails.priority}`,
    `- Steps: ${testCaseDetails.steps}`
  ].join("\n") : "- Title: \n- Requirement: \n- Category: \n- Priority: \n- Steps: ";

  const warnings = dataIntegrityWarnings.length > 0 ? `\n\n## Data Integrity Warnings\n\n- ${dataIntegrityWarnings.join("\n- ")}` : "";

  const stepRows = stepExecutions.length > 0 ? stepExecutions.map((step) => {
    const safeStep = escapeTableCell(String(step.step));
    const safeAction = escapeTableCell(String(step.action));
    const safeExpected = escapeTableCell(String(step.expected));
    const safeActual = escapeTableCell(String(step.actual));
    const safeStatus = escapeTableCell(String(step.status));
    return `| ${safeStep} | ${safeAction} | ${safeExpected} | ${safeActual} | ${safeStatus} |`;
  }).join("\n") : "| No matching Step Execution rows found |  |  |  |  |";

  return [
    "## Observation",
    "",
    `- Observation ID: ${observation.observationId}`,
    `- Execution ID: ${observation.executionId}`,
    `- Test Case ID: ${observation.testCaseId}`,
    `- Requirement (tester/test-system supplied, unverified): ${observation.requirement}`,
    `- Title: ${observation.title}`,
    `- Step No.: ${observation.stepNo}`,
    "",
    "## Tester-Submitted Behaviour",
    "",
    `- Expected (tester-submitted): ${observation.expected}`,
    `- Actual (tester-submitted): ${observation.actual}`,
    "",
    "## Tester-Submitted Metadata",
    "",
    `- Severity (tester-submitted, unverified): ${observation.severity}`,
    `- Defect Type (tester-submitted, unverified): ${observation.defectType}`,
    "",
    "## Tester-Submitted Root Cause Hypothesis",
    "",
    `- Root Cause (tester-submitted hypothesis, not confirmed): ${observation.rootCause}`,
    "",
    "## Evidence Reference",
    "",
    `- Evidence Link (pointer to Step Execution row, not captured evidence): ${observation.evidenceLink}`,
    "",
    "## Test Case Details",
    "",
    testCaseDetailsSection,
    "",
    "## Step Execution",
    "",
    "| Step | Action | Expected | Actual | Status |",
    "|---|---|---|---|---|",
    stepRows,
    "",
    "## RCA Investigation Instructions",
    "",
    "The Banking RCA Investigator must:",
    "",
    "1. Treat Expected and Actual as tester-submitted observations.",
    "2. Treat Severity and Defect Type as unverified tester-submitted metadata.",
    "3. Treat Root Cause as an unconfirmed hypothesis.",
    "4. Treat Evidence Link as a pointer/reference, not captured evidence.",
    "5. Treat the workbook Requirement as metadata, not authoritative BRD evidence.",
    "6. Retrieve the authoritative requirement from Banking RAG.",
    "7. Retrieve relevant historical RCA from Banking RAG.",
    "8. Compare observed behavior against authoritative requirements.",
    "9. Produce the standard RCAInvestigation JSON.",
    "10. Hand the complete RCAInvestigation JSON to the Banking Defect Decision Agent using the exact Multica roster mention protocol.",
    "",
    "The workbook Requirement field is tester/test-system supplied metadata.",
    "It must not be treated as the authoritative BRD requirement.",
    "Retrieve and validate the applicable requirement through Banking RAG.",
    executionSummary,
    warnings
  ].join("\n");
}

function parseSheetRows(workbook: XLSX.WorkBook, sheetName: string, requiredHeaders: Record<string, string>): { rows: Array<{ row: unknown[]; rowNumber: number }>; headerMap: Map<string, number>; missingHeaders: string[] } {
  const rows = XLSX.utils.sheet_to_json<unknown[]>(workbook.Sheets[sheetName], { header: 1, defval: "", raw: false }) as unknown[][];
  const headerRowIndex = findHeaderRow(rows, Object.values(requiredHeaders));
  if (headerRowIndex === null) {
    return { rows: [], headerMap: new Map(), missingHeaders: Object.values(requiredHeaders) };
  }
  const headerRow = rows[headerRowIndex] ?? [];
  const headerMap = new Map<string, number>();
  for (let index = 0; index < headerRow.length; index += 1) {
    const header = normalizeHeaderName(headerRow[index]);
    if (header) headerMap.set(header, index);
  }
  const missingHeaders = Object.values(requiredHeaders)
    .map((header) => normalizeHeaderName(header))
    .filter((header) => !headerMap.has(header));

  const parsedRows: Array<{ row: unknown[]; rowNumber: number }> = [];
  for (let rowIndex = headerRowIndex + 1; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex] ?? [];
    if (row.every((value) => String(value ?? "").trim() === "")) continue;
    parsedRows.push({ row, rowNumber: rowIndex + 1 });
  }
  return { rows: parsedRows, headerMap, missingHeaders };
}

function findHeaderRow(rows: unknown[][], requiredHeaders: string[]): number | null {
  const normalizedRequired = requiredHeaders.map((header) => normalizeHeaderName(header));
  for (let rowIndex = 0; rowIndex < Math.min(rows.length, 50); rowIndex += 1) {
    const row = rows[rowIndex] ?? [];
    const foundHeaders = new Set<string>();
    for (const value of row) {
      const normalized = normalizeHeaderName(value);
      if (normalized) foundHeaders.add(normalized);
    }
    if (normalizedRequired.every((header) => foundHeaders.has(header))) return rowIndex;
  }
  return null;
}

function toTestExecutionRecord(row: unknown[], headerMap: Map<string, number>, sheetName: string): TestExecutionRecord | null {
  const values = readRowValues(row, headerMap);
  const executionId = String(values.get("executionid") ?? "").trim();
  const testCaseId = String(values.get("testcaseid") ?? "").trim();
  const title = String(values.get("title") ?? "").trim();
  const priority = String(values.get("priority") ?? "").trim() || null;
  const status = String(values.get("status") ?? "").trim();
  const stepsValue = String(values.get("steps") ?? "").trim();
  const passedValue = String(values.get("passed") ?? "").trim();
  const failedValue = String(values.get("failed") ?? "").trim();
  if (!executionId || !testCaseId || !status) {
    return null;
  }
  return {
    executionId,
    testCaseId,
    title,
    priority,
    status,
    steps: parseIntegerLike(stepsValue),
    passed: parseIntegerLike(passedValue),
    failed: parseIntegerLike(failedValue)
  };
}

function toStepExecutionRecord(row: unknown[], headerMap: Map<string, number>, sheetName: string): StepExecutionRecord | null {
  const values = readRowValues(row, headerMap);
  const executionId = String(values.get("executionid") ?? "").trim();
  const testCaseId = String(values.get("testcaseid") ?? "").trim();
  const step = String(values.get("step") ?? "").trim();
  const action = String(values.get("action") ?? "").trim();
  const expected = String(values.get("expected") ?? "").trim();
  const actual = String(values.get("actual") ?? "").trim();
  const status = String(values.get("status") ?? "").trim();
  if (!executionId || !testCaseId) return null;
  return { executionId, testCaseId, step, action, expected, actual, status };
}

function toObservationRecord(row: unknown[], headerMap: Map<string, number>, sheetName: string, sourceRow: number): ObservationRecord | null {
  const values = readRowValues(row, headerMap);
  const observationId = String(values.get("observationid") ?? "").trim();
  const executionId = String(values.get("executionid") ?? "").trim();
  const testCaseId = String(values.get("testcaseid") ?? "").trim();
  const requirement = String(values.get("requirement") ?? "").trim();
  const title = String(values.get("title") ?? "").trim();
  const stepNo = String(values.get("stepno") ?? "").trim();
  const expected = String(values.get("expected") ?? "").trim();
  const actual = String(values.get("actual") ?? "").trim();
  const severity = String(values.get("severity") ?? "").trim();
  const defectType = String(values.get("defecttype") ?? "").trim();
  const rootCause = String(values.get("rootcause") ?? "").trim();
  const resolutionStatus = String(values.get("resolutionstatuspassfail") ?? "").trim();
  const evidenceLink = String(values.get("evidencelink") ?? "").trim();
  const sNo = String(values.get("sno") ?? "").trim();
  const assignedTo = String(values.get("assignedto") ?? "").trim();
  const reportedByDate = String(values.get("reportedbydate") ?? "").trim();

  if (!observationId || !executionId || !testCaseId) {
    return null;
  }

  return {
    sNo,
    observationId,
    executionId,
    testCaseId,
    requirement,
    stepNo,
    title,
    expected,
    actual,
    severity,
    defectType,
    rootCause,
    resolutionStatus,
    assignedTo,
    reportedByDate,
    evidenceLink,
    sourceSheet: sheetName,
    sourceRow
  };
}

function toTestCaseDetailRecord(row: unknown[], headerMap: Map<string, number>, sheetName: string): TestCaseDetailRecord | null {
  const values = readRowValues(row, headerMap);
  const testCaseId = String(values.get("testcaseid") ?? "").trim();
  const title = String(values.get("title") ?? "").trim();
  const requirement = String(values.get("requirement") ?? "").trim();
  const category = String(values.get("category") ?? "").trim();
  const priority = String(values.get("priority") ?? "").trim();
  const steps = String(values.get("steps") ?? "").trim();
  if (!testCaseId) return null;
  return { testCaseId, title, requirement, category, priority, steps };
}

function readRowValues(row: unknown[], headerMap: Map<string, number>): Map<string, string> {
  const values = new Map<string, string>();
  for (const [header, index] of headerMap.entries()) {
    const value = row[index] ?? "";
    values.set(header, String(value).trim());
  }
  return values;
}

function normalizeHeaderName(value: unknown): string {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "")
    .trim();
}

function normalizeSheetName(value: string): string {
  return String(value ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}

function normalizeStatus(value: string): string {
  return String(value ?? "").trim().toUpperCase();
}

function parseIntegerLike(value: string): number | null {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

function sortStepRows(rows: StepExecutionRecord[]): StepExecutionRecord[] {
  return [...rows].sort((left, right) => {
    const leftValue = Number.parseFloat(left.step);
    const rightValue = Number.parseFloat(right.step);
    if (Number.isFinite(leftValue) && Number.isFinite(rightValue)) return leftValue - rightValue;
    return left.step.localeCompare(right.step, undefined, { numeric: true, sensitivity: "base" });
  });
}

function escapeTableCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\n+/g, " <br> ");
}

export function buildTestExecutionDocumentContent(result: TestExecutionIngestionResult): string {
  const blockedSection = result.blockedExecutions.length > 0
    ? [
        "## Blocked Test Executions",
        "",
        ...result.blockedExecutions.map((entry) => [
          `- ${entry.testCaseId}: ${entry.title} (Status: ${entry.status}; Steps: ${entry.steps ?? 0}; Passed: ${entry.passed ?? 0}; Failed: ${entry.failed ?? 0})`
        ].join("\n")),
        ""
      ].join("\n")
    : "## Blocked Test Executions\n\n- None";

  const issueSection = result.packages.length > 0
    ? [
        "## Eligible Observations",
        "",
        ...result.packages.map((pkg) => [
          `### ${pkg.observationId}`,
          `- Execution ID: ${pkg.executionId}`,
          `- Test Case ID: ${pkg.testCaseId}`,
          `- Requirement: ${pkg.requirement}`,
          `- Title: ${pkg.title}`,
          `- Step No.: ${pkg.stepNo}`,
          `- Expected: ${pkg.expected}`,
          `- Actual: ${pkg.actual}`
        ].join("\n"))
      ].join("\n\n")
    : "## Eligible Observations\n\n- None";

  const warnings = result.validationErrors.length > 0 ? [
    "## Validation Warnings",
    "",
    ...result.validationErrors.map((error) => `- ${error.message}`)
  ].join("\n") : "## Validation Warnings\n\n- None";

  return [
    "# Test Execution Export",
    "",
    `- Source: ${result.source}`,
    `- Total observations: ${result.totalObservationRows}`,
    `- Eligible observations: ${result.eligibleObservations}`,
    `- Blocked executions: ${result.blockedExecutions.length}`,
    "",
    blockedSection,
    "",
    issueSection,
    "",
    warnings
  ].join("\n");
}

export function detectTestExecutionWorkbook(buffer: Buffer): boolean {
  try {
    const workbook = XLSX.read(buffer, { type: "buffer", cellDates: false, raw: false });
    const names = workbook.SheetNames.map((sheet) => normalizeSheetName(sheet));
    return ["test execution", "step execution", "observations", "test case details"].every((name) => names.includes(name));
  } catch {
    return false;
  }
}
