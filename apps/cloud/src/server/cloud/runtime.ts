import { CloudAuthorization } from "./oauth/authorization";
import { CloudClientSignIn } from "./oauth/client-sign-in";
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
import { CloudLoops } from "./loops/loops";
import { CloudLoopSources } from "./loops/loop-sources";
import { CloudAutomationExecutor } from "./automation/automation-executor";
import { CloudAutomationDispatcher } from "./automation/automation-dispatcher";
import { CloudProducts } from "./releases/products";
import { CloudSocial } from "./releases/social-accounts";
import { CloudReleases } from "./releases/releases";
import { CloudReleasePipelines } from "./releases/pipelines";
import { CloudPipelineReleases } from "./releases/pipeline-releases";
import { CloudPipelineDeployments } from "./releases/pipeline-deployments";
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
import { CloudPullRequestFixes } from "./execution/pull-request-fixes";
import { CloudWorkers } from "./execution/workers";
import { CloudHostedRunners } from "./execution/hosted-runners";
import { CloudSandboxRuntime } from "./execution/sandbox-runtime";
import type { HostSandboxLocation } from "@machdoch/cloud-client/sandbox-installation";
import { CloudClientWorkspaces } from "./execution/client-workspaces";
import { CloudExecutionLeases } from "./execution/leases";
import { CloudExecutionEffects } from "./execution/effects";
import { CloudRunReviews } from "./execution/reviews";
import { CloudAutopilot } from "./execution/autopilot";
import { CloudDeliveries } from "./execution/deliveries";
import type { pushCandidate } from "./execution/candidate-push";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CloudTaskInference } from "./execution/inference";
import { CloudRepositories } from "./execution/repositories";
import { CloudGitAccounts } from "./git/accounts";
import { CloudGitHubSignIn } from "./git/github-sign-in";
import { CloudRoles } from "./roles";
import { CloudGitStatusRules } from "./git/automations";
import { CloudGitReviewSettings } from "./git/review-settings";
import { CloudGitReviewGuides } from "./git/review-guides";
import { CloudGitConnections } from "./git/connections";
import { CloudGitPullRequests } from "./git/pull-requests";
import { CloudIssueDelivery } from "./git/issue-delivery";
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
import { CloudAgentHandoffs } from "./ai/agent-handoffs";
import { CloudProjectStatuses } from "./project-statuses";
import {
  CloudProjectUpdates,
  projectUpdateReminderBatchSize,
} from "./project-updates";
import { CloudPulse } from "./pulse/pulse";
import { CloudSlas, slaSweepBatchSize } from "./slas";
import { CloudTeamHomes } from "./team-homes";
import { CloudFavorites, CloudIssueSubscriptions } from "./favorites";
import { CloudInitiatives } from "./initiatives";
import { CloudTriage } from "./triage";
import { CloudCustomerRequests } from "./customer-requests";
import { CloudNotificationSettingsService } from "./notification-settings";
import {
  CloudNotificationDelivery,
  defaultNotificationTransports,
  notificationDeliveryBatchSize,
} from "./notification-delivery";
import { CloudSidebar } from "./sidebar";
import { CloudSettingsStore } from "./settings-store";
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
  autopilot: {
    autopilot: CloudAutopilot;
    deliveries: CloudDeliveries;
    loop: CloudPeriodicLoop;
  };
  releases: {
    products: CloudProducts;
    social: CloudSocial;
    releases: CloudReleases;
    pipelines: CloudReleasePipelines;
    pipelineReleases: CloudPipelineReleases;
    deployments: CloudPipelineDeployments;
    media: CloudReleaseMedia;
    studio: CloudReleaseStudio;
    dispatcher: CloudReleaseDispatcher;
    loop: CloudPeriodicLoop;
  };
  automations: {
    service: CloudAutomations;
    dispatcher: CloudAutomationDispatcher;
    loop: CloudPeriodicLoop;
    loops: CloudLoops;
    sources: CloudLoopSources;
  };
  pulse: {
    writer: CloudPulse;
    loop: CloudPeriodicLoop;
  };
  slas: {
    service: CloudSlas;
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
  clientSignIn: CloudClientSignIn;
  oauthTokens: CloudOAuthTokens;
  planning: CloudPlanning;
  issueChanges: CloudIssueChanges;
  inbox: CloudInbox;
  views: CloudSavedViews;
  projects: CloudProjects;
  milestones: CloudProjectMilestones;
  projectUpdates: CloudProjectUpdates;
  projectStatuses: CloudProjectStatuses;
  projectUpdateReminders: CloudPeriodicLoop;
  teamHomes: CloudTeamHomes;
  initiatives: CloudInitiatives;
  triage: CloudTriage;
  customerRequests: CloudCustomerRequests;
  notifications: {
    settings: CloudNotificationSettingsService;
    loop: CloudPeriodicLoop;
  };
  sidebar: CloudSidebar;
  settings: CloudSettingsStore;
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
    handoffs: CloudAgentHandoffs;
  };
  inference: {
    store: CloudInferenceStore;
    worker: CloudInferenceWorker;
  };
  git: {
    connections: CloudGitConnections;
    accounts: CloudGitAccounts;
    gitHubSignIn: CloudGitHubSignIn;
    statusRules: CloudGitStatusRules;
    reviewSettings: CloudGitReviewSettings;
    sync: CloudGitSync;
    webhooks: CloudGitWebhooks;
    oauth: CloudGitOAuth;
    pullRequests: CloudGitPullRequests;
    reviewGuides: CloudGitReviewGuides;
    reviewGuideLoop: CloudPeriodicLoop;
    delivery: CloudIssueDelivery;
    syncLoop: CloudPeriodicLoop;
  };
  execution: {
    profiles: CloudExecutionProfiles;
    runs: CloudRuns;
    workers: CloudWorkers;
    sandbox: CloudSandboxRuntime;
    hostedRunners: CloudHostedRunners;
    clientWorkspaces: CloudClientWorkspaces;
    leases: CloudExecutionLeases;
    effects: CloudExecutionEffects;
    inference: CloudTaskInference;
    reviews: CloudRunReviews;
    repositories: CloudRepositories;
    uploads: CloudArtifactUploads;
    artifacts: CloudArtifacts;
    pullRequestFixes: CloudPullRequestFixes;
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
    gitCacheDirectory?: string;
    candidatePush?: typeof pushCandidate;
    sandboxLocation?: () => Promise<HostSandboxLocation>;
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
  const gitAccounts = new CloudGitAccounts(
    database,
    options.credentialsCipher ?? null,
    gitFetch,
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
  const deployments = new CloudPipelineDeployments(database, issueChanges);
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
  const executionProfiles = new CloudExecutionProfiles(
    database,
    options.credentialsCipher ?? null,
    options.gitFetch ?? fetch,
  );
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
    runs,
  });
  let wakePulse = () => {};
  const pulse = new CloudPulse(database, chatStore, projectUpdates, () =>
    wakePulse(),
  );
  const notificationDelivery = new CloudNotificationDelivery(
    database,
    options.credentialsCipher ?? null,
    origin,
    defaultNotificationTransports,
  );
  const pulseLoop = new CloudPeriodicLoop(
    "Pulse writing",
    () => pulse.tick(),
    5,
  );
  wakePulse = () => pulseLoop.wake();
  let wakeReviewGuides = () => {};
  const reviewGuides = new CloudGitReviewGuides(
    database,
    pullRequests,
    chatStore,
    () => wakeReviewGuides(),
  );
  const reviewGuideLoop = new CloudPeriodicLoop(
    "Review guides",
    () => reviewGuides.tick(),
    5,
  );
  wakeReviewGuides = () => reviewGuideLoop.wake();
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
  const slas = new CloudSlas(database);
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
  const autopilot = new CloudAutopilot(database, issueChanges);
  const sandboxRuntime = new CloudSandboxRuntime(
    database,
    options.sandboxLocation,
  );
  const hostedRunners = new CloudHostedRunners(
    database,
    options.credentialsCipher ?? null,
    sandboxRuntime,
  );
  const workers = new CloudWorkers(database, hostedRunners);
  const deliveries = new CloudDeliveries(
    database,
    options.credentialsCipher ?? null,
    gitFetch,
    gitSync,
    issueChanges,
    origin,
    options.gitCacheDirectory ??
      process.env.MACHDOCH_CLOUD_GIT_CACHE ??
      join(tmpdir(), "machdoch-cloud-git"),
    options.candidatePush,
  );
  const autopilotLoop = new CloudPeriodicLoop(
    "Autopilot",
    async () => (await autopilot.tick()) + (await deliveries.tick()),
    1,
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
      pipelines: new CloudReleasePipelines(database),
      pipelineReleases: new CloudPipelineReleases(database, releases),
      deployments,
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
      loops: new CloudLoops(database, () => wakeAutomations()),
      sources: new CloudLoopSources(database, origin, () => wakeAutomations()),
    },
    pulse: { writer: pulse, loop: pulseLoop },
    slas: {
      service: slas,
      loop: new CloudPeriodicLoop(
        "SLA breaches",
        () => slas.sweep(),
        slaSweepBatchSize,
      ),
    },
    autopilot: { autopilot, deliveries, loop: autopilotLoop },
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
    clientSignIn: new CloudClientSignIn(database, origin),
    oauthTokens: new CloudOAuthTokens(database, origin),
    planning,
    issueChanges,
    inbox: new CloudInbox(database),
    views: new CloudSavedViews(database),
    projects,
    milestones,
    projectUpdates,
    projectStatuses: new CloudProjectStatuses(database),
    projectUpdateReminders: new CloudPeriodicLoop(
      "Project update reminders",
      () => projectUpdates.remindDue(),
      projectUpdateReminderBatchSize,
    ),
    teamHomes: new CloudTeamHomes(database),
    initiatives,
    triage,
    customerRequests: new CloudCustomerRequests(database, origin),
    notifications: {
      settings: new CloudNotificationSettingsService(
        database,
        options.credentialsCipher ?? null,
      ),
      loop: new CloudPeriodicLoop(
        "Notification delivery",
        () => notificationDelivery.deliverDue(notificationDeliveryBatchSize),
        notificationDeliveryBatchSize,
      ),
    },
    sidebar: new CloudSidebar(database),
    settings: new CloudSettingsStore(database),
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
      handoffs: new CloudAgentHandoffs(database, {
        profiles: executionProfiles,
        workers,
        providers: aiProviders,
      }),
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
      accounts: gitAccounts,
      gitHubSignIn: new CloudGitHubSignIn(
        database,
        gitConnections,
        gitAccounts,
      ),
      statusRules: new CloudGitStatusRules(database),
      reviewSettings: new CloudGitReviewSettings(database),
      sync: gitSync,
      webhooks: new CloudGitWebhooks(
        database,
        options.credentialsCipher ?? null,
        gitSync,
        gitFetch,
        deployments,
      ),
      oauth: new CloudGitOAuth(
        database,
        options.credentialsCipher ?? null,
        gitFetch,
        gitCallbackUrl,
      ),
      pullRequests,
      reviewGuides,
      reviewGuideLoop,
      delivery: new CloudIssueDelivery(
        database,
        options.credentialsCipher ?? null,
        pullRequests,
        gitFetch,
      ),
      syncLoop: new CloudPeriodicLoop("Git sync", () => gitSync.tick(), 1),
    },
    execution: {
      profiles: executionProfiles,
      runs,
      workers,
      sandbox: sandboxRuntime,
      hostedRunners,
      clientWorkspaces: new CloudClientWorkspaces(database),
      leases: new CloudExecutionLeases(database),
      effects: new CloudExecutionEffects(database),
      inference: new CloudTaskInference(database),
      reviews: new CloudRunReviews(
        database,
        options.credentialsCipher ?? null,
        gitFetch,
      ),
      repositories: new CloudRepositories(
        database,
        options.credentialsCipher ?? null,
        options.repositoryFetch,
      ),
      uploads: new CloudArtifactUploads(database),
      artifacts: new CloudArtifacts(database),
      pullRequestFixes: new CloudPullRequestFixes(database, pullRequests),
    },
  };
}

export async function refreshCloudOrigin(runtime: CloudRuntime): Promise<void> {
  const installation = await initializeInstallation(runtime.database);
  const origin = installation.origin ?? "";
  if (runtime.origin === origin) return;
  const hostedOrigin = runtime.execution.hostedRunners.localOrigin;
  await runtime.execution.hostedRunners.close();
  runtime.cliLogins.close();
  await runtime.git.gitHubSignIn.close();
  await runtime.scheduleLoop.close();
  await runtime.automations.loop.close();
  await runtime.autopilot.loop.close();
  await runtime.releases.loop.close();
  await runtime.pulse.loop.close();
  await runtime.slas.loop.close();
  await runtime.projectUpdateReminders.close();
  await runtime.notifications.loop.close();
  await runtime.activity.exportLoop.close();
  await runtime.git.syncLoop.close();
  await runtime.git.reviewGuideLoop.close();
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
  runtime.autopilot.loop.start();
  runtime.releases.loop.start();
  runtime.pulse.loop.start();
  runtime.slas.loop.start();
  runtime.projectUpdateReminders.start();
  runtime.notifications.loop.start();
  runtime.activity.exportLoop.start();
  runtime.git.syncLoop.start();
  runtime.git.reviewGuideLoop.start();
  if (hostedOrigin) runtime.execution.hostedRunners.start(hostedOrigin);
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
    await current.execution.hostedRunners.close();
    current.cliLogins.close();
    await current.scheduleLoop.close();
    await current.automations.loop.close();
    await current.autopilot.loop.close();
    await current.releases.loop.close();
    await current.pulse.loop.close();
    await current.slas.loop.close();
    await current.projectUpdateReminders.close();
    await current.notifications.loop.close();
    await current.activity.exportLoop.close();
    await current.git.syncLoop.close();
    await current.git.reviewGuideLoop.close();
    await current.authentication.mailWorker.close();
    await current.inference.worker.close();
    await current.database.close();
  }
}
