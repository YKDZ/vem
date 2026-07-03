let kioskBrowserGuardsInstalled = false;

export function installKioskBrowserGuards(): void {
  if (kioskBrowserGuardsInstalled) return;
  kioskBrowserGuardsInstalled = true;

  window.addEventListener(
    "contextmenu",
    (event) => {
      event.preventDefault();
    },
    { capture: true },
  );

  window.addEventListener(
    "dragstart",
    (event) => {
      event.preventDefault();
    },
    { capture: true },
  );
}
