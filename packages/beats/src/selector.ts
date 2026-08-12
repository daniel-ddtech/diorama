import type { CdpClient } from "@adlicio/diorama-engine";

export interface ResolvedSelector {
  found: boolean;
  x: number;
  y: number;
}

export async function resolveSelector(
  cdp: CdpClient,
  session: string,
  selector: string,
): Promise<ResolvedSelector> {
  const expression = `(() => {
    const selector = ${JSON.stringify(selector)};
    const isVisible = (element) => {
      if (typeof element.checkVisibility === "function"
        && !element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) {
        return false;
      }
      const rect = element.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0 || element.getClientRects().length === 0) {
        return false;
      }
      const style = getComputedStyle(element);
      return style.display !== "none"
        && style.visibility !== "hidden"
        && style.visibility !== "collapse"
        && Number(style.opacity) !== 0;
    };

    let element = null;
    if (selector.startsWith("text=")) {
      const needle = selector.slice(5).trim().toLocaleLowerCase();
      const matches = Array.from(document.querySelectorAll("*"))
        .filter((candidate) => isVisible(candidate)
          && (candidate.textContent || "").trim().toLocaleLowerCase().includes(needle));
      element = matches.find((candidate) => !matches.some(
        (other) => other !== candidate && candidate.contains(other),
      )) || null;
    } else {
      element = document.querySelector(selector);
    }

    if (!element) return { found: false, x: 0, y: 0 };
    element.scrollIntoView({ block: "center" });
    const rect = element.getBoundingClientRect();
    return {
      found: true,
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
    };
  })()`;

  return cdp.evaluate<ResolvedSelector>(session, expression);
}
