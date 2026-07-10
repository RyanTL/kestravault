// KestraVault landing page behavior: nav border, scroll reveals, and download
// buttons resolved from the latest GitHub release (with a graceful
// "coming soon" state while the repo is private / has no releases).

const REPO = "RyanTL/kestravault";
const RELEASES_PAGE = `https://github.com/${REPO}/releases`;

// Scroll-reveal styles only apply when JS is around to trigger them.
document.documentElement.classList.add("js");

// ── Nav border on scroll ─────────────────────────────────────────────────
const nav = document.getElementById("nav");
const onScroll = () => nav.classList.toggle("scrolled", window.scrollY > 8);
onScroll();
addEventListener("scroll", onScroll, { passive: true });

// ── Scroll reveals ───────────────────────────────────────────────────────
const revealed = document.querySelectorAll(".reveal");
if ("IntersectionObserver" in window) {
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (e.isIntersecting) {
          e.target.classList.add("visible");
          io.unobserve(e.target);
        }
      }
    },
    { rootMargin: "0px 0px -60px 0px" },
  );
  revealed.forEach((el) => io.observe(el));
} else {
  revealed.forEach((el) => el.classList.add("visible"));
}

// ── Download buttons ─────────────────────────────────────────────────────
// Release artifact names come from electron-builder and embed the version, so
// we resolve them from the releases API instead of hardcoding filenames.
const matchers = {
  "mac-arm64": (n) => n.endsWith(".dmg") && n.includes("arm64"),
  "mac-x64": (n) => n.endsWith(".dmg") && (n.includes("x64") || n.includes("intel")),
  win: (n) => n.endsWith(".exe"),
  linux: (n) => n.endsWith(".AppImage") || n.endsWith(".deb"),
};

function comingSoon() {
  document.querySelectorAll(".dl").forEach((el) => {
    el.classList.add("soon");
    el.href = RELEASES_PAGE;
  });
  const note = document.getElementById("release-line");
  if (note) {
    note.textContent =
      "First public build is almost out — watch the GitHub repo to get it the moment it lands.";
  }
}

async function resolveDownloads() {
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { Accept: "application/vnd.github+json" },
    });
    if (!res.ok) throw new Error(`releases API ${res.status}`);
    const release = await res.json();
    const assets = release.assets ?? [];
    let found = 0;
    for (const [key, match] of Object.entries(matchers)) {
      const el = document.querySelector(`.dl[data-asset="${key}"]`);
      const asset = assets.find((a) => match(a.name));
      if (el && asset) {
        el.href = asset.browser_download_url;
        found += 1;
      } else if (el) {
        el.href = RELEASES_PAGE;
      }
    }
    if (!found) throw new Error("no matching assets");
    const version = (release.tag_name || "").replace(/^v/, "");
    if (version) {
      const note = document.getElementById("hero-note");
      if (note) note.textContent = `v${version} · macOS · Windows · Linux`;
    }
  } catch {
    comingSoon();
  }
}

resolveDownloads();
