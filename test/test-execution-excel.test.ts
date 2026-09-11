import assert from "node:assert/strict";
import test from "node:test";
import * as XLSX from "xlsx";
import { parseTestExecutionWorkbook } from "../src/parser/test-execution-excel.js";

const path = "documents/UAT/2026/test-execution/Gen_Final.xlsx";

function workbookBuffer(sheets: Record<string, unknown[][]>): Buffer {
  const workbook = XLSX.utils.book_new();
  for (const [name, rows] of Object.entries(sheets)) {
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), name);
  }
  return XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
}

const testExecutionSheet = [
  ["Execution ID", "Test Case ID", "Title", "Priority", "Status", "Steps", "Passed", "Failed"],
  ["GEN-20260909-OBS-001", "TC-002", "Login flow", "High", "FAIL", "5", "0", "1"],
  ["GEN-20260909-OBS-001", "TC-021", "Blocked test", "Low", "BLOCKED", "0", "0", "0"],
  ["GEN-20260909-OBS-001", "TC-003", "Checkout API", "Medium", "PASS", "4", "1", "0"]
];

const stepExecutionSheet = [
  ["Execution ID", "Test Case ID", "Step", "Action", "Expected", "Actual", "Status"],
  ["GEN-20260909-OBS-001", "TC-002", "1", "Open login page", "Page loads", "Page loads", "PASS"],
  ["GEN-20260909-OBS-001", "TC-002", "2", "Submit invalid credentials", "Error is shown", "Validation error is missing", "FAIL"],
  ["GEN-20260909-OBS-001", "TC-021", "1", "Attempt blocked call", "N/A", "N/A", "BLOCKED"],
  ["GEN-20260909-OBS-001", "TC-003", "1", "Add item", "Added", "Added", "PASS"]
];

const observationsSheet = [
  ["S.No", "Observation ID", "Execution ID", "Test Case ID", "Requirement", "Step No.", "Title", "Expected", "Actual", "Severity", "Defect Type", "Root Cause", "Resolution Status (Pass/Fail)", "Assigned To", "Reported By / Date", "Evidence Link"],
  ["1", "OBS-001", "GEN-20260909-OBS-001", "TC-002", "FR-001", "2", "Invalid credential validation", "Error is shown", "Validation error is missing", "High", "Validation", "Input validation rule not enforced at the field/API layer.", "Fail", "Tester A", "2026-09-09", "Step Execution row for TC-002"],
  ["2", "OBS-002", "GEN-20260909-OBS-001", "TC-003", "FR-002", "1", "Payment flow", "Payment succeeds", "Payment is rejected", "Medium", "Functional", "Missing business rule", "PASS", "Tester B", "2026-09-09", "Step Execution row for TC-003"]
];

const testCaseDetailsSheet = [
  ["Test Case ID", "Title", "Requirement", "Category", "Priority", "Steps"],
  ["TC-002", "Login flow", "FR-001", "Authentication", "High", "5"],
  ["TC-003", "Checkout flow", "FR-002", "Payments", "Medium", "4"],
  ["TC-021", "Blocked test", "FR-021", "Authentication", "Low", "0"]
];

test("detects the Gen_Final workbook structure, recognizes exact headers, and keeps Export Summary optional", () => {
  const result = parseTestExecutionWorkbook(workbookBuffer({
    "Export Summary": [["Summary"]],
    "Test Execution": testExecutionSheet,
    "Step Execution": stepExecutionSheet,
    "Observations": observationsSheet,
    "Test Case Details": testCaseDetailsSheet
  }), path);

  assert.equal(result.source, path);
  assert.deepEqual(result.sheets, ["Test Execution", "Step Execution", "Observations", "Test Case Details"]);
  assert.equal(result.totalObservationRows, 2);
  assert.equal(result.eligibleObservations, 1);
  assert.equal(result.skippedNonFailObservations, 1);
  assert.equal(result.blockedExecutions.length, 1);
  assert.equal(result.packages.length, 1);
  assert.equal(result.packages[0].issueBody.includes("Expected (tester-submitted)"), true);
  assert.equal(result.packages[0].issueBody.includes("Root Cause (tester-submitted hypothesis, not confirmed)"), true);
  assert.equal(result.packages[0].issueBody.includes("Evidence Link (pointer to Step Execution row, not captured evidence)"), true);
});

test("rejects missing sheets and missing required headers with clear validation errors", () => {
  assert.throws(() => parseTestExecutionWorkbook(workbookBuffer({
    "Test Execution": testExecutionSheet,
    "Step Execution": stepExecutionSheet,
    "Observations": [["Observation ID", "Execution ID", "Test Case ID"]],
    "Test Case Details": testCaseDetailsSheet
  }), path), /Observations.*missing.*required headers|required headers/i);

  assert.throws(() => parseTestExecutionWorkbook(workbookBuffer({
    "Test Execution": [["Execution ID", "Title"]],
    "Step Execution": stepExecutionSheet,
    "Observations": observationsSheet,
    "Test Case Details": testCaseDetailsSheet
  }), path), /Test Execution.*missing.*required headers|required headers/i);
});

test("filters case-insensitive fail values and routes blocked executions separately", () => {
  const result = parseTestExecutionWorkbook(workbookBuffer({
    "Test Execution": [
      ["Execution ID", "Test Case ID", "Title", "Priority", "Status", "Steps", "Passed", "Failed"],
      ["GEN-1", "TC-100", "Blocked test", "Low", "BLOCKED", "0", "0", "0"],
      ["GEN-1", "TC-101", "Failing test", "High", "FAIL", "3", "0", "1"]
    ],
    "Step Execution": [
      ["Execution ID", "Test Case ID", "Step", "Action", "Expected", "Actual", "Status"],
      ["GEN-1", "TC-101", "1", "Attempt action", "Success", "Failure", "FAIL"]
    ],
    "Observations": [
      ["S.No", "Observation ID", "Execution ID", "Test Case ID", "Requirement", "Step No.", "Title", "Expected", "Actual", "Severity", "Defect Type", "Root Cause", "Resolution Status (Pass/Fail)", "Assigned To", "Reported By / Date", "Evidence Link"],
      ["1", "OBS-100", "GEN-1", "TC-100", "FR-100", "1", "Blocked", "Expected", "Actual", "Low", "Validation", "Not relevant", "block", "Tester", "date", "x"],
      ["2", "OBS-101", "GEN-1", "TC-101", "FR-101", "1", "Fail claim", "Expected", "Actual", "High", "Validation", "Issue", " Fail ", "Tester", "date", "x"],
      ["3", "OBS-102", "GEN-1", "TC-101", "FR-101", "1", "Pass claim", "Expected", "Actual", "High", "Validation", "Issue", "PASS", "Tester", "date", "x"],
      ["4", "OBS-103", "GEN-1", "TC-101", "FR-101", "1", "Uppercase fail", "Expected", "Actual", "High", "Validation", "Issue", "FAIL", "Tester", "date", "x"]
    ],
    "Test Case Details": [
      ["Test Case ID", "Title", "Requirement", "Category", "Priority", "Steps"],
      ["TC-100", "Blocked test", "FR-100", "Auth", "Low", "0"],
      ["TC-101", "Failing test", "FR-101", "Auth", "High", "3"]
    ]
  }), path);

  assert.equal(result.blockedExecutions.length, 1);
  assert.equal(result.eligibleObservations, 2);
  assert.equal(result.packages.some((pkg) => pkg.observationId === "OBS-101"), true);
  assert.equal(result.packages.some((pkg) => pkg.observationId === "OBS-102"), false);
  assert.equal(result.packages.some((pkg) => pkg.observationId === "OBS-103"), true);
});

test("joins observations to execution, steps, and test case details and preserves detailed warnings for missing relations", () => {
  const result = parseTestExecutionWorkbook(workbookBuffer({
    "Test Execution": [
      ["Execution ID", "Test Case ID", "Title", "Priority", "Status", "Steps", "Passed", "Failed"],
      ["GEN-1", "TC-200", "Broken test", "High", "FAIL", "3", "0", "1"]
    ],
    "Step Execution": [
      ["Execution ID", "Test Case ID", "Step", "Action", "Expected", "Actual", "Status"],
      ["GEN-1", "TC-200", "1", "Open screen", "Loads", "Loads", "PASS"],
      ["GEN-1", "TC-200", "2", "Submit bad data", "Error", "No error", "FAIL"]
    ],
    "Observations": [
      ["S.No", "Observation ID", "Execution ID", "Test Case ID", "Requirement", "Step No.", "Title", "Expected", "Actual", "Severity", "Defect Type", "Root Cause", "Resolution Status (Pass/Fail)", "Assigned To", "Reported By / Date", "Evidence Link"],
      ["1", "OBS-200", "GEN-1", "TC-200", "FR-200", "2", "Missing validation", "Error", "No error", "High", "Validation", "Rule missing", "fail", "Tester", "date", "Step Execution row for TC-200"]
    ],
    "Test Case Details": [
      ["Test Case ID", "Title", "Requirement", "Category", "Priority", "Steps"],
      ["TC-999", "Different case", "FR-999", "Auth", "High", "5"]
    ]
  }), path);

  assert.equal(result.packages[0].matchedExecution?.testCaseId, "TC-200");
  assert.equal(result.packages[0].stepExecutions.length, 2);
  assert.equal(result.packages[0].testCaseDetails, undefined);
  assert.equal(result.validationErrors.some((error) => /Test Case Details.*TC-200|missing.*relationship/i.test(error.message)), true);
});

test("deduplication is by Observation ID, not title; closed or open matching issues are skipped", () => {
  const result = parseTestExecutionWorkbook(workbookBuffer({
    "Test Execution": [
      ["Execution ID", "Test Case ID", "Title", "Priority", "Status", "Steps", "Passed", "Failed"],
      ["GEN-1", "TC-300", "Existing issue", "High", "FAIL", "3", "0", "1"]
    ],
    "Step Execution": [
      ["Execution ID", "Test Case ID", "Step", "Action", "Expected", "Actual", "Status"],
      ["GEN-1", "TC-300", "1", "Submit invalid data", "Error", "No error", "FAIL"]
    ],
    "Observations": [
      ["S.No", "Observation ID", "Execution ID", "Test Case ID", "Requirement", "Step No.", "Title", "Expected", "Actual", "Severity", "Defect Type", "Root Cause", "Resolution Status (Pass/Fail)", "Assigned To", "Reported By / Date", "Evidence Link"],
      ["1", "OBS-300", "GEN-1", "TC-300", "FR-300", "1", "Same title", "Error", "No error", "High", "Validation", "Issue", "fail", "Tester", "date", "Evidence"],
      ["2", "OBS-301", "GEN-1", "TC-300", "FR-300", "1", "Same title", "Error", "No error", "High", "Validation", "Issue", "fail", "Tester", "date", "Evidence"]
    ],
    "Test Case Details": [
      ["Test Case ID", "Title", "Requirement", "Category", "Priority", "Steps"],
      ["TC-300", "Existing issue", "FR-300", "Auth", "High", "3"]
    ]
  }), path);

  assert.equal(result.packages[0].issueTitle.startsWith("[RCA] OBS-300"), true);
  assert.equal(result.packages[1].issueTitle.startsWith("[RCA] OBS-301"), true);
  assert.equal(result.packages[0].skipIssue === false, true);
  assert.equal(result.packages[1].skipIssue === false, true);
});
