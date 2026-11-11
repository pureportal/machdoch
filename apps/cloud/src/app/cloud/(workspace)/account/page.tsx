import { SsoAccount } from "@/components/cloud/sso-account";
import { AccountSessions } from "@/components/cloud/account-sessions";
import { AccountCredentials } from "@/components/cloud/account-credentials";
import { AccountTwoFactor } from "@/components/cloud/account-two-factor";
import { AppearancePreferences } from "@/components/fleet-appearance";
import { requireCloudPageSession } from "@/server/cloud/page-auth";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";

const tabs = ["appearance", "security", "sessions"] as const;

export default async function Account({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  const { runtime, actor } = await requireCloudPageSession();
  const requested = (await searchParams).tab;
  const tab = tabs.find((value) => value === requested) ?? "appearance";
  return (
    <>
      <header className="cloud-page-header">
        <h1>Account</h1>
      </header>
      <Tabs defaultValue={tab}>
        <TabsList aria-label="Account settings">
          <TabsTrigger value="appearance">Appearance</TabsTrigger>
          <TabsTrigger value="security">Security</TabsTrigger>
          <TabsTrigger value="sessions">Sessions</TabsTrigger>
        </TabsList>
        <TabsContent value="appearance" className="cloud-settings">
          <AppearancePreferences />
        </TabsContent>
        <TabsContent value="security" className="cloud-settings">
          <AccountTwoFactor
            status={await runtime.authentication.twoFactor.status(actor)}
          />
          <AccountCredentials
            account={actor}
            credentials={await runtime.authentication.credentials.status(actor)}
          />
          <SsoAccount
            identities={await runtime.authentication.ssoProviders.account(
              actor,
            )}
          />
        </TabsContent>
        <TabsContent value="sessions" className="cloud-settings">
          <AccountSessions account={actor} />
        </TabsContent>
      </Tabs>
    </>
  );
}
