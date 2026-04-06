---
name: vajra-knowledge-writing
description: Use for Vajra stages that draft category knowledge docs grounded in repo instructions, target schemas, and the closest existing knowledge docs.
---

# Vajra Knowledge Writing

You are writing a new category knowledge document for `experiments/knowledge/agent-drafts/`.

Your job is to produce a schema-aware draft that teaches the system how to reason about a product category for retrieval, ranking, matching, and recommendation. This is not generic product education. It is operational knowledge tied to the repo's schema.

## Non-Negotiable Read Requirements

Before writing anything, you must read every file in `experiments/knowledge/instructions` completely and carefully.

Do not skim, sample, or stop early. That behavior is incorrect for this task. It is not possible to succeed without fully reading and understanding the instruction documents and historical logs in that directory.

Treat every file there as required source material, not optional context.

### What the instruction files are

The files in `experiments/knowledge/instructions` are cleaned conversation logs between the project owner and an AI collaborator. They are not structured style guides. They are transcripts of real writing sessions where the owner demonstrated the quality bar, corrected mistakes, pushed back on generic output, and showed what good knowledge writing actually looks like for this repo.

Read them as apprenticeship material. Pay attention to:

- what the owner corrected and why
- what patterns the owner praised or accepted
- what specific mistakes triggered pushback
- the level of specificity and schema-grounding the owner demanded

The corrections and feedback in these logs define the quality bar more precisely than any style guide could. If the logs show the owner rejecting a particular approach, do not use that approach.

### Schema and extraction instructions

After the instruction files, read the target category's schema and extraction instructions:

- `experiments/schemas/examples/<category>.jsonc`
- `experiments/schemas/examples/<category>.md`

### Closest existing knowledge docs

Then inspect the existing knowledge docs in `experiments/knowledge/`, identify the 2–3 closest examples to learn from, and read those examples fully. Choose examples based on product structure, buyer tradeoffs, and schema shape, not superficial keyword similarity. For example, if writing about throw pillows, cushions and decorative pillowcases are structurally closer than bedsheets — even though all are "textiles."

## Mindset

The knowledge doc and the schema are a pair.

The schema defines what data exists. The knowledge doc explains what those fields mean, how to interpret them, which ones matter most, what tradeoffs they capture, and what field combinations signal quality or problems.

The common failure mode is writing a smart-sounding category essay that is only loosely connected to the schema. That is wrong. The document must read like it was written by someone who understands both the category and the exact schema used in this repo.

The second common failure mode is borrowing conclusions from an analogous category doc without adapting them to the target schema. Existing docs are for learning tone, structure, and level of specificity. They are not templates to copy blindly.

## Process

### 1. Determine the target category precisely

Infer the category slug from the issue title and description. Use the exact slug that matches the schema filenames and the draft output filename.

### 2. Read the source material comprehensively

Read all required instruction files in `experiments/knowledge/instructions`.

Read the target category schema and extraction guidance fully.

Read the closest existing knowledge docs fully.

Do not begin drafting until all of that reading is complete.

### 3. Write a schema-aware knowledge draft

Explain how the category actually works in terms that map back to the schema.

Reference schema field names inline throughout the document.

Explain what enum values mean in practice, what dimensions matter most for matching, which fields are trustworthy, which require interpretation, and which combinations are red flags.

Surface real tradeoffs. Do not reduce the category to a brittle decision tree.

Use the issue and instruction files as the source of truth for market scope and audience. If they specify a market such as the US, keep the reasoning anchored to that market.

### 4. Use strong examples correctly

Learn from the closest existing docs for:

- tone
- level of specificity
- section structure
- how schema-aware reasoning is expressed

Do not transplant category-specific claims from those examples into the target category.

### 5. Write to the correct locations

Write the actual draft to `experiments/knowledge/agent-drafts/<category>.md`.

Also copy the exact final draft to `.vajra/run/knowledge-draft.md` so the workflow has a stable artifact path.

Do not overwrite or edit the curated docs in `experiments/knowledge/`.

## Quality Bar

Good knowledge docs:

- are grounded in the actual schema
- use real field names inline
- explain why the category behaves the way it does
- distinguish strong signals from noisy or misleading ones
- help the system translate user language into schema-aware reasoning
- cover the category's real tensions and tradeoffs

Bad knowledge docs:

- read like generic product education
- barely mention schema fields
- list materials or features without explaining what they imply
- copy patterns from other categories without adapting them
- include claims that are not supported by the target schema or source material

## Rules

- Read every file in `experiments/knowledge/instructions` fully before drafting.
- Read the target schema and extraction guide fully before drafting.
- Read the closest existing example docs fully before drafting.
- Reference schema fields inline throughout the document.
- Use existing docs to learn style and rigor, not to copy conclusions.
- Write the new file only under `experiments/knowledge/agent-drafts/`.
- Do not modify curated docs in `experiments/knowledge/`.
