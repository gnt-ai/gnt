import type { MetadataRoute } from "next";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: [
        "/settings",
        "/onboarding",
        "/sign-in",
        "/sign-up",
        "/verify-2fa",
        "/cli-login",
        "/accept-invitation",
        "/billing",
      ],
    },
    sitemap: "https://gntai.dev/sitemap.xml",
  };
}
