/**
 * Markdown section parsing and reconstruction utilities.
 * Parses markdown into sections by ## headings and subsections by ### headings.
 */

export interface Subsection {
  heading: string;
  content: string;
}

export interface Section {
  heading: string;
  content: string;
  subsections: Subsection[];
}

/**
 * Strip trailing empty lines from text to prevent accumulating
 * separator newlines when reconstructing markdown.
 */
function trimTrailingEmptyLines(text: string): string {
  const lines = text.split("\n");
  while (lines.length > 0 && lines[lines.length - 1].trim() === "") {
    lines.pop();
  }
  return lines.join("\n");
}

/**
 * Parse markdown content into hierarchical sections.
 * - ## headings become sections
 * - ### headings become subsections within the current section
 * - Content before any ## heading becomes an "Overview" section
 */
export function parseMarkdownSections(markdown: string): Section[] {
  const lines = markdown.split("\n");
  const sections: Section[] = [];
  let currentSection: Section | null = null;
  let currentSubsection: Subsection | null = null;
  const preambleContent: string[] = [];

  const pushSubsection = () => {
    if (currentSubsection && currentSection) {
      currentSection.subsections.push({
        ...currentSubsection,
        content: trimTrailingEmptyLines(currentSubsection.content),
      });
      currentSubsection = null;
    }
  };

  const pushSection = () => {
    if (currentSection) {
      sections.push({
        ...currentSection,
        content: trimTrailingEmptyLines(currentSection.content),
      });
      currentSection = null;
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Order matters: check h3 first since h2 regex would also match ### lines
    const h3Match = line.match(/^###\s+(.+)$/);
    const h2Match = !h3Match ? line.match(/^##\s+(.+)$/) : null;

    if (h2Match) {
      pushSubsection();

      // Save preamble as first section if exists
      if (currentSection === null && preambleContent.length > 0) {
        const content = preambleContent.join("\n").trim();
        if (content) {
          sections.push({
            heading: "Overview",
            content,
            subsections: [],
          });
        }
      }

      // Save previous section
      pushSection();

      // Start new section
      currentSection = {
        heading: h2Match[1],
        content: "",
        subsections: [],
      };
    } else if (h3Match && currentSection) {
      // Save any pending subsection
      pushSubsection();

      // Trim dangling separator lines before first subsection
      currentSection.content = trimTrailingEmptyLines(currentSection.content);

      // Start new subsection
      currentSubsection = {
        heading: h3Match[1],
        content: "",
      };
    } else if (currentSubsection) {
      currentSubsection.content += (currentSubsection.content ? "\n" : "") + line;
    } else if (currentSection) {
      currentSection.content += (currentSection.content ? "\n" : "") + line;
    } else {
      preambleContent.push(line);
    }
  }

  // Save last subsection
  pushSubsection();

  // Save last section
  if (currentSection) {
    sections.push({
      ...currentSection,
      content: trimTrailingEmptyLines(currentSection.content),
    });
  } else if (preambleContent.length > 0) {
    // Entire doc is preamble (no ## headings)
    sections.push({
      heading: "Content",
      content: preambleContent.join("\n").trim(),
      subsections: [],
    });
  }

  return sections;
}

/**
 * Reconstruct markdown from parsed sections.
 * Handles preamble sections (Overview/Content) specially by not adding ## prefix.
 */
export function reconstructMarkdown(sections: Section[]): string {
  const result: string[] = [];

  for (const section of sections) {
    if (section.heading === "Overview" || section.heading === "Content") {
      // This is preamble content, add directly
      const cleanedContent = trimTrailingEmptyLines(section.content);
      if (cleanedContent) {
        result.push(cleanedContent);
        result.push("");
      }
    } else {
      // Regular ## section
      result.push(`## ${section.heading}`);
      result.push("");
      const cleanedSectionContent = trimTrailingEmptyLines(section.content);
      if (cleanedSectionContent) {
        result.push(cleanedSectionContent);
        result.push("");
      }

      // Add subsections
      for (const sub of section.subsections) {
        result.push(`### ${sub.heading}`);
        result.push("");
        const cleanedSubContent = trimTrailingEmptyLines(sub.content);
        if (cleanedSubContent) {
          result.push(cleanedSubContent);
          result.push("");
        }
      }
    }
  }

  return result.join("\n").trim();
}

/**
 * Count the number of top-level sections in markdown content.
 */
export function countSections(markdown: string): number {
  return parseMarkdownSections(markdown).length;
}
