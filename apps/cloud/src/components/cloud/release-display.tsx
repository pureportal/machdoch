"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Webhook } from "lucide-react";
import {
  channelKindLabels,
  type ChannelKind,
  type PostState,
  type ReleaseStatus,
} from "@/lib/cloud-release-contract";

export const releaseStatusLabels: Record<ReleaseStatus, string> = {
  draft: "Draft",
  review: "In review",
  ready: "Ready",
  scheduled: "Scheduled",
  publishing: "Publishing",
  published: "Published",
  attention: "Needs attention",
};

export const postStateLabels: Record<PostState, string> = {
  draft: "Draft",
  approved: "Approved",
  scheduled: "Scheduled",
  publishing: "Publishing",
  published: "Published",
  failed: "Failed",
};

export function ChannelMark({
  kind,
  state,
}: {
  kind: ChannelKind;
  state?: PostState;
}) {
  return (
    <span
      className="cloud-channel-mark"
      data-kind={kind}
      data-state={state}
      title={
        state
          ? `${channelKindLabels[kind]} · ${postStateLabels[state]}`
          : channelKindLabels[kind]
      }
    >
      {kind === "linkedin" ? (
        "in"
      ) : kind === "reddit" ? (
        "r/"
      ) : (
        <Webhook size={11} aria-hidden="true" />
      )}
    </span>
  );
}

export function ReleaseStatusPill({ status }: { status: ReleaseStatus }) {
  return (
    <span className="cloud-release-status" data-status={status}>
      {releaseStatusLabels[status]}
    </span>
  );
}

const sections = [
  { href: "/cloud/releases", label: "Releases" },
  { href: "/cloud/releases/products", label: "Products" },
  { href: "/cloud/releases/connections", label: "Connections" },
];

export function ReleaseSections({ admin }: { admin: boolean }) {
  const pathname = usePathname();
  return (
    <nav className="cloud-release-sections" aria-label="Release sections">
      {sections
        .filter(
          (section) => admin || section.href !== "/cloud/releases/connections",
        )
        .map((section) => (
          <Link
            key={section.href}
            href={section.href}
            aria-current={pathname === section.href ? "page" : undefined}
          >
            {section.label}
          </Link>
        ))}
    </nav>
  );
}

export function mediaUrl(id: string): string {
  return `/api/v1/release-media/${id}`;
}
