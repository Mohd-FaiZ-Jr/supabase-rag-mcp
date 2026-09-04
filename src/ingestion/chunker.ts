import { chunkMetadataSchema, type SemanticChunk } from "./types.js";

const MAX_CHUNK_LENGTH = 5000;

export function chunkMarkdown(document: { path: string; content: string; documentType: string }): SemanticChunk[] {
  const lines = document.content.replace(/\r\n?/g, "\n").split("\n");
  const sections: Array<{ headings: string[]; lines: string[] }> = [];
  const headings: string[] = [];
  let current: string[] = [];

  const flushSection = () => {
    if (current.join("\n").trim()) sections.push({ headings: [...headings], lines: current });
    current = [];
  };

  for (const line of lines) {
    const heading = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) {
      flushSection();
      const level = heading[1].length;
      headings.splice(level - 1);
      headings[level - 1] = heading[2].trim();
      continue;
    }
    current.push(line);
  }
  flushSection();
  if (sections.length === 0) throw new Error(`Markdown chunking produced no content for ${document.path}`);

  const documentRequirementId = /(?:requirement\s*id|requirement\s*identifier)\s*(?:[:#-]|\n)\s*([A-Z][A-Z0-9]+(?:-[A-Z0-9]+)+)/i.exec(document.content)?.[1];
  const chunks: SemanticChunk[] = [];
  for (const section of sections) {
    const context = section.headings.filter(Boolean);
    const sectionName = context.at(-1) ?? "Document";
    const paragraphs = section.lines.join("\n").split(/\n\s*\n/).map((value) => value.trim()).filter(Boolean);
    let body = "";
    for (const paragraph of paragraphs) {
      const candidate = body ? `${body}\n\n${paragraph}` : paragraph;
      if (body && candidate.length > MAX_CHUNK_LENGTH) {
        chunks.push(makeChunk(chunks.length, document, context, sectionName, body, documentRequirementId));
        body = paragraph;
      } else {
        body = candidate;
      }
    }
    if (body) chunks.push(makeChunk(chunks.length, document, context, sectionName, body, documentRequirementId));
  }
  return chunks;
}

function makeChunk(index: number, document: { path: string; documentType: string }, headings: string[], section: string, body: string, documentRequirementId?: string): SemanticChunk {
  const requirementId = documentRequirementId ?? /(?:requirement\s*id|requirement\s*identifier|id)\s*[:#-]?\s*([A-Z][A-Z0-9]+(?:-[A-Z0-9]+)+)/i.exec(body)?.[1];
  const context = headings.length > 0 ? `Section: ${headings.join(" > ")}\n\n` : "";
  const metadata = chunkMetadataSchema.parse({
    document_type: document.documentType,
    ...(requirementId ? { requirement_id: requirementId } : {}),
    section,
    github_path: document.path
  });
  return {
    chunkIndex: index,
    content: `${context}${body}`,
    metadata
  };
}