import {
  formatOAuthInstallationName,
  type OAuthInstallationPlatform,
} from "@obsidian-plugin/runtime/oauth-installation-name";
import { describe, expect, it } from "vitest";

const platform: OAuthInstallationPlatform = {
  isIosApp: false,
  isAndroidApp: false,
  isTablet: false,
  isMacOS: false,
  isWin: false,
  isLinux: false,
};

describe("OAuth installation name", () => {
  it("uses recognizable platform labels without exposing a device ID", () => {
    expect(formatOAuthInstallationName({ ...platform, isMacOS: true })).toBe(
      "Mac",
    );
    expect(
      formatOAuthInstallationName({
        ...platform,
        isIosApp: true,
        isTablet: true,
        isMacOS: true,
      }),
    ).toBe("iPad");
    expect(formatOAuthInstallationName({ ...platform, isIosApp: true })).toBe(
      "iPhone",
    );
    expect(
      formatOAuthInstallationName({ ...platform, isAndroidApp: true }),
    ).toBe("Android phone");
    expect(
      formatOAuthInstallationName({
        ...platform,
        isAndroidApp: true,
        isTablet: true,
      }),
    ).toBe("Android tablet");
    expect(formatOAuthInstallationName({ ...platform, isWin: true })).toBe(
      "Windows PC",
    );
    expect(formatOAuthInstallationName({ ...platform, isLinux: true })).toBe(
      "Linux PC",
    );
    expect(formatOAuthInstallationName(platform)).toBe("Device");
  });
});
