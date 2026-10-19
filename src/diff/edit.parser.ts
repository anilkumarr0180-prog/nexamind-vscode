import type { EditChunk, FileEditProposal, ParsedProposalResult } from "./edit.types";

/**
 * Standard instructions explaining the expected edit format to the AI model.
 */
export const STRUCTURED_EDIT_SYSTEM_PROMPT = `When proposing code modifications, you MUST format changes using this exact structured block:
\`\`\`edit:relative/file/path
<<<<<<< SEARCH
exact original code lines to replace
=======
new replacement code lines
>>>>>>> REPLACE
\`\`\`
Rules for code proposals:
1. Specify the target file path relative to the workspace root after "edit:".
2. The code in the SEARCH block must match existing file content EXACTLY, including indentation.
3. Keep SEARCH blocks concise and focused on the lines being modified.
4. You may include multiple SEARCH/REPLACE chunks in a single block for non-contiguous changes.
5. Do not include markdown or explanations inside the edit code block.`;

/**
 * Parses markdown text to detect and extract structured edit blocks.
 * Safely distinguishes executable edit blocks from normal code blocks or prose.
 */
export function parseEditProposals(text: string): ParsedProposalResult {
  if (!text || typeof text !== "string") {
    return { hasProposals: false, proposals: [], errors: [] };
  }

  const proposals: FileEditProposal[] = [];
  const errors: string[] = [];

  // Match fenced code blocks starting with edit: or edit <path>
  const blockRegex = /```(?:edit\s*:\s*|edit\s+)([^\r\n]+)\r?\n([\s\S]*?)```/gi;

  let match: RegExpExecArray | null;
  while ((match = blockRegex.exec(text)) !== null) {
    const rawPath = match[1]?.trim() || "";
    const blockContent = match[2] || "";
    const rawBlock = match[0];

    // Clean path (strip backticks, quotes, or trailing comments)
    const cleanPath = rawPath
      .replace(/^[`"']+|[`"']+$/g, "")
      .split(/\s+/)[0]
      .replace(/\\/g, "/");

    if (!cleanPath) {
      errors.push("Malformed edit block: missing target file path after 'edit:'.");
      continue;
    }

    // Verify SEARCH marker presence
    if (!/<<<<<<<[ \t]*SEARCH/i.test(blockContent)) {
      errors.push(
        `Malformed edit block for "${cleanPath}": missing '<<<<<<< SEARCH' marker.`,
      );
      continue;
    }

    // Match all SEARCH / REPLACE chunks inside this block
    const chunkRegex =
      /<<<<<<<[ \t]*SEARCH[ \t]*\r?\n([\s\S]*?)\r?\n=======[ \t]*\r?\n([\s\S]*?)\r?\n>>>>>>>[ \t]*REPLACE/g;

    const chunks: EditChunk[] = [];
    let chunkMatch: RegExpExecArray | null;

    while ((chunkMatch = chunkRegex.exec(blockContent)) !== null) {
      const search = chunkMatch[1];
      const replace = chunkMatch[2];
      chunks.push({ search, replace });
    }

    if (chunks.length === 0) {
      errors.push(
        `Malformed edit block for "${cleanPath}": could not parse valid '<<<<<<< SEARCH ... ======= ... >>>>>>> REPLACE' chunks.`,
      );
      continue;
    }

    // Group with existing file proposal if same file appeared in multiple blocks
    const existing = proposals.find((p) => p.filePath === cleanPath);
    if (existing) {
      existing.chunks.push(...chunks);
      existing.rawBlock += "\n\n" + rawBlock;
    } else {
      proposals.push({
        filePath: cleanPath,
        chunks,
        rawBlock,
      });
    }
  }

  return {
    hasProposals: proposals.length > 0,
    proposals,
    errors,
  };
}
