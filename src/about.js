const aboutOverlay = document.getElementById("about-overlay");
const aboutClose = document.getElementById("about-close");
const aboutVersion = document.getElementById("about-version");
const aboutCopy = document.getElementById("about-copy");
const ABOUT_REPO = "https://github.com/outusuke/maia3-tauri";
let aboutOpener = null;

async function loadAboutVersion() {
  try { aboutVersion.textContent = `Version ${await window.__TAURI__.core.invoke("app_version")}`; } catch {}
}

function openAbout() {
  aboutOpener = document.activeElement;
  aboutOverlay.classList.add("show");
  aboutClose.focus();
}

function closeAbout() {
  aboutOverlay.classList.remove("show");
  if (aboutOpener) aboutOpener.focus();
}

for (const btn of document.querySelectorAll(".aboutOpen")) btn.addEventListener("click", openAbout);
aboutClose.addEventListener("click", closeAbout);
aboutOverlay.addEventListener("click", (e) => { if (e.target === aboutOverlay) closeAbout(); });

// capture phase so the board shortcuts (arrows, F, U) don't fire behind the dialog
document.addEventListener("keydown", (e) => {
  if (!aboutOverlay.classList.contains("show")) return;
  if (e.key === "Escape") closeAbout();
  if (e.key !== "Tab") e.stopPropagation();
}, true);

aboutCopy.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(ABOUT_REPO);
    aboutCopy.textContent = "Copied!";
    setTimeout(() => { aboutCopy.textContent = "Copy link"; }, 1200);
  } catch {}
});

loadAboutVersion();
