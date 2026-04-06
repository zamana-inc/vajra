"use client";

/**
 * Individual subsection editor within a markdown section.
 * Handles collapse/expand, editing heading, content, and reordering.
 */

import { type KeyboardEvent as ReactKeyboardEvent } from "react";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  TrashIcon,
  PencilIcon,
  ArrowUpSmallIcon,
  ArrowDownSmallIcon,
  CheckIcon,
} from "@/components/ui/icons";
import type { SubsectionWithId } from "./types";

interface SubsectionEditorProps {
  subsection: SubsectionWithId;
  sectionId: string;
  index: number;
  totalCount: number;
  isExpanded: boolean;
  isEditing: boolean;
  isReordering: boolean;
  headingValue: string;
  disabled?: boolean;
  onToggle: () => void;
  onContentChange: (content: string) => void;
  onStartEditing: () => void;
  onHeadingChange: (value: string) => void;
  onHeadingKeyDown: (e: ReactKeyboardEvent) => void;
  onHeadingBlur: () => void;
  onHeadingSave: () => void;
  onDelete: () => void;
  onMove: (direction: "up" | "down") => void;
}

export function SubsectionEditor({
  subsection,
  index,
  totalCount,
  isExpanded,
  isEditing,
  isReordering,
  headingValue,
  disabled,
  onToggle,
  onContentChange,
  onStartEditing,
  onHeadingChange,
  onHeadingKeyDown,
  onHeadingBlur,
  onHeadingSave,
  onDelete,
  onMove,
}: SubsectionEditorProps) {
  return (
    <div className="border border-[var(--d-border)] bg-[var(--d-bg-subtle)] rounded-lg overflow-hidden">
      {/* Subsection header */}
      <div className="flex items-center gap-2 px-3 py-2 bg-[var(--d-bg-hover)] group">
        <button
          onClick={onToggle}
          className="flex items-center gap-2 flex-1 text-left -ml-1 pl-1 py-0.5 rounded transition-colors"
        >
          <span className="w-3.5 h-3.5 flex-shrink-0 text-[var(--d-text-tertiary)]">
            {isExpanded ? (
              <ChevronDownIcon className="w-3.5 h-3.5" />
            ) : (
              <ChevronRightIcon className="w-3.5 h-3.5" />
            )}
          </span>
          {isEditing ? (
            <input
              type="text"
              value={headingValue}
              onChange={(e) => onHeadingChange(e.target.value)}
              onKeyDown={onHeadingKeyDown}
              onBlur={onHeadingBlur}
              onClick={(e) => e.stopPropagation()}
              autoFocus
              className="flex-1 text-[13px] font-medium text-[var(--d-text-primary)] bg-[var(--d-bg-surface)] border border-[var(--d-primary)] rounded px-2 py-0.5 focus:outline-none"
            />
          ) : (
            <span className="text-[13px] font-medium text-[var(--d-text-primary)]">
              {subsection.heading}
            </span>
          )}
          {!isExpanded && subsection.content && !isEditing && (
            <span className="text-[11px] text-[var(--d-text-tertiary)] truncate max-w-[180px]">
              {subsection.content.slice(0, 40)}...
            </span>
          )}
        </button>

        {/* Subsection actions */}
        {!disabled && (
          <div className="flex items-center gap-1">
            {isReordering ? (
              <>
                <button
                  onClick={() => onMove("up")}
                  disabled={index === 0}
                  className="p-1 text-[var(--d-text-tertiary)] hover:text-[var(--d-text-secondary)] disabled:opacity-30 disabled:hover:text-[var(--d-text-tertiary)] transition-colors"
                  title="Move up"
                >
                  <ArrowUpSmallIcon className="w-3.5 h-3.5" />
                </button>
                <button
                  onClick={() => onMove("down")}
                  disabled={index === totalCount - 1}
                  className="p-1 text-[var(--d-text-tertiary)] hover:text-[var(--d-text-secondary)] disabled:opacity-30 disabled:hover:text-[var(--d-text-tertiary)] transition-colors"
                  title="Move down"
                >
                  <ArrowDownSmallIcon className="w-3.5 h-3.5" />
                </button>
              </>
            ) : isEditing ? (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onHeadingSave();
                }}
                className="p-1 text-[var(--d-success)] hover:text-[var(--d-success)] transition-colors"
                title="Save"
              >
                <CheckIcon className="w-3 h-3" />
              </button>
            ) : (
              <>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onStartEditing();
                  }}
                  className="p-1 text-[var(--d-text-tertiary)] opacity-0 group-hover:opacity-100 hover:text-[var(--d-text-secondary)] transition-all"
                  title="Rename subsection"
                >
                  <PencilIcon className="w-3 h-3" />
                </button>
                <button
                  onClick={onDelete}
                  className="p-1 text-[var(--d-text-tertiary)] opacity-0 group-hover:opacity-100 hover:text-[var(--d-text-secondary)] transition-all"
                  title="Delete subsection"
                >
                  <TrashIcon className="w-3 h-3" />
                </button>
              </>
            )}
          </div>
        )}
      </div>

      {/* Subsection content */}
      {isExpanded && (
        <div className="p-3 border-t border-[var(--d-border)]">
          <textarea
            value={subsection.content}
            onChange={(e) => onContentChange(e.target.value)}
            disabled={disabled}
            rows={Math.max(3, subsection.content.split("\n").length + 1)}
            placeholder="Enter subsection content..."
            className="w-full p-3 text-[13px] font-mono bg-[var(--d-bg-surface)] border border-[var(--d-border)] rounded resize-none focus:outline-none focus:border-[var(--d-primary)] disabled:opacity-50"
          />
        </div>
      )}
    </div>
  );
}
