"use strict";

const catalog = JSON.parse(document.getElementById("catalog").textContent);
const state = {
  icon: catalog.icons[0],
  wordmark: catalog.wordmarks[0],
  theme: "light",
  color: "neutral",
  layout: "horizontal",
};

function svgMarkup(design, decorative = true) {
  const accessibility = decorative
    ? 'aria-hidden="true"'
    : `role="img" aria-label="Machdoch — ${design.name}"`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${design.width} ${design.height}" width="${design.width}" height="${design.height}" ${accessibility}><g fill="currentColor" color="currentColor">${design.artwork}</g></svg>`;
}

function composeLogo(layout = state.layout) {
  const { icon, wordmark } = state;
  const scale = 56 / wordmark.height;
  const textWidth = wordmark.width * scale;
  if (layout === "stacked") {
    const width = Math.max(124, textWidth + 24);
    return {
      name: `${icon.name} + ${wordmark.name}`,
      width,
      height: 204,
      artwork: `<g transform="translate(${(width - 100) / 2} 10)">${icon.artwork}</g><g transform="translate(${(width - textWidth) / 2} 132) scale(${scale})">${wordmark.artwork}</g>`,
    };
  }
  return {
    name: `${icon.name} + ${wordmark.name}`,
    width: 132 + textWidth,
    height: 112,
    artwork: `<g transform="translate(4 6)">${icon.artwork}</g><g transform="translate(126 28) scale(${scale})">${wordmark.artwork}</g>`,
  };
}

function updateSelection() {
  document.getElementById("pair-title").textContent =
    `${state.icon.name} + ${state.wordmark.name}`;
  const stage = document.getElementById("lockup-stage");
  stage.dataset.layout = state.layout;
  stage.innerHTML = svgMarkup(composeLogo(), false);
  document.getElementById("sidebar-sample").innerHTML = svgMarkup(state.icon);
  document.getElementById("header-sample").innerHTML = svgMarkup(
    composeLogo("horizontal"),
  );
  for (const button of document.querySelectorAll("[data-icon]")) {
    button.setAttribute(
      "aria-pressed",
      String(button.dataset.icon === state.icon.id),
    );
  }
  for (const button of document.querySelectorAll("[data-wordmark]")) {
    button.setAttribute(
      "aria-pressed",
      String(button.dataset.wordmark === state.wordmark.id),
    );
  }
}

function populateGallery() {
  for (const [collection, key] of [
    [catalog.icons, "icon"],
    [catalog.wordmarks, "wordmark"],
  ]) {
    const container = document.getElementById(
      key === "icon" ? "icons" : "wordmarks",
    );
    for (const design of collection) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "variant";
      button.dataset[key] = design.id;
      button.setAttribute(
        "aria-label",
        `${design.id.slice(0, 2)} ${design.name}`,
      );
      button.innerHTML = `<span class="variant-name"><span class="variant-number">${design.id.slice(0, 2)}</span>${design.name}</span><span class="${key}-art">${svgMarkup(design)}</span>`;
      if (key === "icon") {
        const scales = document.createElement("span");
        scales.className = "small-scales";
        for (const size of [16, 24, 32]) {
          const sample = document.createElement("span");
          sample.innerHTML = svgMarkup(design);
          sample.firstElementChild.style.width = `${size}px`;
          sample.firstElementChild.style.height = `${size}px`;
          scales.append(sample);
        }
        button.append(scales);
      }
      button.addEventListener("click", () => {
        state[key] = design;
        updateSelection();
      });
      container.append(button);
    }
  }
}

function exportSvg(kind) {
  const design = kind === "lockup" ? composeLogo() : state[kind];
  const color =
    state.color === "accent"
      ? state.theme === "dark"
        ? "#65C3E2"
        : catalog.colors.accent
      : state.theme === "dark"
        ? catalog.colors.white
        : catalog.colors.black;
  const artwork = svgMarkup(design, false).replaceAll("currentColor", color);
  const filename =
    kind === "lockup"
      ? `machdoch-${state.icon.id}-${state.wordmark.id}-${state.layout}.svg`
      : `machdoch-${design.id}.svg`;
  const url = URL.createObjectURL(
    new Blob([artwork], { type: "image/svg+xml;charset=utf-8" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  document.getElementById("download-status").textContent =
    `Downloaded ${filename}`;
}

for (const key of ["theme", "color", "layout"]) {
  document.getElementById(key).addEventListener("change", (event) => {
    state[key] = event.target.value;
    document.documentElement.dataset[key] = state[key];
    updateSelection();
  });
}

document.getElementById("text-size").addEventListener("change", (event) => {
  document.documentElement.style.setProperty(
    "--text-size",
    `${event.target.value}px`,
  );
});

for (const button of document.querySelectorAll("[data-download]")) {
  button.addEventListener("click", () => exportSvg(button.dataset.download));
}

populateGallery();
updateSelection();
