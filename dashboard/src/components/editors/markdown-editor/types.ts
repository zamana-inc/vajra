/**
 * Internal types for MarkdownEditor with stable IDs for React keys.
 */

import type { Section, Subsection } from "@/lib/markdown-sections";

export interface SubsectionWithId extends Subsection {
  id: string;
}

export interface SectionWithId extends Section {
  id: string;
  subsections: SubsectionWithId[];
}

export interface EditingHeading {
  type: "section" | "subsection";
  sectionId: string;
  subsectionId?: string;
}

let idCounter = 0;

export function createId(prefix: string): string {
  return `${prefix}-${++idCounter}`;
}

export function withIds(sections: Section[]): SectionWithId[] {
  return sections.map((section) => ({
    ...section,
    id: createId("section"),
    subsections: section.subsections.map((sub) => ({
      ...sub,
      id: createId("subsection"),
    })),
  }));
}

/**
 * Merge newly parsed sections with existing ones, preserving IDs where possible.
 * This prevents unnecessary re-renders when external value changes.
 */
export function mergeWithExistingIds(
  parsed: Section[],
  existing: SectionWithId[]
): SectionWithId[] {
  const takenSectionIndexes = new Set<number>();

  const pickSection = (section: Section): SectionWithId => {
    const matchIndex = existing.findIndex((candidate, idx) => {
      if (takenSectionIndexes.has(idx)) return false;
      return (
        candidate.heading === section.heading &&
        candidate.subsections.length === section.subsections.length
      );
    });

    if (matchIndex === -1) {
      return {
        ...section,
        id: createId("section"),
        subsections: section.subsections.map((sub) => ({
          ...sub,
          id: createId("subsection"),
        })),
      };
    }

    takenSectionIndexes.add(matchIndex);
    const matched = existing[matchIndex];

    const subsections: SubsectionWithId[] = section.subsections.map(
      (sub, subIndex) => {
        const prev = matched.subsections[subIndex];
        const id =
          prev && prev.heading === sub.heading ? prev.id : createId("subsection");
        return { ...sub, id };
      }
    );

    return {
      ...section,
      id: matched.id,
      subsections,
    };
  };

  return parsed.map(pickSection);
}
