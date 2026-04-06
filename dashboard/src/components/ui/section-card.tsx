"use client";

/**
 * Section card with optional header.
 */

import { ReactNode } from "react";

interface SectionCardProps {
  children: ReactNode;
  header?: ReactNode;
}

export function SectionCard({ children, header }: SectionCardProps) {
  return (
    <div className="bg-white rounded-xl overflow-hidden">
      {header && (
        <div className="px-3 py-2.5 border-b border-[#c6c6c8]/50">
          {header}
        </div>
      )}
      {children}
    </div>
  );
}
