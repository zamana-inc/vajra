"use client";

/**
 * Mobile detection hook.
 *
 * Uses a combination of:
 * 1. CSS media query (responsive, updates on resize)
 * 2. User agent sniffing (for initial SSR-safe detection)
 *
 * Returns `null` during SSR to avoid hydration mismatch.
 */

import { useState, useEffect } from "react";

const MOBILE_BREAKPOINT = 768;

/**
 * Check if running on a mobile device.
 * Returns null during SSR, boolean after hydration.
 */
export function useIsMobile(): boolean | null {
  const [isMobile, setIsMobile] = useState<boolean | null>(null);

  useEffect(() => {
    // Media query for responsive detection
    const mql = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`);

    const handleChange = (e: MediaQueryListEvent | MediaQueryList) => {
      setIsMobile(e.matches);
    };

    // Set initial value
    handleChange(mql);

    // Listen for changes
    mql.addEventListener("change", handleChange);
    return () => mql.removeEventListener("change", handleChange);
  }, []);

  return isMobile;
}

/**
 * Check if device is likely a touch device.
 * Useful for UI affordances (hover states, etc.)
 */
export function useIsTouchDevice(): boolean | null {
  const [isTouch, setIsTouch] = useState<boolean | null>(null);

  useEffect(() => {
    setIsTouch(
      "ontouchstart" in window ||
        navigator.maxTouchPoints > 0
    );
  }, []);

  return isTouch;
}

/**
 * Check if app is running as installed PWA (standalone mode).
 */
export function useIsStandalone(): boolean | null {
  const [isStandalone, setIsStandalone] = useState<boolean | null>(null);

  useEffect(() => {
    const standalone =
      window.matchMedia("(display-mode: standalone)").matches ||
      (window.navigator as Navigator & { standalone?: boolean }).standalone === true;
    setIsStandalone(standalone);
  }, []);

  return isStandalone;
}
