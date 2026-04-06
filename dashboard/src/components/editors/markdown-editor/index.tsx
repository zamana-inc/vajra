"use client";

/**
 * Collapsible markdown section editor with subsection support.
 * Parses markdown into sections by ## headings and subsections by ### headings.
 * Supports adding, deleting, renaming, and reordering sections/subsections.
 */

import { useState, useCallback, useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { parseMarkdownSections, reconstructMarkdown } from "@/lib/markdown-sections";
import { SectionEditor } from "./section-editor";
import {
  type SectionWithId,
  type EditingHeading,
  createId,
  withIds,
  mergeWithExistingIds,
} from "./types";

// Re-export countSections from lib for backward compatibility
export { countSections } from "@/lib/markdown-sections";

interface MarkdownEditorProps {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  reorderMode?: boolean;
  onReorderModeChange?: (mode: boolean) => void;
}

export function MarkdownEditor({
  value,
  onChange,
  disabled,
  reorderMode: externalReorderMode,
  onReorderModeChange,
}: MarkdownEditorProps) {
  const [sections, setSections] = useState<SectionWithId[]>(() =>
    withIds(parseMarkdownSections(value))
  );

  // Track previous value for synchronous updates during render
  const [prevValue, setPrevValue] = useState(value);

  // Refs for emit tracking (only accessed in effects, not during render)
  const lastEmittedMarkdownRef = useRef(value);
  const skipNextEmitRef = useRef(true);
  const onChangeRef = useRef(onChange);

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  const [expandedSections, setExpandedSections] = useState<Set<string>>(
    () => new Set(sections.map((s) => s.id))
  );
  const [expandedSubsections, setExpandedSubsections] = useState<Set<string>>(
    () => new Set()
  );
  const [editingHeading, setEditingHeading] = useState<EditingHeading | null>(null);
  const [headingValue, setHeadingValue] = useState("");
  const [internalReorderMode, setInternalReorderMode] = useState(false);
  const [reorderSubsectionMode, setReorderSubsectionMode] = useState<string | null>(null);
  const [addingContentToSection, setAddingContentToSection] = useState<string | null>(null);

  const reorderMode = externalReorderMode ?? internalReorderMode;
  const setReorderMode = onReorderModeChange ?? setInternalReorderMode;

  // Synchronously update sections when value prop changes
  if (value !== prevValue) {
    setPrevValue(value);
    const parsed = parseMarkdownSections(value);
    const newSections = mergeWithExistingIds(parsed, sections);
    setSections(newSections);
    setEditingHeading(null);
    setReorderSubsectionMode(null);
    setAddingContentToSection(null);

    // Preserve expanded states
    const newSectionIds = new Set(newSections.map((s) => s.id));
    setExpandedSections((prev) => {
      const next = new Set<string>();
      prev.forEach((id) => {
        if (newSectionIds.has(id)) next.add(id);
      });
      const prevSectionIds = new Set(sections.map((s) => s.id));
      newSectionIds.forEach((id) => {
        if (!prevSectionIds.has(id)) next.add(id);
      });
      return next;
    });

    const newSubKeys = new Set<string>();
    newSections.forEach((section) => {
      section.subsections.forEach((sub) => {
        newSubKeys.add(`${section.id}-${sub.id}`);
      });
    });
    setExpandedSubsections((prev) => {
      const next = new Set<string>();
      prev.forEach((key) => {
        if (newSubKeys.has(key)) next.add(key);
      });
      const prevSubKeys = new Set<string>();
      sections.forEach((section) => {
        section.subsections.forEach((sub) => {
          prevSubKeys.add(`${section.id}-${sub.id}`);
        });
      });
      newSubKeys.forEach((key) => {
        if (!prevSubKeys.has(key)) next.add(key);
      });
      return next;
    });
  }

  useEffect(() => {
    lastEmittedMarkdownRef.current = value;
    skipNextEmitRef.current = true;
  }, [value]);

  const syncSections = useCallback(
    (updater: (prev: SectionWithId[]) => SectionWithId[]) => {
      setSections((prev) => {
        const next = updater(prev);
        const prevSectionIds = new Set(prev.map((s) => s.id));
        const nextSectionIds = new Set(next.map((s) => s.id));

        setExpandedSections((prevExpanded) => {
          const result = new Set<string>();
          prevExpanded.forEach((id) => {
            if (nextSectionIds.has(id)) result.add(id);
          });
          nextSectionIds.forEach((id) => {
            if (!prevSectionIds.has(id)) result.add(id);
          });
          return result;
        });

        const prevSubKeys = new Set<string>();
        prev.forEach((section) => {
          section.subsections.forEach((sub) => {
            prevSubKeys.add(`${section.id}-${sub.id}`);
          });
        });
        const nextSubKeys = new Set<string>();
        next.forEach((section) => {
          section.subsections.forEach((sub) => {
            nextSubKeys.add(`${section.id}-${sub.id}`);
          });
        });

        setExpandedSubsections((prevSubExpanded) => {
          const result = new Set<string>();
          prevSubExpanded.forEach((key) => {
            if (nextSubKeys.has(key)) result.add(key);
          });
          nextSubKeys.forEach((key) => {
            if (!prevSubKeys.has(key)) result.add(key);
          });
          return result;
        });

        return next;
      });
    },
    []
  );

  // Emit changes to parent when sections change internally
  useEffect(() => {
    const markdown = reconstructMarkdown(sections);
    if (skipNextEmitRef.current) {
      skipNextEmitRef.current = false;
      lastEmittedMarkdownRef.current = markdown;
      return;
    }
    if (markdown === lastEmittedMarkdownRef.current) return;
    lastEmittedMarkdownRef.current = markdown;
    onChangeRef.current(markdown);
  }, [sections]);

  // Handle escape key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (reorderMode) setReorderMode(false);
        if (reorderSubsectionMode !== null) setReorderSubsectionMode(null);
        if (editingHeading) setEditingHeading(null);
        if (addingContentToSection !== null) setAddingContentToSection(null);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [reorderMode, reorderSubsectionMode, editingHeading, addingContentToSection, setReorderMode]);

  // Section operations
  const toggleSection = useCallback((sectionId: string) => {
    setExpandedSections((prev) => {
      const next = new Set(prev);
      if (next.has(sectionId)) next.delete(sectionId);
      else next.add(sectionId);
      return next;
    });
  }, []);

  const toggleSubsection = useCallback((sectionId: string, subsectionId: string) => {
    const key = `${sectionId}-${subsectionId}`;
    setExpandedSubsections((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const updateSectionContent = useCallback(
    (sectionId: string, newContent: string) => {
      syncSections((prev) =>
        prev.map((s) => (s.id === sectionId ? { ...s, content: newContent } : s))
      );
    },
    [syncSections]
  );

  const updateSubsectionContent = useCallback(
    (sectionId: string, subsectionId: string, newContent: string) => {
      syncSections((prev) =>
        prev.map((section) => {
          if (section.id !== sectionId) return section;
          return {
            ...section,
            subsections: section.subsections.map((sub) =>
              sub.id === subsectionId ? { ...sub, content: newContent } : sub
            ),
          };
        })
      );
    },
    [syncSections]
  );

  const renameSection = useCallback(
    (sectionId: string, newHeading: string) => {
      const trimmed = newHeading.trim();
      if (!trimmed) {
        setEditingHeading(null);
        return;
      }
      syncSections((prev) =>
        prev.map((s) => (s.id === sectionId ? { ...s, heading: trimmed } : s))
      );
      setEditingHeading(null);
    },
    [syncSections]
  );

  const renameSubsection = useCallback(
    (sectionId: string, subsectionId: string, newHeading: string) => {
      const trimmed = newHeading.trim();
      if (!trimmed) {
        setEditingHeading(null);
        return;
      }
      syncSections((prev) =>
        prev.map((section) => {
          if (section.id !== sectionId) return section;
          return {
            ...section,
            subsections: section.subsections.map((sub) =>
              sub.id === subsectionId ? { ...sub, heading: trimmed } : sub
            ),
          };
        })
      );
      setEditingHeading(null);
    },
    [syncSections]
  );

  const deleteSection = useCallback(
    (sectionId: string) => {
      syncSections((prev) => prev.filter((s) => s.id !== sectionId));
    },
    [syncSections]
  );

  const deleteSubsection = useCallback(
    (sectionId: string, subsectionId: string) => {
      syncSections((prev) =>
        prev.map((section) => {
          if (section.id !== sectionId) return section;
          return {
            ...section,
            subsections: section.subsections.filter((sub) => sub.id !== subsectionId),
          };
        })
      );
    },
    [syncSections]
  );

  const addSubsection = useCallback(
    (sectionId: string) => {
      syncSections((prev) =>
        prev.map((section) => {
          if (section.id !== sectionId) return section;
          return {
            ...section,
            subsections: [
              ...section.subsections,
              { id: createId("subsection"), heading: "New Subsection", content: "" },
            ],
          };
        })
      );
    },
    [syncSections]
  );

  const moveSection = useCallback(
    (sectionId: string, direction: "up" | "down") => {
      syncSections((prev) => {
        const idx = prev.findIndex((s) => s.id === sectionId);
        const newIdx = direction === "up" ? idx - 1 : idx + 1;
        if (idx === -1 || newIdx < 0 || newIdx >= prev.length) return prev;
        const next = [...prev];
        [next[idx], next[newIdx]] = [next[newIdx], next[idx]];
        return next;
      });
    },
    [syncSections]
  );

  const moveSubsection = useCallback(
    (sectionId: string, subsectionId: string, direction: "up" | "down") => {
      syncSections((prev) =>
        prev.map((section) => {
          if (section.id !== sectionId) return section;
          const idx = section.subsections.findIndex((sub) => sub.id === subsectionId);
          const newIdx = direction === "up" ? idx - 1 : idx + 1;
          if (idx === -1 || newIdx < 0 || newIdx >= section.subsections.length) {
            return section;
          }
          const updatedSubs = [...section.subsections];
          [updatedSubs[idx], updatedSubs[newIdx]] = [updatedSubs[newIdx], updatedSubs[idx]];
          return { ...section, subsections: updatedSubs };
        })
      );
    },
    [syncSections]
  );

  const startEditingHeading = useCallback(
    (
      type: "section" | "subsection",
      sectionId: string,
      currentHeading: string,
      subsectionId?: string
    ) => {
      setEditingHeading({ type, sectionId, subsectionId });
      setHeadingValue(currentHeading);
    },
    []
  );

  const handleHeadingKeyDown = useCallback(
    (e: ReactKeyboardEvent) => {
      if (e.key === "Enter") {
        e.preventDefault();
        if (editingHeading?.type === "section" && editingHeading.sectionId) {
          renameSection(editingHeading.sectionId, headingValue);
        } else if (
          editingHeading?.type === "subsection" &&
          editingHeading.sectionId &&
          editingHeading.subsectionId
        ) {
          renameSubsection(editingHeading.sectionId, editingHeading.subsectionId, headingValue);
        }
      } else if (e.key === "Escape") {
        setEditingHeading(null);
      }
    },
    [editingHeading, headingValue, renameSection, renameSubsection]
  );

  const handleHeadingBlur = useCallback(() => {
    if (editingHeading?.type === "section" && editingHeading.sectionId) {
      renameSection(editingHeading.sectionId, headingValue);
    } else if (
      editingHeading?.type === "subsection" &&
      editingHeading.sectionId &&
      editingHeading.subsectionId
    ) {
      renameSubsection(editingHeading.sectionId, editingHeading.subsectionId, headingValue);
    }
  }, [editingHeading, headingValue, renameSection, renameSubsection]);

  // Fallback for no sections
  if (sections.length === 0) {
    return (
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        placeholder="Enter prompt content..."
        className="w-full h-48 p-4 text-[14px] font-mono bg-[var(--d-bg-surface)] border border-[var(--d-border)] rounded-lg resize-none focus:outline-none focus:border-[var(--d-primary)] disabled:opacity-50 disabled:bg-[var(--d-bg-subtle)]"
      />
    );
  }

  return (
    <div className="space-y-2">
      {sections.map((section, index) => (
        <SectionEditor
          key={section.id}
          section={section}
          index={index}
          totalCount={sections.length}
          isExpanded={expandedSections.has(section.id)}
          expandedSubsections={expandedSubsections}
          editingHeading={editingHeading}
          headingValue={headingValue}
          reorderMode={reorderMode}
          reorderSubsectionMode={reorderSubsectionMode}
          addingContentToSection={addingContentToSection}
          disabled={disabled}
          onToggle={() => toggleSection(section.id)}
          onToggleSubsection={(subId) => toggleSubsection(section.id, subId)}
          onSectionContentChange={(content) => updateSectionContent(section.id, content)}
          onSubsectionContentChange={(subId, content) =>
            updateSubsectionContent(section.id, subId, content)
          }
          onStartEditingSection={() =>
            startEditingHeading("section", section.id, section.heading)
          }
          onStartEditingSubsection={(subId, heading) =>
            startEditingHeading("subsection", section.id, heading, subId)
          }
          onHeadingChange={setHeadingValue}
          onHeadingKeyDown={handleHeadingKeyDown}
          onHeadingBlur={handleHeadingBlur}
          onRenameSectionSave={() => renameSection(section.id, headingValue)}
          onRenameSubsectionSave={(subId) =>
            renameSubsection(section.id, subId, headingValue)
          }
          onDeleteSection={() => deleteSection(section.id)}
          onDeleteSubsection={(subId) => deleteSubsection(section.id, subId)}
          onMoveSection={(dir) => moveSection(section.id, dir)}
          onMoveSubsection={(subId, dir) => moveSubsection(section.id, subId, dir)}
          onAddSubsection={() => addSubsection(section.id)}
          onSetReorderSubsectionMode={setReorderSubsectionMode}
          onSetAddingContent={setAddingContentToSection}
        />
      ))}
    </div>
  );
}
