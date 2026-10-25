import { SsoAccount } from "@/components/cloud/sso-account";
import { AccountSessions } from "@/components/cloud/account-sessions";
import { requireCloudPageSession } from "@/server/cloud/page-auth";

export default async function Account() {
  const { runtime, actor } = await requireCloudPageSession();
  return (
    <>
      <header className="cloud-page-header">
        <h1>Account</h1>
      </header>
      <div className="cloud-settings">
        <AccountSessions account={actor} />
        <SsoAccount
          identities={await runtime.authentication.ssoProviders.account(actor)}
        />
      </div>
    </>
  );
}
