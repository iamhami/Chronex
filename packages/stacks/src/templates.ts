import { randomUUID } from "node:crypto";

import type { StackSection, StackTemplate } from "./types.ts";

export const defaultStackTemplates: StackTemplate[] = [
  {
    id: "creator-standard",
    name: "Creator Standard",
    description: "Structured sections for a creator-owned draft with proof and offer blocks.",
    sections: [
      {
        type: "summary",
        label: "Summary",
        content: ""
      },
      {
        type: "problem",
        label: "Problem",
        content: ""
      },
      {
        type: "solution",
        label: "Solution",
        content: ""
      },
      {
        type: "proof",
        label: "Proof",
        content: ""
      },
      {
        type: "offer",
        label: "Offer",
        content: ""
      }
    ]
  },
  {
    id: "blank",
    name: "Blank Draft",
    description: "Fallback scaffold used when a requested template is unavailable.",
    sections: [
      {
        type: "summary",
        label: "Summary",
        content: ""
      }
    ]
  }
];

export function instantiateTemplateSections(template: StackTemplate): StackSection[] {
  return template.sections.map((section, index) => ({
    id: `sec_${randomUUID().replaceAll("-", "")}`,
    type: section.type,
    content: section.content,
    order: index
  }));
}
