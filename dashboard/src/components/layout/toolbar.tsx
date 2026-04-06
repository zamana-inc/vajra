"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ReactNode, useState } from "react";
import {
  BoltIcon,
  BotIcon,
  DocumentIcon,
  GearIcon,
  WorkflowIcon,
  WrenchIcon,
} from "@/components/ui/icons";
import { SettingsDialog } from "./settings-dialog";

interface ToolbarItemProps {
  href: string;
  icon: ReactNode;
  label: string;
  matchPrefix?: boolean;
}

function ToolbarItem({ href, icon, label, matchPrefix }: ToolbarItemProps) {
  const pathname = usePathname();
  const isActive = matchPrefix ? pathname.startsWith(href) : pathname === href;

  return (
    <Link
      href={href}
      className={`flex items-center gap-2.5 px-3 py-2 rounded-lg transition-all duration-200 ${
        isActive
          ? "text-[#1a1a1a] bg-[#e8e8e8]"
          : "text-[#8e8e93] hover:text-[#6e6e73] hover:bg-[#efefef]"
      }`}
    >
      <span className="w-[18px] h-[18px] flex-shrink-0">{icon}</span>
      <span className="text-[13px] font-medium">{label}</span>
    </Link>
  );
}

function SettingsButton() {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <>
      <button
        onClick={() => setIsOpen(true)}
        className="flex items-center gap-2.5 w-full px-3 py-2 rounded-lg transition-all duration-200 text-[#8e8e93] hover:text-[#6e6e73] hover:bg-[#efefef]"
        aria-label="Settings"
      >
        <GearIcon className="w-[18px] h-[18px]" />
        <span className="text-[13px] font-medium">Settings</span>
      </button>

      <SettingsDialog isOpen={isOpen} onClose={() => setIsOpen(false)} />
    </>
  );
}

export function Toolbar() {
  return (
    <nav className="fixed left-0 top-0 bottom-0 w-40 bg-[#fafafa] border-r border-[#e5e5e5] flex flex-col px-3 pt-5 z-50">
      {/* Logo */}
      <div className="px-3 mb-6">
        <span className="text-[15px] font-semibold text-[#b0b0b0] tracking-tight">vajra</span>
      </div>

      {/* Navigation */}
      <div className="flex flex-col gap-0.5">
        <ToolbarItem
          href="/vajra"
          icon={<BoltIcon className="w-[18px] h-[18px]" />}
          label="Monitor"
        />
        <ToolbarItem
          href="/vajra/agents"
          icon={<BotIcon className="w-[18px] h-[18px]" />}
          label="Agents"
          matchPrefix
        />
        <ToolbarItem
          href="/vajra/skills"
          icon={<DocumentIcon className="w-[18px] h-[18px]" />}
          label="Skills"
          matchPrefix
        />
        <ToolbarItem
          href="/vajra/workflows"
          icon={<WorkflowIcon className="w-[18px] h-[18px]" />}
          label="Workflows"
          matchPrefix
        />
        <ToolbarItem
          href="/vajra/config"
          icon={<WrenchIcon className="w-[18px] h-[18px]" />}
          label="Config"
          matchPrefix
        />
      </div>

      {/* Spacer */}
      <div className="flex-1" />

      {/* Settings */}
      <div className="mb-3 pb-5 space-y-1">
        <SettingsButton />
      </div>
    </nav>
  );
}
