import { SsoAccount } from "@/components/cloud/sso-account";
import { AccountSessions } from "@/components/cloud/account-sessions";
import { AccountCredentials } from "@/components/cloud/account-credentials";
import { AppearancePreferences } from "@/components/fleet-appearance";
import { requireCloudPageSession } from "@/server/cloud/page-auth";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";

export default async function Account() {
  const { runtime, actor } = await requireCloudPageSession();
  return (
    <>
      <header className="cloud-page-header">
        <h1>Account</h1>
      </header>
      <Tabs defaultValue="appearance">
        <TabsList aria-label="Account settings">
          <TabsTrigger value="appearance">Appearance</TabsTrigger>
          <TabsTrigger value="security">Security</TabsTrigger>
          <TabsTrigger value="sessions">Sessions</TabsTrigger>
        </TabsList>
        <TabsContent value="appearance" className="cloud-settings">
          <AppearancePreferences />
        </TabsContent>
        <TabsContent value="security" className="cloud-settings">
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
