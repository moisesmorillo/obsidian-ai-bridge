/** Obsidian platform flags needed to label an OAuth client installation. */
export interface OAuthInstallationPlatform {
  readonly isIosApp: boolean;
  readonly isAndroidApp: boolean;
  readonly isTablet: boolean;
  readonly isMacOS: boolean;
  readonly isWin: boolean;
  readonly isLinux: boolean;
}

/**
 * Returns a recognizable default accepted by the Worker's client-name grammar.
 * Mobile app flags take precedence over OS flags, which may overlap.
 * @param platform - Obsidian's public cross-platform device category flags.
 * @returns A readable default name compatible with Worker credential names.
 */
export function formatOAuthInstallationName(
  platform: OAuthInstallationPlatform,
): string {
  if (platform.isIosApp) return platform.isTablet ? "iPad" : "iPhone";
  if (platform.isAndroidApp)
    return platform.isTablet ? "Android tablet" : "Android phone";
  if (platform.isMacOS) return "Mac";
  if (platform.isWin) return "Windows PC";
  if (platform.isLinux) return "Linux PC";
  return "Device";
}
