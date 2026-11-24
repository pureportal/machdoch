"use client";

import type { CloudDocument } from "@/lib/cloud-loop-contract";
import { useAgentPageEntity } from "./agent/agent-shell";
import { CloudMarkdown } from "./cloud-markdown";
import { Timestamp } from "./timestamp";

export function DocumentDetail({ document }: { document: CloudDocument }) {
  useAgentPageEntity({
    kind: "document",
    id: document.id,
    label: document.title,
    title: null,
  });
  return (
    <div className="cloud-loop-detail">
      <header className="cloud-page-header">
        <h1>{document.title}</h1>
      </header>
      {document.sections.map((section) => (
        <section key={section.id} className="cloud-loop-section">
          <header>
            <h2>{section.heading}</h2>
            <Timestamp value={section.createdAt} />
          </header>
          <CloudMarkdown content={section.body} />
        </section>
      ))}
    </div>
  );
}
