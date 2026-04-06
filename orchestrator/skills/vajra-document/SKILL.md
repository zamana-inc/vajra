---
name: vajra-document
description: Use for Vajra documentation stages to write developer documentation grounded in the actual codebase.
---

# Vajra Document

You are writing developer documentation. Your job is to read the code, understand the system, and produce docs that help engineers onboard and work effectively.

## Context

Documentation should be practical and concise — not exhaustive. Write what an engineer actually needs to know. Skip ceremony.

## Mindset

Documentation is a map of the territory. The territory is the code. If you have not read the code, you cannot draw the map.

The most common documentation failure is writing about what you think the code does instead of what it actually does. Every claim in your docs must be verifiable by opening the file you reference. If you are unsure how something works, read it — do not guess.

The second most common failure is writing too much. Engineers skim documentation. Dense paragraphs get skipped. Short sections with concrete examples get read.

## Process

### 1. Understand the scope

Read the issue. What area needs documentation? What audience — new developer, maintainer, API consumer? What is the right format — README, guide, AGENTS.md, API reference?

### 2. Read the code

Read the relevant source files, tests, and configs thoroughly. Understand:

- What the system does and why it exists
- How the key components interact
- What the entry points are
- What the non-obvious behaviors and gotchas are

Tests are often the best documentation of actual behavior. Read them.

### 3. Write grounded documentation

Every statement must trace back to code you read. Prefer:

- Concrete file paths and function names over vague descriptions
- Real examples from the codebase over hypothetical ones
- Short sections with clear headings over walls of text
- "This does X" over "This is designed to do X"

### 4. Structure for scanning

Engineers do not read docs linearly. Structure for quick lookup:

- Start with a one-paragraph overview
- Use clear headings that answer "what is this section about?"
- Put the most important information first in each section
- Use code blocks for commands, file paths, and examples

## Output Format

Structure depends on the issue, but prefer:

```markdown
# Title

## Overview
What this system/module does. 2-3 sentences max.

## How it works
Key components and their interactions. Keep it concrete.

## Usage
How to use, configure, or extend. Include actual commands.

## Examples
Real code or command examples from the codebase.

## Gotchas
Non-obvious behaviors, constraints, known issues.
```

## Quality Bar

**Good docs**: an engineer can read them in 5 minutes and start working. Every file path is real. Every example runs. Every behavior described matches the code.

**Bad docs**: verbose, speculative, full of "should" and "is designed to", references files that do not exist, describes aspirational behavior instead of actual behavior.

## Rules

- Do not invent behaviors that are not in the code.
- Do not leave placeholders ("TBD", "TODO", "to be documented").
- Do not write aspirational documentation ("this will eventually...").
- Use concrete file paths and function names.
- If something is unclear from the code, say so explicitly rather than guessing.
- Keep it short. If a section is longer than a screenful, it is too long.
