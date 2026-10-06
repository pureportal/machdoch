export type InstructionTagRule =
  | {
      op: "tag";
      tag: string;
    }
  | {
      op: "and" | "or";
      rules: InstructionTagRule[];
    };

export type InstructionDiagnosticSeverity =
  | "info"
  | "advisory"
  | "warning"
  | "error";

export interface InstructionDiagnostic {
  code: string;
  severity: InstructionDiagnosticSeverity;
  message: string;
  sourceId?: string;
  relativePath?: string;
  details?: Record<string, unknown>;
}

export class InstructionSystemError extends Error {
  readonly code: string;
  readonly diagnostics: readonly InstructionDiagnostic[];

  constructor(
    code: string,
    message: string,
    diagnostics: readonly InstructionDiagnostic[] = [],
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "InstructionSystemError";
    this.code = code;
    this.diagnostics = diagnostics;
  }
}

export interface InstructionProfileView {
  id: string;
  name: string;
  description?: string;
  body?: string;
  createdAt: string;
  updatedAt: string;
  byteLength: number;
  lineCount: number;
  digest: string;
  manualAssignmentCount: number;
  enabled: boolean;
  global: boolean;
  tags: string[];
  match?: InstructionTagRule;
}

export interface InstructionWorkspaceView {
  id: string;
  root: string;
  displayName?: string;
  tags: string[];
  scopes: Array<{ path: string; profiles: string[] }>;
}

export interface InstructionLibraryRecoveryView {
  libraryPath: string;
  backupPath: string;
  primaryValid: boolean;
  primaryDigest?: string;
  backupValid: boolean;
  backupDigest?: string;
  backupRevision?: number;
  resetDigest?: string;
  resetSource?: "primary" | "backup";
  errorCode?: string;
  errorMessage?: string;
}

export interface InstructionRegistryResult {
  schemaVersion: number;
  revision: number;
  profiles: InstructionProfileView[];
  workspaces: InstructionWorkspaceView[];
  recovery?: InstructionLibraryRecoveryView;
  libraryError?: string;
}

export type InstructionMutationInput =
  | {
      operation: "profile-create";
      profileId?: string;
      name: string;
      description?: string;
      body: string;
      enabled?: boolean;
      global?: boolean;
      tags?: string[];
      match?: InstructionTagRule;
      expectedRevision: number;
    }
  | {
      operation: "profile-edit";
      profileId: string;
      name?: string;
      description?: string;
      body?: string;
      enabled?: boolean;
      global?: boolean;
      tags?: string[];
      match?: InstructionTagRule | null;
      expectedRevision: number;
    }
  | {
      operation: "profile-duplicate";
      profileId: string;
      name?: string;
      expectedRevision: number;
    }
  | {
      operation: "profile-delete";
      profileId: string;
      expectedRevision: number;
    }
  | {
      operation: "workspace-configure";
      root: string;
      displayName?: string;
      tags?: string[];
      profileIds?: string[];
      expectedRevision: number;
    }
  | {
      operation: "workspace-relink";
      workspaceId: string;
      root: string;
      expectedRevision: number;
    }
  | {
      operation: "workspace-remove";
      workspaceId: string;
      confirmAssignedRemoval: boolean;
      expectedRevision: number;
    }
  | {
      operation: "workspace-scope-set";
      workspaceId: string;
      path: string;
      profileIds: string[];
      expectedRevision: number;
    }
  | {
      operation: "recovery-restore";
      expectedDigest: string;
    }
  | {
      operation: "recovery-reset";
      expectedDigest: string;
    };

export interface InstructionMutationResult {
  library?: { revision: number } & Record<string, unknown>;
  previousRevision?: number;
  profile?: { id: string; name: string } & Record<string, unknown>;
  workspace?: { id: string; root: string } & Record<string, unknown>;
  recovered?: boolean;
  reset?: boolean;
}
