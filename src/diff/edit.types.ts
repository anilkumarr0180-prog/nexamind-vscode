/**
 * Types for structured code edit proposals and diff management.
 */

export interface EditChunk {
  search: string;
  replace: string;
}

export interface FileEditProposal {
  filePath: string;
  chunks: EditChunk[];
  rawBlock: string;
}

export interface ParsedProposalResult {
  hasProposals: boolean;
  proposals: FileEditProposal[];
  errors: string[];
}

export interface ValidatedFileEdit {
  filePath: string;
  originalContent: string;
  proposedContent: string;
  chunks: EditChunk[];
  fullPath?: string;
}

export type ProposalStatus = "pending" | "applied" | "rejected" | "stale";

export interface ActiveProposal {
  id: string;
  timestamp: number;
  files: ValidatedFileEdit[];
  status: ProposalStatus;
  errorMessage?: string;
}
