export interface FeaturedPlugin {
  id: string;
  name: string;
  description: string;
  githubUrl: string;
}

/** Reviewed entries ship with the extension and never update at runtime. */
export const FEATURED_PLUGINS: readonly FeaturedPlugin[] = [];
