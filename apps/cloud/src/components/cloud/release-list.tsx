"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Archive,
  CalendarClock,
  Images,
  ListChecks,
  Megaphone,
  Plus,
} from "lucide-react";
import { useRef, useState } from "react";
import { Field } from "@/components/field";
import { FormDialog } from "@/components/form-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import type {
  CloudProduct,
  CloudReleaseSummary,
} from "@/lib/cloud-release-contract";
import type { CloudWorkspace } from "@/lib/cloud-contract";
import { cloudRequest, createCommandSender, formText } from "./api-client";
import {
  ChannelMark,
  ReleaseSections,
  ReleaseStatusPill,
} from "./release-display";
import { RelativeTime } from "./relative-time";
import { useToast } from "./toast";

function NewReleaseDialog({
  products,
  productId,
  onClose,
}: {
  products: CloudProduct[];
  productId: string | null;
  onClose: () => void;
}) {
  const router = useRouter();
  const sender = useRef(createCommandSender());
  return (
    <FormDialog
      open
      onOpenChange={(open) => !open && onClose()}
      title="New release"
      submitLabel="Create release"
      onSubmit={async (form) => {
        const { id } = await sender.current<{ id: string }>("releases", {
          productId: formText(form, "product"),
          version: formText(form, "version"),
          name: formText(form, "name"),
          since: formText(form, "since") || null,
          targetDate: formText(form, "targetDate") || null,
        });
        router.push(`/cloud/releases/${id}`);
      }}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Product" htmlFor="release-product">
          <Select
            id="release-product"
            name="product"
            defaultValue={productId ?? products[0]?.id}
            required
          >
            {products.map((product) => (
              <option key={product.id} value={product.id}>
                {product.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Version" htmlFor="release-version">
          <Input
            id="release-version"
            name="version"
            required
            maxLength={40}
            placeholder="42.1"
            autoFocus
          />
        </Field>
      </div>
      <Field label="Name" htmlFor="release-name">
        <Input
          id="release-name"
          name="name"
          maxLength={120}
          placeholder="Automations"
        />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Shipped since" htmlFor="release-since">
          <Input id="release-since" name="since" type="date" />
        </Field>
        <Field label="Launch date" htmlFor="release-target">
          <Input id="release-target" name="targetDate" type="date" />
        </Field>
      </div>
    </FormDialog>
  );
}

export function ReleaseList({
  workspace,
  products,
  initial,
}: {
  workspace: CloudWorkspace;
  products: CloudProduct[];
  initial: CloudReleaseSummary[];
}) {
  const [productId, setProductId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [archived, setArchived] = useState<CloudReleaseSummary[] | null>(null);
  const [loadingArchived, setLoadingArchived] = useState(false);
  const toast = useToast();
  const admin = ["owner", "admin"].includes(workspace.actor.role);
  const canWrite = workspace.actor.role !== "viewer";
  const releases = (archived ?? initial).filter(
    (release) => !productId || release.productId === productId,
  );
  async function toggleArchived() {
    if (archived) {
      setArchived(null);
      return;
    }
    setLoadingArchived(true);
    try {
      setArchived(
        await cloudRequest<CloudReleaseSummary[]>("releases?archived=true"),
      );
    } catch (reason) {
      toast(reason instanceof Error ? reason.message : "Try again.", "error");
    } finally {
      setLoadingArchived(false);
    }
  }
  return (
    <>
      <header className="cloud-page-header">
        <h1>Releases</h1>
        {canWrite && products.length > 0 && (
          <Button onClick={() => setCreating(true)}>
            <Plus />
            New release
          </Button>
        )}
      </header>
      <ReleaseSections admin={admin} />
      {products.length > 0 && (
        <div className="cloud-release-filter" role="group" aria-label="Filter">
          {(products.length > 1
            ? [null, ...products.map((product) => product.id)]
            : []
          ).map((id) => {
            const product = products.find((entry) => entry.id === id);
            return (
              <button
                key={id ?? "all"}
                type="button"
                className="cloud-automation-chip"
                aria-pressed={productId === id}
                onClick={() => setProductId(id)}
              >
                {product && (
                  <span
                    className="cloud-product-dot"
                    style={{ background: product.brand.primary }}
                  />
                )}
                {product?.name ?? "All products"}
              </button>
            );
          })}
          <span className="cloud-automation-spacer" />
          <button
            type="button"
            className="cloud-automation-chip"
            aria-pressed={archived !== null}
            disabled={loadingArchived}
            onClick={() => void toggleArchived()}
          >
            <Archive size={13} aria-hidden="true" />
            Archived
          </button>
        </div>
      )}
      {!products.length ? (
        <div className="cloud-empty">
          <Megaphone aria-hidden="true" />
          <p>No products yet.</p>
          {admin && (
            <Link href="/cloud/releases/products">Set up a product</Link>
          )}
        </div>
      ) : !releases.length ? (
        <div className="cloud-empty">
          <Megaphone aria-hidden="true" />
          <p>{archived ? "No archived releases." : "No releases yet."}</p>
        </div>
      ) : (
        <ul className="cloud-release-list" aria-label="Releases">
          {releases.map((release) => (
            <li key={release.id}>
              <Link href={`/cloud/releases/${release.id}`}>
                <span
                  className="cloud-release-badge"
                  style={{
                    backgroundImage: `linear-gradient(135deg, ${release.brand.primary}, ${release.brand.accent})`,
                  }}
                >
                  {release.productName.slice(0, 1).toUpperCase()}
                </span>
                <span className="cloud-release-title">
                  <strong>
                    {release.productName} {release.version}
                  </strong>
                  <span>{release.name || "Untitled release"}</span>
                </span>
                <span className="cloud-release-meta">
                  <span title="Shipped issues">
                    <ListChecks size={13} aria-hidden="true" />
                    {release.itemCount}
                  </span>
                  <span title="Media">
                    <Images size={13} aria-hidden="true" />
                    {release.mediaCount}
                  </span>
                  {release.nextScheduledAt ? (
                    <span title="Next post">
                      <CalendarClock size={13} aria-hidden="true" />
                      {new Date(release.nextScheduledAt).toLocaleString(
                        undefined,
                        {
                          dateStyle: "medium",
                          timeStyle: "short",
                        },
                      )}
                    </span>
                  ) : release.targetDate ? (
                    <span title="Launch date">
                      <CalendarClock size={13} aria-hidden="true" />
                      {new Date(
                        `${release.targetDate}T00:00:00`,
                      ).toLocaleDateString(undefined, {
                        dateStyle: "medium",
                      })}
                    </span>
                  ) : null}
                </span>
                <span className="cloud-release-channels">
                  {release.channels.map((channel, index) => (
                    <ChannelMark
                      key={index}
                      kind={channel.kind}
                      state={channel.state}
                    />
                  ))}
                </span>
                <ReleaseStatusPill status={release.status} />
                <span className="cloud-release-updated">
                  <RelativeTime value={release.updatedAt} compact />
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
      {creating && (
        <NewReleaseDialog
          products={products}
          productId={productId}
          onClose={() => setCreating(false)}
        />
      )}
    </>
  );
}
