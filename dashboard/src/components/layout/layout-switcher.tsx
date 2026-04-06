"use client";

import { ReactNode } from "react";
import { usePathname } from "next/navigation";
import { useIsMobile } from "@/lib/use-mobile";
import { Toolbar } from "./toolbar";

interface LayoutSwitcherProps {
  children: ReactNode;
}

const STANDALONE_ROUTES = ["/login"];

export function LayoutSwitcher({ children }: LayoutSwitcherProps) {
  const isMobile = useIsMobile();
  const pathname = usePathname();

  if (STANDALONE_ROUTES.some((route) => pathname.startsWith(route))) {
    return <>{children}</>;
  }

  if (isMobile === null) {
    return <div className="min-h-screen bg-[#f0f0f0]" aria-hidden="true" />;
  }

  if (isMobile) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#f0f0f0] p-6">
        <div className="text-center">
          <p className="text-[15px] font-medium text-[#1a1a1a]">Desktop Only</p>
          <p className="mt-2 text-[13px] text-[#8e8e93]">
            This dashboard is optimized for desktop browsers.
          </p>
        </div>
      </div>
    );
  }

  return (
    <>
      <Toolbar />
      <main className="pl-40">{children}</main>
    </>
  );
}
