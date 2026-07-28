import type { MetadataRoute } from "next";

export default function sitemap(): MetadataRoute.Sitemap {
  const routes = ["", "/pricing", "/docs", "/changelog", "/privacy", "/terms"];

  return routes.map((route) => ({
    url: `https://gntai.dev${route}`,
    lastModified: new Date(),
  }));
}
