import { CloudAuthorization } from "./oauth/authorization";
import { CloudOAuthTokens } from "./oauth/tokens";
import type { CloudDatabase } from "./database";
import { CloudIdentity } from "./identity";
import { CloudSsoProviders } from "./auth/sso-providers";
import { CloudSsoFlows } from "./auth/sso-flows";
import { CloudOidcExchange } from "./auth/oidc-exchange";
import { CloudSigninPolicy } from "./auth/signin-policy";
import { CloudSessions } from "./auth/sessions";
import { CloudRememberedSessions } from "./auth/remembered-sessions";
import { CloudCredentials } from "./auth/credentials";
import { CloudTwoFactor } from "./auth/two-factor";
import { CloudRecurrencePreview } from "./automation/recurrence";
import { CloudSchedules } from "./automation/schedules";
import { CloudScheduleDispatcher } from "./automation/schedule-dispatcher";
import { CloudAutomations } from "./automation/automations";
import { CloudAutomationExecutor } from "./automation/automation-executor";
import { CloudAutomationDispatcher } from "./automation/automation-dispatcher";
import { CloudProducts } from "./releases/products";
import { CloudSocial } from "./releases/social-accounts";
import { CloudReleases } from "./releases/releases";
import { CloudReleaseMedia } from "./releases/release-media";
import { CloudReleaseStudio } from "./releases/release-studio";
import { CloudReleasePublisher } from "./releases/release-publisher";
import { CloudReleaseDispatcher } from "./releases/release-dispatcher";
import { CloudVideoComposer } from "./releases/video-composer";
import { CloudPeriodicLoop } from "./periodic-loop";
import { CloudAttachments } from "./attachments/attachments";
import { CloudClients } from "./clients/clients";
import { CloudAiActivity } from "./activity/feed";
import { CloudMimoriiConnections } from "./activity/mimorii-connections";
import { CloudMimoriiExporter } from "./activity/mimorii-export";
import { mimoriiBatchSize } from "./activity/mimorii-protocol";
import { CloudInvitations } from "./auth/invitations";
import { CloudInvitationAcceptance } from "./auth/invitation-acceptance";
import { CloudEmailSettingsService } from "./auth/email-settings";
import { CloudMagicLinks } from "./auth/magic-links";
import { CloudMailStore } from "./auth/mail-store";
import { CloudMailDispatcher } from "./auth/mail-dispatcher";
import type { MailSender } from "./auth/smtp";
import { CloudPlanning } from "./planning";
import { CloudProjects } from "./projects";
import { CloudProjectMilestones } from "./project-milestones";
import { CloudIssueChanges } from "./issue-changes";
import { CloudInbox } from "./notifications";
import { CloudSavedViews } from "./saved-views";
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
import { CloudGitAccounts } from "./git/accounts";
import { CloudRoles } from "./roles";
import { CloudGitStatusRules } from "./git/automations";
import { CloudGitConnections } from "./git/connections";
import { CloudGitPullRequests } from "./git/pull-requests";
import { CloudGitSync } from "./git/sync";
import { CloudGitWebhooks } from "./git/webhooks";
import { GitIdentities } from "./git/identity";
import { CloudGitOAuth } from "./git/oauth-flow";
import type { GitProvider } from "../../lib/git-providers";
import { CloudArtifactUploads } from "./execution/artifact-uploads";
import { CloudArtifacts } from "./execution/artifacts";
import { CloudAiProviders } from "./ai/providers";
import { cloudCredentialsCipher } from "./credential-storage";
import { initializeInstallation } from "./installation-storage";
import type { SettingsCipher } from "../settings-crypto";
import { CloudChatStore } from "./ai/chat-store";
import { CloudAgentTools } from "./ai/agent-tools";
import { CloudAgentActions } from "./ai/agent-actions";
import { CloudProjectUpdates } from "./project-updates";
import { CloudPulse } from "./pulse/pulse";
import { CloudFavorites, CloudIssueSubscriptions } from "./favorites";
import { CloudInitiatives } from "./initiatives";
import { CloudTriage } from "./triage";
import { CloudSidebar } from "./sidebar";
import { CloudCliLogins } from "./ai/cli-login";
import { CloudInferenceStore } from "./ai/inference-store";
import {
  CloudInferenceWorker,
  type CloudModelAdapterFactory,
} from "./ai/inference-worker";

export interface CloudRuntime {
  origin: string;
  database: CloudDatabase;
  attachments: CloudAttachments;
  identity: CloudIdentity;
  recurrence: CloudRecurrencePreview;
  schedules: CloudSchedules;
  scheduleDispatcher: CloudScheduleDispatcher;
  scheduleLoop: CloudPeriodicLoop;
  releases: {
    products: CloudProducts;
    social: CloudSocial;
    releases: CloudReleases;
    media: CloudReleaseMedia;
    studio: CloudReleaseStudio;
    dispatcher: CloudReleaseDispatcher;
    loop: CloudPeriodicLoop;
  };
  automations: {
    service: CloudAutomations;
    dispatcher: CloudAutomationDispatcher;
    loop: CloudPeriodicLoop;
  };
  pulse: {
    writer: CloudPulse;
    loop: CloudPeriodicLoop;
  };
  activity: {
    feed: CloudAiActivity;
    mimorii: CloudMimoriiConnections;
    exportLoop: CloudPeriodicLoop;
  };
  authentication: {
    credentials: CloudCredentials;
    twoFactor: CloudTwoFactor;
    ssoProviders: CloudSsoProviders;
    ssoFlows: CloudSsoFlows;
    oidcExchange: CloudOidcExchange;
    signinPolicy: CloudSigninPolicy;
    sessions: CloudSessions;
    rememberedSessions: CloudRememberedSessions;
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
  issueChanges: CloudIssueChanges;
  inbox: CloudInbox;
  views: CloudSavedViews;
  projects: CloudProjects;
  milestones: CloudProjectMilestones;
  projectUpdates: CloudProjectUpdates;
  initiatives: CloudInitiatives;
  triage: CloudTriage;
  sidebar: CloudSidebar;
  favorites: CloudFavorites;
  subscriptions: CloudIssueSubscriptions;
  labels: CloudLabels;
  relations: CloudIssueRelations;
  workflows: CloudWorkflows;
  poker: CloudPoker;
  administration: CloudAdministrationService;
  roles: CloudRoles;
  cycles: CloudCycles;
  comments: CloudComments;
  aiProviders: CloudAiProviders;
  cliLogins: CloudCliLogins;
  chat: {
    store: CloudChatStore;
    actions: CloudAgentActions;
  };
  inference: {
    store: CloudInferenceStore;
    worker: CloudInferenceWorker;
  };
  git: {
    connections: CloudGitConnections;
    accounts: CloudGitAccounts;
    statusRules: CloudGitStatusRules;
    sync: CloudGitSync;
    webhooks: CloudGitWebhooks;
    oauth: CloudGitOAuth;
    pullRequests: CloudGitPullRequests;
    syncLoop: CloudPeriodicLoop;
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
    gitFetch?: typeof fetch;
    automationFetch?: typeof fetch;
    socialFetch?: typeof fetch;
    videoComposer?: CloudVideoComposer;
    mailSender?: MailSender;
  } = {},
): CloudRuntime {
  const aiProviders = new CloudAiProviders(
    database,
    options.credentialsCipher ?? null,
  );
  const attachments = new CloudAttachments(database);
  const clients = new CloudClients(database);
  const chatStore = new CloudChatStore(database, attachments);
  const inference = new CloudInferenceStore(database);
  const mailStore = new CloudMailStore(
    database,
    options.credentialsCipher ?? null,
    origin,
  );
  const recurrence = new CloudRecurrencePreview(database);
  const planning = new CloudPlanning(database);
  const projects = new CloudProjects(database);
  const milestones = new CloudProjectMilestones(database);
  const projectUpdates = new CloudProjectUpdates(database);
  const initiatives = new CloudInitiatives(database);
  const triage = new CloudTriage(database);
  const issueChanges = new CloudIssueChanges(database);
  const labels = new CloudLabels(database);
  const relations = new CloudIssueRelations(database);
  const cycles = new CloudCycles(database);
  const comments = new CloudComments(database);
  const runs = new CloudRuns(database);
  const scheduleDispatcher = new CloudScheduleDispatcher(database, recurrence);
  const mimoriiExporter = new CloudMimoriiExporter(
    database,
    options.credentialsCipher ?? null,
  );
  const gitFetch = options.gitFetch ?? fetch;
  const gitConnections = new CloudGitConnections(
    database,
    options.credentialsCipher ?? null,
    origin,
    gitFetch,
  );
  const gitSync = new CloudGitSync(
    database,
    options.credentialsCipher ?? null,
    issueChanges,
    gitFetch,
    (provider, id) => gitConnections.webhookUrl(provider, id),
    origin.startsWith("https://"),
  );
  const gitCallbackUrl = (provider: GitProvider) =>
    gitConnections.oauthCallbackUrl(provider);
  const pullRequests = new CloudGitPullRequests(
    database,
    options.credentialsCipher ?? null,
    new GitIdentities(
      database,
      options.credentialsCipher ?? null,
      gitFetch,
      gitCallbackUrl,
    ),
    gitSync,
    gitFetch,
  );
  const socialFetch = options.socialFetch ?? fetch;
  const products = new CloudProducts(
    database,
    options.credentialsCipher ?? null,
  );
  const social = new CloudSocial(
    database,
    options.credentialsCipher ?? null,
    origin,
    socialFetch,
  );
  const releaseMedia = new CloudReleaseMedia(database);
  let wakeReleases = () => {};
  const releases = new CloudReleases(database, () => wakeReleases());
  const studio = new CloudReleaseStudio(
    database,
    releaseMedia,
    options.videoComposer ?? new CloudVideoComposer(),
    chatStore,
    origin,
    () => wakeReleases(),
  );
  let wakeAutomations = () => {};
  const automations = new CloudAutomations(database, origin, () =>
    wakeAutomations(),
  );
  const executionProfiles = new CloudExecutionProfiles(database);
  const agentActions = new CloudAgentActions({
    origin,
    attachments,
    clients,
    automations,
    chat: chatStore,
    planning,
    relations,
    labels,
    issueChanges,
    comments,
    projectUpdates,
    triage,
    releases,
    studio,
    pullRequests,
  });
  let wakePulse = () => {};
  const pulse = new CloudPulse(database, chatStore, agentActions, () =>
    wakePulse(),
  );
  const pulseLoop = new CloudPeriodicLoop(
    "Pulse writing",
    () => pulse.tick(),
    5,
  );
  wakePulse = () => pulseLoop.wake();
  const releaseDispatcher = new CloudReleaseDispatcher(
    database,
    new CloudReleasePublisher(
      database,
      social,
      releaseMedia,
      options.credentialsCipher ?? null,
      origin,
      socialFetch,
    ),
    studio,
    releaseMedia,
    agentActions,
  );
  const releaseLoop = new CloudPeriodicLoop(
    "Release publishing",
    () => releaseDispatcher.tick(),
    1,
  );
  wakeReleases = () => releaseLoop.wake();
  const automationDispatcher = new CloudAutomationDispatcher(
    database,
    new CloudAutomationExecutor({
      database,
      origin,
      planning,
      issueChanges,
      labels,
      comments,
      relations,
      runs,
      chat: chatStore,
      agentActions,
      releases,
      studio,
      attachments,
      clients,
      pullRequests,
      automations,
      pulse,
      fetch: options.automationFetch ?? fetch,
    }),
  );
  const automationLoop = new CloudPeriodicLoop(
    "Automation dispatch",
    () => automationDispatcher.tick(),
    1,
  );
  wakeAutomations = () => automationLoop.wake();
  const agentTools = new CloudAgentTools({
    planning,
    projects,
    cycles,
    relations,
    comments,
    labels,
    milestones,
    projectUpdates,
    initiatives,
    triage,
    runs,
    pullRequests,
    releases,
    products,
    releaseMedia,
    automations,
    providers: aiProviders,
    profiles: executionProfiles,
    attachments,
    clients,
  });
  return {
    releases: {
      products,
      social,
      releases,
      media: releaseMedia,
      studio,
      dispatcher: releaseDispatcher,
      loop: releaseLoop,
    },
    database,
    origin,
    attachments,
    identity: new CloudIdentity(database),
    recurrence,
    schedules: new CloudSchedules(database, recurrence),
    scheduleDispatcher,
    scheduleLoop: new CloudPeriodicLoop(
      "Schedule dispatch",
      () => scheduleDispatcher.tick(),
      5,
    ),
    automations: {
      service: automations,
      dispatcher: automationDispatcher,
      loop: automationLoop,
    },
    pulse: { writer: pulse, loop: pulseLoop },
    activity: {
      feed: new CloudAiActivity(database),
      mimorii: new CloudMimoriiConnections(
        database,
        options.credentialsCipher ?? null,
      ),
      exportLoop: new CloudPeriodicLoop(
        "Mimorii export",
        () => mimoriiExporter.tick(),
        mimoriiBatchSize,
      ),
    },
    authentication: {
      credentials: new CloudCredentials(database),
      twoFactor: new CloudTwoFactor(
        database,
        options.credentialsCipher ?? null,
      ),
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
      rememberedSessions: new CloudRememberedSessions(database),
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
    planning,
    issueChanges,
    inbox: new CloudInbox(database),
    views: new CloudSavedViews(database),
    projects,
    milestones,
    projectUpdates,
    initiatives,
    triage,
    sidebar: new CloudSidebar(database),
    favorites: new CloudFavorites(database),
    subscriptions: new CloudIssueSubscriptions(database),
    labels,
    relations,
    workflows: new CloudWorkflows(database),
    poker: new CloudPoker(database),
    administration: new CloudAdministrationService(database),
    roles: new CloudRoles(database),
    cycles,
    comments,
    aiProviders,
    cliLogins: new CloudCliLogins(aiProviders),
    chat: {
      store: chatStore,
      actions: agentActions,
    },
    inference: {
      store: inference,
      worker: new CloudInferenceWorker(
        inference,
        aiProviders,
        agentTools,
        attachments,
        options.modelAdapterFactory,
      ),
    },
    git: {
      connections: gitConnections,
      accounts: new CloudGitAccounts(
        database,
        options.credentialsCipher ?? null,
        gitFetch,
      ),
      statusRules: new CloudGitStatusRules(database),
      sync: gitSync,
      webhooks: new CloudGitWebhooks(
        database,
        options.credentialsCipher ?? null,
        gitSync,
        gitFetch,
      ),
      oauth: new CloudGitOAuth(
        database,
        options.credentialsCipher ?? null,
        gitFetch,
        gitCallbackUrl,
      ),
      pullRequests,
      syncLoop: new CloudPeriodicLoop("Git sync", () => gitSync.tick(), 1),
    },
    execution: {
      profiles: executionProfiles,
      runs,
      workers: new CloudWorkers(database),
      clientWorkspaces: new CloudClientWorkspaces(database),
      leases: new CloudExecutionLeases(database),
      effects: new CloudExecutionEffects(database),
      inference: new CloudTaskInference(database),
      repositories: new CloudRepositories(
        database,
        options.credentialsCipher ?? null,
        options.repositoryFetch,
      ),
      uploads: new CloudArtifactUploads(database),
      artifacts: new CloudArtifacts(database),
    },
  };
}

export async function refreshCloudOrigin(runtime: CloudRuntime): Promise<void> {
  const installation = await initializeInstallation(runtime.database);
  const origin = installation.origin ?? "";
  if (runtime.origin === origin) return;
  runtime.cliLogins.close();
  await runtime.scheduleLoop.close();
  await runtime.automations.loop.close();
  await runtime.releases.loop.close();
  await runtime.pulse.loop.close();
  await runtime.activity.exportLoop.close();
  await runtime.git.syncLoop.close();
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
  runtime.scheduleLoop.start();
  runtime.automations.loop.start();
  runtime.releases.loop.start();
  runtime.pulse.loop.start();
  runtime.activity.exportLoop.start();
  runtime.git.syncLoop.start();
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
    current.cliLogins.close();
    await current.scheduleLoop.close();
    await current.automations.loop.close();
    await current.releases.loop.close();
    await current.pulse.loop.close();
    await current.activity.exportLoop.close();
    await current.git.syncLoop.close();
    await current.authentication.mailWorker.close();
    await current.inference.worker.close();
    await current.database.close();
  }
}
