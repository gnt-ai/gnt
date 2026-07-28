import { CliLoginClient } from "@/components/cli-login-client";
import { enabledOAuthProviders } from "@/lib/auth";
import { isEmailConfigured } from "@/lib/email";

export default function CliLoginPage() {
  return <CliLoginClient providers={enabledOAuthProviders()} emailConfigured={isEmailConfigured()} />;
}
