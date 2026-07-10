// electron-builder afterSign hook (see electron-builder.yml).
//
// When no signing certificate is configured (CI sets
// CSC_IDENTITY_AUTO_DISCOVERY=false), electron-builder skips macOS signing
// entirely, so the .app keeps only the stock Electron linker signature. That
// counts as a *broken* bundle signature, and Gatekeeper rejects quarantined
// downloads with "KestraVault is damaged and can't be opened" — no bypass
// offered. A valid ad-hoc signature downgrades that to the normal
// unverified-developer warning, which System Settings → Open Anyway clears.
//
// CommonJS (.cjs) because the package is "type": "module".
const { execFileSync } = require("node:child_process");
const path = require("node:path");

exports.default = async function adhocSign(context) {
  if (context.electronPlatformName !== "darwin") return;

  const appPath = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`,
  );

  try {
    execFileSync("codesign", ["--verify", "--deep", "--strict", appPath], {
      stdio: "ignore",
    });
    return; // real signing already produced a valid signature — keep it
  } catch {
    // invalid/missing signature — fall through and ad-hoc sign
  }

  console.log(`  • ad-hoc signing (no certificate) ${appPath}`);
  execFileSync("codesign", ["--force", "--deep", "--sign", "-", appPath], {
    stdio: "inherit",
  });
  // Fail the build if the result still doesn't verify.
  execFileSync("codesign", ["--verify", "--deep", "--strict", appPath], {
    stdio: "inherit",
  });
};
