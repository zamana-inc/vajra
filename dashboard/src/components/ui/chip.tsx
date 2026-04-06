/**
 * Chip component for tool calls and action buttons.
 */

import { ReactNode } from "react";

interface ChipProps {
  label: string;
  icon?: ReactNode;
  onClick?: () => void;
  variant?: "default" | "action";
}

export function Chip({ label, icon, onClick, variant = "default" }: ChipProps) {
  const isButton = !!onClick || variant === "action";
  const Component = isButton ? "button" : "span";

  return (
    <Component
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 px-2.5 py-1 text-[11px] rounded-full bg-[#e5e5ea] ${
        isButton
          ? "text-[#007aff] hover:bg-[#d1d1d6] transition-colors cursor-pointer"
          : "text-[#8e8e93]"
      }`}
    >
      {icon}
      {label}
    </Component>
  );
}
