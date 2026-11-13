"use client";

import { Info } from "lucide-react";
import type { SidebarPage } from "@/lib/cloud-sidebar-contract";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { CloudMarkdown } from "./cloud-markdown";

export function PageHelp({
  page,
  content,
}: {
  page: SidebarPage;
  content: string;
}) {
  return (
    <Dialog>
      <DialogTrigger
        className="cloud-page-help-trigger"
        aria-label={`About ${page.label}`}
      >
        <Info size={15} />
      </DialogTrigger>
      <DialogContent className="cloud-page-help max-w-xl gap-4">
        <DialogTitle>{page.label}</DialogTitle>
        <DialogDescription>{page.description}</DialogDescription>
        <CloudMarkdown content={content} />
      </DialogContent>
    </Dialog>
  );
}
