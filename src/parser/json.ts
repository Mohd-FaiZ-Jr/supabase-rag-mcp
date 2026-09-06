import { createHash } from "node:crypto";
import type { GithubFile } from "../services/github.js";
import type { ChunkMetadata, DocumentType, IngestionDocument } from "../ingestion/types.js";

type JsonRecord = Record<string, unknown>;

export type ParsedJsonDocument = {
  document: IngestionDocument;
  documentType: DocumentType;
  contentHash: string;
  chunkMetadata: Array<Record<string, unknown>>;
  skipped: boolean;
};

export function parseJsonDocument(file: GithubFile): ParsedJsonDocument {
  const rawContent = file.content.toString("utf8");
  let value: unknown;
  try {
    value = JSON.parse(rawContent);
  } catch (error) {
    throw new Error(`Invalid JSON in ${file.path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isRecord(value)) throw new Error(`Invalid JSON document in ${file.path}: top-level value must be an object`);

  const contentHash = createHash("sha256").update(rawContent, "utf8").digest("hex");
  if (Object.hasOwn(value, "coverage_report")) {
    return { document: { ...file, content: "" }, documentType: "OPEN_QUESTION", contentHash, chunkMetadata: [], skipped: true };
  }

  const parsed = normalize(value, file.path);
  return {
    document: { ...file, content: parsed.content },
    documentType: parsed.documentType,
    contentHash,
    chunkMetadata: parsed.chunkMetadata,
    skipped: false
  };
}

function normalize(value: JsonRecord, path: string): { content: string; documentType: DocumentType; chunkMetadata: Array<Record<string, unknown>> } {
  if (isRecord(value.brd)) return { content: normalizeBrd(value.brd), documentType: "BRD", chunkMetadata: [] };
  if (Array.isArray(value.business_rules)) return normalizeRecords(value.business_rules, path, "BRD", "Business Rule", (record) => [
    `Rule: ${text(record.rule)}`,
    `Priority: ${text(record.priority)}`,
    `Status: ${text(record.status)}`,
    `Source: ${text(record.source)}`,
    `Related Roles: ${join(record.related_roles)}`
  ], (record) => statusMetadata(record));
  if (Array.isArray(value.requirements)) return normalizeRecords(value.requirements, path, "BRD", "Requirement", (record) => [
    `Description: ${text(record.description)}`,
    `Functional Behaviour: ${text(record.functional_behaviour)}`,
    `Priority: ${text(record.priority)}`,
    `Status: ${text(record.status)}`,
    `Related Business Rules: ${join(record.business_rules)}`,
    `Data Entities: ${join(record.data_entities)}`,
    `Scope: ${text(record.scope)}`
  ], (record) => statusMetadata(record));
  if (Array.isArray(value.acceptance_criteria)) return normalizeRecords(value.acceptance_criteria, path, "BRD", "Acceptance Criterion", (record) => [
    `Criterion: ${text(record.criterion)}`
  ], () => ({}), (record) => `: ${text(record.id)} (Requirement: ${text(record.requirement_id)})`);
  if (Array.isArray(value.data_entities)) return normalizeRecords(value.data_entities, path, "BRD", "Data Entity", (record) => [
    `Description: ${text(record.description)}`,
    `Fields: ${formatFields(record.fields)}`,
    `Validations: ${join(record.validations)}`
  ], () => ({}), (record) => `: ${text(record.name)}`);
  if (Array.isArray(value.open_questions)) return normalizeRecords(value.open_questions, path, "OPEN_QUESTION", "Open Question", (record) => [
    `Question: ${text(record.question)}`,
    `Status: ${text(record.status)}`,
    `Priority: ${text(record.priority)}`,
    `Source: ${text(record.source)}`
  ]);
  if (Array.isArray(value.errors)) {
    if (value.errors.length === 0) return {
      content: `# Error Catalogue\n\nNo error codes are currently defined. ${text(value.note)}`,
      documentType: "OPEN_QUESTION",
      chunkMetadata: []
    };
    return normalizeRecords(value.errors, path, "OPEN_QUESTION", "Error", (record) => Object.entries(record)
      .filter(([key]) => key !== "id")
      .map(([key, entry]) => `${label(key)}: ${renderValue(entry)}`), () => ({}), (record) => `: ${text(record.id ?? record.code)}`);
  }
  if (Array.isArray(value.uat_cases)) return normalizeRecords(value.uat_cases, path, "TEST_CASE", "Planned Test Case", (record) => [
    `Precondition: ${text(record.precondition)}`,
    `Steps: ${formatSteps(record.steps)}`,
    `Expected Result (PLANNED — not yet executed): ${text(record.expected_result)}`
  ], () => ({}), (record) => `: ${text(record.id)} (Acceptance Criterion: ${text(record.acceptance_criterion_id)}, Requirement: ${text(record.requirement_id)})`);
  throw new Error(`Unsupported JSON shape in ${path}: expected one of brd, business_rules, requirements, acceptance_criteria, data_entities, open_questions, errors, uat_cases, or coverage_report`);
}

function normalizeBrd(brd: JsonRecord): string {
  const sections: Array<[string, string]> = [
    ["Project Overview", renderValue(brd.project_overview)],
    ["Objectives", renderValue(brd.objectives)],
    ["Stakeholders", renderValue(brd.stakeholders)],
    ["Scope", renderValue(brd.scope)],
    ["Governance", renderValue(brd.governance)],
    ["Success Criteria", renderValue(brd.success_criteria)]
  ];
  return sections.map(([heading, content]) => `# ${heading}\n\n${content}`).join("\n\n");
}

function normalizeRecords(
  records: unknown[],
  path: string,
  documentType: DocumentType,
  heading: string,
  lines: (record: JsonRecord) => string[],
  metadata: (record: JsonRecord) => Record<string, unknown> = () => ({}),
  titleSuffix: (record: JsonRecord) => string = (record) => `: ${text(record.id)}`
): { content: string; documentType: DocumentType; chunkMetadata: Array<Record<string, unknown>> } {
  const normalized = records.map((entry, index) => {
    if (!isRecord(entry)) throw new Error(`Invalid JSON shape in ${path}: ${heading} entry ${index + 1} must be an object`);
    return { content: `# ${heading}${titleSuffix(entry)}\n\n${lines(entry).join("\n")}`, metadata: metadata(entry) };
  });
  return { content: normalized.map((entry) => entry.content).join("\n\n"), documentType, chunkMetadata: normalized.map((entry) => entry.metadata) };
}

function statusMetadata(record: JsonRecord): Record<string, unknown> {
  return typeof record.status === "string" ? { rule_status: record.status } : {};
}

function formatFields(value: unknown): string {
  if (!Array.isArray(value)) return renderValue(value);
  return value.map((field) => {
    if (!isRecord(field)) return renderValue(field);
    return `${text(field.name)} (${text(field.type)}) - ${text(field.description)}; ${text(field.validation)}; ${text(field.constraint)}`;
  }).join(", ");
}

function formatSteps(value: unknown): string {
  if (!Array.isArray(value)) return text(value);
  return value.map((step, index) => `${index + 1}. ${renderValue(step)}`).join(" ");
}

function join(value: unknown): string {
  return Array.isArray(value) ? value.map(renderValue).join(", ") : renderValue(value);
}

function renderValue(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (Array.isArray(value)) return value.map(renderValue).join(", ");
  if (isRecord(value)) return Object.entries(value).map(([key, entry]) => `${label(key)}: ${renderValue(entry)}`).join("; ");
  return String(value);
}

function text(value: unknown): string {
  return renderValue(value);
}

function label(value: string): string {
  return value.replace(/_/g, " ").replace(/\b\w/g, (character) => character.toUpperCase());
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}