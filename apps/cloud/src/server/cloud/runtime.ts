import { CloudAuthorization } from "./oauth/authorization";
import { CloudOAuthTokens } from "./oauth/tokens";
import type { CloudDatabase } from "./database";
import { CloudIdentity } from "./identity";
import { CloudSsoProviders } from "./auth/sso-providers";
import { CloudSsoFlows } from "./auth/sso-flows";
import { CloudOidcExchange } from "./auth/oidc-exchange";
import { CloudSigninPolicy } from "./auth/signin-policy";
import { CloudSessions } from "./auth/sessions";
import { CloudCredentials } from "./auth/credentials";
import { CloudRecurrencePreview } from "./automation/recurrence";
import { CloudSchedules } from "./automation/schedules";
import { CloudScheduleDispatcher } from "./automation/schedule-dispatcher";
import { CloudInvitations } from "./auth/invitations";
import { CloudInvitationAcceptance } from "./auth/invitation-acceptance";
import { CloudEmailSettingsService } from "./auth/email-settings";
import { CloudMagicLinks } from "./auth/magic-links";
import { CloudMailStore } from "./auth/mail-store";
import { CloudMailDispatcher } from "./auth/mail-dispatcher";
import type { MailSender } from "./auth/smtp";
import { CloudPlanning } from "./planning";
import { CloudProjects } from "./projects";
import { CloudLabels } from "./labels";
import { CloudIssueRelations } from "./relations";
import { CloudWorkflows } from "./workflows";
import { CloudPoker } from "./poker";
import { CloudAdministrationService } from "./administration";
import { CloudCycles } from "./cycles";
import { CloudComments } from "./comments";
import { CloudExecutionProfiles } from "./execution/profiles";
import { CloudRuns } from "./execution/runs";
import { CloudWorkers } from "./execution/workers";
import { CloudClientWorkspaces } from "./execution/client-workspaces";
import { CloudExecutionLeases } from "./execution/leases";
import { CloudExecutionEffects } from "./execution/effects";
import { CloudTaskInference } from "./execution/inference";
import { CloudRepositories } from "./execution/repositories";
import { CloudArtifactUploads } from "./execution/artifact-uploads";
import { CloudArtifacts } from "./execution/artifacts";
import { CloudAiProviders } from "./ai/providers";
import { cloudCredentialsCipher } from "./credential-storage";
import { initializeInstallation } from "./installation-storage";
import type { SettingsCipher } from "../settings-crypto";
import { CloudChatStore } from "./ai/chat-store";
import { CloudInferenceStore } from "./ai/inference-store";
import {
  CloudInferenceWorker,
  type CloudModelAdapterFactory,
} from "./ai/inference-worker";

export interface CloudRuntime {
  origin: string;
  database: CloudDatabase;
  identity: CloudIdentity;
  recurrence: CloudRecurrencePreview;
  schedules: CloudSchedules;
  scheduleDispatcher: CloudScheduleDispatcher;
  authentication: {
    credentials: CloudCredentials;
    ssoProviders: CloudSsoProviders;
    ssoFlows: CloudSsoFlows;
    oidcExchange: CloudOidcExchange;
    signinPolicy: CloudSigninPolicy;
    sessions: CloudSessions;
    invitations: CloudInvitations;
    invitationAcceptance: CloudInvitationAcceptance;
    emailSettings: CloudEmailSettingsService;
    magicLinks: CloudMagicLinks;
    mailStore: CloudMailStore;
    mailWorker: CloudMailDispatcher;
  };
  authorization: CloudAuthorization;
  oauthTokens: CloudOAuthTokens;
  planning: CloudPlanning;
  projects: CloudProjects;
  labels: CloudLabels;
  relations: CloudIssueRelations;
  workflows: CloudWorkflows;
  poker: CloudPoker;
  administration: CloudAdministrationService;
  cycles: CloudCycles;
  comments: CloudComments;
  aiProviders: CloudAiProviders;
  chat: {
    store: CloudChatStore;
  };
  inference: {
    store: CloudInferenceStore;
    worker: CloudInferenceWorker;
  };
  execution: {
    profiles: CloudExecutionProfiles;
    runs: CloudRuns;
    workers: CloudWorkers;
    clientWorkspaces: CloudClientWorkspaces;
    leases: CloudExecutionLeases;
    effects: CloudExecutionEffects;
    inference: CloudTaskInference;
    repositories: CloudRepositories;
    uploads: CloudArtifactUploads;
    artifacts: CloudArtifacts;
  };
}

const runtimeSymbol = Symbol.for("machdoch.cloud.runtime");
type RuntimeGlobal = typeof globalThis & {
  [runtimeSymbol]?: Promise<CloudRuntime>;
};

export function getCloudRuntime(): Promise<CloudRuntime> {
  const runtime = (globalThis as RuntimeGlobal)[runtimeSymbol];
  if (!runtime) throw new Error("Cloud runtime has not been initialized.");
  return runtime;
}

export function initializeCloudRuntime(
  factory: () => Promise<CloudRuntime>,
): Promise<CloudRuntime> {
  const globalRuntime = globalThis as RuntimeGlobal;
  if (!globalRuntime[runtimeSymbol]) {
    globalRuntime[runtimeSymbol] = factory().catch((error: unknown) => {
      delete globalRuntime[runtimeSymbol];
      throw error;
    });
  }
  return globalRuntime[runtimeSymbol];
}

export function createCloudRuntime(
  database: CloudDatabase,
  origin: string,
  options: {
    credentialsCipher?: SettingsCipher | null;
    modelAdapterFactory?: CloudModelAdapterFactory;
    repositoryFetch?: typeof fetch;
    mailSender?: MailSender;
  } = {},
): CloudRuntime {
  const aiProviders = new CloudAiProviders(
    database,
    options.credentialsCipher ?? null,
  );
  const chatStore = new CloudChatStore(database);
  const inference = new CloudInferenceStore(database);
  const mailStore = new CloudMailStore(
    database,
    options.credentialsCipher ?? null,
    origin,
  );
  const recurrence = new CloudRecurrencePreview(database);
  return {
    database,
    origin,
    identity: new CloudIdentity(database),
    recurrence,
    schedules: new CloudSchedules(database, recurrence),
    scheduleDispatcher: new CloudScheduleDispatcher(database, recurrence),
    authentication: {
      credentials: new CloudCredentials(database),
      ssoProviders: new CloudSsoProviders(
        database,
        options.credentialsCipher ?? null,
        origin,
      ),
      ssoFlows: new CloudSsoFlows(
        database,
        options.credentialsCipher ?? null,
        origin,
      ),
      oidcExchange: new CloudOidcExchange(
        database,
        options.credentialsCipher ?? null,
        origin,
      ),
      signinPolicy: new CloudSigninPolicy(database),
      sessions: new CloudSessions(database),
      invitations: new CloudInvitations(
        database,
        options.credentialsCipher ?? null,
        origin,
      ),
      invitationAcceptance: new CloudInvitationAcceptance(
        database,
        options.credentialsCipher ?? null,
      ),
      emailSettings: new CloudEmailSettingsService(
        database,
        options.credentialsCipher ?? null,
      ),
      magicLinks: new CloudMagicLinks(
        database,
        options.credentialsCipher ?? null,
      ),
      mailStore,
      mailWorker: new CloudMailDispatcher(mailStore, options.mailSender),
    },
    authorization: new CloudAuthorization(database, origin),
    oauthTokens: new CloudOAuthTokens(database, origin),
    planning: new CloudPlanning(database),
    projects: new CloudProjects(database),
    labels: new CloudLabels(database),
    relations: new CloudIssueRelations(database),
    workflows: new CloudWorkflows(database),
    poker: new CloudPoker(database),
    administration: new CloudAdministrationService(database),
    cycles: new CloudCycles(database),
    comments: new CloudComments(database),
    aiProviders,
    chat: {
      store: chatStore,
    },
    inference: {
      store: inference,
      worker: new CloudInferenceWorker(
        inference,
        aiProviders,
        options.modelAdapterFactory,
      ),
    },
    execution: {
      profiles: new CloudExecutionProfiles(database),
      runs: new CloudRuns(database),
      workers: new CloudWorkers(database),
      clientWorkspaces: new CloudClientWorkspaces(database),
      leases: new CloudExecutionLeases(database),
      effects: new CloudExecutionEffects(database),
      inference: new CloudTaskInference(database),
      repositories: new CloudRepositories(database, options.repositoryFetch),
      uploads: new CloudArtifactUploads(database),
      artifacts: new CloudArtifacts(database),
    },
  };
}

export async function refreshCloudOrigin(runtime: CloudRuntime): Promise<void> {
  const installation = await initializeInstallation(runtime.database);
  const origin = installation.origin ?? "";
  if (runtime.origin === origin) return;
  await runtime.authentication.mailWorker.close();
  await runtime.inference.worker.close();
  Object.assign(
    runtime,
    createCloudRuntime(runtime.database, origin, {
      credentialsCipher: cloudCredentialsCipher(installation.credentials_key),
    }),
  );
  runtime.inference.worker.start();
  runtime.authentication.mailWorker.start();
}

export function setCloudRuntimeForTests(
  runtime: CloudRuntime | undefined,
): void {
  const globalRuntime = globalThis as RuntimeGlobal;
  if (runtime) globalRuntime[runtimeSymbol] = Promise.resolve(runtime);
  else delete globalRuntime[runtimeSymbol];
}

export async function closeCloudRuntime(): Promise<void> {
  const globalRuntime = globalThis as RuntimeGlobal;
  const runtime = globalRuntime[runtimeSymbol];
  delete globalRuntime[runtimeSymbol];
  if (runtime) {
    const current = await runtime;
    await current.authentication.mailWorker.close();
    await current.inference.worker.close();
    await current.database.close();
  }
}
