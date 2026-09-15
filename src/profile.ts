export interface Profile {
  id: string;
  entryPath: string;
  allowedOrigin: string;
  allowedRoutePatterns: RegExp[];
}

function buildProfiles(appOrigin: string): Record<string, Profile> {
  return {
    demo: {
      id: 'demo',
      entryPath: '/',
      allowedOrigin: appOrigin,
      allowedRoutePatterns: [
        /^\/$/,
        /^\/search$/,
        /^\/member\/[^/]+$/,
        /^\/member\/[^/]+\/savings$/,
        /^\/control$/,
      ],
    },
  };
}

export function loadProfile(name: string): Profile {
  const appOrigin = process.env.APP_ORIGIN;
  if (!appOrigin) {
    throw new Error('APP_ORIGIN is not set; refusing to resolve any profile.');
  }
  const profile = buildProfiles(appOrigin)[name];
  if (!profile) {
    const known = Object.keys(buildProfiles(appOrigin)).join(', ');
    throw new Error(`Unknown profile "${name}". Known profiles: ${known}`);
  }
  return profile;
}
