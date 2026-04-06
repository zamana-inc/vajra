"use client";

/**
 * Settings dialog — centered modal for system-wide configuration.
 */

import { useState, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { CloseIcon, LogOutIcon } from "@/components/ui/icons";

interface SettingsDialogProps {
  isOpen: boolean;
  onClose: () => void;
}

export function SettingsDialog({ isOpen, onClose }: SettingsDialogProps) {
  const router = useRouter();
  const [loggingOut, setLoggingOut] = useState(false);
  const [mounted, setMounted] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, onClose]);

  useEffect(() => {
    if (isOpen) {
      const originalOverflow = document.body.style.overflow;
      document.body.style.overflow = "hidden";
      return () => {
        document.body.style.overflow = originalOverflow;
      };
    }
  }, [isOpen]);

  useEffect(() => {
    if (isOpen && dialogRef.current) {
      dialogRef.current.focus();
    }
  }, [isOpen]);

  const handleLogout = async () => {
    setLoggingOut(true);
    try {
      await fetch("/api/auth/logout", { method: "POST" });
      onClose();
      router.push("/login");
      router.refresh();
    } catch (error) {
      console.error("Failed to logout:", error);
      setLoggingOut(false);
    }
  };

  if (!isOpen || !mounted) return null;

  const content = (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
      <div
        className="absolute inset-0 bg-black/40 animate-in fade-in duration-150"
        onClick={onClose}
      />
      <div
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        className="relative w-full max-w-[420px] bg-[#f2f2f7] rounded-2xl shadow-2xl animate-in fade-in zoom-in-95 duration-150 outline-none overflow-hidden"
      >
        <div className="flex items-center justify-between px-4 py-3">
          <h2 id="settings-title" className="text-[17px] font-semibold text-[#1a1a1a]">
            Settings
          </h2>
          <button
            onClick={onClose}
            className="w-8 h-8 flex items-center justify-center rounded-full bg-[#e5e5ea] text-[#8e8e93] hover:text-[#1a1a1a] transition-colors"
            aria-label="Close"
          >
            <CloseIcon className="w-4 h-4" />
          </button>
        </div>
        <div className="pb-4">
          <div className="mx-4">
            <button
              onClick={handleLogout}
              disabled={loggingOut}
              className="w-full px-4 py-3 bg-white rounded-lg border border-[#e5e5e5] flex items-center justify-center gap-2 text-[14px] text-[#ff3b30] hover:bg-[#fff5f5] transition-colors disabled:opacity-50"
            >
              <LogOutIcon className="w-4 h-4" />
              <span>{loggingOut ? "Signing out..." : "Sign out"}</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );

  return createPortal(content, document.body);
}
