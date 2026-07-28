import { AuthScreen } from "@/components/auth-screen";
import { MarketingHeader } from "@/components/marketing-header";
import { enabledOAuthProviders } from "@/lib/auth";
import { isEmailConfigured } from "@/lib/email";

export default function SignUpPage() {
  return (
    <div className="flex-1 flex flex-col">
      <MarketingHeader />
      <main className="flex-1 flex items-center justify-center max-w-3xl w-full mx-auto sm:border-x sm:border-border px-6 py-16">
        <AuthScreen mode="sign-up" providers={enabledOAuthProviders()} emailConfigured={isEmailConfigured()} />
      </main>
    </div>
  );
}
