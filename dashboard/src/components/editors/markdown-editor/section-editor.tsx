"use client";

/**
 * Individual section editor within the markdown editor.
 * Handles collapse/expand, editing heading, content, subsections, and reordering.
 */

import { type KeyboardEvent as ReactKeyboardEvent } from "react";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  TrashIcon,
  PencilIcon,
  ArrowUpSmallIcon,
  ArrowDownSmallIcon,
  ReorderIcon,
  PlusCircleIcon,
  CheckIcon,
} from "@/components/ui/icons";
import { SubsectionEditor } from "./subsection-editor";
import type { SectionWithId, EditingHeading } from "./types";

interface SectionEditorProps {
  section: SectionWithId;
  index: number;
  totalCount: number;
  isExpanded: boolean;
  expandedSubsections: Set<string>;
  editingHeading: EditingHeading | null;
  headingValue: string;
  reorderMode: boolean;
  reorderSubsectionMode: string | null;
  addingContentToSection: string | null;
  disabled?: boolean;
  onToggle: () => void;
  onToggleSubsection: (subsectionId: string) => void;
  onSectionContentChange: (content: string) => void;
  onSubsectionContentChange: (subsectionId: string, content: string) => void;
  onStartEditingSection: () => void;
  onStartEditingSubsection: (subsectionId: string, heading: string) => void;
  onHeadingChange: (value: string) => void;
  onHeadingKeyDown: (e: ReactKeyboardEvent) => void;
  onHeadingBlur: () => void;
  onRenameSectionSave: () => void;
  onRenameSubsectionSave: (subsectionId: string) => void;
  onDeleteSection: () => void;
  onDeleteSubsection: (subsectionId: string) => void;
  onMoveSection: (direction: "up" | "down") => void;
  onMoveSubsection: (subsectionId: string, direction: "up" | "down") => void;
  onAddSubsection: () => void;
  onSetReorderSubsectionMode: (sectionId: string | null) => void;
  onSetAddingContent: (sectionId: string | null) => void;
}

export function SectionEditor({
  section,
  index,
  totalCount,
  isExpanded,
  expandedSubsections,
  editingHeading,
  headingValue,
  reorderMode,
  reorderSubsectionMode,
  addingContentToSection,
  disabled,
  onToggle,
  onToggleSubsection,
  onSectionContentChange,
  onSubsectionContentChange,
  onStartEditingSection,
  onStartEditingSubsection,
  onHeadingChange,
  onHeadingKeyDown,
  onHeadingBlur,
  onRenameSectionSave,
  onRenameSubsectionSave,
  onDeleteSection,
  onDeleteSubsection,
  onMoveSection,
  onMoveSubsection,
  onAddSubsection,
  onSetReorderSubsectionMode,
  onSetAddingContent,
}: SectionEditorProps) {
  const isPreamble = section.heading === "Overview" || section.heading === "Content";
  const isEditingThis =
    editingHeading?.type === "section" && editingHeading.sectionId === section.id;
  const hasSubsections = section.subsections.length > 0;
  const isReorderingSubsections = reorderSubsectionMode === section.id;

  const getSubsectionPreview = (): string => {
    const count = section.subsections.length;
    if (count === 0) return section.content.slice(0, 50);
    return `${count} subsection${count > 1 ? "s" : ""}`;
  };

  return (
    <div className="border border-[var(--d-border)] rounded-lg overflow-hidden bg-[var(--d-bg-surface)]">
      {/* Section header */}
      <div className="flex items-center gap-2 px-3 py-2.5 bg-[var(--d-bg-subtle)] group">
        {/* Collapse toggle */}
        <button
          onClick={onToggle}
          className="flex items-center gap-2 flex-1 text-left -ml-1 pl-1 py-0.5 rounded transition-colors"
        >
          <span className="w-4 h-4 flex-shrink-0 text-[var(--d-text-tertiary)]">
            {isExpanded ? (
              <ChevronDownIcon className="w-4 h-4" />
            ) : (
              <ChevronRightIcon className="w-4 h-4" />
            )}
          </span>
          {isEditingThis ? (
            <input
              type="text"
              value={headingValue}
              onChange={(e) => onHeadingChange(e.target.value)}
              onKeyDown={onHeadingKeyDown}
              onBlur={onHeadingBlur}
              onClick={(e) => e.stopPropagation()}
              autoFocus
              className="flex-1 text-[14px] font-medium text-[var(--d-text-primary)] bg-[var(--d-bg-surface)] border border-[var(--d-primary)] rounded px-2 py-0.5 focus:outline-none"
            />
          ) : (
            <span className="text-[14px] font-medium text-[var(--d-text-primary)] flex-1">
              {section.heading}
            </span>
          )}
          {!isExpanded && !isEditingThis && (
            <span className="text-[12px] text-[var(--d-text-tertiary)] truncate max-w-[200px]">
              {getSubsectionPreview()}...
            </span>
          )}
        </button>

        {/* Section actions */}
        {!disabled && !isPreamble && (
          <div className="flex items-center gap-1">
            {reorderMode ? (
              <>
                <button
                  onClick={() => onMoveSection("up")}
                  disabled={index === 0}
                  className="p-1 text-[var(--d-text-tertiary)] hover:text-[var(--d-text-secondary)] disabled:opacity-30 disabled:hover:text-[var(--d-text-tertiary)] transition-colors"
                  title="Move up"
                >
                  <ArrowUpSmallIcon className="w-4 h-4" />
                </button>
                <button
                  onClick={() => onMoveSection("down")}
                  disabled={index === totalCount - 1}
                  className="p-1 text-[var(--d-text-tertiary)] hover:text-[var(--d-text-secondary)] disabled:opacity-30 disabled:hover:text-[var(--d-text-tertiary)] transition-colors"
                  title="Move down"
                >
                  <ArrowDownSmallIcon className="w-4 h-4" />
                </button>
              </>
            ) : isEditingThis ? (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onRenameSectionSave();
                }}
                className="p-1 text-[var(--d-success)] hover:text-[var(--d-success)] transition-colors"
                title="Save"
              >
                <CheckIcon className="w-3.5 h-3.5" />
              </button>
            ) : (
              <>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onStartEditingSection();
                  }}
                  className="p-1 text-[var(--d-text-tertiary)] opacity-0 group-hover:opacity-100 hover:text-[var(--d-text-secondary)] transition-all"
                  title="Rename section"
                >
                  <PencilIcon className="w-3.5 h-3.5" />
                </button>
                <button
                  onClick={onDeleteSection}
                  className="p-1 text-[var(--d-text-tertiary)] opacity-0 group-hover:opacity-100 hover:text-[var(--d-text-secondary)] transition-all"
                  title="Delete section"
                >
                  <TrashIcon className="w-3.5 h-3.5" />
                </button>
              </>
            )}
          </div>
        )}
      </div>

      {/* Section content */}
      {isExpanded && (
        <div className="border-t border-[var(--d-border)]">
          {/* Main section content */}
          <div className="p-3">
            {section.content.trim() || addingContentToSection === section.id ? (
              <textarea
                value={section.content}
                onChange={(e) => onSectionContentChange(e.target.value)}
                onBlur={() => {
                  if (!section.content.trim() && addingContentToSection === section.id) {
                    onSetAddingContent(null);
                  }
                }}
                disabled={disabled}
                autoFocus={addingContentToSection === section.id}
                rows={Math.max(3, section.content.split("\n").length + 1)}
                placeholder="Enter section content..."
                className="w-full p-3 text-[13px] font-mono bg-[var(--d-bg-subtle)] border border-[var(--d-border)] rounded resize-none focus:outline-none focus:border-[var(--d-primary)] disabled:opacity-50"
              />
            ) : hasSubsections ? (
              <button
                onClick={() => onSetAddingContent(section.id)}
                disabled={disabled}
                className="w-full p-3 text-[13px] text-[var(--d-text-tertiary)] bg-[var(--d-bg-subtle)] border border-dashed border-[var(--d-border)] rounded hover:border-[var(--d-primary)] hover:text-[var(--d-primary)] transition-colors text-left"
              >
                + Add content before subsections...
              </button>
            ) : (
              <textarea
                value={section.content}
                onChange={(e) => onSectionContentChange(e.target.value)}
                disabled={disabled}
                rows={3}
                placeholder="Enter section content..."
                className="w-full p-3 text-[13px] font-mono bg-[var(--d-bg-subtle)] border border-[var(--d-border)] rounded resize-none focus:outline-none focus:border-[var(--d-primary)] disabled:opacity-50"
              />
            )}
          </div>

          {/* Subsections */}
          {hasSubsections && (
            <div className="mx-3 mb-3 space-y-2">
              {section.subsections.map((sub, subIndex) => {
                const subKey = `${section.id}-${sub.id}`;
                const isSubExpanded = expandedSubsections.has(subKey);
                const isEditingThisSub =
                  editingHeading?.type === "subsection" &&
                  editingHeading.sectionId === section.id &&
                  editingHeading.subsectionId === sub.id;

                return (
                  <SubsectionEditor
                    key={sub.id}
                    subsection={sub}
                    sectionId={section.id}
                    index={subIndex}
                    totalCount={section.subsections.length}
                    isExpanded={isSubExpanded}
                    isEditing={isEditingThisSub}
                    isReordering={isReorderingSubsections}
                    headingValue={isEditingThisSub ? headingValue : ""}
                    disabled={disabled}
                    onToggle={() => onToggleSubsection(sub.id)}
                    onContentChange={(content) => onSubsectionContentChange(sub.id, content)}
                    onStartEditing={() => onStartEditingSubsection(sub.id, sub.heading)}
                    onHeadingChange={onHeadingChange}
                    onHeadingKeyDown={onHeadingKeyDown}
                    onHeadingBlur={onHeadingBlur}
                    onHeadingSave={() => onRenameSubsectionSave(sub.id)}
                    onDelete={() => onDeleteSubsection(sub.id)}
                    onMove={(dir) => onMoveSubsection(sub.id, dir)}
                  />
                );
              })}
            </div>
          )}

          {/* Add subsection and reorder buttons */}
          {!disabled && !isPreamble && (
            <div className="px-3 pb-3 flex items-center justify-between">
              <button
                onClick={onAddSubsection}
                className="flex items-center gap-1.5 px-2.5 py-1.5 text-[12px] text-[var(--d-text-tertiary)] hover:text-[var(--d-text-secondary)] rounded transition-colors"
              >
                <PlusCircleIcon className="w-3.5 h-3.5" />
                Add Subsection
              </button>
              {section.subsections.length > 1 &&
                (isReorderingSubsections ? (
                  <button
                    onClick={() => onSetReorderSubsectionMode(null)}
                    className="px-2.5 py-1.5 text-[12px] text-white bg-[var(--d-primary)] rounded hover:opacity-90 transition-colors"
                  >
                    Done
                  </button>
                ) : (
                  <button
                    onClick={() => onSetReorderSubsectionMode(section.id)}
                    className="flex items-center gap-1.5 px-2.5 py-1.5 text-[12px] text-[var(--d-text-tertiary)] hover:text-[var(--d-text-secondary)] rounded transition-colors"
                  >
                    <ReorderIcon className="w-3.5 h-3.5" />
                    Reorder
                  </button>
                ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
